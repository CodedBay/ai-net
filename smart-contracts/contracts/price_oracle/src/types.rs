//! # Data Types for Price Oracle

use soroban_sdk::{contracttype, Address, Symbol};

pub const MAX_FEEDERS: u32 = 5;
pub const DEFAULT_MAX_LEDGER_AGE: u32 = 120; // 10 minutes at 5s/ledger
pub const AGGREGATION_WINDOW_SECS: u64 = 300; // 5-minute window
pub const MAX_DEVIATION_PCT: i128 = 10; // 10%

/// A single price submission by a specific feeder.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct FeederSubmission {
    pub feeder: Address,
    pub price: i128,
    pub timestamp: u64,
    pub ledger: u32,
}

/// A single price observation pushed by the authoritative feed provider.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PriceEntry {
    /// Price in stroops (8-decimal fixed point, e.g. 1 XLM = 10_000_000).
    pub price: i128,
    /// Unix timestamp (seconds) when this price was observed off-chain.
    pub timestamp: u64,
    /// Ledger sequence when this price entry was written.
    pub ledger: u32,
}

/// A price query result returned to callers.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PriceResult {
    /// Asset pair symbol (e.g. `XLM_USD`).
    pub pair: Symbol,
    /// Price in stroops.
    pub price: i128,
    /// Unix timestamp (seconds) of the feed observation.
    pub timestamp: u64,
}

/// Storage key enum for the Price Oracle contract.
#[contracttype]
#[derive(Clone)]
pub enum DataKey {
    /// Admin address (Instance storage).
    Admin,
    /// Maximum age in seconds before a price is considered stale (Instance storage).
    MaxPriceAge,
    /// Maximum age in ledgers before a price is considered stale (Instance storage).
    MaxLedgerAge,
    /// Registered feeder addresses (Instance storage, Vec<Address>).
    Feeders,
    /// Price entry for a given asset pair (Persistent storage).
    Price(Symbol),
    /// Active feeder submissions for an asset pair (Persistent storage, Vec<FeederSubmission>).
    Submissions(Symbol),
}

/// Event emitted when a new price is submitted or updated.
#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub struct PriceUpdatedEvent {
    pub version: u32,
    /// Asset pair that was updated.
    pub asset: Symbol,
    /// Submitted price in stroops.
    pub price: i128,
    /// Computed median price.
    pub median: i128,
    /// Number of active feeders contributing.
    pub num_feeders: u32,
    /// Ledger sequence.
    pub ledger: u32,
}

/// Event emitted when a feeder's price submission is rejected due to deviation.
#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub struct PriceDeviationRejectedEvent {
    pub version: u32,
    pub feeder: Address,
    pub submitted_price: i128,
    pub median: i128,
    pub deviation_pct: u32,
    pub ledger: u32,
}

/// Event emitted when the admin changes the maximum price age.
#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub struct MaxAgeUpdatedEvent {
    pub version: u32,
    /// Previous max age in seconds.
    pub old_max_age: u64,
    /// New max age in seconds.
    pub new_max_age: u64,
    pub ledger: u32,
}
