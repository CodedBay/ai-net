//! Error codes for the payment escrow contract.

use soroban_sdk::contracterror;

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum Error {
    /// Contract already initialized.
    AlreadyInitialized = 1,
    /// Caller is not authorized for this operation.
    Unauthorized = 2,
    /// Escrow record not found for the given task_id.
    NotFound = 3,
    /// An escrow with this task_id already exists.
    AlreadyExists = 4,
    /// Amount must be positive.
    InvalidAmount = 5,
    /// timeout_ledger must be in the future.
    InvalidTimeout = 6,
    /// Escrow has already been released.
    AlreadyReleased = 7,
    /// Escrow is in Disputed state; use dispute_resolution contract.
    EscrowDisputed = 8,
    /// Escrow has already expired.
    AlreadyExpired = 9,
    /// Escrow is in Expired state; funds have been returned.
    EscrowExpired = 10,
    /// timeout_ledger has not been reached yet.
    NotYetExpired = 11,
    /// Escrow is already in Disputed state.
    AlreadyDisputed = 12,
}
