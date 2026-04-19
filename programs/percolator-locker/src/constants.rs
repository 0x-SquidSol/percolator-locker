use anchor_lang::prelude::*;

/// PDA seed for an admin's LockVault: `[LOCK_VAULT_SEED, admin.key()]`.
/// Exported via `#[constant]` so downstream consumers (percolator-match,
/// percolator-app) can read the bytes from the generated IDL instead of
/// duplicating the string literal across repos.
#[constant]
pub const LOCK_VAULT_SEED: &[u8] = b"lock_vault";

/// PDA seed for a user's LockPosition: `[LOCK_POSITION_SEED, vault.key(), user.key()]`.
/// Same cross-repo rationale as `LOCK_VAULT_SEED`.
#[constant]
pub const LOCK_POSITION_SEED: &[u8] = b"lock_position";
