use anchor_lang::prelude::*;

use crate::state::LockVault;

/// Accounts required by the `update_config` instruction.
///
/// `update_config` lets the vault admin adjust `lock_duration` and the
/// three tier thresholds on the vault after initialization. Existing
/// lock positions are unaffected by config changes — `cycle_duration` and
/// `tier` are snapshotted onto each `LockPosition` at lock time, so an
/// admin re-tuning the vault's current values only influences FUTURE
/// locks, never retroactively extends or re-classifies what existing
/// lockers agreed to.
///
/// No token accounts, no token program — this instruction only mutates
/// vault fields. Intentionally narrow surface.
#[derive(Accounts)]
pub struct UpdateConfig<'info> {
    /// The vault admin — must match `vault.admin`, enforced via `has_one`.
    /// Signer only, no lamport delta (no rent change, no close).
    pub admin: Signer<'info>,

    /// The vault whose config is being updated. `mut` because the handler
    /// writes `lock_duration`, `tier_bronze`, `tier_silver`, `tier_gold`,
    /// and `last_config_update`. `has_one = admin` binds the signer to
    /// the admin recorded at initialize_vault time — prevents any signer
    /// other than the recorded admin from mutating vault config.
    ///
    /// Deliberately NO `has_one = token_mint` or `has_one = vault_token_account`:
    /// those accounts are not passed in this struct since update_config does
    /// not touch the mint or the vault's token account. Their values on the
    /// vault are write-once at init and no handler mutates them, so re-pinning
    /// here would be pure ceremony.
    #[account(
        mut,
        has_one = admin,
    )]
    pub vault: Account<'info, LockVault>,
}
