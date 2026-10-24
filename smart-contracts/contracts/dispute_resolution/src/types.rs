use soroban_sdk::{contracttype, Address, BytesN, String, Symbol};

/// Funded task payment held by this contract until dispute settlement.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct TaskEscrow {
    pub submitter: Address,
    pub agent: Address,
    pub asset: Address,
    pub amount: i128,
    pub task_completed_at: u64,
    pub disputed: bool,
    pub settled: bool,
}

/// A vote cast by an arbiter.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
#[repr(u32)]
pub enum Vote {
    Approve = 0,
    Reject = 1,
}

/// Resolution outcome.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
#[repr(u32)]
pub enum Resolution {
    /// Dispute approved — release payment to agent.
    Approve = 0,
    /// Dispute rejected — refund to submitter.
    Reject = 1,
}

/// Dispute lifecycle status.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
#[repr(u32)]
pub enum DisputeStatus {
    Open = 0,
    Resolved = 1,
}

/// A single dispute record stored on-chain.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct DisputeRecord {
    pub dispute_id: u64,
    pub task_id: Symbol,
    pub submitter: Address,
    pub evidence_hash: BytesN<32>,
    pub reason: String,
    pub status: DisputeStatus,
    pub raised_at: u64,
    pub voting_deadline: u64,
    /// 0 = Approve, 1 = Reject
    pub approve_votes: u32,
    pub reject_votes: u32,
    /// Resolution: None until resolved.
    pub resolution: Option<Resolution>,
    /// The timestamp when the disputed task was completed.
    pub task_completed_at: u64,
}

/// Event emitted when a dispute is raised.
#[contracttype]
#[derive(Clone)]
pub struct DisputeRaisedEvent {
    pub dispute_id: u64,
    pub task_id: Symbol,
    pub submitter: Address,
    pub evidence_hash: BytesN<32>,
}

/// Event emitted when an arbiter votes.
#[contracttype]
#[derive(Clone)]
pub struct DisputeVotedEvent {
    pub dispute_id: u64,
    pub arbiter: Address,
    pub vote: Vote,
}

/// Event emitted when a dispute is resolved.
#[contracttype]
#[derive(Clone)]
pub struct DisputeResolvedEvent {
    pub dispute_id: u64,
    pub resolution: Resolution,
    pub approve_votes: u32,
    pub reject_votes: u32,
}
