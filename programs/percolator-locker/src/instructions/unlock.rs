use anchor_lang::prelude::*;
use anchor_spl::token::{Mint, Token, TokenAccount};

use crate::constants::LOCK_POSITION_SEED;
use crate::state::{LockPosition, LockVault};

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
