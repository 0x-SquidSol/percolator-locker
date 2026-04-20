use anchor_lang::prelude::*;

use crate::constants::LOCK_POSITION_SEED;
use crate::state::{LockPosition, LockVault};

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
