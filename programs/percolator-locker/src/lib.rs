use anchor_lang::prelude::*;

pub mod error;
pub mod instructions;
pub mod state;

declare_id!("91JU1rmiLAPNcmC9Kew8cCXTRGFW1Pe67ZreijUia5S8");

#[program]
pub mod percolator_locker {
    use super::*;
}
