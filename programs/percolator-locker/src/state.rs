use anchor_lang::prelude::*;

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
}

impl LockVault {
    /// Account size: 8 (discriminator) + 32 + 32 + 32 + 8 + 8 + 8 + 8 + 8 + 8 + 1 + 1 = 154
    pub const SIZE: usize = 8 + 32 + 32 + 32 + 8 + 8 + 8 + 8 + 8 + 8 + 1 + 1;
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
    pub tier: u8,
    /// Whether the lock is currently active
    pub is_active: bool,
    /// PDA bump seed
    pub bump: u8,
}

impl LockPosition {
    /// Account size: 8 (discriminator) + 32 + 32 + 8 + 8 + 8 + 8 + 1 + 1 + 1 = 107
    pub const SIZE: usize = 8 + 32 + 32 + 8 + 8 + 8 + 8 + 1 + 1 + 1;
}
