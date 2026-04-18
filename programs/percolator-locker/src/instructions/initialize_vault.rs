use anchor_lang::prelude::*;
use anchor_spl::token::{Mint, Token, TokenAccount};

use crate::state::LockVault;

#[derive(Accounts)]
pub struct InitializeVault<'info> {
    /// The admin who will own this vault — must sign the transaction
    #[account(mut)]
    pub admin: Signer<'info>,

    /// The vault PDA — created here, stores all vault config and counters
    #[account(
        init,
        payer = admin,
        space = LockVault::SIZE,
        seeds = [b"lock_vault", admin.key().as_ref()],
        bump,
    )]
    pub vault: Account<'info, LockVault>,

    /// The token account that will hold all locked tokens — owned by the vault PDA
    #[account(
        init,
        payer = admin,
        token::mint = token_mint,
        token::authority = vault,
    )]
    pub vault_token_account: Account<'info, TokenAccount>,

    /// The Percolator token mint — read to verify mint and get decimals
    pub token_mint: Account<'info, Mint>,

    /// Standard Solana programs needed for account creation
    pub system_program: Program<'info, System>,
    pub token_program: Program<'info, Token>,
}
