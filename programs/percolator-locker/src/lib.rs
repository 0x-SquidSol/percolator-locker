use anchor_lang::prelude::*;

pub mod constants;
pub mod error;
pub mod instructions;
pub mod state;

pub use instructions::initialize_vault::*;
pub use instructions::lock::*;
pub use instructions::refresh_lock::*;
pub use instructions::unlock::*;
pub use instructions::update_config::*;

declare_id!("91JU1rmiLAPNcmC9Kew8cCXTRGFW1Pe67ZreijUia5S8");

#[program]
pub mod percolator_locker {
    use super::*;

    pub fn initialize_vault(
        ctx: Context<InitializeVault>,
        lock_duration: u64,
        tier_bronze: u64,
        tier_silver: u64,
        tier_gold: u64,
    ) -> Result<()> {
        crate::instructions::initialize_vault::handler(
            ctx,
            lock_duration,
            tier_bronze,
            tier_silver,
            tier_gold,
        )
    }

    pub fn lock(ctx: Context<Lock>, amount: u64) -> Result<()> {
        crate::instructions::lock::handler(ctx, amount)
    }

    pub fn unlock(ctx: Context<Unlock>) -> Result<()> {
        crate::instructions::unlock::handler(ctx)
    }

    pub fn refresh_lock(ctx: Context<RefreshLock>) -> Result<()> {
        crate::instructions::refresh_lock::handler(ctx)
    }

    pub fn update_config(
        ctx: Context<UpdateConfig>,
        new_lock_duration: Option<u64>,
        new_tier_bronze: Option<u64>,
        new_tier_silver: Option<u64>,
        new_tier_gold: Option<u64>,
    ) -> Result<()> {
        crate::instructions::update_config::handler(
            ctx,
            new_lock_duration,
            new_tier_bronze,
            new_tier_silver,
            new_tier_gold,
        )
    }
}
