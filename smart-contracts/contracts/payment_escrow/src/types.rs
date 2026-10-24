//! Types for the payment escrow contract.

use soroban_sdk::{contracttype, Address, Symbol};

/// Lifecycle state of an escrow record.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum EscrowState {
    /// Funds are locked; waiting for task completion or timeout.
    Active,
    /// Funds have been released to the agent by the coordinator.
    Released,
    /// A dispute was raised; funds are held pending resolution.
    Disputed,
    /// Timeout elapsed with no release or dispute; funds returned to coordinator.
    Expired,
}

/// A single escrow record stored in Temporary storage.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct EscrowRecord {
    /// Task identifier (matches task_store).
    pub task_id: Symbol,
    /// Address that created the escrow and will receive funds on expiry.
    pub coordinator: Address,
    /// Agent performing the task; receives funds on release.
    pub agent: Address,
    /// Amount locked in escrow, in stroops.
    pub amount: i128,
    /// Ledger sequence at which the escrow auto-expires if not released or disputed.
    pub timeout_ledger: u32,
    /// Current lifecycle state.
    pub state: EscrowState,
    /// When disputed: the earliest ledger at which dispute_resolution may act.
    pub dispute_hold_until: Option<u32>,
}

// ─── Event types ─────────────────────────────────────────────────────────────

/// Emitted by `create_escrow`.
/// topic: `("escrow", "created")`
#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub struct EscrowCreatedEvent {
    pub task_id: Symbol,
    pub coordinator: Address,
    pub agent: Address,
    pub amount: i128,
    pub timeout_ledger: u32,
}

/// Emitted by `release_escrow`.
/// topic: `("escrow", "released")`
#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub struct EscrowReleasedEvent {
    pub task_id: Symbol,
    pub agent: Address,
    pub amount: i128,
}

/// Emitted by `dispute_escrow`.
/// topic: `("escrow", "disputed")`
#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub struct EscrowDisputedEvent {
    pub task_id: Symbol,
    pub caller: Address,
    pub dispute_hold_until: u32,
}

/// Emitted by `expire_escrow`.
/// topic: `("escrow", "expired")`
#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub struct EscrowExpiredEvent {
    pub task_id: Symbol,
    pub coordinator: Address,
    pub amount: i128,
}
