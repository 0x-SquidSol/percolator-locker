use anchor_lang::prelude::*;
use anchor_spl::token::{Mint, Token, TokenAccount};

use crate::constants::LOCK_VAULT_SEED;
use crate::error::LockerError;
use crate::state::LockVault;

/// Minimum allowed lock duration: 1 day in seconds
pub(crate) const MIN_LOCK_DURATION: u64 = 86_400;

/// Maximum allowed lock duration: 1 year in seconds (prevents unreasonable lock periods)
pub(crate) const MAX_LOCK_DURATION: u64 = 31_536_000;

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

    // Validate tier thresholds: all positive and strictly ascending
    require!(tier_bronze > 0, LockerError::InvalidTierThresholds);
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
