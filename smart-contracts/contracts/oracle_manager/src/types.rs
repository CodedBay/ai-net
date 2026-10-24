//! # Data Types for Oracle Manager

use soroban_sdk::{contracttype, Address, Symbol};

/// The resolved price for a pair, including its provenance.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ResolvedPrice {
    /// The asset pair.
    pub pair: Symbol,
    /// Price in stroops.
    pub price: i128,
    /// How this price was obtained.
    pub source: PriceSource,
}

/// Provenance of a resolved price.
#[contracttype]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
#[repr(u32)]
pub enum PriceSource {
    /// Live price obtained from the registered on-chain oracle.
    Oracle = 0,
    /// Admin-set fallback used because no live oracle is configured.
    Fallback = 1,
    /// Price aggregated from multiple authorized feeders (median).
    Feeder = 2,
}

/// A single price submission from an authorized oracle feeder.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct FeederSubmission {
    /// The feeder's address.
    pub feeder: Address,
    /// Submitted price in stroops (8-decimal fixed point).
    pub price: i128,
    /// Unix timestamp of the observation (seconds).
    pub timestamp: u64,
}

/// Storage key enum for the Oracle Manager.
#[contracttype]
#[derive(Clone)]
pub enum DataKey {
    /// Admin address (Instance storage).
    Admin,
    /// Optional oracle contract address (Instance storage).
    OracleAddress,
    /// Admin-set fallback price per asset pair (Persistent storage).
    FallbackPrice(Symbol),
    /// List of authorized feeder addresses (Instance storage).
    AuthorizedFeeders,
    /// Latest price submission from a specific feeder (Persistent storage).
    FeederSubmission(Address),
}

/// Event emitted when the oracle address is changed.
#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub struct OracleSetEvent {
    /// The new oracle contract address.  `None` means the oracle was removed.
    pub oracle: Option<Address>,
}

/// Event emitted when a fallback price is set.
#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub struct FallbackPriceSetEvent {
    pub pair: Symbol,
    pub price: i128,
}

/// Event emitted when a price is resolved (live or fallback).
#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub struct PriceResolvedEvent {
    pub pair: Symbol,
    pub price: i128,
    pub source: PriceSource,
}

/// Event emitted when an authorized feeder submits a price.
#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub struct FeederPriceSubmittedEvent {
    pub feeder: Address,
    pub price: i128,
    pub timestamp: u64,
}

/// Event emitted when a feeder is added.
#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub struct FeederAddedEvent {
    pub feeder: Address,
}

/// Event emitted when a feeder is removed.
#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub struct FeederRemovedEvent {
    pub feeder: Address,
}
