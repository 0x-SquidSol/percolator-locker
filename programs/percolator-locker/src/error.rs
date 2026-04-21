use anchor_lang::prelude::*;

#[error_code]
pub enum LockerError {
    // === Permission errors ===
    /// Reserved. Anchor `has_one = admin` surfaces first.
    #[msg("Only the vault admin can perform this action")]
    Unauthorized,

    /// Reserved. Anchor `has_one = owner` on lock_position surfaces first.
    #[msg("This lock position does not belong to you")]
    NotOwner,

    // === Lock state errors ===
    /// Reserved. Anchor `init` on lock_position surfaces first (system-program: account already in use).
    #[msg("You already have an active lock — unlock first to start a new one")]
    PositionAlreadyActive,

    #[msg("No active lock position to operate on")]
    PositionNotActive,

    #[msg("The lock period has not expired yet")]
    LockNotExpired,

    // === Amount errors ===
    #[msg("Lock amount must be greater than zero")]
    InvalidAmount,

    #[msg("Lock amount is below the minimum Bronze tier threshold — no discount would be earned")]
    BelowMinimumTier,

    // === Config validation errors ===
    #[msg("Tier thresholds must be positive and in ascending order (bronze < silver < gold)")]
    InvalidTierThresholds,

    #[msg("Lock duration must be at least the minimum allowed")]
    LockDurationTooShort,

    #[msg("Lock duration exceeds the maximum allowed")]
    LockDurationTooLong,

    // === Account mismatch errors ===
    /// Reserved. Anchor `has_one = vault` on lock_position surfaces first.
    #[msg("The lock position does not belong to this vault")]
    VaultMismatch,

    /// Reserved. Anchor `has_one = token_mint` on vault surfaces first.
    #[msg("Token mint does not match the vault's configured mint")]
    WrongTokenMint,

    /// Reserved. Anchor `has_one = vault_token_account` on vault surfaces first.
    #[msg("Vault token account does not match the vault's stored account")]
    WrongVaultTokenAccount,

    // === Math errors ===
    #[msg("An arithmetic operation overflowed or underflowed")]
    ArithmeticOverflow,

    #[msg("The earned-discount window has already lapsed — unlock and re-lock instead of refreshing")]
    DiscountLapsed,

    #[msg("Config update rejected: minimum cooldown between successive update_config calls has not elapsed")]
    ConfigCooldownActive,

    #[msg("Config update rejected: requested threshold change exceeds the per-call magnitude cap")]
    ConfigChangeOverLimit,

    #[msg("Config update rejected: at least one field must be supplied — an empty call would burn the cooldown for no state change")]
    EmptyConfigUpdate,

    #[msg("Tier bronze threshold is below the minimum allowed floor")]
    TierBronzeBelowMinimum,

    // NOTE: append-only. Anchor auto-numbers variants by declaration position
    // (starting at 6000), so inserting mid-enum shifts every subsequent code
    // and breaks any client pinned to a specific numeric error. New variants
    // MUST go here at the end, even if they belong semantically with an
    // existing section above.
}
