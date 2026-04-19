use anchor_lang::prelude::*;
use anchor_spl::token::{self, Mint, Token, TokenAccount, Transfer};

use crate::constants::{LOCK_POSITION_SEED, LOCK_VAULT_SEED};
use crate::error::LockerError;
use crate::state::{LockPosition, LockVault, Tier};

/// Returns the user's locked tokens once the 30-day cycle has elapsed and marks
/// the position inactive while preserving `tier` and `discount_end` — the matcher
/// reads those fields for the earned-discount window that runs `lock_duration`
/// past `lock_end`.
pub fn handler(ctx: Context<Unlock>) -> Result<()> {
    // Guard: the position must currently hold tokens. This blocks replayed
    // unlocks against an already-retired position.
    require!(
        ctx.accounts.lock_position.is_active,
        LockerError::PositionNotActive
    );

    // Guard: the lock window must have elapsed. Clock::get() is validator-provided;
    // a user-supplied timestamp would be a trivial bypass.
    let now = Clock::get()?.unix_timestamp;
    require!(
        now >= ctx.accounts.lock_position.lock_end,
        LockerError::LockNotExpired
    );

    // Cache everything we need AFTER the CPI and state writes, BEFORE any &mut
    // borrow is taken. Pubkey and primitive fields are Copy.
    let amount = ctx.accounts.lock_position.amount;
    let owner = ctx.accounts.owner.key();
    let vault_key = ctx.accounts.vault.key();
    let vault_admin = ctx.accounts.vault.admin;
    let vault_bump = ctx.accounts.vault.bump;
    let tier = ctx.accounts.lock_position.tier;
    let lock_start = ctx.accounts.lock_position.lock_start;
    let lock_end = ctx.accounts.lock_position.lock_end;
    let discount_end = ctx.accounts.lock_position.discount_end;

    // Move tokens vault -> user via SPL Token CPI. The vault PDA is the
    // authority on vault_token_account (pinned at initialize_vault time), so
    // we sign as that PDA using its stored seeds + canonical bump.
    let signer_seeds: &[&[&[u8]]] = &[&[
        LOCK_VAULT_SEED,
        vault_admin.as_ref(),
        &[vault_bump],
    ]];
    token::transfer(
        CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            Transfer {
                from: ctx.accounts.vault_token_account.to_account_info(),
                to: ctx.accounts.user_token_account.to_account_info(),
                authority: ctx.accounts.vault.to_account_info(),
            },
            signer_seeds,
        ),
        amount,
    )?;

    // Retire the position: zero the amount, flip the flag. Keep tier,
    // discount_end, owner, vault, lock_start, lock_end, and bump untouched —
    // the matcher needs tier + discount_end readable until discount_end elapses.
    let lock_position = &mut ctx.accounts.lock_position;
    lock_position.amount = 0;
    lock_position.is_active = false;

    // Decrement vault counters with checked math. `checked_sub` returns None on
    // underflow; we map that to `ArithmeticOverflow` by existing convention
    // (the error variant covers both overflow and underflow failure modes).
    let vault = &mut ctx.accounts.vault;
    vault.total_locked = vault
        .total_locked
        .checked_sub(amount)
        .ok_or(error!(LockerError::ArithmeticOverflow))?;
    vault.total_lockers = vault
        .total_lockers
        .checked_sub(1)
        .ok_or(error!(LockerError::ArithmeticOverflow))?;

    emit!(Unlocked {
        user: owner,
        vault: vault_key,
        amount,
        tier,
        lock_start,
        lock_end,
        discount_end,
    });

    Ok(())
}

#[event]
pub struct Unlocked {
    pub user: Pubkey,
    pub vault: Pubkey,
    pub amount: u64,
    pub tier: Tier,
    pub lock_start: i64,
    pub lock_end: i64,
    pub discount_end: i64,
}

#[derive(Accounts)]
pub struct Unlock<'info> {
    /// The lock position owner requesting withdrawal — signs the transaction.
    /// Not mut: no lamports debited (no init, no close, no rent delta).
    pub owner: Signer<'info>,

    /// The vault holding tier configuration; mut because the handler decrements
    /// `total_locked` and `total_lockers`. has_one pins the mint and the vault's
    /// token account to the exact pubkeys recorded at init.
    #[account(
        mut,
        has_one = token_mint,
        has_one = vault_token_account,
    )]
    pub vault: Account<'info, LockVault>,

    /// The user's existing lock position. mut because the handler sets is_active
    /// = false and zeroes amount (preserving tier and discount_end). Seeds +
    /// stored bump re-derive the canonical PDA; has_one = vault and has_one =
    /// owner defend against cross-vault and cross-user tampering, since seeds
    /// are only checked at init time — subsequent mutations deserialize by
    /// address alone without explicit has_one.
    #[account(
        mut,
        seeds = [LOCK_POSITION_SEED, vault.key().as_ref(), owner.key().as_ref()],
        bump = lock_position.bump,
        has_one = vault,
        has_one = owner,
    )]
    pub lock_position: Account<'info, LockPosition>,

    /// Destination — credited by the transfer. Must be owned by the caller and
    /// hold the vault's mint.
    #[account(
        mut,
        token::mint = token_mint,
        token::authority = owner,
    )]
    pub user_token_account: Account<'info, TokenAccount>,

    /// Source — PDA-owned token account, debited by the transfer. Pinned via
    /// the vault's has_one above, plus explicit token::mint defense-in-depth.
    #[account(
        mut,
        token::mint = token_mint,
    )]
    pub vault_token_account: Account<'info, TokenAccount>,

    /// The Percolator mint — pinned via the vault's has_one above.
    pub token_mint: Account<'info, Mint>,

    pub token_program: Program<'info, Token>,
}
