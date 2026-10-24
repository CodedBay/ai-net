use soroban_sdk::contracterror;

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum Error {
    /// Contract has not been initialized.
    NotInitialized = 1,
    /// Contract has already been initialized.
    AlreadyInitialized = 2,
    /// Caller is not a registered signer.
    NotSigner = 3,
    /// Caller has already approved this proposal.
    AlreadyApproved = 4,
    /// Proposal does not exist.
    ProposalNotFound = 5,
    /// Proposal has already been executed.
    AlreadyExecuted = 6,
    /// Proposal has expired (past its expiry timestamp).
    ProposalExpired = 7,
    /// Timelock has not elapsed yet; proposal cannot be executed.
    TimelockNotElapsed = 8,
    /// Not enough approvals to execute.
    InsufficientApprovals = 9,
    /// Threshold is invalid (0 or exceeds signer count).
    InvalidThreshold = 10,
    /// Signer list is empty.
    InvalidSignerList = 11,
    /// Proposal title or description is empty.
    EmptyMetadata = 12,
    /// Attempted to approve a proposal that has been cancelled.
    ProposalCancelled = 13,
    /// Only the proposer may cancel a proposal.
    Unauthorized = 14,
    /// A signer has already voted on this proposal.
    AlreadyVoted = 15,
    /// The proposal has reached the rejection threshold.
    ProposalRejected = 16,
}
