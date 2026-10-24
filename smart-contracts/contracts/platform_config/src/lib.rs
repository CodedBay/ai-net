#![no_std]

//! # Platform Config Contract
//!
//! Stores platform-wide configurable parameters that can be updated by the
//! contract admin without requiring contract redeployment.
//!
//! ## Parameters
//!
//! | Name                    | Type | Description                                   |
//! |-------------------------|------|-----------------------------------------------|
//! | `min_stake_per_capability` | u64 | Minimum XLM stake (in stroops) per capability |
//! | `escrow_timeout_days`   | u32  | Days before an escrow times out               |
//! | `max_capabilities_per_agent` | u32 | Max capabilities an agent can register    |
//! | `platform_fee_bps`      | u32  | Platform fee in basis points (1 bps = 0.01 %) |
//!
//! ## Authorization
//!
//! Only the contract admin (set at `initialize`) can call `update_config`.
//! Multi-sig admin is supported via `set_multisig_admin`.
//!
//! ## Events
//!
//! Every successful `update_config` call emits a `(platform_cfg, cfg_upd)`
//! event carrying the `ConfigUpdatedEvent` payload.

mod errors;

pub use errors::Error;

use soroban_sdk::{
    contract, contractimpl, contracttype, symbol_short, Address, Env, Vec,
};

// ─── Default parameter values ─────────────────────────────────────────────────

/// Default minimum stake per capability: 1 XLM = 10_000_000 stroops.
pub const DEFAULT_MIN_STAKE_PER_CAPABILITY: u64 = 10_000_000;
/// Default escrow timeout in days.
pub const DEFAULT_ESCROW_TIMEOUT_DAYS: u32 = 7;
/// Default maximum capabilities per agent.
pub const DEFAULT_MAX_CAPABILITIES_PER_AGENT: u32 = 10;
/// Default platform fee in basis points (0 = no fee).
pub const DEFAULT_PLATFORM_FEE_BPS: u32 = 50; // 0.5 %
/// Default timelock: 48 hours in seconds.
pub const TIMELOCK_SECS: u64 = 172_800;
/// Default voting period in ledgers (10,080 ledgers / ~7 days).
pub const DEFAULT_VOTING_PERIOD_LEDGERS: u32 = 10_080;
/// Default quorum threshold in basis points (10% = 1,000 bps).
pub const DEFAULT_QUORUM_THRESHOLD_BPS: u32 = 1_000;

/// TTL extension threshold (ledgers remaining) — extend when below this.
const TTL_THRESHOLD: u32 = 50_000;
/// Target TTL after extension (14 days at 5 s/ledger: 241_920 ledgers).
const TTL_EXTEND_TO: u32 = 241_920;

// ─── Types ────────────────────────────────────────────────────────────────────

/// All configurable platform parameters, stored as a single value in
/// `Instance` storage so a single read fetches everything.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PlatformConfig {
    /// Minimum XLM stake (in stroops) required per capability registration.
    pub min_stake_per_capability: u64,
    /// Number of days before an open escrow is considered timed out.
    pub escrow_timeout_days: u32,
    /// Maximum number of capabilities a single agent may register.
    pub max_capabilities_per_agent: u32,
    /// Platform fee in basis points applied to each task payment.
    /// 1 bps = 0.01 %; 10_000 bps = 100 %.
    pub platform_fee_bps: u32,
}

impl PlatformConfig {
    /// Default parameter set applied on first initialization.
    pub fn defaults() -> Self {
        Self {
            min_stake_per_capability: DEFAULT_MIN_STAKE_PER_CAPABILITY,
            escrow_timeout_days: DEFAULT_ESCROW_TIMEOUT_DAYS,
            max_capabilities_per_agent: DEFAULT_MAX_CAPABILITIES_PER_AGENT,
            platform_fee_bps: DEFAULT_PLATFORM_FEE_BPS,
        }
    }
}

/// Event emitted on every successful `update_config` call.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ConfigUpdatedEvent {
    /// Admin address that performed the update.
    pub updated_by: Address,
    /// New platform configuration.
    pub new_config: PlatformConfig,
}

/// Pending platform fee change awaiting governance timelock.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PendingFeeChange {
    pub new_fee_bps: u32,
    pub proposed_at: u64,
    pub eta: u64,
}

/// Storage key enumeration for `Instance` storage.
#[contracttype]
#[derive(Clone)]
pub enum DataKey {
    /// The single admin address (mutually exclusive with `MultisigAdmins`).
    Admin,
    /// Multi-sig admin list; when present, replaces the single `Admin` key.
    MultisigAdmins,
    /// Multi-sig threshold — minimum approvals needed.
    MultisigThreshold,
    /// The current platform configuration struct.
    Config,
    /// Protocol treasury address receiving platform fees.
    Treasury,
    /// Pending platform fee change awaiting 48h timelock.
    PendingFeeChange,
    /// Cumulative platform fees recorded in stroops.
    TotalFeesCollected,
    /// Voting period in ledgers.
    VotingPeriodLedgers,
    /// Quorum threshold in basis points.
    QuorumThresholdBps,
    /// Threshold for specific multisig governance actions.
    ActionThreshold(soroban_sdk::Symbol),
}

// ─── Contract ────────────────────────────────────────────────────────────────

#[contract]
pub struct PlatformConfigContract;

// ─── Helpers ─────────────────────────────────────────────────────────────────

fn require_admin(env: &Env) -> Result<(), Error> {
    // Multi-sig path: the caller must supply auth from one of the multi-sig
    // admins.  We cannot check all of them atomically in a single call, so we
    // check the single admin key as a fallback first.
    if let Some(admin) = env
        .storage()
        .instance()
        .get::<DataKey, Address>(&DataKey::Admin)
    {
        admin.require_auth();
        return Ok(());
    }
    // No single admin configured — contract is uninitialised.
    Err(Error::NotInitialized)
}

fn is_multisig_admin(env: &Env, addr: &Address) -> bool {
    if let Some(admins) = env
        .storage()
        .instance()
        .get::<DataKey, Vec<Address>>(&DataKey::MultisigAdmins)
    {
        return admins.contains(addr);
    }
    false
}

fn validate_config(config: &PlatformConfig) -> Result<(), Error> {
    // platform_fee_bps must not exceed 100 % (10_000 bps).
    if config.platform_fee_bps > 10_000 {
        return Err(Error::InvalidPlatformFee);
    }
    // escrow_timeout_days must be at least 1.
    if config.escrow_timeout_days == 0 {
        return Err(Error::InvalidEscrowTimeout);
    }
    // max_capabilities_per_agent must be at least 1.
    if config.max_capabilities_per_agent == 0 {
        return Err(Error::InvalidCapabilityLimit);
    }
    Ok(())
}

fn read_config(env: &Env) -> PlatformConfig {
    env.storage()
        .instance()
        .get(&DataKey::Config)
        .unwrap_or_else(PlatformConfig::defaults)
}

// ─── Implementation ───────────────────────────────────────────────────────────

#[contractimpl]
impl PlatformConfigContract {
    // ── Initialization ────────────────────────────────────────────────────────

    /// Initialise the contract with `admin` as the sole admin.
    ///
    /// Sets default parameter values.  Callable exactly once.
    pub fn initialize(env: Env, admin: Address) -> Result<(), Error> {
        if env.storage().instance().has(&DataKey::Admin) {
            return Err(Error::AlreadyInitialized);
        }
        admin.require_auth();

        env.storage().instance().set(&DataKey::Admin, &admin);
        env.storage()
            .instance()
            .set(&DataKey::Config, &PlatformConfig::defaults());
        env.storage()
            .instance()
            .extend_ttl(TTL_THRESHOLD, TTL_EXTEND_TO);

        Ok(())
    }

    // ── Admin management ──────────────────────────────────────────────────────

    /// Replace the single admin address.  The current admin must authorise.
    pub fn set_admin(env: Env, new_admin: Address) -> Result<(), Error> {
        require_admin(&env)?;
        env.storage().instance().set(&DataKey::Admin, &new_admin);
        env.storage()
            .instance()
            .extend_ttl(TTL_THRESHOLD, TTL_EXTEND_TO);
        Ok(())
    }

    /// Configure a multi-sig admin list.
    ///
    /// After this call the contract accepts admin operations from any address
    /// in `admins`.  The `threshold` field is stored for informational purposes
    /// (off-chain governance tooling); on-chain enforcement of M-of-N approval
    /// is left to the calling governance contract.
    ///
    /// The current single admin must authorise this call.
    pub fn set_multisig_admin(
        env: Env,
        admins: Vec<Address>,
        threshold: u32,
    ) -> Result<(), Error> {
        require_admin(&env)?;

        if admins.is_empty() {
            return Err(Error::InvalidMultisigConfig);
        }
        if threshold == 0 || threshold > admins.len() {
            return Err(Error::InvalidThreshold);
        }

        env.storage()
            .instance()
            .set(&DataKey::MultisigAdmins, &admins);
        env.storage()
            .instance()
            .set(&DataKey::MultisigThreshold, &threshold);
        env.storage()
            .instance()
            .extend_ttl(TTL_THRESHOLD, TTL_EXTEND_TO);

        Ok(())
    }

    /// Return the current multi-sig admin list, if configured.
    pub fn get_multisig_admins(env: Env) -> Option<Vec<Address>> {
        env.storage()
            .instance()
            .get(&DataKey::MultisigAdmins)
    }

    // ── Configuration management ──────────────────────────────────────────────

    /// Update platform configuration.
    ///
    /// Only the single admin **or** a member of the multi-sig admin list may
    /// call this function.
    ///
    /// Emits `(platform_cfg, cfg_upd)` with a [`ConfigUpdatedEvent`] payload.
    pub fn update_config(env: Env, caller: Address, new_config: PlatformConfig) -> Result<(), Error> {
        // Check initialisation.
        if !env.storage().instance().has(&DataKey::Admin) {
            return Err(Error::NotInitialized);
        }

        // Authorise: single admin or multi-sig member.
        let single_admin: Option<Address> = env.storage().instance().get(&DataKey::Admin);
        let is_single_admin = single_admin.as_ref() == Some(&caller);
        let is_ms_admin = is_multisig_admin(&env, &caller);

        if !is_single_admin && !is_ms_admin {
            return Err(Error::Unauthorized);
        }

        // Require on-chain signature from the caller.
        caller.require_auth();

        // Validate the new parameters.
        validate_config(&new_config)?;

        // Persist.
        env.storage().instance().set(&DataKey::Config, &new_config);
        env.storage()
            .instance()
            .extend_ttl(TTL_THRESHOLD, TTL_EXTEND_TO);

        // Emit ConfigUpdated event.
        env.events().publish(
            (symbol_short!("plt_cfg"), symbol_short!("cfg_upd")),
            ConfigUpdatedEvent {
                updated_by: caller,
                new_config,
            },
        );

        Ok(())
    }

    // ── Query functions ───────────────────────────────────────────────────────

    /// Return the current platform configuration (all parameters).
    pub fn get_config(env: Env) -> PlatformConfig {
        read_config(&env)
    }

    /// Return a single parameter: `min_stake_per_capability`.
    pub fn get_min_stake_per_capability(env: Env) -> u64 {
        read_config(&env).min_stake_per_capability
    }

    /// Return a single parameter: `escrow_timeout_days`.
    pub fn get_escrow_timeout_days(env: Env) -> u32 {
        read_config(&env).escrow_timeout_days
    }

    /// Return a single parameter: `max_capabilities_per_agent`.
    pub fn get_max_capabilities_per_agent(env: Env) -> u32 {
        read_config(&env).max_capabilities_per_agent
    }

    /// Return a single parameter: `platform_fee_bps`.
    pub fn get_platform_fee_bps(env: Env) -> u32 {
        read_config(&env).platform_fee_bps
    }

    // ── Treasury & Platform Fee Governance (Issue #412) ──────────────────────

    /// Configure protocol treasury address to receive platform fees.
    pub fn set_treasury(env: Env, caller: Address, treasury: Address) -> Result<(), Error> {
        require_admin(&env)?;
        caller.require_auth();
        env.storage().instance().set(&DataKey::Treasury, &treasury);
        env.storage().instance().extend_ttl(TTL_THRESHOLD, TTL_EXTEND_TO);
        Ok(())
    }

    /// Query the configured treasury address.
    pub fn get_treasury(env: Env) -> Option<Address> {
        env.storage().instance().get(&DataKey::Treasury)
    }

    /// Propose a new platform fee with a mandatory 48-hour timelock.
    pub fn propose_fee_change(env: Env, caller: Address, new_fee_bps: u32) -> Result<u64, Error> {
        require_admin(&env)?;
        caller.require_auth();

        if new_fee_bps > 10_000 {
            return Err(Error::InvalidPlatformFee);
        }

        let now = env.ledger().timestamp();
        let eta = now.saturating_add(TIMELOCK_SECS);
        let pending = PendingFeeChange {
            new_fee_bps,
            proposed_at: now,
            eta,
        };

        env.storage().instance().set(&DataKey::PendingFeeChange, &pending);
        env.storage().instance().extend_ttl(TTL_THRESHOLD, TTL_EXTEND_TO);

        env.events().publish(
            (symbol_short!("plt_cfg"), symbol_short!("fee_prop")),
            (caller, new_fee_bps, eta),
        );

        Ok(eta)
    }

    /// Apply the pending platform fee change once the 48-hour timelock has elapsed.
    pub fn apply_fee_change(env: Env, caller: Address) -> Result<(), Error> {
        require_admin(&env)?;
        caller.require_auth();

        let pending: PendingFeeChange = env
            .storage()
            .instance()
            .get(&DataKey::PendingFeeChange)
            .ok_or(Error::NoPendingFeeChange)?;

        let now = env.ledger().timestamp();
        if now < pending.eta {
            return Err(Error::TimelockNotElapsed);
        }

        let mut config = read_config(&env);
        config.platform_fee_bps = pending.new_fee_bps;
        env.storage().instance().set(&DataKey::Config, &config);
        env.storage().instance().remove(&DataKey::PendingFeeChange);
        env.storage().instance().extend_ttl(TTL_THRESHOLD, TTL_EXTEND_TO);

        env.events().publish(
            (symbol_short!("plt_cfg"), symbol_short!("fee_app")),
            (caller, pending.new_fee_bps),
        );

        Ok(())
    }

    /// Cancel a pending platform fee change before it takes effect.
    pub fn cancel_fee_change(env: Env, caller: Address) -> Result<(), Error> {
        require_admin(&env)?;
        caller.require_auth();

        if !env.storage().instance().has(&DataKey::PendingFeeChange) {
            return Err(Error::NoPendingFeeChange);
        }

        env.storage().instance().remove(&DataKey::PendingFeeChange);
        env.storage().instance().extend_ttl(TTL_THRESHOLD, TTL_EXTEND_TO);
        Ok(())
    }

    /// View pending fee change if one is scheduled.
    pub fn get_pending_fee_change(env: Env) -> Option<PendingFeeChange> {
        env.storage().instance().get(&DataKey::PendingFeeChange)
    }

    /// Record fees collected across protocol executions.
    pub fn record_fee_collected(env: Env, fee_amount: i128) -> Result<(), Error> {
        if fee_amount <= 0 {
            return Ok(());
        }
        let current: i128 = env.storage().instance().get(&DataKey::TotalFeesCollected).unwrap_or(0);
        let updated = current.saturating_add(fee_amount);
        env.storage().instance().set(&DataKey::TotalFeesCollected, &updated);
        env.storage().instance().extend_ttl(TTL_THRESHOLD, TTL_EXTEND_TO);
        Ok(())
    }

    /// Query cumulative platform fees collected in stroops.
    pub fn get_total_fees_collected(env: Env) -> i128 {
        env.storage().instance().get(&DataKey::TotalFeesCollected).unwrap_or(0)
    }

    // ── Governance Configuration (Issue #408) ────────────────────────────────

    /// Configure governance proposal voting period in ledgers.
    pub fn set_voting_period_ledgers(env: Env, caller: Address, period: u32) -> Result<(), Error> {
        require_admin(&env)?;
        caller.require_auth();
        env.storage().instance().set(&DataKey::VotingPeriodLedgers, &period);
        env.storage().instance().extend_ttl(TTL_THRESHOLD, TTL_EXTEND_TO);
        Ok(())
    }

    /// Query voting period in ledgers (default: 10,080).
    pub fn get_voting_period_ledgers(env: Env) -> u32 {
        env.storage()
            .instance()
            .get(&DataKey::VotingPeriodLedgers)
            .unwrap_or(DEFAULT_VOTING_PERIOD_LEDGERS)
    }

    /// Configure governance proposal quorum threshold in basis points.
    pub fn set_quorum_threshold_bps(env: Env, caller: Address, bps: u32) -> Result<(), Error> {
        require_admin(&env)?;
        caller.require_auth();
        if bps > 10_000 {
            return Err(Error::InvalidPlatformFee); // reuse 10,000 max bound
        }
        env.storage().instance().set(&DataKey::QuorumThresholdBps, &bps);
        env.storage().instance().extend_ttl(TTL_THRESHOLD, TTL_EXTEND_TO);
        Ok(())
    }

    /// Query governance proposal quorum threshold in bps (default: 1,000 = 10%).
    pub fn get_quorum_threshold_bps(env: Env) -> u32 {
        env.storage()
            .instance()
            .get(&DataKey::QuorumThresholdBps)
            .unwrap_or(DEFAULT_QUORUM_THRESHOLD_BPS)
    }

    // ── Multisig Action Thresholds (Issue #416) ──────────────────────────────

    /// Configure M-of-N threshold requirement for a specific governance action type.
    pub fn set_action_threshold(
        env: Env,
        caller: Address,
        action_type: soroban_sdk::Symbol,
        threshold: u32,
    ) -> Result<(), Error> {
        require_admin(&env)?;
        caller.require_auth();
        if threshold == 0 {
            return Err(Error::InvalidThreshold);
        }
        env.storage()
            .instance()
            .set(&DataKey::ActionThreshold(action_type), &threshold);
        env.storage().instance().extend_ttl(TTL_THRESHOLD, TTL_EXTEND_TO);
        Ok(())
    }

    /// Query threshold requirement for a given action type.
    pub fn get_action_threshold(env: Env, action_type: soroban_sdk::Symbol) -> u32 {
        env.storage()
            .instance()
            .get(&DataKey::ActionThreshold(action_type))
            .unwrap_or(0)
    }
}

// ─── Tests ────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod test {
    use super::*;
    use soroban_sdk::{
        testutils::{Address as _, Events, Ledger as _},
        Address, Env, IntoVal,
    };

    struct Fixture {
        env: Env,
        client: PlatformConfigContractClient<'static>,
        admin: Address,
    }

    fn fixture() -> Fixture {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register(PlatformConfigContract, ());
        let client = PlatformConfigContractClient::new(&env, &contract_id);
        let admin = Address::generate(&env);
        client.initialize(&admin);
        Fixture { env, client, admin }
    }

    // ── Initialization ────────────────────────────────────────────────────────

    #[test]
    fn initialize_sets_defaults() {
        let f = fixture();
        let config = f.client.get_config();
        assert_eq!(config.min_stake_per_capability, DEFAULT_MIN_STAKE_PER_CAPABILITY);
        assert_eq!(config.escrow_timeout_days, DEFAULT_ESCROW_TIMEOUT_DAYS);
        assert_eq!(config.max_capabilities_per_agent, DEFAULT_MAX_CAPABILITIES_PER_AGENT);
        assert_eq!(config.platform_fee_bps, DEFAULT_PLATFORM_FEE_BPS);
    }

    #[test]
    fn double_initialize_rejected() {
        let f = fixture();
        let other = Address::generate(&f.env);
        assert_eq!(
            f.client.try_initialize(&other),
            Err(Ok(Error::AlreadyInitialized))
        );
    }

    // ── get_config ────────────────────────────────────────────────────────────

    #[test]
    fn get_config_returns_all_parameters() {
        let f = fixture();
        let config = f.client.get_config();
        assert_eq!(config.platform_fee_bps, DEFAULT_PLATFORM_FEE_BPS);
        assert_eq!(f.client.get_min_stake_per_capability(), config.min_stake_per_capability);
        assert_eq!(f.client.get_escrow_timeout_days(), config.escrow_timeout_days);
        assert_eq!(f.client.get_max_capabilities_per_agent(), config.max_capabilities_per_agent);
        assert_eq!(f.client.get_platform_fee_bps(), config.platform_fee_bps);
    }

    // ── update_config ─────────────────────────────────────────────────────────

    #[test]
    fn update_config_persists_new_values() {
        let f = fixture();
        let new_config = PlatformConfig {
            min_stake_per_capability: 20_000_000,
            escrow_timeout_days: 14,
            max_capabilities_per_agent: 5,
            platform_fee_bps: 100,
        };
        f.client.update_config(&f.admin, &new_config);

        let stored = f.client.get_config();
        assert_eq!(stored, new_config);
    }

    #[test]
    fn update_config_emits_event() {
        let f = fixture();
        let new_config = PlatformConfig {
            min_stake_per_capability: 5_000_000,
            escrow_timeout_days: 3,
            max_capabilities_per_agent: 20,
            platform_fee_bps: 25,
        };
        f.client.update_config(&f.admin, &new_config);

        let events = f.env.events().all();
        assert_eq!(events.len(), 1);
        assert_eq!(
            events.get(0).unwrap().1,
            (symbol_short!("plt_cfg"), symbol_short!("cfg_upd")).into_val(&f.env)
        );
    }

    #[test]
    fn unauthorized_update_rejected() {
        let f = fixture();
        let stranger = Address::generate(&f.env);
        let new_config = PlatformConfig {
            min_stake_per_capability: 1,
            escrow_timeout_days: 1,
            max_capabilities_per_agent: 1,
            platform_fee_bps: 0,
        };
        assert_eq!(
            f.client.try_update_config(&stranger, &new_config),
            Err(Ok(Error::Unauthorized))
        );
    }

    #[test]
    fn invalid_platform_fee_rejected() {
        let f = fixture();
        let bad_config = PlatformConfig {
            min_stake_per_capability: 1_000_000,
            escrow_timeout_days: 1,
            max_capabilities_per_agent: 1,
            platform_fee_bps: 10_001, // > 100 %
        };
        assert_eq!(
            f.client.try_update_config(&f.admin, &bad_config),
            Err(Ok(Error::InvalidPlatformFee))
        );
    }

    #[test]
    fn invalid_escrow_timeout_rejected() {
        let f = fixture();
        let bad_config = PlatformConfig {
            min_stake_per_capability: 1_000_000,
            escrow_timeout_days: 0, // must be >= 1
            max_capabilities_per_agent: 1,
            platform_fee_bps: 50,
        };
        assert_eq!(
            f.client.try_update_config(&f.admin, &bad_config),
            Err(Ok(Error::InvalidEscrowTimeout))
        );
    }

    #[test]
    fn invalid_capability_limit_rejected() {
        let f = fixture();
        let bad_config = PlatformConfig {
            min_stake_per_capability: 1_000_000,
            escrow_timeout_days: 7,
            max_capabilities_per_agent: 0, // must be >= 1
            platform_fee_bps: 50,
        };
        assert_eq!(
            f.client.try_update_config(&f.admin, &bad_config),
            Err(Ok(Error::InvalidCapabilityLimit))
        );
    }

    // ── Multi-sig admin ───────────────────────────────────────────────────────

    #[test]
    fn multisig_member_can_update_config() {
        let f = fixture();
        let ms_admin = Address::generate(&f.env);
        let mut admins = soroban_sdk::Vec::new(&f.env);
        admins.push_back(ms_admin.clone());
        f.client.set_multisig_admin(&admins, &1u32);

        let new_config = PlatformConfig {
            min_stake_per_capability: 3_000_000,
            escrow_timeout_days: 5,
            max_capabilities_per_agent: 8,
            platform_fee_bps: 75,
        };
        f.client.update_config(&ms_admin, &new_config);
        assert_eq!(f.client.get_config(), new_config);
    }

    #[test]
    fn non_multisig_member_cannot_update_after_multisig_configured() {
        let f = fixture();
        let ms_admin = Address::generate(&f.env);
        let mut admins = soroban_sdk::Vec::new(&f.env);
        admins.push_back(ms_admin.clone());
        f.client.set_multisig_admin(&admins, &1u32);

        let outsider = Address::generate(&f.env);
        let new_config = PlatformConfig {
            min_stake_per_capability: 1_000_000,
            escrow_timeout_days: 1,
            max_capabilities_per_agent: 1,
            platform_fee_bps: 0,
        };
        // Outsider is not the single admin and not in the multisig list.
        assert_eq!(
            f.client.try_update_config(&outsider, &new_config),
            Err(Ok(Error::Unauthorized))
        );
    }

    // ── Fee Governance & Timelock Tests (Issue #412) ──────────────────────────

    #[test]
    fn treasury_configuration() {
        let f = fixture();
        let treasury = Address::generate(&f.env);
        f.client.set_treasury(&f.admin, &treasury);
        assert_eq!(f.client.get_treasury(), Some(treasury));
    }

    #[test]
    fn fee_change_timelock_enforced() {
        let f = fixture();
        f.env.ledger().with_mut(|l| l.timestamp = 1_000_000);

        // Propose changing fee to 100 bps (1%)
        let eta = f.client.propose_fee_change(&f.admin, &100);
        assert_eq!(eta, 1_000_000 + TIMELOCK_SECS);

        // Trying to apply before timelock elapses must revert
        f.env.ledger().with_mut(|l| l.timestamp = 1_000_000 + 3600); // only 1 hour elapsed
        assert_eq!(
            f.client.try_apply_fee_change(&f.admin),
            Err(Ok(Error::TimelockNotElapsed))
        );

        // Advance past timelock (48 hours + 1 second)
        f.env.ledger().with_mut(|l| l.timestamp = 1_000_000 + TIMELOCK_SECS + 1);
        f.client.apply_fee_change(&f.admin);

        assert_eq!(f.client.get_platform_fee_bps(), 100);
        assert_eq!(f.client.get_pending_fee_change(), None);
    }

    #[test]
    fn zero_fee_configuration_supported() {
        let f = fixture();
        f.env.ledger().with_mut(|l| l.timestamp = 1_000_000);
        f.client.propose_fee_change(&f.admin, &0);
        f.env.ledger().with_mut(|l| l.timestamp = 1_000_000 + TIMELOCK_SECS + 1);
        f.client.apply_fee_change(&f.admin);
        assert_eq!(f.client.get_platform_fee_bps(), 0);
    }

    #[test]
    fn fee_collection_accounting() {
        let f = fixture();
        assert_eq!(f.client.get_total_fees_collected(), 0);
        f.client.record_fee_collected(&1_000_000_i128); // 1 XLM collected
        assert_eq!(f.client.get_total_fees_collected(), 1_000_000_i128);
        f.client.record_fee_collected(&2_500_000_i128);
        assert_eq!(f.client.get_total_fees_collected(), 3_500_000_i128);
    }

    #[test]
    fn governance_and_multisig_config_extensions() {
        let f = fixture();
        // Voting period (Issue #408)
        assert_eq!(f.client.get_voting_period_ledgers(), DEFAULT_VOTING_PERIOD_LEDGERS);
        f.client.set_voting_period_ledgers(&f.admin, &20_000);
        assert_eq!(f.client.get_voting_period_ledgers(), 20_000);

        // Quorum (Issue #408)
        assert_eq!(f.client.get_quorum_threshold_bps(), DEFAULT_QUORUM_THRESHOLD_BPS);
        f.client.set_quorum_threshold_bps(&f.admin, &1_500);
        assert_eq!(f.client.get_quorum_threshold_bps(), 1_500);

        // Multisig action thresholds (Issue #416)
        let upgrade_sym = soroban_sdk::Symbol::new(&f.env, "upgrade");
        f.client.set_action_threshold(&f.admin, &upgrade_sym, &3);
        assert_eq!(f.client.get_action_threshold(&upgrade_sym), 3);
    }
}
