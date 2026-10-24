//! # Governance and Vote Types
//!
//! Core data structures for the Agent Governance contract: agent stake records,
//! governance proposals, individual vote records, storage keys, and every event
//! payload emitted during the proposal lifecycle.
//!
//! ## Proposal Lifecycle
//!
//! ```text
//! create_proposal  →  vote_on_proposal (For | Against | Abstain)  →  execute_proposal
//!       ↓                                                                 ↓
//!    [Active] ──────────────────────────────────────────────→  [Executed] | [Failed]
//! ```
//!
//! ## Voting Power
//!
//! An agent's voting power is weighted by **both** its reputation score and its
//! staked amount:
//!
//! ```text
//! voting_power = stake + reputation * REPUTATION_POWER_UNIT
//! ```
//!
//! The electorate's total voting power is snapshotted into each proposal at
//! creation time, so quorum is measured against a stable denominator.
//!
//! ## Passing Rules
//!
//! * **Quorum** — the power of all cast votes (For + Against + Abstain) must be
//!   at least [`QUORUM_BPS`] (30 %) of the snapshotted total voting power.
//! * **Majority** — For votes must be strictly more than [`MAJORITY_BPS`]
//!   (50 %) of the *decisive* votes (For + Against; abstentions excluded).
//!
//! ## Event Catalogue
//!
//! | Function            | topic[1]     | Data                    |
//! |--------------------|---------------|-------------------------|
//! | `create_proposal`  | `created`     | `ProposalCreatedEvent`  |
//! | `vote_on_proposal` | `vote_cast`   | `VoteCastEvent`         |
//! | `execute_proposal` | `executed`    | `ProposalExecutedEvent` |
//! | `execute_proposal` | `failed`      | `ProposalFailedEvent`   |

use soroban_sdk::{contracttype, Address, String, Symbol, Vec};

// ─── Constants ───────────────────────────────────────────────────────────────

/// Default voting period in ledger-seconds (7 days).
pub const DEFAULT_VOTING_PERIOD_SECS: u64 = 604_800;

/// Minimum configurable voting period (1 hour) — guards against instant votes.
pub const MIN_VOTING_PERIOD_SECS: u64 = 3_600;

/// Maximum configurable voting period (30 days).
pub const MAX_VOTING_PERIOD_SECS: u64 = 2_592_000;

/// Maximum allowed reputation score (percentage scale).
pub const MAX_REPUTATION: u32 = 100;

/// Basis-point denominator (100 % == 10_000 bps).
pub const BPS_DENOMINATOR: i128 = 10_000;

/// Quorum requirement: at least 30 % of total voting power must vote.
pub const QUORUM_BPS: i128 = 3_000;

/// Default voting period in ledgers (10,080 ledgers / ~7 days).
pub const DEFAULT_VOTING_PERIOD_LEDGERS: u32 = 10_080;

/// Default quorum threshold in basis points (10% = 1,000 bps).
pub const DEFAULT_QUORUM_THRESHOLD_BPS: i128 = 1_000;

/// Majority requirement: strictly more than 50 % of decisive votes.
pub const MAJORITY_BPS: i128 = 5_000;

/// Voting-power contribution of a single reputation point, expressed in the
/// same unit as `stake` (stroops). One reputation point == 0.1 XLM of weight.
pub const REPUTATION_POWER_UNIT: i128 = 1_000_000;

/// Compute an agent's voting power from its stake and reputation score.
pub fn voting_power(stake: i128, reputation: u32) -> i128 {
    stake.saturating_add((reputation as i128).saturating_mul(REPUTATION_POWER_UNIT))
}

// ─── Agent stake records ─────────────────────────────────────────────────────

/// On-chain record for a registered agent stakeholder.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AgentInfo {
    /// The agent's address.
    pub agent: Address,
    /// Reputation score in `[0, 100]`.
    pub reputation: u32,
    /// Staked amount in stroops.
    pub stake: i128,
    /// Derived voting power (`voting_power(stake, reputation)`), cached.
    pub power: i128,
}

// ─── Proposals ───────────────────────────────────────────────────────────────

/// Category of a governance proposal.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
#[repr(u32)]
pub enum ProposalType {
    /// A change to a tunable protocol parameter.
    ParameterChange = 0,
    /// A dispute between agents to be adjudicated by the electorate.
    AgentDispute = 1,
    /// An upgrade to protocol contract code / logic.
    ProtocolUpgrade = 2,
}

/// Lifecycle state of a proposal.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
#[repr(u32)]
pub enum ProposalStatus {
    /// Voting is open.
    Active = 0,
    /// Voting closed, quorum + majority met — the proposal passed.
    Executed = 1,
    /// Voting closed, majority not met — the proposal failed.
    Failed = 2,
    /// Voting closed, quorum not met.
    QuorumFailed = 3,
}

/// The three vote options.
#[contracttype]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
#[repr(u32)]
pub enum VoteChoice {
    For = 0,
    Against = 1,
    Abstain = 2,
}

/// On-chain governance proposal record.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Proposal {
    /// Monotonic proposal identifier (starts at 1).
    pub id: u64,
    /// Address that created the proposal (a registered agent).
    pub proposer: Address,
    /// Proposal category.
    pub proposal_type: ProposalType,
    /// Short human-readable title.
    pub title: String,
    /// Free-form description / rationale.
    pub description: String,
    /// Ledger timestamp when the proposal was created.
    pub created_at: u64,
    /// Ledger timestamp after which voting is closed.
    pub voting_ends_at: u64,
    /// Current lifecycle state.
    pub status: ProposalStatus,
    /// Accumulated voting power that voted `For`.
    pub for_power: i128,
    /// Accumulated voting power that voted `Against`.
    pub against_power: i128,
    /// Accumulated voting power that voted `Abstain`.
    pub abstain_power: i128,
    /// Total electorate voting power at creation time (quorum denominator).
    pub total_power_snapshot: i128,
    /// Ledger sequence when voting starts (Issue #408).
    pub voting_start_ledger: u32,
    /// Ledger sequence when voting ends (Issue #408).
    pub voting_end_ledger: u32,
}

/// A single agent's vote on a proposal.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct VoteRecord {
    pub proposal_id: u64,
    pub voter: Address,
    pub choice: VoteChoice,
    /// Voting power applied to this vote (snapshotted at vote time).
    pub weight: i128,
}

// ─── Storage keys ────────────────────────────────────────────────────────────

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum DataKey {
    /// The governance admin address.
    Admin,
    /// Aggregate voting power of every registered agent.
    TotalPower,
    /// Monotonic proposal counter.
    ProposalCount,
    /// [`AgentInfo`] for a given agent address.
    Agent(Address),
    /// [`Proposal`] record by id.
    Proposal(u64),
    /// [`VoteRecord`] for a given (proposal, voter) pair.
    Vote(u64, Address),
    /// Platform config address (Issue #408).
    PlatformConfig,
    /// Configured voting period in ledgers.
    VotingPeriodLedgers,
    /// Configured quorum threshold in basis points.
    QuorumThresholdBps,
}

// ─── Event payloads ──────────────────────────────────────────────────────────

/// Emitted when `create_proposal` records a new proposal.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ProposalCreatedEvent {
    pub id: u64,
    pub proposer: Address,
    pub proposal_type: ProposalType,
    pub voting_ends_at: u64,
    pub total_power_snapshot: i128,
}

/// Emitted when `vote_on_proposal` records a vote.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct VoteCastEvent {
    pub proposal_id: u64,
    pub voter: Address,
    pub choice: VoteChoice,
    pub weight: i128,
}

/// Emitted when `execute_proposal` finalises a proposal that passed.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ProposalExecutedEvent {
    pub id: u64,
    pub for_power: i128,
    pub against_power: i128,
    pub abstain_power: i128,
}

/// Emitted when voting starts on a proposal (Issue #408).
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct VotingStartedEvent {
    pub proposal_id: u64,
    pub proposer: Address,
    pub voting_start_ledger: u32,
    pub voting_end_ledger: u32,
}

/// Emitted when proposal quorum is reached (Issue #408).
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct QuorumReachedEvent {
    pub proposal_id: u64,
    pub total_voted: i128,
}

/// Emitted when proposal quorum fails (Issue #408).
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct QuorumFailedEvent {
    pub proposal_id: u64,
    pub total_voted: i128,
    pub quorum_needed: i128,
}

/// Emitted when `execute_proposal` finalises a proposal that failed.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ProposalFailedEvent {
    pub id: u64,
    /// Whether the quorum threshold was met.
    pub quorum_met: bool,
    /// Whether the majority threshold was met.
    pub majority_met: bool,
    pub for_power: i128,
    pub against_power: i128,
    pub abstain_power: i128,
}

// ─── Timelock constants ───────────────────────────────────────────────────────

/// Default minimum delay in ledgers before a proposed change can be executed
/// (~4 days at 5 s/ledger: 48 ledgers for testnet convenience; production
/// deployments should pass a higher value to `initialize_timelock`).
pub const MIN_DELAY_LEDGERS: u32 = 48;

/// Maximum TTL in ledgers for a pending change stored in Temporary storage.
/// If the change is not executed or cancelled within this window it expires
/// automatically and a fresh proposal must be submitted.
pub const CHANGE_EXPIRY_LEDGERS: u32 = 200;

/// Minimum number of guardian approvals required for an emergency fast-track
/// execution that bypasses the timelock delay.
pub const DEFAULT_GUARDIAN_THRESHOLD: u32 = 3;

/// Recommended guardian set size (3-of-5 default).
pub const DEFAULT_GUARDIAN_SET_SIZE: u32 = 5;

// ─── Timelock storage keys ────────────────────────────────────────────────────

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum TimelockKey {
    /// Minimum delay configured at deploy time (overrides `MIN_DELAY_LEDGERS`).
    MinDelay,
    /// Monotonic counter for pending change ids.
    ChangeCount,
    /// Guardian multi-sig configuration.
    GuardianConfig,
    /// Pending change record (Temporary storage).
    PendingChange(u32),
    /// Guardian approval for a given change (Temporary storage).
    GuardianApproval(u32, Address),
}

// ─── Timelock types ───────────────────────────────────────────────────────────

/// A guardian set that can fast-track execution via M-of-N approval.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct GuardianConfig {
    /// The set of trusted guardian addresses.
    pub guardians: Vec<Address>,
    /// Minimum approvals required to emergency-execute a change.
    pub threshold: u32,
}

/// A pending parameter-change proposal stored in Temporary storage.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PendingChange {
    /// Monotonic identifier.
    pub id: u32,
    /// The protocol parameter being changed (e.g. `Symbol::new(&env, "fee_rate")`).
    pub parameter: Symbol,
    /// The address that proposed the change (admin or guardian).
    pub proposer: Address,
    /// Ledger sequence number at or after which the change may be executed normally.
    pub execute_after_ledger: u32,
    /// Whether the change has been executed.
    pub executed: bool,
    /// Whether the change has been cancelled.
    pub cancelled: bool,
    /// Number of guardian approvals received for emergency fast-track.
    pub guardian_approvals: u32,
}

// ─── Timelock event payloads ──────────────────────────────────────────────────

/// Emitted by `propose_change`.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ChangeProposedEvent {
    pub change_id: u32,
    pub parameter: Symbol,
    pub proposer: Address,
    pub execute_after_ledger: u32,
}

/// Emitted by `execute_change`.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ChangeExecutedEvent {
    pub change_id: u32,
    pub parameter: Symbol,
    pub executor: Address,
    pub emergency: bool,
}

/// Emitted by `cancel_change`.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ChangeCancelledEvent {
    pub change_id: u32,
    pub parameter: Symbol,
    pub canceller: Address,
}

/// Emitted by `guardian_approve`.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct GuardianApprovalEvent {
    pub change_id: u32,
    pub guardian: Address,
    pub total_approvals: u32,
}
