use anchor_lang::prelude::*;
use anchor_spl::token::{self, Mint, Token, TokenAccount, TransferChecked};

use crate::constants::LOCK_POSITION_SEED;
use crate::error::LockerError;
use crate::state::{LockPosition, LockVault, Tier};

/// Opens a new lock position: transfers `amount` into the vault, classifies
/// the earned tier, and computes the earned-discount window. Each lock cycle
/// earns a discount of equal duration applied AFTER the lock ends — encoded
/// as `discount_end = lock_end + lock_duration`. A user who locks for N
/// seconds receives the fee discount for N additional seconds once their
/// tokens become withdrawable.
pub fn handler(ctx: Context<Lock>, amount: u64) -> Result<()> {
    // Input validation — reject zero and below-Bronze amounts before doing any work.
    require!(amount > 0, LockerError::InvalidAmount);
    require!(
        amount >= ctx.accounts.vault.tier_bronze,
        LockerError::BelowMinimumTier
    );

    // Timestamps come from the on-chain clock, never from user input.
    // i64 arithmetic via checked_add guards against overflow at extreme lock_duration values.
    let now = Clock::get()?.unix_timestamp;
    let cycle_duration = ctx.accounts.vault.lock_duration;
    let lock_duration = i64::try_from(cycle_duration)
        .map_err(|_| error!(LockerError::ArithmeticOverflow))?;
    let lock_end = now
        .checked_add(lock_duration)
        .ok_or(error!(LockerError::ArithmeticOverflow))?;
    let discount_end = lock_end
        .checked_add(lock_duration)
        .ok_or(error!(LockerError::ArithmeticOverflow))?;

    // Classify the earned tier using the vault's configured thresholds.
    let tier = ctx.accounts.vault.calculate_tier(amount);

    // Move tokens: user_token_account -> vault_token_account. SPL Token enforces balance
    // and authority checks; on failure the whole transaction rolls back atomically.
    // transfer_checked revalidates the mint + decimals on every transfer, catching
    // account-substitution bugs that plain `transfer` would let through.
    token::transfer_checked(
        CpiContext::new(
            ctx.accounts.token_program.to_account_info(),
            TransferChecked {
                from: ctx.accounts.user_token_account.to_account_info(),
                mint: ctx.accounts.token_mint.to_account_info(),
                to: ctx.accounts.vault_token_account.to_account_info(),
                authority: ctx.accounts.user.to_account_info(),
            },
        ),
        amount,
        ctx.accounts.vault.token_decimals,
    )?;

    // Cache pubkeys for both the LockPosition write and the event emit.
    let owner = ctx.accounts.user.key();
    let vault_key = ctx.accounts.vault.key();
    let position_bump = ctx.bumps.lock_position;

    // Populate every LockPosition field unconditionally — no stale fields possible since
    // this handler only runs on the first-ever lock (init guard at the accounts struct).
    let lock_position = &mut ctx.accounts.lock_position;
    lock_position.owner = owner;
    lock_position.vault = vault_key;
    lock_position.amount = amount;
    lock_position.lock_start = now;
    lock_position.lock_end = lock_end;
    lock_position.discount_end = discount_end;
    lock_position.tier = tier;
    lock_position.is_active = true;
    lock_position.bump = position_bump;
    // Snapshot the vault's current lock_duration onto the position. refresh_lock
    // reads THIS value, not the vault's live duration, so admin config changes
    // can never retroactively extend an existing locker's commitment.
    lock_position.cycle_duration = cycle_duration;

    // Update aggregate counters with checked math.
    let vault = &mut ctx.accounts.vault;
    vault.total_locked = vault
        .total_locked
        .checked_add(amount)
        .ok_or(error!(LockerError::ArithmeticOverflow))?;
    vault.total_lockers = vault
        .total_lockers
        .checked_add(1)
        .ok_or(error!(LockerError::ArithmeticOverflow))?;

    emit!(Locked {
        user: owner,
        vault: vault_key,
        amount,
        tier,
        lock_start: now,
        lock_end,
        discount_end,
        cycle_duration,
    });

    Ok(())
}

/// Emitted on every successful `lock`.
///
/// The `vault` field is the canonicality pin: because `initialize_vault` is
/// permissionless, this program emits `Locked` events from every `LockVault`
/// that exists under its ID. Event consumers MUST filter on a specific
/// canonical vault pubkey — filtering by program ID alone admits spoof
/// events from uncontrolled vaults. See `LockVault` for the full rationale.
#[event]
pub struct Locked {
    pub user: Pubkey,
    pub vault: Pubkey,
    pub amount: u64,
    pub tier: Tier,
    pub lock_start: i64,
    pub lock_end: i64,
    pub discount_end: i64,
    /// Cycle duration (seconds) snapshotted from `vault.lock_duration` at lock
    /// time. Emitted on the event so indexers can reconstruct `refresh_lock`
    /// math without re-reading vault state.
    pub cycle_duration: u64,
}

#[derive(Accounts)]
pub struct Lock<'info> {
    /// The user locking tokens — signs the transaction and pays rent for the new LockPosition
    #[account(mut)]
    pub user: Signer<'info>,

    /// The vault holding tier configuration; has_one pins token_mint and vault_token_account
    /// to the exact pubkeys recorded at vault init, preventing account substitution attacks.
    /// mut because the handler increments total_locked and total_lockers.
    #[account(
        mut,
        has_one = token_mint,
        has_one = vault_token_account,
    )]
    pub vault: Account<'info, LockVault>,

    /// The user's lock position — init for first-ever lock (re-lock after unlock is a
    /// separate instruction that uses mut + is_active == false guard, by design to avoid
    /// init_if_needed)
    #[account(
        init,
        payer = user,
        space = LockPosition::SIZE,
        seeds = [LOCK_POSITION_SEED, vault.key().as_ref(), user.key().as_ref()],
        bump,
    )]
    pub lock_position: Account<'info, LockPosition>,

    /// Source of tokens — must be owned by the user and hold the vault's mint
    #[account(
        mut,
        token::mint = token_mint,
        token::authority = user,
    )]
    pub user_token_account: Account<'info, TokenAccount>,

    /// Destination — PDA-owned token account, pinned via vault's has_one above
    #[account(mut)]
    pub vault_token_account: Account<'info, TokenAccount>,

    /// The Percolator mint — pinned via vault's has_one above
    pub token_mint: Account<'info, Mint>,

    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}
