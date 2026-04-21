use anchor_lang::prelude::*;
use anchor_spl::token::{Mint, Token, TokenAccount};

use crate::constants::LOCK_VAULT_SEED;
use crate::error::LockerError;
use crate::state::LockVault;

/// Minimum allowed lock duration: 1 day in seconds
pub(crate) const MIN_LOCK_DURATION: u64 = 86_400;

/// Maximum allowed lock duration: 1 year in seconds (prevents unreasonable lock periods)
pub(crate) const MAX_LOCK_DURATION: u64 = 31_536_000;

/// Minimum allowed Bronze tier threshold, in token base units. Rejects
/// pathologically small init configs (e.g. `(1, 2, 3)`) that would make
/// Gold tier essentially free — a fat-finger admin would otherwise need
/// ~32 weeks of 7-day-spaced `update_config` calls to climb back to a
/// realistic floor, since the 50% per-call cap only allows 1.5x weekly
/// growth. Silver and Gold inherit this floor through the existing
/// strict-ascending ordering checks.
pub(crate) const MIN_TIER_BRONZE: u64 = 1_000;

pub fn handler(
    ctx: Context<InitializeVault>,
    lock_duration: u64,
    tier_bronze: u64,
    tier_silver: u64,
    tier_gold: u64,
) -> Result<()> {
    // Validate lock duration bounds
    require!(
        lock_duration >= MIN_LOCK_DURATION,
        LockerError::LockDurationTooShort
    );
    require!(
        lock_duration <= MAX_LOCK_DURATION,
        LockerError::LockDurationTooLong
    );

    // Validate tier thresholds: bronze above floor, strictly ascending.
    // The floor catches fat-finger inits (e.g. `(1, 2, 3)`); silver and gold
    // inherit the floor via the ordering checks below.
    require!(
        tier_bronze >= MIN_TIER_BRONZE,
        LockerError::TierBronzeBelowMinimum
    );
    require!(tier_silver > tier_bronze, LockerError::InvalidTierThresholds);
    require!(tier_gold > tier_silver, LockerError::InvalidTierThresholds);

    let vault = &mut ctx.accounts.vault;

    vault.admin = ctx.accounts.admin.key();
    vault.token_mint = ctx.accounts.token_mint.key();
    vault.vault_token_account = ctx.accounts.vault_token_account.key();
    vault.lock_duration = lock_duration;
    vault.tier_bronze = tier_bronze;
    vault.tier_silver = tier_silver;
    vault.tier_gold = tier_gold;
    vault.total_locked = 0;
    vault.total_lockers = 0;
    vault.token_decimals = ctx.accounts.token_mint.decimals;
    vault.bump = ctx.bumps.vault;
    // Initialize to 0 so the first `update_config` call is unrestricted by the
    // cooldown guard (admin may want to tune parameters once before traffic
    // arrives). Every successful `update_config` stamps this with the current
    // clock, enforcing the minimum cooldown thereafter.
    vault.last_config_update = 0;

    Ok(())
}

#[derive(Accounts)]
pub struct InitializeVault<'info> {
    /// The admin who will own this vault — must sign the transaction
    #[account(mut)]
    pub admin: Signer<'info>,

    /// The vault PDA — created here, stores all vault config and counters
    #[account(
        init,
        payer = admin,
        space = LockVault::SIZE,
        seeds = [LOCK_VAULT_SEED, admin.key().as_ref()],
        bump,
    )]
    pub vault: Account<'info, LockVault>,

    /// The token account that will hold all locked tokens — owned by the vault PDA
    #[account(
        init,
        payer = admin,
        token::mint = token_mint,
        token::authority = vault,
    )]
    pub vault_token_account: Account<'info, TokenAccount>,

    /// The Percolator token mint — read to verify mint and get decimals
    pub token_mint: Account<'info, Mint>,

    /// Standard Solana programs needed for account creation
    pub system_program: Program<'info, System>,
    pub token_program: Program<'info, Token>,
}
