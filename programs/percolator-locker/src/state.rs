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
    /// Lock duration in seconds (default: 2,592,000 = 30 days)
    pub lock_duration: i64,
    /// Minimum tokens required for Bronze tier
    pub tier_bronze: u64,
    /// Minimum tokens required for Silver tier
    pub tier_silver: u64,
    /// Minimum tokens required for Gold tier
    pub tier_gold: u64,
    /// Number of active lock positions
    pub total_lockers: u64,
    /// PDA bump seed
    pub bump: u8,
}

impl LockVault {
    /// Account size: 8 (discriminator) + 32 + 32 + 32 + 8 + 8 + 8 + 8 + 8 + 8 + 1 = 153
    pub const SIZE: usize = 8 + 32 + 32 + 32 + 8 + 8 + 8 + 8 + 8 + 8 + 1;
}
