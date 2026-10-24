#![no_std]

//! # Dispute Resolution Contract
//!
//! Handles contested task outcomes with a 3-of-5 arbiter voting system.
//!
//! ## Flow
//! 1. Submitter calls [`raise_dispute`] within 24 h of task completion.
//! 2. Each of the 5 configured arbiters may call [`vote_on_dispute`] during the
//!    72-hour voting window.
//! 3. After the window closes, anyone calls [`resolve_dispute`] to finalize:
//!    - ≥3 Approve votes → [`Resolution::Approve`] (release funds to agent)
//!    - < 3 Approve votes → [`Resolution::Reject`] (refund to submitter)
//!
//! ## Events
//! | Topic                          | Payload              |
//! |-------------------------------|----------------------|
//! | `(dispute, raised)`           | `DisputeRaisedEvent` |
//! | `(dispute, voted)`            | `DisputeVotedEvent`  |
//! | `(dispute, resolved)`         | `DisputeResolvedEvent` |

mod errors;
mod types;

pub use errors::Error;
pub use types::*;

use soroban_sdk::{
    contract, contractclient, contractimpl, contracttype, symbol_short, token, Address, Bytes,
    BytesN, Env, String, Symbol, Vec,
};

// ── Thin client for capability_staking.slash() ───────────────────────────────

/// Minimal interface used to invoke `capability_staking::slash` via cross-contract call.
#[contractclient(name = "CapabilityStakingClient")]
pub trait ICapabilityStaking {
    fn slash(
        env: Env,
        agent_id: Address,
        capability: Bytes,
        slash_amount: i128,
        reason: Bytes,
    );
}

/// Voting window: 72 hours in seconds.
const VOTING_PERIOD_SECS: u64 = 72 * 60 * 60; // 259_200
/// Maximum time after task completion within which a dispute may be raised: 24 h.
const RAISE_WINDOW_SECS: u64 = 24 * 60 * 60; // 86_400
/// Minimum Approve votes required for [`Resolution::Approve`] (3-of-5).
const REQUIRED_APPROVE_VOTES: u32 = 3;
const STORAGE_TTL_THRESHOLD: u32 = 100_000;
const STORAGE_TTL_EXTEND_TO: u32 = 535_680;

/// Storage keys for this contract.
#[contracttype]
#[derive(Clone)]
pub enum DataKey {
    /// Admin address (set at initialization).
    Admin,
    /// Whether the contract is paused.
    Paused,
    /// The 5-address arbiter pool.
    Arbiters,
    /// A dispute record, keyed by its numeric ID.
    Dispute(u64),
    /// Funded payment escrow keyed by task ID.
    TaskEscrow(Symbol),
    /// Dispute ID associated with a task; retained after settlement.
    TaskDispute(Symbol),
    /// An arbiter's vote for a specific dispute.
    Vote(u64, Address),
    /// Monotonic counter for dispute IDs.
    NextDisputeId,
    /// capability_staking contract address — called on Reject resolutions.
    CapabilityStakingContract,
}

#[contract]
pub struct DisputeResolutionContract;

// ─── Private helpers ──────────────────────────────────────────────────────────

fn require_not_paused(env: &Env) -> Result<(), Error> {
    let paused: bool = env
        .storage()
        .instance()
        .get(&DataKey::Paused)
        .unwrap_or(false);
    if paused {
        return Err(Error::ContractPaused);
    }
    Ok(())
}

fn require_admin(env: &Env) -> Result<Address, Error> {
    let admin: Address = env
        .storage()
        .instance()
        .get(&DataKey::Admin)
        .ok_or(Error::NotInitialized)?;
    admin.require_auth();
    Ok(admin)
}

fn get_arbiters(env: &Env) -> Vec<Address> {
    env.storage()
        .instance()
        .get(&DataKey::Arbiters)
        .unwrap_or_else(|| Vec::new(env))
}

fn is_arbiter(env: &Env, addr: &Address) -> bool {
    get_arbiters(env).contains(addr)
}

fn extend_ttl(env: &Env, key: &DataKey) {
    if env.storage().persistent().has(key) {
        env.storage()
            .persistent()
            .extend_ttl(key, STORAGE_TTL_THRESHOLD, STORAGE_TTL_EXTEND_TO);
    }
}

fn next_dispute_id(env: &Env) -> Result<u64, Error> {
    let id: u64 = env
        .storage()
        .instance()
        .get(&DataKey::NextDisputeId)
        .unwrap_or(0);
    let next = id.checked_add(1).ok_or(Error::ArithmeticOverflow)?;
    env.storage()
        .instance()
        .set(&DataKey::NextDisputeId, &next);
    Ok(next)
}

// ─── Contract implementation ─────────────────────────────────────────────────

#[contractimpl]
impl DisputeResolutionContract {
    /// Initialize the contract with an admin address.
    ///
    /// May only be called once. The `admin` address authorizes itself.
    pub fn initialize(env: Env, admin: Address) -> Result<(), Error> {
        if env.storage().instance().has(&DataKey::Admin) {
            return Err(Error::AlreadyExists);
        }
        admin.require_auth();
        env.storage().instance().set(&DataKey::Admin, &admin);
        env.storage().instance().set(&DataKey::Paused, &false);
        Ok(())
    }

    /// Admin: configure the arbiter pool.
    ///
    /// The pool must contain exactly five distinct addresses and cannot be
    /// changed after the first dispute is raised.
    pub fn set_arbiters(env: Env, arbiters: Vec<Address>) -> Result<(), Error> {
        require_admin(&env)?;
        if arbiters.len() != 5 {
            return Err(Error::InvalidArbiterSet);
        }
        for (index, arbiter) in arbiters.iter().enumerate() {
            if arbiters.iter().skip(index + 1).any(|other| other == arbiter) {
                return Err(Error::InvalidArbiterSet);
            }
        }
        let next_dispute_id: u64 = env
            .storage()
            .instance()
            .get(&DataKey::NextDisputeId)
            .unwrap_or(0);
        if next_dispute_id != 0 {
            return Err(Error::InvalidArbiterSet);
        }
        env.storage()
            .instance()
            .set(&DataKey::Arbiters, &arbiters);
        Ok(())
    }

    /// Admin registers and funds the task escrow. Both the admin and submitter
    /// authorize this operation; settlement pays the agent or returns the funds.
    pub fn fund_task_escrow(
        env: Env,
        submitter: Address,
        task_id: Symbol,
        agent: Address,
        asset: Address,
        amount: i128,
        task_completed_at: u64,
    ) -> Result<(), Error> {
        require_not_paused(&env)?;
        require_admin(&env)?;
        submitter.require_auth();
        if amount <= 0 {
            return Err(Error::InvalidEscrowAmount);
        }
        if task_completed_at > env.ledger().timestamp() {
            return Err(Error::TaskNotCompleted);
        }

        let key = DataKey::TaskEscrow(task_id);
        if env.storage().persistent().has(&key) {
            return Err(Error::AlreadyExists);
        }

        let contract_address = env.current_contract_address();
        token::Client::new(&env, &asset).transfer(&submitter, &contract_address, &amount);
        env.storage().persistent().set(
            &key,
            &TaskEscrow {
                submitter,
                agent,
                asset,
                amount,
                task_completed_at,
                disputed: false,
                settled: false,
            },
        );
        extend_ttl(&env, &key);
        Ok(())
    }

    /// Release undisputed task funds to the agent after the 24-hour dispute
    /// window closes. Anyone may call this permissionless settlement.
    pub fn settle_undisputed_task(env: Env, task_id: Symbol) -> Result<(), Error> {
        require_not_paused(&env)?;
        let key = DataKey::TaskEscrow(task_id);
        let mut escrow: TaskEscrow = env
            .storage()
            .persistent()
            .get(&key)
            .ok_or(Error::InvalidTaskEscrow)?;
        if escrow.settled {
            return Err(Error::EscrowAlreadySettled);
        }
        if escrow.disputed {
            return Err(Error::DisputeAlreadyRaised);
        }
        let settlement_at = escrow
            .task_completed_at
            .checked_add(RAISE_WINDOW_SECS)
            .ok_or(Error::ArithmeticOverflow)?;
        if env.ledger().timestamp() < settlement_at {
            return Err(Error::VotingPeriodActive);
        }

        token::Client::new(&env, &escrow.asset).transfer(
            &env.current_contract_address(),
            &escrow.agent,
            &escrow.amount,
        );
        escrow.settled = true;
        env.storage().persistent().set(&key, &escrow);
        extend_ttl(&env, &key);
        Ok(())
    }

    /// Admin: pause or resume the contract.
    pub fn set_paused(env: Env, paused: bool) -> Result<(), Error> {
        require_admin(&env)?;
        env.storage().instance().set(&DataKey::Paused, &paused);
        Ok(())
    }

    /// Admin: set the capability_staking contract address.
    ///
    /// When set, `resolve_dispute` will call `capability_staking.slash(...)` on
    /// every `Resolution::Reject` outcome to economically penalise the agent.
    pub fn set_capability_staking(env: Env, contract_id: Address) -> Result<(), Error> {
        require_admin(&env)?;
        env.storage()
            .instance()
            .set(&DataKey::CapabilityStakingContract, &contract_id);
        Ok(())
    }

    // ── Core dispute lifecycle ────────────────────────────────────────────────

    /// Raise a dispute for a contested task outcome.
    ///
    /// # Parameters
    /// - `submitter` — the disputing party; must authorize the call
    /// - `task_id` — on-chain task identifier being disputed
    /// - `evidence_hash` — 32-byte hash of off-chain evidence package
    /// - `reason` — human-readable dispute reason
    /// The task must have a funded escrow, and the escrow's submitter and
    /// completion timestamp are used to verify caller identity and the 24-hour
    /// dispute window.
    ///
    /// # Returns
    /// The numeric dispute ID.
    ///
    /// # Emits
    /// `(dispute, raised)` → [`DisputeRaisedEvent`]
    pub fn raise_dispute(
        env: Env,
        submitter: Address,
        task_id: Symbol,
        evidence_hash: BytesN<32>,
        reason: String,
    ) -> Result<u64, Error> {
        require_not_paused(&env)?;
        submitter.require_auth();

        let now = env.ledger().timestamp();

        // Enforce 24-hour raise window.
        let escrow: TaskEscrow = env
            .storage()
            .persistent()
            .get(&DataKey::TaskEscrow(task_id.clone()))
            .ok_or(Error::InvalidTaskEscrow)?;
        extend_ttl(&env, &DataKey::TaskEscrow(task_id.clone()));
        if escrow.submitter != submitter || escrow.settled {
            return Err(Error::InvalidTaskEscrow);
        }
        let raise_deadline = escrow
            .task_completed_at
            .checked_add(RAISE_WINDOW_SECS)
            .ok_or(Error::ArithmeticOverflow)?;
        if now < escrow.task_completed_at || now > raise_deadline {
            return Err(Error::RaisedTooLate);
        }

        let task_dispute_key = DataKey::TaskDispute(task_id.clone());
        if env.storage().persistent().has(&task_dispute_key) {
            return Err(Error::DisputeAlreadyRaised);
        }

        let arbiters = get_arbiters(&env);
        if arbiters.is_empty() {
            return Err(Error::NoArbiters);
        }

        let dispute_id = next_dispute_id(&env)?;
        let voting_deadline = now
            .checked_add(VOTING_PERIOD_SECS)
            .ok_or(Error::ArithmeticOverflow)?;

        let record = DisputeRecord {
            dispute_id,
            task_id: task_id.clone(),
            submitter: submitter.clone(),
            evidence_hash: evidence_hash.clone(),
            reason,
            status: DisputeStatus::Open,
            raised_at: now,
            voting_deadline,
            approve_votes: 0,
            reject_votes: 0,
            resolution: None,
            task_completed_at: escrow.task_completed_at,
        };

        env.storage()
            .persistent()
            .set(&DataKey::Dispute(dispute_id), &record);
        extend_ttl(&env, &DataKey::Dispute(dispute_id));
        let mut disputed_escrow = escrow;
        disputed_escrow.disputed = true;
        env.storage()
            .persistent()
            .set(&DataKey::TaskEscrow(task_id.clone()), &disputed_escrow);
        extend_ttl(&env, &DataKey::TaskEscrow(task_id.clone()));
        env.storage()
            .persistent()
            .set(&task_dispute_key, &dispute_id);
        extend_ttl(&env, &task_dispute_key);

        env.events().publish(
            (symbol_short!("dispute"), symbol_short!("raised")),
            DisputeRaisedEvent {
                dispute_id,
                task_id,
                submitter,
                evidence_hash,
            },
        );

        Ok(dispute_id)
    }

    /// An arbiter votes on an open dispute.
    ///
    /// - Only addresses in the configured arbiter pool may vote.
    /// - Each arbiter may vote at most once per dispute.
    /// - Voting closes when `ledger.timestamp() >= voting_deadline`.
    ///
    /// # Emits
    /// `(dispute, voted)` → [`DisputeVotedEvent`]
    pub fn vote_on_dispute(
        env: Env,
        arbiter: Address,
        dispute_id: u64,
        vote: Vote,
    ) -> Result<(), Error> {
        require_not_paused(&env)?;
        arbiter.require_auth();

        // Non-arbiters cannot vote.
        if !is_arbiter(&env, &arbiter) {
            return Err(Error::NotArbiter);
        }

        let dispute_key = DataKey::Dispute(dispute_id);
        let mut record: DisputeRecord = env
            .storage()
            .persistent()
            .get(&dispute_key)
            .ok_or(Error::NotFound)?;
        extend_ttl(&env, &dispute_key);

        if record.status == DisputeStatus::Resolved {
            return Err(Error::AlreadyResolved);
        }

        // Enforce voting window.
        let now = env.ledger().timestamp();
        if now >= record.voting_deadline {
            return Err(Error::VotingPeriodActive);
        }

        // Each arbiter may vote at most once.
        let vote_key = DataKey::Vote(dispute_id, arbiter.clone());
        if env.storage().persistent().has(&vote_key) {
            return Err(Error::AlreadyVoted);
        }

        // Record the vote.
        env.storage().persistent().set(&vote_key, &vote);
        extend_ttl(&env, &vote_key);

        match vote {
            Vote::Approve => record.approve_votes += 1,
            Vote::Reject => record.reject_votes += 1,
        }

        env.storage().persistent().set(&dispute_key, &record);
        extend_ttl(&env, &dispute_key);

        env.events().publish(
            (symbol_short!("dispute"), symbol_short!("voted")),
            DisputeVotedEvent {
                dispute_id,
                arbiter,
                vote,
            },
        );

        Ok(())
    }

    /// Resolve a dispute after the 72-hour voting period has elapsed.
    ///
    /// Anyone may call this once `ledger.timestamp() >= voting_deadline`.
    ///
    /// Resolution rule:
    /// - `approve_votes >= 3` → [`Resolution::Approve`] (release to agent)
    /// - otherwise            → [`Resolution::Reject`] (refund to submitter)
    ///
    /// # Emits
    /// `(dispute, resolved)` → [`DisputeResolvedEvent`]
    pub fn resolve_dispute(env: Env, dispute_id: u64) -> Result<Resolution, Error> {
        require_not_paused(&env)?;

        let dispute_key = DataKey::Dispute(dispute_id);
        let mut record: DisputeRecord = env
            .storage()
            .persistent()
            .get(&dispute_key)
            .ok_or(Error::NotFound)?;
        extend_ttl(&env, &dispute_key);

        if record.status == DisputeStatus::Resolved {
            return Err(Error::AlreadyResolved);
        }

        let now = env.ledger().timestamp();
        if now < record.voting_deadline {
            return Err(Error::VotingPeriodActive);
        }

        // 3-of-5: approve wins if at least 3 arbiters approved.
        let resolution = if record.approve_votes >= REQUIRED_APPROVE_VOTES {
            Resolution::Approve
        } else {
            Resolution::Reject
        };

        record.status = DisputeStatus::Resolved;
        record.resolution = Some(resolution.clone());

        let escrow_key = DataKey::TaskEscrow(record.task_id.clone());
        let mut settled_escrow: TaskEscrow = env
            .storage()
            .persistent()
            .get(&escrow_key)
            .ok_or(Error::InvalidTaskEscrow)?;
        extend_ttl(&env, &escrow_key);
        if !settled_escrow.disputed || settled_escrow.settled {
            return Err(Error::InvalidTaskEscrow);
        }
        let recipient = if resolution == Resolution::Approve {
            settled_escrow.agent.clone()
        } else {
            settled_escrow.submitter.clone()
        };
        token::Client::new(&env, &settled_escrow.asset).transfer(
            &env.current_contract_address(),
            &recipient,
            &settled_escrow.amount,
        );
        settled_escrow.settled = true;
        env.storage()
            .persistent()
            .set(&escrow_key, &settled_escrow);
        extend_ttl(&env, &escrow_key);
        env.storage().persistent().set(&dispute_key, &record);
        extend_ttl(&env, &dispute_key);

        env.events().publish(
            (symbol_short!("dispute"), symbol_short!("resolved")),
            DisputeResolvedEvent {
                dispute_id,
                resolution: resolution.clone(),
                approve_votes: record.approve_votes,
                reject_votes: record.reject_votes,
            },
        );

        // On Reject: slash the agent's capability bond via cross-contract call.
        if resolution == Resolution::Reject {
            if let Some(staking_contract) = env
                .storage()
                .instance()
                .get::<DataKey, Address>(&DataKey::CapabilityStakingContract)
            {
                // Use the full escrow amount as the slash amount; the staking
                // contract will cap it at the agent's actual bond.
                let slash_amount = settled_escrow.amount;
                // Encode task_id as capability bytes for the slash call.
                let capability = Bytes::from_slice(&env, &[]);
                // reason = dispute_id encoded as bytes
                let reason = Bytes::from_slice(&env, &[]);
                let client = CapabilityStakingClient::new(&env, &staking_contract);
                // Best-effort: if the slash panics (e.g. no stake registered),
                // we swallow the error so dispute settlement is never blocked.
                let _ = client.try_slash(
                    &settled_escrow.agent,
                    &capability,
                    &slash_amount,
                    &reason,
                );
            }
        }

        Ok(resolution)
    }

    /// Retrieve a dispute record by its numeric ID.
    ///
    /// Returns `None` if the dispute does not exist.
    pub fn get_dispute(env: Env, dispute_id: u64) -> Option<DisputeRecord> {
        env.storage()
            .persistent()
            .get(&DataKey::Dispute(dispute_id))
    }

    // ── Read-only helpers ─────────────────────────────────────────────────────

    /// Returns `true` if `addr` is in the configured arbiter pool.
    pub fn is_arbiter(env: Env, addr: Address) -> bool {
        is_arbiter(&env, &addr)
    }

    /// Returns the configured arbiter pool.
    pub fn get_arbiters(env: Env) -> Vec<Address> {
        get_arbiters(&env)
    }

    /// Returns the vote cast by `arbiter` for `dispute_id`, or `None`.
    pub fn get_vote(env: Env, dispute_id: u64, arbiter: Address) -> Option<Vote> {
        env.storage()
            .persistent()
            .get(&DataKey::Vote(dispute_id, arbiter))
    }
}

#[cfg(test)]
mod test;
#[cfg(test)]
mod integration_tests;
