//! # Error Types for Price Oracle

use soroban_sdk::contracterror;

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum Error {
    /// Contract has not been initialized.
    NotInitialized = 1,
    /// Caller is not the admin.
    Unauthorized = 2,
    /// Contract has already been initialized.
    AlreadyInitialized = 3,
    /// No price feed exists for the requested asset pair.
    FeedNotFound = 4,
    /// The stored price is older than the configured `max_price_age`.
    PriceStale = 5,
    /// The submitted price is zero or negative.
    InvalidPrice = 6,
    /// The submitted timestamp is in the future or otherwise invalid.
    InvalidTimestamp = 7,
    /// Caller is not a registered price feeder.
    FeederNotRegistered = 8,
    /// Maximum number of price feeders (5) reached.
    MaxFeedersExceeded = 9,
    /// Submitted price deviates more than 10% from current median.
    PriceDeviationTooHigh = 10,
    /// Feeder address is already registered.
    FeederAlreadyRegistered = 11,
}
