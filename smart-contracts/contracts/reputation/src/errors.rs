use soroban_sdk::contracterror;

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum Error {
    /// Contract has not been initialized.
    NotInitialized = 1,
    /// Contract has already been initialized.
    AlreadyInitialized = 2,
    /// The caller is not authorized to record outcomes.
    Unauthorized = 3,
    /// The rating value is out of range [0, 5].
    InvalidRating = 4,
    /// The agent has not been seen before (no reputation entry).
    AgentNotFound = 5,
    /// The authorized caller address is already registered.
    CallerAlreadyRegistered = 6,
    /// The authorized caller address was not found.
    CallerNotFound = 7,
}
