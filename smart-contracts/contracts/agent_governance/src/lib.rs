#![no_std]

//! # Agent Governance Contract
//!
//! On-chain governance for the agent network. Registered agents are
//! stakeholders: they stake value and carry a reputation score, and together
//! those determine their **voting power**. Agents create governance proposals
//! and vote `For`, `Against`, or `Abstain`. After a time-limited voting period
//! anyone can call [`execute_proposal`](AgentGovernanceContract::execute_proposal),
//! which checks quorum and majority and marks the proposal `Executed` or
//! `Failed`.
//!
//! ## Flow
//!
//! 1. **`initialize`** — set the governance admin (one-time).
//! 2. **`register_agent`** — an agent registers with a reputation score and a
//!    stake amount. Voting power = `stake + reputation * REPUTATION_POWER_UNIT`.
//!    The electorate's total voting power is tracked in aggregate.
//! 3. **`create_proposal`** — a registered agent opens a proposal
//!    (`ParameterChange`, `AgentDispute`, or `ProtocolUpgrade`) with a
//!    configurable voting period (default 7 days). The current total voting
//!    power is snapshotted into the proposal.
//! 4. **`vote_on_proposal`** — registered agents cast exactly one vote each,
//!    weighted by their current voting power.
//! 5. **`execute_proposal`** — after the deadline, quorum and majority are
//!    evaluated and the proposal is finalised.
//!
//! ## Passing Rules
//!
//! * **Quorum** — `(for + against + abstain) power >= 30%` of the snapshotted
//!   total voting power.
//! * **Majority** — `for power > 50%` of decisive power (`for + against`;
//!   abstentions excluded). A proposal with zero decisive votes fails.

mod errors;
mod types;

pub use errors::Error;
pub use types::{
    voting_power, AgentInfo, DataKey, Proposal, ProposalCreatedEvent, ProposalExecutedEvent,
    ProposalFailedEvent, ProposalStatus, ProposalType, VoteCastEvent, VoteChoice, VoteRecord,
    VotingStartedEvent, QuorumReachedEvent, QuorumFailedEvent,
    BPS_DENOMINATOR, DEFAULT_VOTING_PERIOD_SECS, DEFAULT_VOTING_PERIOD_LEDGERS, DEFAULT_QUORUM_THRESHOLD_BPS,
    MAJORITY_BPS, MAX_REPUTATION,
    MAX_VOTING_PERIOD_SECS, MIN_VOTING_PERIOD_SECS, QUORUM_BPS, REPUTATION_POWER_UNIT,
    // Timelock exports
    ChangeProposedEvent, ChangeExecutedEvent, ChangeCancelledEvent, GuardianApprovalEvent,
    GuardianConfig, PendingChange, TimelockKey,
    CHANGE_EXPIRY_LEDGERS, DEFAULT_GUARDIAN_THRESHOLD, DEFAULT_GUARDIAN_SET_SIZE, MIN_DELAY_LEDGERS,
};

use soroban_sdk::{contract, contractimpl, symbol_short, Address, Env, String, Symbol, Vec};

// ─── TTL constants (mirrored from agent_registry) ────────────────────────────

/// Threshold (ledgers remaining) below which we extend.
const TTL_THRESHOLD: u32 = 100_000;
/// Target TTL after extension (~31 days at 5s ledgers).
const TTL_EXTEND_TO: u32 = 535_680;

// ─── Helpers ─────────────────────────────────────────────────────────────────

fn extend_ttl_for_key(env: &Env, key: &DataKey) {
    if env.storage().persistent().has(key) {
        env.storage()
            .persistent()
            .extend_ttl(key, TTL_THRESHOLD, TTL_EXTEND_TO);
    }
}

fn require_initialized(env: &Env) -> Result<(), Error> {
    if env.storage().instance().has(&DataKey::Admin) {
        Ok(())
    } else {
        Err(Error::NotInitialized)
    }
}

fn load_agent(env: &Env, agent: &Address) -> Result<AgentInfo, Error> {
    env.storage()
        .persistent()
        .get(&DataKey::Agent(agent.clone()))
        .ok_or(Error::AgentNotRegistered)
}

fn total_power(env: &Env) -> i128 {
    env.storage()
        .instance()
        .get(&DataKey::TotalPower)
        .unwrap_or(0)
}

// ─── Contract ────────────────────────────────────────────────────────────────

#[contract]
pub struct AgentGovernanceContract;

#[contractimpl]
impl AgentGovernanceContract {
    // ── Initialisation ───────────────────────────────────────────────────

    /// Set the governance admin. Callable exactly once.
    pub fn initialize(env: Env, admin: Address) -> Result<(), Error> {
        if env.storage().instance().has(&DataKey::Admin) {
            return Err(Error::AlreadyInitialized);
        }
        admin.require_auth();
        env.storage().instance().set(&DataKey::Admin, &admin);
        env.storage().instance().set(&DataKey::TotalPower, &0i128);
        env.storage().instance().set(&DataKey::ProposalCount, &0u64);
        Ok(())
    }

    // ── Agent registration ───────────────────────────────────────────────

    /// Register `agent` as a stakeholder with a reputation score and stake.
    ///
    /// * `reputation` — must be in `[0, 100]`.
    /// * `stake` — must be `>= 0`.
    ///
    /// Voting power is `stake + reputation * REPUTATION_POWER_UNIT` and is
    /// added to the electorate's aggregate total. The agent must authorise.
    pub fn register_agent(
        env: Env,
        agent: Address,
        reputation: u32,
        stake: i128,
    ) -> Result<(), Error> {
        require_initialized(&env)?;
        agent.require_auth();

        if reputation > MAX_REPUTATION {
            return Err(Error::InvalidReputation);
        }
        if stake < 0 {
            return Err(Error::InvalidStake);
        }

        let key = DataKey::Agent(agent.clone());
        if env.storage().persistent().has(&key) {
            return Err(Error::AgentAlreadyRegistered);
        }

        let power = voting_power(stake, reputation);
        if power <= 0 {
            return Err(Error::ZeroVotingPower);
        }

        let info = AgentInfo {
            agent: agent.clone(),
            reputation,
            stake,
            power,
        };
        env.storage().persistent().set(&key, &info);
        extend_ttl_for_key(&env, &key);

        let new_total = total_power(&env).saturating_add(power);
        env.storage()
            .instance()
            .set(&DataKey::TotalPower, &new_total);

        env.events().publish(
            (symbol_short!("gov"), symbol_short!("agent_reg")),
            (agent, power),
        );

        Ok(())
    }

    /// Update an already-registered agent's reputation and/or stake.
    ///
    /// The aggregate total voting power is adjusted by the delta. The agent
    /// must authorise the call.
    pub fn update_agent(
        env: Env,
        agent: Address,
        reputation: u32,
        stake: i128,
    ) -> Result<(), Error> {
        require_initialized(&env)?;
        agent.require_auth();

        if reputation > MAX_REPUTATION {
            return Err(Error::InvalidReputation);
        }
        if stake < 0 {
            return Err(Error::InvalidStake);
        }

        let key = DataKey::Agent(agent.clone());
        let mut info = load_agent(&env, &agent)?;

        let new_power = voting_power(stake, reputation);
        if new_power <= 0 {
            return Err(Error::ZeroVotingPower);
        }

        let delta = new_power - info.power;
        info.reputation = reputation;
        info.stake = stake;
        info.power = new_power;
        env.storage().persistent().set(&key, &info);
        extend_ttl_for_key(&env, &key);

        let new_total = total_power(&env).saturating_add(delta).max(0);
        env.storage()
            .instance()
            .set(&DataKey::TotalPower, &new_total);

        env.events().publish(
            (symbol_short!("gov"), symbol_short!("agent_upd")),
            (agent, new_power),
        );

        Ok(())
    }

    // ── Proposals ────────────────────────────────────────────────────────

    /// Create a governance proposal. The `proposer` must be a registered
    /// agent and must authorise the call.
    ///
    /// * `voting_period_secs` — `0` uses [`DEFAULT_VOTING_PERIOD_SECS`]
    ///   (7 days); otherwise must be within
    ///   `[MIN_VOTING_PERIOD_SECS, MAX_VOTING_PERIOD_SECS]`.
    ///
    /// Returns the new proposal id. Emits `(gov, created)`.
    pub fn create_proposal(
        env: Env,
        proposer: Address,
        proposal_type: ProposalType,
        title: String,
        description: String,
        voting_period_secs: u64,
    ) -> Result<u64, Error> {
        require_initialized(&env)?;
        proposer.require_auth();

        // Proposer must be a stakeholder.
        load_agent(&env, &proposer)?;

        if title.is_empty() || description.is_empty() {
            return Err(Error::EmptyMetadata);
        }

        let period = if voting_period_secs == 0 {
            DEFAULT_VOTING_PERIOD_SECS
        } else {
            voting_period_secs
        };
        if !(MIN_VOTING_PERIOD_SECS..=MAX_VOTING_PERIOD_SECS).contains(&period) {
            return Err(Error::InvalidVotingPeriod);
        }

        let snapshot = total_power(&env);
        if snapshot <= 0 {
            return Err(Error::ZeroVotingPower);
        }

        let id: u64 = env
            .storage()
            .instance()
            .get(&DataKey::ProposalCount)
            .unwrap_or(0)
            + 1;

        let now = env.ledger().timestamp();
        let start_ledger = env.ledger().sequence();
        let period_ledgers: u32 = env
            .storage()
            .instance()
            .get(&DataKey::VotingPeriodLedgers)
            .unwrap_or(DEFAULT_VOTING_PERIOD_LEDGERS);
        let end_ledger = start_ledger.saturating_add(period_ledgers);

        let proposal = Proposal {
            id,
            proposer: proposer.clone(),
            proposal_type: proposal_type.clone(),
            title,
            description,
            created_at: now,
            voting_ends_at: now.saturating_add(period),
            status: ProposalStatus::Active,
            for_power: 0,
            against_power: 0,
            abstain_power: 0,
            total_power_snapshot: snapshot,
            voting_start_ledger: start_ledger,
            voting_end_ledger: end_ledger,
        };

        let key = DataKey::Proposal(id);
        env.storage().persistent().set(&key, &proposal);
        extend_ttl_for_key(&env, &key);
        env.storage().instance().set(&DataKey::ProposalCount, &id);

        env.events().publish(
            (symbol_short!("gov"), symbol_short!("created")),
            ProposalCreatedEvent {
                id,
                proposer: proposer.clone(),
                proposal_type,
                voting_ends_at: proposal.voting_ends_at,
                total_power_snapshot: snapshot,
            },
        );

        env.events().publish(
            (Symbol::new(&env, "voting_started"),),
            VotingStartedEvent {
                proposal_id: id,
                proposer,
                voting_start_ledger: start_ledger,
                voting_end_ledger: end_ledger,
            },
        );

        Ok(id)
    }

    /// Cast a vote on an active proposal. The `voter` must be a registered
    /// agent, must authorise the call, and must not have voted already.
    ///
    /// The vote weight is the agent's current voting power. Emits
    /// `(gov, vote_cast)`.
    pub fn vote_on_proposal(
        env: Env,
        proposal_id: u64,
        voter: Address,
        choice: VoteChoice,
    ) -> Result<(), Error> {
        require_initialized(&env)?;
        voter.require_auth();

        let agent = load_agent(&env, &voter)?;

        let prop_key = DataKey::Proposal(proposal_id);
        let mut proposal: Proposal = env
            .storage()
            .persistent()
            .get(&prop_key)
            .ok_or(Error::NotFound)?;

        if proposal.status != ProposalStatus::Active {
            return Err(Error::ProposalNotActive);
        }
        if env.ledger().timestamp() >= proposal.voting_ends_at {
            return Err(Error::VotingPeriodEnded);
        }

        let vote_key = DataKey::Vote(proposal_id, voter.clone());
        if env.storage().persistent().has(&vote_key) {
            return Err(Error::AlreadyVoted);
        }

        let weight = agent.power;
        match choice {
            VoteChoice::For => proposal.for_power = proposal.for_power.saturating_add(weight),
            VoteChoice::Against => {
                proposal.against_power = proposal.against_power.saturating_add(weight)
            }
            VoteChoice::Abstain => {
                proposal.abstain_power = proposal.abstain_power.saturating_add(weight)
            }
        }

        let record = VoteRecord {
            proposal_id,
            voter: voter.clone(),
            choice,
            weight,
        };
        env.storage().persistent().set(&vote_key, &record);
        extend_ttl_for_key(&env, &vote_key);
        env.storage().persistent().set(&prop_key, &proposal);
        extend_ttl_for_key(&env, &prop_key);

        env.events().publish(
            (symbol_short!("gov"), symbol_short!("vote_cast")),
            VoteCastEvent {
                proposal_id,
                voter,
                choice,
                weight,
            },
        );

        Ok(())
    }

    /// Finalise a proposal after its voting period has ended. Callable by
    /// anyone.
    ///
    /// Evaluates quorum (>= 30 % of snapshotted total power cast) and majority
    /// (> 50 % of decisive `for + against` power). On success the status
    /// becomes `Executed` and `(gov, executed)` is emitted; otherwise the
    /// status becomes `Failed` and `(gov, failed)` is emitted.
    pub fn execute_proposal(env: Env, proposal_id: u64) -> Result<ProposalStatus, Error> {
        require_initialized(&env)?;

        let prop_key = DataKey::Proposal(proposal_id);
        let mut proposal: Proposal = env
            .storage()
            .persistent()
            .get(&prop_key)
            .ok_or(Error::NotFound)?;

        if proposal.status != ProposalStatus::Active {
            return Err(Error::ProposalFinalized);
        }
        let seq = env.ledger().sequence();
        let time = env.ledger().timestamp();
        // Voting period check: must have ended in both sequence and timestamp
        if seq <= proposal.voting_end_ledger && time < proposal.voting_ends_at {
            return Err(Error::VotingPeriodActive);
        }

        let cast_power = proposal
            .for_power
            .saturating_add(proposal.against_power)
            .saturating_add(proposal.abstain_power);
        let decisive_power = proposal.for_power.saturating_add(proposal.against_power);

        let quorum_bps: i128 = env
            .storage()
            .instance()
            .get(&DataKey::QuorumThresholdBps)
            .unwrap_or(DEFAULT_QUORUM_THRESHOLD_BPS);
        let quorum_needed = (proposal.total_power_snapshot.saturating_mul(quorum_bps)) / BPS_DENOMINATOR;
        let quorum_met = proposal.total_power_snapshot > 0
            && cast_power.saturating_mul(BPS_DENOMINATOR)
                >= proposal.total_power_snapshot.saturating_mul(quorum_bps);

        // Majority: for_power / decisive_power > MAJORITY_BPS / BPS_DENOMINATOR.
        let majority_met = decisive_power > 0
            && proposal.for_power.saturating_mul(BPS_DENOMINATOR)
                > decisive_power.saturating_mul(MAJORITY_BPS);

        if !quorum_met {
            proposal.status = ProposalStatus::QuorumFailed;
            env.storage().persistent().set(&prop_key, &proposal);
            extend_ttl_for_key(&env, &prop_key);

            env.events().publish(
                (Symbol::new(&env, "quorum_failed"),),
                QuorumFailedEvent {
                    proposal_id,
                    total_voted: cast_power,
                    quorum_needed,
                },
            );

            env.events().publish(
                (symbol_short!("gov"), symbol_short!("failed")),
                ProposalFailedEvent {
                    id: proposal_id,
                    quorum_met: false,
                    majority_met,
                    for_power: proposal.for_power,
                    against_power: proposal.against_power,
                    abstain_power: proposal.abstain_power,
                },
            );

            return Ok(proposal.status);
        }

        env.events().publish(
            (Symbol::new(&env, "quorum_reached"),),
            QuorumReachedEvent {
                proposal_id,
                total_voted: cast_power,
            },
        );

        let passed = majority_met;
        proposal.status = if passed {
            ProposalStatus::Executed
        } else {
            ProposalStatus::Failed
        };
        env.storage().persistent().set(&prop_key, &proposal);
        extend_ttl_for_key(&env, &prop_key);

        if passed {
            env.events().publish(
                (symbol_short!("gov"), symbol_short!("executed")),
                ProposalExecutedEvent {
                    id: proposal_id,
                    for_power: proposal.for_power,
                    against_power: proposal.against_power,
                    abstain_power: proposal.abstain_power,
                },
            );
        } else {
            env.events().publish(
                (symbol_short!("gov"), symbol_short!("failed")),
                ProposalFailedEvent {
                    id: proposal_id,
                    quorum_met: true,
                    majority_met: false,
                    for_power: proposal.for_power,
                    against_power: proposal.against_power,
                    abstain_power: proposal.abstain_power,
                },
            );
        }

        Ok(proposal.status)
    }

    /// Configure proposal voting period in ledgers (Issue #408).
    pub fn set_voting_period_ledgers(env: Env, period: u32) -> Result<(), Error> {
        require_initialized(&env)?;
        let admin: Address = env.storage().instance().get(&DataKey::Admin).ok_or(Error::NotInitialized)?;
        admin.require_auth();
        env.storage().instance().set(&DataKey::VotingPeriodLedgers, &period);
        Ok(())
    }

    /// Query configured voting period in ledgers.
    pub fn get_voting_period_ledgers(env: Env) -> u32 {
        env.storage()
            .instance()
            .get(&DataKey::VotingPeriodLedgers)
            .unwrap_or(DEFAULT_VOTING_PERIOD_LEDGERS)
    }

    /// Configure quorum threshold in basis points (Issue #408).
    pub fn set_quorum_threshold_bps(env: Env, bps: u32) -> Result<(), Error> {
        require_initialized(&env)?;
        let admin: Address = env.storage().instance().get(&DataKey::Admin).ok_or(Error::NotInitialized)?;
        admin.require_auth();
        env.storage().instance().set(&DataKey::QuorumThresholdBps, &(bps as i128));
        Ok(())
    }

    /// Query configured quorum threshold in basis points.
    pub fn get_quorum_threshold_bps(env: Env) -> u32 {
        let bps: i128 = env
            .storage()
            .instance()
            .get(&DataKey::QuorumThresholdBps)
            .unwrap_or(DEFAULT_QUORUM_THRESHOLD_BPS);
        bps as u32
    }

    /// Configure platform_config contract address (Issue #408).
    pub fn set_platform_config(env: Env, platform_config: Address) -> Result<(), Error> {
        require_initialized(&env)?;
        let admin: Address = env.storage().instance().get(&DataKey::Admin).ok_or(Error::NotInitialized)?;
        admin.require_auth();
        env.storage().instance().set(&DataKey::PlatformConfig, &platform_config);
        Ok(())
    }

    // ── View functions ──────────────────────────────────────────────────

    /// Return the proposal record for `id`, if it exists.
    pub fn get_proposal(env: Env, id: u64) -> Option<Proposal> {
        env.storage().persistent().get(&DataKey::Proposal(id))
    }

    /// Return a specific agent's vote on a proposal, if cast.
    pub fn get_vote(env: Env, proposal_id: u64, voter: Address) -> Option<VoteRecord> {
        env.storage()
            .persistent()
            .get(&DataKey::Vote(proposal_id, voter))
    }

    /// Return the registration record for an agent, if registered.
    pub fn get_agent(env: Env, agent: Address) -> Option<AgentInfo> {
        env.storage().persistent().get(&DataKey::Agent(agent))
    }

    /// Return the electorate's aggregate voting power.
    pub fn get_total_voting_power(env: Env) -> i128 {
        total_power(&env)
    }

    /// Return the number of proposals created so far.
    pub fn get_proposal_count(env: Env) -> u64 {
        env.storage()
            .instance()
            .get(&DataKey::ProposalCount)
            .unwrap_or(0)
    }

    // ── Timelock: parameter-change proposals ─────────────────────────────────

    /// Configure the timelock module. Must be called by the admin after
    /// `initialize`. Subsequent calls by the admin can update the minimum delay.
    ///
    /// * `min_delay_ledgers` — `None` uses [`MIN_DELAY_LEDGERS`] (48).
    pub fn initialize_timelock(
        env: Env,
        admin: Address,
        min_delay_ledgers: Option<u32>,
    ) -> Result<(), Error> {
        require_initialized(&env)?;
        // Must be called by the current admin.
        let stored_admin: Address = env
            .storage()
            .instance()
            .get(&DataKey::Admin)
            .ok_or(Error::NotInitialized)?;
        if stored_admin != admin {
            return Err(Error::Unauthorized);
        }
        admin.require_auth();

        let delay = min_delay_ledgers.unwrap_or(MIN_DELAY_LEDGERS);
        env.storage()
            .instance()
            .set(&TimelockKey::MinDelay, &delay);
        Ok(())
    }

    /// Set the guardian multi-sig configuration (admin only).
    ///
    /// * `guardians` — list of trusted guardian addresses (at least 1).
    /// * `threshold` — minimum approvals required for emergency fast-track
    ///   (must be `>= 1` and `<= guardians.len()`).
    pub fn set_guardian_config(
        env: Env,
        caller: Address,
        guardians: Vec<Address>,
        threshold: u32,
    ) -> Result<(), Error> {
        require_initialized(&env)?;
        let admin: Address = env
            .storage()
            .instance()
            .get(&DataKey::Admin)
            .ok_or(Error::NotInitialized)?;
        if admin != caller {
            return Err(Error::Unauthorized);
        }
        caller.require_auth();

        if threshold == 0 || threshold > guardians.len() {
            return Err(Error::ZeroVotingPower); // reuse: invalid threshold
        }

        let config = GuardianConfig { guardians, threshold };
        env.storage()
            .instance()
            .set(&TimelockKey::GuardianConfig, &config);
        Ok(())
    }

    /// Propose a protocol parameter change.
    ///
    /// The proposer must be the admin. The `execute_after_ledger` must be at
    /// least `current_ledger + min_delay_ledgers`. Returns the new change id.
    ///
    /// The pending change record is stored in **Temporary storage** with a TTL
    /// of [`CHANGE_EXPIRY_LEDGERS`] (200 ledgers). If not executed or cancelled
    /// within that window the record expires automatically.
    pub fn propose_change(
        env: Env,
        proposer: Address,
        parameter: Symbol,
        execute_after_ledger: u32,
    ) -> Result<u32, Error> {
        require_initialized(&env)?;
        let admin: Address = env
            .storage()
            .instance()
            .get(&DataKey::Admin)
            .ok_or(Error::NotInitialized)?;
        if admin != proposer {
            return Err(Error::Unauthorized);
        }
        proposer.require_auth();

        let current_ledger = env.ledger().sequence();
        let min_delay: u32 = env
            .storage()
            .instance()
            .get(&TimelockKey::MinDelay)
            .unwrap_or(MIN_DELAY_LEDGERS);

        if execute_after_ledger < current_ledger.saturating_add(min_delay) {
            return Err(Error::InvalidDelay);
        }

        // Allocate a new change id.
        let change_id: u32 = env
            .storage()
            .instance()
            .get(&TimelockKey::ChangeCount)
            .unwrap_or(0u32)
            + 1;
        env.storage()
            .instance()
            .set(&TimelockKey::ChangeCount, &change_id);

        let change = PendingChange {
            id: change_id,
            parameter: parameter.clone(),
            proposer: proposer.clone(),
            execute_after_ledger,
            executed: false,
            cancelled: false,
            guardian_approvals: 0,
        };

        let key = TimelockKey::PendingChange(change_id);
        env.storage().temporary().set(&key, &change);
        env.storage()
            .temporary()
            .extend_ttl(&key, CHANGE_EXPIRY_LEDGERS - 1, CHANGE_EXPIRY_LEDGERS);

        env.events().publish(
            (symbol_short!("gov"), symbol_short!("chg_prop")),
            ChangeProposedEvent {
                change_id,
                parameter,
                proposer,
                execute_after_ledger,
            },
        );

        Ok(change_id)
    }

    /// Execute a pending parameter change (admin only).
    ///
    /// Callable only after `execute_after_ledger` has passed **or** when the
    /// guardian threshold has been reached (emergency fast-track).
    pub fn execute_change(env: Env, executor: Address, change_id: u32) -> Result<(), Error> {
        require_initialized(&env)?;
        let admin: Address = env
            .storage()
            .instance()
            .get(&DataKey::Admin)
            .ok_or(Error::NotInitialized)?;
        if admin != executor {
            return Err(Error::Unauthorized);
        }
        executor.require_auth();

        let key = TimelockKey::PendingChange(change_id);
        let mut change: PendingChange = env
            .storage()
            .temporary()
            .get(&key)
            .ok_or(Error::ChangeNotFound)?;

        if change.executed {
            return Err(Error::ChangeAlreadyExecuted);
        }
        if change.cancelled {
            return Err(Error::ChangeAlreadyCancelled);
        }

        let current_ledger = env.ledger().sequence();
        let emergency = change.guardian_approvals >= {
            let cfg: Option<GuardianConfig> = env
                .storage()
                .instance()
                .get(&TimelockKey::GuardianConfig);
            cfg.map(|c| c.threshold).unwrap_or(DEFAULT_GUARDIAN_THRESHOLD)
        };

        if !emergency && current_ledger < change.execute_after_ledger {
            return Err(Error::TimelockActive);
        }

        change.executed = true;
        env.storage().temporary().set(&key, &change);

        env.events().publish(
            (symbol_short!("gov"), symbol_short!("chg_exec")),
            ChangeExecutedEvent {
                change_id,
                parameter: change.parameter,
                executor,
                emergency,
            },
        );

        Ok(())
    }

    /// Cancel a pending parameter change (admin only).
    ///
    /// Can be called at any time while the change has not been executed —
    /// including before the timelock elapses.
    pub fn cancel_change(env: Env, canceller: Address, change_id: u32) -> Result<(), Error> {
        require_initialized(&env)?;
        let admin: Address = env
            .storage()
            .instance()
            .get(&DataKey::Admin)
            .ok_or(Error::NotInitialized)?;
        if admin != canceller {
            return Err(Error::Unauthorized);
        }
        canceller.require_auth();

        let key = TimelockKey::PendingChange(change_id);
        let mut change: PendingChange = env
            .storage()
            .temporary()
            .get(&key)
            .ok_or(Error::ChangeNotFound)?;

        if change.executed {
            return Err(Error::ChangeAlreadyExecuted);
        }
        if change.cancelled {
            return Err(Error::ChangeAlreadyCancelled);
        }

        change.cancelled = true;
        env.storage().temporary().set(&key, &change);

        env.events().publish(
            (symbol_short!("gov"), symbol_short!("chg_canc")),
            ChangeCancelledEvent {
                change_id,
                parameter: change.parameter,
                canceller,
            },
        );

        Ok(())
    }

    /// A guardian submits an emergency approval for a pending change.
    ///
    /// Once the number of approvals reaches the configured threshold, the
    /// change can be executed immediately via `execute_change` without waiting
    /// for `execute_after_ledger`.
    pub fn guardian_approve(env: Env, guardian: Address, change_id: u32) -> Result<(), Error> {
        require_initialized(&env)?;
        guardian.require_auth();

        // Verify guardian is a member of the configured set.
        let cfg: GuardianConfig = env
            .storage()
            .instance()
            .get(&TimelockKey::GuardianConfig)
            .ok_or(Error::GuardianSetNotConfigured)?;

        if !cfg.guardians.contains(&guardian) {
            return Err(Error::NotGuardian);
        }

        // Check no duplicate approval.
        let approval_key = TimelockKey::GuardianApproval(change_id, guardian.clone());
        if env.storage().temporary().has(&approval_key) {
            return Err(Error::AlreadyApprovedByGuardian);
        }

        // Record the approval.
        env.storage().temporary().set(&approval_key, &true);
        env.storage()
            .temporary()
            .extend_ttl(&approval_key, CHANGE_EXPIRY_LEDGERS - 1, CHANGE_EXPIRY_LEDGERS);

        // Increment approval count on the pending change.
        let change_key = TimelockKey::PendingChange(change_id);
        let mut change: PendingChange = env
            .storage()
            .temporary()
            .get(&change_key)
            .ok_or(Error::ChangeNotFound)?;

        if change.executed {
            return Err(Error::ChangeAlreadyExecuted);
        }
        if change.cancelled {
            return Err(Error::ChangeAlreadyCancelled);
        }

        change.guardian_approvals = change.guardian_approvals.saturating_add(1);
        env.storage().temporary().set(&change_key, &change);
        env.storage()
            .temporary()
            .extend_ttl(&change_key, CHANGE_EXPIRY_LEDGERS - 1, CHANGE_EXPIRY_LEDGERS);

        env.events().publish(
            (symbol_short!("gov"), symbol_short!("grd_appr")),
            GuardianApprovalEvent {
                change_id,
                guardian,
                total_approvals: change.guardian_approvals,
            },
        );

        Ok(())
    }

    /// Return a pending change record, if it still exists in Temporary storage.
    pub fn get_pending_change(env: Env, change_id: u32) -> Option<PendingChange> {
        env.storage()
            .temporary()
            .get(&TimelockKey::PendingChange(change_id))
    }

    /// Return the current guardian configuration, if set.
    pub fn get_guardian_config(env: Env) -> Option<GuardianConfig> {
        env.storage()
            .instance()
            .get(&TimelockKey::GuardianConfig)
    }

    /// Return the configured minimum timelock delay in ledgers.
    pub fn get_min_delay(env: Env) -> u32 {
        env.storage()
            .instance()
            .get(&TimelockKey::MinDelay)
            .unwrap_or(MIN_DELAY_LEDGERS)
    }
}

#[cfg(test)]
mod test;
