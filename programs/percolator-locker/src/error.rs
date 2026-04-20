use anchor_lang::prelude::*;

#[error_code]
pub enum LockerError {
    // === Permission errors ===
    #[msg("Only the vault admin can perform this action")]
    Unauthorized,

    #[msg("This lock position does not belong to you")]
    NotOwner,

    // === Lock state errors ===
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
    #[msg("The lock position does not belong to this vault")]
    VaultMismatch,

    #[msg("Token mint does not match the vault's configured mint")]
    WrongTokenMint,

    #[msg("Vault token account does not match the vault's stored account")]
    WrongVaultTokenAccount,

    // === Math errors ===
    #[msg("An arithmetic operation overflowed or underflowed")]
    ArithmeticOverflow,

    #[msg("The earned-discount window has already lapsed — unlock and re-lock instead of refreshing")]
    DiscountLapsed,

    // NOTE: append-only. Anchor auto-numbers variants by declaration position
    // (starting at 6000), so inserting mid-enum shifts every subsequent code
    // and breaks any client pinned to a specific numeric error. New variants
    // MUST go here at the end, even if they belong semantically with an
    // existing section above.
}
