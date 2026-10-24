use soroban_sdk::contracterror;

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum Error {
    /// The contract has not been initialized yet.
    NotInitialized = 1,
    /// The contract has already been initialized and cannot be re-initialized.
    AlreadyInitialized = 2,
    /// The caller is not the admin.
    Unauthorized = 3,
    /// `platform_fee_bps` exceeds 10_000 (100 %).
    InvalidPlatformFee = 4,
    /// `escrow_timeout_days` is zero.
    InvalidEscrowTimeout = 5,
    /// `max_capabilities_per_agent` is zero.
    InvalidCapabilityLimit = 6,
    /// The multi-sig admin list is empty.
    InvalidMultisigConfig = 7,
    /// `threshold` is zero or exceeds the number of admins.
    InvalidThreshold = 8,
    /// Timelock has not elapsed yet.
    TimelockNotElapsed = 9,
    /// No pending fee change exists.
    NoPendingFeeChange = 10,
}
