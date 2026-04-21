use anchor_lang::prelude::*;

/// Fee-discount tier earned by completing a lock cycle.
///
/// Wire format is a single byte (Borsh variant index), so this is drop-in
/// compatible with the previous `u8` representation. `None` is ordered first
/// so zero-init (Anchor's default for freshly-created accounts) decodes to
/// `Tier::None` without special handling.
///
/// Variants are append-only: never insert mid-list or renumber existing
/// entries, as persisted `LockPosition::tier` bytes would then misdecode.
/// Construct values by name or via Borsh deserialization — never
/// `mem::transmute` from an arbitrary `u8`.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug)]
#[repr(u8)]
pub enum Tier {
    None = 0,
    Bronze = 1,
    Silver = 2,
    Gold = 3,
}

impl Default for Tier {
    fn default() -> Self {
        Tier::None
    }
}

/// Per-vault configuration and aggregate accounting.
///
/// `initialize_vault` is permissionless — the PDA is seeded by
/// `[b"lock_vault", admin]`, so any signer can create their own `LockVault`
/// pointing at any mint with arbitrary tier thresholds. Only one deployed
/// vault is the canonical Percolator vault; the rest are uncontrolled
/// look-alikes. Off-chain consumers (indexers, matchers, UIs) must pin to
/// the canonical vault's pubkey rather than treating every `LockVault`
/// under this program as authoritative. See the README for the canonical
/// pubkey once mainnet is deployed.
#[account]
pub struct LockVault {
    /// Program admin — can update tier thresholds and lock duration
    pub admin: Pubkey,
    /// The Percolator token mint address
    pub token_mint: Pubkey,
    /// Token account holding all locked tokens (PDA-owned)
    pub vault_token_account: Pubkey,
    /// Total tokens currently locked across all users
    pub total_locked: u64,
    /// Lock duration in seconds (default: 2,592,000 = 30 days) — cast to i64 for timestamp arithmetic
    pub lock_duration: u64,
    /// Minimum tokens required for Bronze tier
    pub tier_bronze: u64,
    /// Minimum tokens required for Silver tier
    pub tier_silver: u64,
    /// Minimum tokens required for Gold tier
    pub tier_gold: u64,
    /// Number of active lock positions
    pub total_lockers: u64,
    /// Token decimals (read from mint at initialization for display/validation)
    pub token_decimals: u8,
    /// PDA bump seed
    pub bump: u8,
    /// Unix timestamp of the last successful `update_config` call, or 0 if the
    /// vault has never been reconfigured. `update_config` requires a minimum
    /// cooldown between calls (reads and writes this field). Initialized to 0
    /// so the very first call is unrestricted. Placed at the end of the struct
    /// so adding it does not shift the byte offsets of any existing field,
    /// preserving downstream byte-layout decoders (`percolator-match`,
    /// indexers) for fields they already read.
    pub last_config_update: i64,
}

impl LockVault {
    /// Account size: 8 (discriminator) + 32 + 32 + 32 + 8 + 8 + 8 + 8 + 8 + 8 + 1 + 1 + 8 = 162
    pub const SIZE: usize = 8 + 32 + 32 + 32 + 8 + 8 + 8 + 8 + 8 + 8 + 1 + 1 + 8;

    /// Classify a lock amount against this vault's tier thresholds.
    /// Returns the highest tier the amount qualifies for.
    pub fn calculate_tier(&self, amount: u64) -> Tier {
        if amount >= self.tier_gold {
            Tier::Gold
        } else if amount >= self.tier_silver {
            Tier::Silver
        } else if amount >= self.tier_bronze {
            Tier::Bronze
        } else {
            Tier::None
        }
    }
}

#[account]
pub struct LockPosition {
    /// The user who locked tokens
    pub owner: Pubkey,
    /// Which vault this position belongs to
    pub vault: Pubkey,
    /// Number of tokens locked (0 after unlock)
    pub amount: u64,
    /// Unix timestamp when tokens were locked
    pub lock_start: i64,
    /// Unix timestamp when tokens become unlockable
    pub lock_end: i64,
    /// Unix timestamp when earned discount expires
    pub discount_end: i64,
    /// Earned tier (persists after unlock so the matcher can read it)
    pub tier: Tier,
    /// Whether the lock is currently active
    pub is_active: bool,
    /// PDA bump seed
    pub bump: u8,
    /// Cycle duration in seconds, snapshotted from `vault.lock_duration` at lock time.
    /// `refresh_lock` reads THIS value, not the vault's current `lock_duration`, so a
    /// later `update_config` that changes the vault's duration cannot retroactively
    /// extend an existing position's commitment without user consent. Immutable for
    /// the life of the position; never re-written by `refresh_lock` or `unlock`.
    /// Placed at the end of the struct so adding it does not shift the byte offsets
    /// of any existing field — keeps downstream byte-layout decoders
    /// (`percolator-match`, indexers) unaffected for fields they already read.
    pub cycle_duration: u64,
}

impl LockPosition {
    /// Account size: 8 (discriminator) + 32 + 32 + 8 + 8 + 8 + 8 + 1 + 1 + 1 + 8 = 115
    pub const SIZE: usize = 8 + 32 + 32 + 8 + 8 + 8 + 8 + 1 + 1 + 1 + 8;
}
