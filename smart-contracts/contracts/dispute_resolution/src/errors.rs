use soroban_sdk::contracterror;

#[contracterror]
#[derive(Clone, Debug, Copy, Eq, PartialEq)]
#[repr(u32)]
pub enum Error {
    /// Contract has not been initialized.
    NotInitialized = 1,
    /// Contract is paused.
    ContractPaused = 2,
    /// Record already exists.
    AlreadyExists = 3,
    /// Record not found.
    NotFound = 4,
    /// Caller is not authorized.
    Unauthorized = 5,
    /// Caller is not a configured arbiter.
    NotArbiter = 6,
    /// Arbiter has already voted on this dispute.
    AlreadyVoted = 7,
    /// Voting period is still active (cannot resolve yet) or has expired (cannot vote).
    VotingPeriodActive = 8,
    /// Dispute is already resolved.
    AlreadyResolved = 9,
    /// Dispute was raised outside the 24-hour window after task completion.
    RaisedTooLate = 10,
    /// No arbiters are configured.
    NoArbiters = 11,
    /// Insufficient votes to resolve.
    InsufficientVotes = 12,
    /// The arbiter committee must contain five distinct addresses.
    InvalidArbiterSet = 13,
    /// No funded escrow exists for the task, or its submitter does not match.
    InvalidTaskEscrow = 14,
    /// Escrow amount must be positive.
    InvalidEscrowAmount = 15,
    /// Task completion time cannot be in the future.
    TaskNotCompleted = 16,
    /// Timestamp or dispute id arithmetic overflowed.
    ArithmeticOverflow = 17,
    /// The task already has a dispute.
    DisputeAlreadyRaised = 18,
    /// Task funds have already been settled.
    EscrowAlreadySettled = 19,
}
