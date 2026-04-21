use anchor_lang::prelude::*;

use crate::constants::LOCK_POSITION_SEED;
use crate::error::LockerError;
use crate::state::{LockPosition, LockVault, Tier};

/// Extends an active lock by another cycle without moving any tokens. Resets
/// `lock_end` to `now + cycle_duration` and advances `discount_end` by the
/// same amount, so a continuous locker who refreshes on time keeps their
/// earned-discount runway equal to one cycle ahead of their unlock date.
///
/// The advance comes from `lock_position.cycle_duration` — snapshotted at
/// lock time — NEVER from `vault.lock_duration`. If a future `update_config`
/// bumps the vault's duration, existing positions that refresh still advance
/// by the value they were created with, preserving user consent.
///
/// Guards enforced:
/// - `is_active` (via `PositionNotActive`): a position already retired by
///   `unlock` cannot be refreshed back into service.
/// - `now >= lock_end` (via `LockNotExpired`): the current cycle must have
///   elapsed before the user can commit to the next one.
/// - `now < discount_end` (via `DiscountLapsed`): the earned-discount window
///   must still be live. If the user waited so long that their discount
///   already expired, a naive advance would leave `discount_end < new_lock_end`
///   — locking tokens for no discount. Make them unlock + re-lock fresh
///   instead of silently stranding them.
pub fn handler(ctx: Context<RefreshLock>) -> Result<()> {
    // Guard: position must currently hold tokens (not retired by unlock).
    require!(
        ctx.accounts.lock_position.is_active,
        LockerError::PositionNotActive
    );

    // Guard: the current lock cycle must have elapsed. Clock::get() is
    // validator-provided — never trust a user-supplied timestamp.
    let now = Clock::get()?.unix_timestamp;
    require!(
        now >= ctx.accounts.lock_position.lock_end,
        LockerError::LockNotExpired
    );

    // Guard: the earned-discount window must still be active. Protects the
    // invariant `new_discount_end > new_lock_end` after this handler runs.
    require!(
        now < ctx.accounts.lock_position.discount_end,
        LockerError::DiscountLapsed
    );

    // Cache fields for the event emit before taking the &mut borrow below.
    let owner = ctx.accounts.lock_position.owner;
    let vault_key = ctx.accounts.vault.key();
    let amount = ctx.accounts.lock_position.amount;
    let tier = ctx.accounts.lock_position.tier;
    let lock_start = ctx.accounts.lock_position.lock_start;
    let cycle_duration_u64 = ctx.accounts.lock_position.cycle_duration;

    // Cast the position's snapshotted cycle_duration (u64) to i64 for timestamp
    // arithmetic. try_from is defensive — only fails if cycle_duration > i64::MAX,
    // which initialize_vault's MAX_LOCK_DURATION cap keeps unreachable, and no
    // handler ever rewrites cycle_duration once it is set at lock time.
    let cycle_duration_i64 = i64::try_from(cycle_duration_u64)
        .map_err(|_| error!(LockerError::ArithmeticOverflow))?;

    let new_lock_end = now
        .checked_add(cycle_duration_i64)
        .ok_or(error!(LockerError::ArithmeticOverflow))?;
    let new_discount_end = ctx
        .accounts
        .lock_position
        .discount_end
        .checked_add(cycle_duration_i64)
        .ok_or(error!(LockerError::ArithmeticOverflow))?;

    // Apply: advance lock_end and discount_end. Leave amount, tier,
    // cycle_duration, owner, vault, lock_start, is_active, and bump untouched.
    // No token transfer. No vault counter changes (the user was locked before
    // and is still locked after — total_locked and total_lockers do not move).
    let lock_position = &mut ctx.accounts.lock_position;
    lock_position.lock_end = new_lock_end;
    lock_position.discount_end = new_discount_end;

    emit!(Refreshed {
        user: owner,
        vault: vault_key,
        amount,
        tier,
        lock_start,
        lock_end: new_lock_end,
        discount_end: new_discount_end,
        cycle_duration: cycle_duration_u64,
    });

    Ok(())
}

/// Emitted on every successful `refresh_lock`. Carries the same 8-field
/// shape as `Locked` so indexers can treat the two events symmetrically —
/// each represents a commitment that re-anchors `lock_end` and extends
/// `discount_end` by one cycle. As with `Locked`, the `vault` field is the
/// canonicality pin — consumers MUST filter on a specific vault pubkey
/// rather than trusting the program ID alone.
#[event]
pub struct Refreshed {
    pub user: Pubkey,
    pub vault: Pubkey,
    pub amount: u64,
    pub tier: Tier,
    /// The position's ORIGINAL `lock_start` — refresh does not modify it, so
    /// this stays pinned to the timestamp of the user's first lock.
    pub lock_start: i64,
    /// The NEW `lock_end` after the refresh (= now + cycle_duration).
    pub lock_end: i64,
    /// The NEW `discount_end` after the refresh (= old discount_end + cycle_duration).
    pub discount_end: i64,
    /// The position's snapshotted cycle duration — identical to the value
    /// emitted on `Locked`, repeated here so indexers do not need to cross-
    /// reference event streams to reconstruct the advance math.
    pub cycle_duration: u64,
}

/// Accounts required by the `refresh_lock` instruction.
///
/// Refresh extends an existing lock by another cycle without moving any
/// tokens — the user keeps their position open, advances `lock_end` and
/// `discount_end`, and continues earning the matcher fee discount with no
/// gap. Because no SPL transfer happens, this struct intentionally omits
/// the token program and both token accounts; the absence is the point.
///
/// The advance amount comes from `lock_position.cycle_duration` (snapshotted
/// at lock time), NOT from `vault.lock_duration`. This keeps any later
/// admin `update_config` change from silently extending an existing
/// locker's commitment when they refresh.
#[derive(Accounts)]
pub struct RefreshLock<'info> {
    /// The lock position owner requesting the refresh — signs the transaction.
    /// Not mut: no lamports debited (no init, no close, no rent delta).
    pub owner: Signer<'info>,

    /// The vault this position belongs to. Not mut: refresh does not change
    /// `total_locked` or `total_lockers` — the user remains locked through
    /// this same vault, just for another cycle. Required in the struct only
    /// so the `lock_position` PDA derivation has a vault key to bind against
    /// and so `lock_position`'s `has_one = vault` can be enforced.
    pub vault: Account<'info, LockVault>,

    /// The user's existing lock position. mut because the handler advances
    /// `lock_end` and `discount_end`. Seeds + stored bump re-derive the
    /// canonical PDA; `has_one = vault` and `has_one = owner` defend against
    /// cross-vault and cross-user tampering, since seeds are only checked at
    /// init time — subsequent mutations deserialize by address alone without
    /// explicit has_one. `cycle_duration` and `tier` on this account are the
    /// source of truth for the refresh — never re-read from the vault.
    #[account(
        mut,
        seeds = [LOCK_POSITION_SEED, vault.key().as_ref(), owner.key().as_ref()],
        bump = lock_position.bump,
        has_one = vault,
        has_one = owner,
    )]
    pub lock_position: Account<'info, LockPosition>,
}
