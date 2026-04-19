use anchor_lang::prelude::*;
use anchor_spl::token::{Mint, Token, TokenAccount};

use crate::constants::LOCK_POSITION_SEED;
use crate::state::{LockPosition, LockVault};

#[derive(Accounts)]
pub struct Lock<'info> {
    /// The user locking tokens — signs the transaction and pays rent for the new LockPosition
    #[account(mut)]
    pub user: Signer<'info>,

    /// The vault holding tier configuration; has_one pins token_mint and vault_token_account
    /// to the exact pubkeys recorded at vault init, preventing account substitution attacks
    #[account(
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
