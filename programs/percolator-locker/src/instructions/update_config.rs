use anchor_lang::prelude::*;

use crate::error::LockerError;
use crate::instructions::initialize_vault::{MAX_LOCK_DURATION, MIN_LOCK_DURATION};
use crate::state::LockVault;

/// Minimum seconds that must elapse between successive successful
/// `update_config` calls for the same vault. Enforced against
/// `vault.last_config_update` to prevent rapid-fire config churn that
/// could destabilize the tier economy even under a multisig admin.
/// 7 days = 7 * 24 * 60 * 60 = 604,800 seconds.
///
/// Exported via `#[constant]` so downstream clients (indexers, app UI)
/// can derive "earliest next reconfig" timings from the IDL instead of
/// hardcoding 604_800 across repos.
#[constant]
pub const CONFIG_UPDATE_COOLDOWN_SECS: i64 = 7 * 24 * 60 * 60;

/// Lets the vault admin adjust `lock_duration` and the three tier
/// thresholds. Every argument is `Option<u64>` — admin passes `None` for
/// fields they want to leave alone, so partial updates are first-class.
///
/// Guards enforced (in this order):
/// - At least one arg must be `Some` (fires `EmptyConfigUpdate` otherwise).
///   An all-None call would still advance `last_config_update` and burn the
///   cooldown slot for zero state change — rejecting it closes a silent-DoS
///   footgun against the legitimate admin under a compromised-key scenario.
/// - `has_one = admin` on the accounts struct (admin must be the signer
///   recorded at init).
/// - Cooldown: `now - vault.last_config_update >= CONFIG_UPDATE_COOLDOWN_SECS`.
///   Fires `ConfigCooldownActive` otherwise. The first call after init is
///   always allowed because `last_config_update` starts at 0.
/// - Per-threshold magnitude cap: for each tier that's being changed,
///   `|new - old| <= (old / 2).max(1)`. A call that tries to move a threshold
///   by more than 50% of its current value fires `ConfigChangeOverLimit`. The
///   `.max(1)` floors the cap at 1 so a threshold stuck at 1 is not frozen
///   forever by integer-division truncating `1 / 2` to 0.
///   `lock_duration` has no per-call cap (MIN/MAX bounds are sufficient).
/// - `lock_duration` bounds: final value in `[MIN_LOCK_DURATION, MAX_LOCK_DURATION]`.
/// - Tier invariants on the FINAL state: `bronze > 0`, `bronze < silver < gold`.
///
/// Existing `LockPosition`s are immune to config changes by design: each
/// position's `tier` and `cycle_duration` are snapshotted at lock time
/// and never re-derived from the vault. A successful `update_config`
/// only influences FUTURE locks.
pub fn handler(
    ctx: Context<UpdateConfig>,
    new_lock_duration: Option<u64>,
    new_tier_bronze: Option<u64>,
    new_tier_silver: Option<u64>,
    new_tier_gold: Option<u64>,
) -> Result<()> {
    // Guard: reject calls that supply no field changes. A fully-None call
    // would still advance last_config_update and burn the 7-day cooldown
    // slot while changing nothing on-chain — giving a stolen admin key a
    // silent DoS against the legitimate admin's next reconfiguration.
    require!(
        new_lock_duration.is_some()
            || new_tier_bronze.is_some()
            || new_tier_silver.is_some()
            || new_tier_gold.is_some(),
        LockerError::EmptyConfigUpdate
    );

    // Cache current state and keys before taking any mutable borrow.
    let now = Clock::get()?.unix_timestamp;
    let last_update = ctx.accounts.vault.last_config_update;
    let old_lock_duration = ctx.accounts.vault.lock_duration;
    let old_bronze = ctx.accounts.vault.tier_bronze;
    let old_silver = ctx.accounts.vault.tier_silver;
    let old_gold = ctx.accounts.vault.tier_gold;
    let vault_key = ctx.accounts.vault.key();
    let admin_key = ctx.accounts.admin.key();

    // Guard: cooldown. checked_sub guards against i64 underflow if
    // last_config_update somehow exceeded now (not reachable in the current
    // program since init hard-codes 0, but defensive).
    let elapsed = now
        .checked_sub(last_update)
        .ok_or(error!(LockerError::ArithmeticOverflow))?;
    require!(
        elapsed >= CONFIG_UPDATE_COOLDOWN_SECS,
        LockerError::ConfigCooldownActive
    );

    // Guard: per-threshold magnitude cap. Applied only to fields that are
    // actually being changed. abs_diff avoids the unsigned-subtraction
    // underflow concern on u64. The `.max(1)` floors the cap at 1 base unit
    // so a threshold whose current value is 1 is not permanently frozen by
    // integer-division truncating `1 / 2` to 0 — a theoretical footgun if
    // an admin ever initialized or decayed a threshold to 1. Larger values
    // are unaffected because `.max(1)` is a no-op above old = 1.
    if let Some(new_bronze) = new_tier_bronze {
        require!(
            new_bronze.abs_diff(old_bronze) <= (old_bronze / 2).max(1),
            LockerError::ConfigChangeOverLimit
        );
    }
    if let Some(new_silver) = new_tier_silver {
        require!(
            new_silver.abs_diff(old_silver) <= (old_silver / 2).max(1),
            LockerError::ConfigChangeOverLimit
        );
    }
    if let Some(new_gold) = new_tier_gold {
        require!(
            new_gold.abs_diff(old_gold) <= (old_gold / 2).max(1),
            LockerError::ConfigChangeOverLimit
        );
    }

    // Compute final state (new values where supplied, old values otherwise).
    let final_lock_duration = new_lock_duration.unwrap_or(old_lock_duration);
    let final_bronze = new_tier_bronze.unwrap_or(old_bronze);
    let final_silver = new_tier_silver.unwrap_or(old_silver);
    let final_gold = new_tier_gold.unwrap_or(old_gold);

    // Guard: lock_duration bounds (same bounds initialize_vault enforces).
    require!(
        final_lock_duration >= MIN_LOCK_DURATION,
        LockerError::LockDurationTooShort
    );
    require!(
        final_lock_duration <= MAX_LOCK_DURATION,
        LockerError::LockDurationTooLong
    );

    // Guard: tier ordering and positivity on the FINAL state.
    require!(final_bronze > 0, LockerError::InvalidTierThresholds);
    require!(
        final_silver > final_bronze,
        LockerError::InvalidTierThresholds
    );
    require!(
        final_gold > final_silver,
        LockerError::InvalidTierThresholds
    );

    // Apply writes. total_locked, total_lockers, admin, token_mint,
    // vault_token_account, token_decimals, and bump are deliberately NOT
    // touched — config changes must not corrupt accounting or move the
    // vault's custody/identity.
    let vault = &mut ctx.accounts.vault;
    vault.lock_duration = final_lock_duration;
    vault.tier_bronze = final_bronze;
    vault.tier_silver = final_silver;
    vault.tier_gold = final_gold;
    vault.last_config_update = now;

    emit!(ConfigUpdated {
        vault: vault_key,
        admin: admin_key,
        lock_duration: final_lock_duration,
        tier_bronze: final_bronze,
        tier_silver: final_silver,
        tier_gold: final_gold,
        timestamp: now,
    });

    Ok(())
}

/// Emitted on every successful `update_config` call. Carries the FULL
/// resulting config (not just the changed fields) so indexers can
/// reconstruct the vault's state without a cross-reference lookup.
#[event]
pub struct ConfigUpdated {
    pub vault: Pubkey,
    pub admin: Pubkey,
    /// Final lock_duration after the update.
    pub lock_duration: u64,
    /// Final tier_bronze after the update.
    pub tier_bronze: u64,
    /// Final tier_silver after the update.
    pub tier_silver: u64,
    /// Final tier_gold after the update.
    pub tier_gold: u64,
    /// The unix_timestamp the update was applied at — stamped into
    /// `vault.last_config_update` in the same tx.
    pub timestamp: i64,
}

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
