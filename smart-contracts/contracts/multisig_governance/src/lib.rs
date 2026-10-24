#![no_std]

//! # Multi-Signature Governance Contract
//!
//! Provides an M-of-N multi-signature governance layer for sensitive admin
//! operations: contract upgrades, config updates, agent slashing, and signer
//! rotation.
//!
//! ## Flow
//!
//! 1. **`initialize`** — register the initial signer set and threshold.
//! 2. **`propose`** — any signer creates a proposal; they automatically count
//!    as the first approval.
//! 3. **`approve`** — other signers add their approval.
//! 4. **`execute`** — once the threshold is met **and** the 48-hour timelock
//!    has elapsed, any signer may execute.
//! 5. **`cancel`** — the original proposer may cancel before execution.
//!
//! ## Timelock
//!
//! Every proposal has an `eta` (earliest time it can be executed), set to
//! `created_at + TIMELOCK_SECS` (48 hours by default). The timelock gives
//! stakeholders time to react to unexpected proposals.
//!
//! ## Expiry
//!
//! Proposals that are not executed within 7 days of creation expire and
//! cannot be approved or executed.
//!
//! ## Actions
//!
//! | Variant            | Description                                             |
//! |--------------------|---------------------------------------------------------|
//! | `UpgradeContract`  | Signals an upgrade to a new WASM hash                  |
//! | `UpdateConfig`     | Signals an update to platform configuration            |
//! | `SlashAgent`       | Signals slashing of an agent bond                      |
//! | `ChangeSigners`    | Replaces the signer set and/or threshold               |
//!
//! ## Events
//!
//! | Event name              | Topics                          |
//! |-------------------------|---------------------------------|
//! | Proposal created        | `(gov_ms, proposed)`            |
//! | Proposal approved       | `(gov_ms, approved)`            |
//! | Proposal executed       | `(gov_ms, executed)`            |
//! | Proposal cancelled      | `(gov_ms, cancelled)`           |

mod errors;

pub use errors::Error;

use soroban_sdk::{
    auth::{ContractContext, InvokerContractAuthEntry, SubContractInvocation}, contract,
    contractimpl, contracttype, symbol_short, Address, BytesN, Env, IntoVal, String, Symbol, Val,
    Vec,
};

// ─── Constants ────────────────────────────────────────────────────────────────

/// Default timelock: 48 hours in seconds.
pub const TIMELOCK_SECS: u64 = 172_800;
/// Proposal expiry: 7 days in seconds.
pub const PROPOSAL_EXPIRY_SECS: u64 = 604_800;
/// Default signature collection window in ledgers (~48 hours at 5s/ledger: 34,560 ledgers).
pub const DEFAULT_WINDOW_LEDGERS: u32 = 34_560;

/// TTL extension threshold (ledgers remaining).
const TTL_THRESHOLD: u32 = 50_000;
/// Target TTL after extension (~14 days at 5 s/ledger).
const TTL_EXTEND_TO: u32 = 241_920;

// ─── Action types ─────────────────────────────────────────────────────────────

/// The action a proposal will perform when executed.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum GovernanceAction {
    /// Upgrade a target exposing `upgrade_contract(hash, version, description)`.
    UpgradeContract(Address, BytesN<32>, String, String),
    /// Update a target exposing `update_config(key, value)`.
    UpdateConfig(Address, Symbol, i128),
    /// Slash an agent's bond by `penalty_stroops`.
    /// The target must expose `slash_bond(agent_id, penalty_stroops)`.
    SlashAgent(Address, Symbol, i128),
    /// Replace the signer set with `new_signers` and set `new_threshold`.
    ChangeSigners(Vec<Address>, u32),
}

// ─── Proposal ────────────────────────────────────────────────────────────────

/// A governance proposal.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Proposal {
    /// Auto-incremented proposal identifier.
    pub id: u64,
    /// Signer who created the proposal.
    pub proposer: Address,
    /// Human-readable title.
    pub title: String,
    /// Human-readable description.
    pub description: String,
    /// The action to perform when the proposal is executed.
    pub action: GovernanceAction,
    /// UNIX timestamp (seconds) when the proposal was created.
    pub created_at: u64,
    /// Earliest UNIX timestamp at which the proposal may be executed.
    pub eta: u64,
    /// UNIX timestamp after which the proposal is expired and cannot be executed.
    pub expires_at: u64,
    /// Addresses that have approved so far.
    pub approvals: Vec<Address>,
    /// Addresses that have rejected so far.
    pub rejections: Vec<Address>,
    /// Whether the proposal has reached the rejection threshold.
    pub rejected: bool,
    /// Whether the proposal has been executed.
    pub executed: bool,
    /// Whether the proposal has been cancelled.
    pub cancelled: bool,
    /// Ledger sequence when the signature collection window ends.
    pub window_end_ledger: u32,
}

// ─── Events ───────────────────────────────────────────────────────────────────

/// Emitted when a new proposal is created.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct GovernanceProposedEvent {
    pub proposal_id: u64,
    pub proposer: Address,
    pub eta: u64,
    pub expires_at: u64,
}

/// Emitted when a signer approves a proposal.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct GovernanceApprovedEvent {
    pub proposal_id: u64,
    pub approver: Address,
    pub approval_count: u32,
}

/// Emitted when a proposal is executed.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct GovernanceExecutedEvent {
    pub proposal_id: u64,
    pub executor: Address,
}

/// Emitted when a signer rejects a proposal.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct GovernanceRejectedEvent {
    pub proposal_id: u64,
    pub rejector: Address,
    pub rejection_count: u32,
    pub rejected: bool,
}

/// Emitted when a proposal is cancelled.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct GovernanceCancelledEvent {
    pub proposal_id: u64,
    pub canceller: Address,
}

/// Emitted when a signature is added.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SignatureAddedEvent {
    pub proposal_id: u64,
    pub signer: Address,
    pub current_count: u32,
}

/// Emitted when a signer revokes their signature.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SignatureRevokedEvent {
    pub proposal_id: u64,
    pub signer: Address,
    pub current_count: u32,
}

/// Emitted when a proposal reaches its required signature threshold.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ThresholdReachedEvent {
    pub proposal_id: u64,
    pub threshold: u32,
    pub ledger: u32,
}

/// Emitted when a proposal's signature collection window expires.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ProposalExpiredEvent {
    pub proposal_id: u64,
    pub ledger: u32,
}

// ─── Storage keys ────────────────────────────────────────────────────────────

#[contracttype]
#[derive(Clone)]
pub enum DataKey {
    /// Whether the contract has been initialized.
    Initialized,
    /// Current signer list.
    Signers,
    /// Current approval threshold.
    Threshold,
    /// Proposal sequence counter.
    ProposalSeq,
    /// A proposal record, keyed by its ID.
    Proposal(u64),
    /// Platform config address (Issue #416).
    PlatformConfig,
    /// Action-specific threshold (Issue #416).
    ActionThreshold(Symbol),
}

// ─── Contract ────────────────────────────────────────────────────────────────

#[contract]
pub struct MultisigGovernanceContract;

// ─── Helpers ─────────────────────────────────────────────────────────────────

fn is_signer(env: &Env, addr: &Address) -> bool {
    let signers: Vec<Address> = env
        .storage()
        .instance()
        .get(&DataKey::Signers)
        .unwrap_or_else(|| Vec::new(env));
    signers.contains(addr)
}

fn threshold(env: &Env) -> u32 {
    env.storage()
        .instance()
        .get(&DataKey::Threshold)
        .unwrap_or(1)
}

fn action_symbol(env: &Env, action: &GovernanceAction) -> Symbol {
    match action {
        GovernanceAction::UpgradeContract(_, _, _, _) => Symbol::new(env, "upgrade"),
        GovernanceAction::UpdateConfig(_, _, _) => Symbol::new(env, "config"),
        GovernanceAction::SlashAgent(_, _, _) => Symbol::new(env, "slash"),
        GovernanceAction::ChangeSigners(_, _) => Symbol::new(env, "signers"),
    }
}

fn action_threshold(env: &Env, action: &GovernanceAction) -> u32 {
    let sym = action_symbol(env, action);
    if let Some(t) = env.storage().instance().get(&DataKey::ActionThreshold(sym)) {
        return t;
    }
    threshold(env)
}

fn next_seq(env: &Env) -> u64 {
    let seq: u64 = env
        .storage()
        .instance()
        .get(&DataKey::ProposalSeq)
        .unwrap_or(0)
        + 1;
    env.storage().instance().set(&DataKey::ProposalSeq, &seq);
    seq
}

fn load_proposal(env: &Env, id: u64) -> Result<Proposal, Error> {
    env.storage()
        .persistent()
        .get(&DataKey::Proposal(id))
        .ok_or(Error::ProposalNotFound)
}

fn save_proposal(env: &Env, proposal: &Proposal) {
    env.storage()
        .persistent()
        .set(&DataKey::Proposal(proposal.id), proposal);
    env.storage()
        .persistent()
        .extend_ttl(&DataKey::Proposal(proposal.id), TTL_THRESHOLD, TTL_EXTEND_TO);
}

fn authorize_target_call(env: &Env, target: &Address, method: Symbol, args: Vec<Val>) {
    let invocation = InvokerContractAuthEntry::Contract(SubContractInvocation {
        context: ContractContext {
            contract: target.clone(),
            fn_name: method,
            args,
        },
        sub_invocations: Vec::new(env),
    });
    let mut invocations = Vec::new(env);
    invocations.push_back(invocation);
    env.authorize_as_current_contract(invocations);
}

// ─── Implementation ───────────────────────────────────────────────────────────

#[contractimpl]
impl MultisigGovernanceContract {
    // ── Initialization ────────────────────────────────────────────────────────

    /// Initialize the contract with an initial set of signers and a threshold.
    ///
    /// `threshold` must be `>= 1` and `<= signers.len()`.
    ///
    /// Callable exactly once.
    pub fn initialize(
        env: Env,
        signers: Vec<Address>,
        threshold: u32,
    ) -> Result<(), Error> {
        if env.storage().instance().has(&DataKey::Initialized) {
            return Err(Error::AlreadyInitialized);
        }
        if signers.is_empty() {
            return Err(Error::InvalidSignerList);
        }
        if threshold == 0 || threshold > signers.len() {
            return Err(Error::InvalidThreshold);
        }
        for (index, signer) in signers.iter().enumerate() {
            if signers.iter().skip(index + 1).any(|other| other == signer) {
                return Err(Error::InvalidSignerList);
            }
        }

        env.storage().instance().set(&DataKey::Initialized, &true);
        env.storage().instance().set(&DataKey::Signers, &signers);
        env.storage().instance().set(&DataKey::Threshold, &threshold);
        env.storage().instance().set(&DataKey::ProposalSeq, &0u64);
        env.storage()
            .instance()
            .extend_ttl(TTL_THRESHOLD, TTL_EXTEND_TO);

        Ok(())
    }

    // ── Proposal lifecycle ────────────────────────────────────────────────────

    /// Create a new proposal.
    ///
    /// The proposer must be a registered signer and must authorise the call.
    /// The proposer's approval is automatically counted.
    ///
    /// Emits `GovernanceProposed`.
    pub fn propose(
        env: Env,
        proposer: Address,
        title: String,
        description: String,
        action: GovernanceAction,
    ) -> Result<u64, Error> {
        if !env.storage().instance().has(&DataKey::Initialized) {
            return Err(Error::NotInitialized);
        }
        if !is_signer(&env, &proposer) {
            return Err(Error::NotSigner);
        }
        proposer.require_auth();

        if title.is_empty() || description.is_empty() {
            return Err(Error::EmptyMetadata);
        }

        let id = next_seq(&env);
        let now = env.ledger().timestamp();
        let eta = now.saturating_add(TIMELOCK_SECS);
        let window_end_ledger = env.ledger().sequence().saturating_add(DEFAULT_WINDOW_LEDGERS);

        let mut initial_approvals = Vec::new(&env);
        initial_approvals.push_back(proposer.clone());

        let proposal = Proposal {
            id,
            proposer: proposer.clone(),
            title,
            description,
            action,
            created_at: now,
            eta,
            expires_at: if initial_approvals.len() >= threshold(&env) {
                now.saturating_add(PROPOSAL_EXPIRY_SECS)
            } else {
                0
            },
            approvals: initial_approvals,
            rejections: Vec::new(&env),
            rejected: false,
            executed: false,
            cancelled: false,
            window_end_ledger,
        };
        save_proposal(&env, &proposal);

        env.events().publish(
            (Symbol::new(&env, "GovernanceProposed"),),
            GovernanceProposedEvent {
                proposal_id: id,
                proposer: proposer.clone(),
                eta,
                expires_at: proposal.expires_at,
            },
        );

        env.events().publish(
            (Symbol::new(&env, "signature_added"),),
            SignatureAddedEvent {
                proposal_id: id,
                signer: proposer,
                current_count: 1,
            },
        );

        let required = action_threshold(&env, &proposal.action);
        if 1 >= required {
            env.events().publish(
                (Symbol::new(&env, "threshold_reached"),),
                ThresholdReachedEvent {
                    proposal_id: id,
                    threshold: required,
                    ledger: env.ledger().sequence(),
                },
            );
        }

        Ok(id)
    }

    /// Approve an existing proposal.
    ///
    /// The approver must be a registered signer, must authorise the call, and
    /// must not have already approved this proposal.
    ///
    /// Emits `GovernanceApproved`.
    pub fn approve(env: Env, approver: Address, proposal_id: u64) -> Result<(), Error> {
        if !env.storage().instance().has(&DataKey::Initialized) {
            return Err(Error::NotInitialized);
        }
        if !is_signer(&env, &approver) {
            return Err(Error::NotSigner);
        }
        approver.require_auth();

        let mut proposal = load_proposal(&env, proposal_id)?;

        if proposal.executed {
            return Err(Error::AlreadyExecuted);
        }
        if proposal.cancelled {
            return Err(Error::ProposalCancelled);
        }
        if proposal.rejected {
            return Err(Error::ProposalRejected);
        }
        let now = env.ledger().timestamp();
        if proposal.expires_at != 0 && now >= proposal.expires_at {
            return Err(Error::ProposalExpired);
        }
        if proposal.window_end_ledger > 0 && env.ledger().sequence() > proposal.window_end_ledger {
            env.events().publish(
                (Symbol::new(&env, "proposal_expired"),),
                ProposalExpiredEvent {
                    proposal_id,
                    ledger: env.ledger().sequence(),
                },
            );
            return Err(Error::ProposalExpired);
        }
        if proposal.approvals.contains(&approver) || proposal.rejections.contains(&approver) {
            return Err(Error::AlreadyApproved);
        }

        proposal.approvals.push_back(approver.clone());
        let approval_count = proposal.approvals.len();
        let required = action_threshold(&env, &proposal.action);

        if proposal.expires_at == 0 && approval_count >= required {
            proposal.expires_at = now.saturating_add(PROPOSAL_EXPIRY_SECS);
        }
        save_proposal(&env, &proposal);

        env.events().publish(
            (Symbol::new(&env, "GovernanceApproved"),),
            GovernanceApprovedEvent {
                proposal_id,
                approver: approver.clone(),
                approval_count,
            },
        );

        env.events().publish(
            (Symbol::new(&env, "signature_added"),),
            SignatureAddedEvent {
                proposal_id,
                signer: approver,
                current_count: approval_count,
            },
        );

        if approval_count >= required {
            env.events().publish(
                (Symbol::new(&env, "threshold_reached"),),
                ThresholdReachedEvent {
                    proposal_id,
                    threshold: required,
                    ledger: env.ledger().sequence(),
                },
            );
        }

        Ok(())
    }

    /// Reject an existing proposal. A proposal is rejected once the current
    /// threshold of signers have rejected it.
    pub fn reject(env: Env, rejector: Address, proposal_id: u64) -> Result<(), Error> {
        if !env.storage().instance().has(&DataKey::Initialized) {
            return Err(Error::NotInitialized);
        }
        if !is_signer(&env, &rejector) {
            return Err(Error::NotSigner);
        }
        rejector.require_auth();

        let mut proposal = load_proposal(&env, proposal_id)?;
        if proposal.executed {
            return Err(Error::AlreadyExecuted);
        }
        if proposal.cancelled {
            return Err(Error::ProposalCancelled);
        }
        if proposal.rejected {
            return Err(Error::ProposalRejected);
        }
        let now = env.ledger().timestamp();
        if proposal.expires_at != 0 && now >= proposal.expires_at {
            return Err(Error::ProposalExpired);
        }
        if proposal.approvals.contains(&rejector) || proposal.rejections.contains(&rejector) {
            return Err(Error::AlreadyVoted);
        }

        proposal.rejections.push_back(rejector.clone());
        let rejection_count = proposal.rejections.len();
        proposal.rejected = rejection_count >= threshold(&env);
        save_proposal(&env, &proposal);

        env.events().publish(
            (Symbol::new(&env, "GovernanceRejected"),),
            GovernanceRejectedEvent {
                proposal_id,
                rejector,
                rejection_count,
                rejected: proposal.rejected,
            },
        );
        Ok(())
    }

    /// Execute a proposal that has met its threshold and timelock.
    ///
    /// The executor must be a registered signer and must authorise the call.
    ///
    /// Emits `GovernanceExecuted`.
    pub fn execute(env: Env, executor: Address, proposal_id: u64) -> Result<(), Error> {
        if !env.storage().instance().has(&DataKey::Initialized) {
            return Err(Error::NotInitialized);
        }
        if !is_signer(&env, &executor) {
            return Err(Error::NotSigner);
        }
        executor.require_auth();

        let mut proposal = load_proposal(&env, proposal_id)?;

        if proposal.executed {
            return Err(Error::AlreadyExecuted);
        }
        if proposal.cancelled {
            return Err(Error::ProposalCancelled);
        }
        if proposal.rejected {
            return Err(Error::ProposalRejected);
        }
        let now = env.ledger().timestamp();
        if now < proposal.eta {
            return Err(Error::TimelockNotElapsed);
        }
        let required = action_threshold(&env, &proposal.action);
        if proposal.approvals.len() < required {
            return Err(Error::InsufficientApprovals);
        }
        if proposal.expires_at == 0 || now >= proposal.expires_at {
            return Err(Error::ProposalExpired);
        }

        proposal.executed = true;
        save_proposal(&env, &proposal);

        match proposal.action.clone() {
            GovernanceAction::UpgradeContract(target, wasm_hash, version, description) => {
                let method = Symbol::new(&env, "upgrade_contract");
                let args: Vec<Val> = (wasm_hash, version, description).into_val(&env);
                authorize_target_call(&env, &target, method.clone(), args.clone());
                env.invoke_contract::<()>(&target, &method, args);
            }
            GovernanceAction::UpdateConfig(target, key, value) => {
                let method = Symbol::new(&env, "update_config");
                let args: Vec<Val> = (key, value).into_val(&env);
                authorize_target_call(&env, &target, method.clone(), args.clone());
                env.invoke_contract::<()>(&target, &method, args);
            }
            GovernanceAction::SlashAgent(target, agent_id, penalty_stroops) => {
                let method = Symbol::new(&env, "slash_bond");
                let args: Vec<Val> = (agent_id, penalty_stroops).into_val(&env);
                authorize_target_call(&env, &target, method.clone(), args.clone());
                env.invoke_contract::<()>(&target, &method, args);
            }
            GovernanceAction::ChangeSigners(new_signers, new_threshold) => {
                if new_signers.is_empty() {
                    return Err(Error::InvalidSignerList);
                }
                if new_threshold == 0 || new_threshold > new_signers.len() {
                    return Err(Error::InvalidThreshold);
                }
                for (index, signer) in new_signers.iter().enumerate() {
                    if new_signers.iter().skip(index + 1).any(|other| other == signer) {
                        return Err(Error::InvalidSignerList);
                    }
                }
                env.storage().instance().set(&DataKey::Signers, &new_signers);
                env.storage()
                    .instance()
                    .set(&DataKey::Threshold, &new_threshold);
                env.storage()
                    .instance()
                    .extend_ttl(TTL_THRESHOLD, TTL_EXTEND_TO);
            }
        }

        env.events().publish(
            (Symbol::new(&env, "GovernanceExecuted"),),
            GovernanceExecutedEvent {
                proposal_id,
                executor,
            },
        );

        Ok(())
    }

    /// Cancel a proposal.  Only the original proposer may cancel.
    ///
    /// Emits `(gov_ms, cancelled)`.
    pub fn cancel(env: Env, canceller: Address, proposal_id: u64) -> Result<(), Error> {
        if !env.storage().instance().has(&DataKey::Initialized) {
            return Err(Error::NotInitialized);
        }
        canceller.require_auth();

        let mut proposal = load_proposal(&env, proposal_id)?;

        if proposal.proposer != canceller {
            return Err(Error::Unauthorized);
        }
        if proposal.executed {
            return Err(Error::AlreadyExecuted);
        }
        if proposal.rejected {
            return Err(Error::ProposalRejected);
        }
        if proposal.cancelled {
            return Err(Error::ProposalCancelled);
        }

        proposal.cancelled = true;
        save_proposal(&env, &proposal);

        env.events().publish(
            (symbol_short!("gov_ms"), symbol_short!("cancelled")),
            GovernanceCancelledEvent {
                proposal_id,
                canceller,
            },
        );

        Ok(())
    }

    /// Revoke a previously submitted signature before the proposal is executed.
    ///
    /// The signer must authorise the call. Emits `signature_revoked`.
    pub fn revoke(env: Env, signer: Address, proposal_id: u64) -> Result<(), Error> {
        if !env.storage().instance().has(&DataKey::Initialized) {
            return Err(Error::NotInitialized);
        }
        if !is_signer(&env, &signer) {
            return Err(Error::NotSigner);
        }
        signer.require_auth();

        let mut proposal = load_proposal(&env, proposal_id)?;

        if proposal.executed {
            return Err(Error::AlreadyExecuted);
        }
        if proposal.cancelled {
            return Err(Error::ProposalCancelled);
        }
        if proposal.rejected {
            return Err(Error::ProposalRejected);
        }

        let mut found_index: Option<u32> = None;
        for (i, approved) in proposal.approvals.iter().enumerate() {
            if approved == signer {
                found_index = Some(i as u32);
                break;
            }
        }

        let idx = found_index.ok_or(Error::Unauthorized)?;
        proposal.approvals.remove(idx);
        save_proposal(&env, &proposal);

        env.events().publish(
            (Symbol::new(&env, "signature_revoked"),),
            SignatureRevokedEvent {
                proposal_id,
                signer,
                current_count: proposal.approvals.len(),
            },
        );

        Ok(())
    }

    /// Configure action-specific approval threshold requirement.
    pub fn set_action_threshold(
        env: Env,
        caller: Address,
        action_name: Symbol,
        threshold_val: u32,
    ) -> Result<(), Error> {
        if !env.storage().instance().has(&DataKey::Initialized) {
            return Err(Error::NotInitialized);
        }
        if !is_signer(&env, &caller) {
            return Err(Error::NotSigner);
        }
        caller.require_auth();

        let signers: Vec<Address> = env
            .storage()
            .instance()
            .get(&DataKey::Signers)
            .unwrap_or_else(|| Vec::new(&env));

        if threshold_val == 0 || threshold_val > signers.len() {
            return Err(Error::InvalidThreshold);
        }

        env.storage()
            .instance()
            .set(&DataKey::ActionThreshold(action_name), &threshold_val);
        env.storage()
            .instance()
            .extend_ttl(TTL_THRESHOLD, TTL_EXTEND_TO);
        Ok(())
    }

    /// Query the configured threshold for an action type.
    pub fn get_action_threshold(env: Env, action_name: Symbol) -> u32 {
        env.storage()
            .instance()
            .get(&DataKey::ActionThreshold(action_name))
            .unwrap_or_else(|| threshold(&env))
    }

    /// Set platform_config contract address.
    pub fn set_platform_config(env: Env, caller: Address, platform_config: Address) -> Result<(), Error> {
        if !env.storage().instance().has(&DataKey::Initialized) {
            return Err(Error::NotInitialized);
        }
        if !is_signer(&env, &caller) {
            return Err(Error::NotSigner);
        }
        caller.require_auth();
        env.storage().instance().set(&DataKey::PlatformConfig, &platform_config);
        Ok(())
    }

    // ── Query functions ───────────────────────────────────────────────────────

    /// Return the proposal record for `id`.
    pub fn get_proposal(env: Env, id: u64) -> Result<Proposal, Error> {
        load_proposal(&env, id)
    }

    /// Return the current signer list.
    pub fn get_signers(env: Env) -> Vec<Address> {
        env.storage()
            .instance()
            .get(&DataKey::Signers)
            .unwrap_or_else(|| Vec::new(&env))
    }

    /// Return the current approval threshold.
    pub fn get_threshold(env: Env) -> u32 {
        threshold(&env)
    }

    /// Return the total number of proposals created so far.
    pub fn get_proposal_count(env: Env) -> u64 {
        env.storage()
            .instance()
            .get(&DataKey::ProposalSeq)
            .unwrap_or(0)
    }
}

// ─── Tests ────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod test {
    use super::*;
    use soroban_sdk::{
        testutils::{Address as _, Events, Ledger},
        Address, Env, IntoVal, String,
    };

    fn make_env() -> Env {
        let env = Env::default();
        env.mock_all_auths();
        env.ledger().with_mut(|l| l.timestamp = 1_000_000);
        env
    }

    fn signers(env: &Env, n: usize) -> Vec<Address> {
        let mut v = Vec::new(env);
        for _ in 0..n {
            v.push_back(Address::generate(env));
        }
        v
    }

    fn deploy(env: &Env, n_signers: usize, threshold: u32) -> (MultisigGovernanceContractClient<'static>, Vec<Address>) {
        let contract_id = env.register(MultisigGovernanceContract, ());
        let client = MultisigGovernanceContractClient::new(env, &contract_id);
        let s = signers(env, n_signers);
        client.initialize(&s, &threshold);
        (client, s)
    }

    fn action(env: &Env) -> GovernanceAction {
        let mut replacement_signers = Vec::new(env);
        replacement_signers.push_back(Address::generate(env));
        GovernanceAction::ChangeSigners(replacement_signers, 1)
    }

    // ── Basic proposal flow ───────────────────────────────────────────────────

    #[test]
    fn propose_creates_proposal_with_self_approval() {
        let env = make_env();
        let (client, s) = deploy(&env, 3, 2);
        let id = client.propose(&s.get(0).unwrap(), &String::from_str(&env, "T"), &String::from_str(&env, "D"), &action(&env));
        let p = client.get_proposal(&id);
        assert_eq!(p.approvals.len(), 1); // proposer auto-approved
        assert!(!p.executed);
        assert!(!p.cancelled);
    }

    #[test]
    fn non_signer_cannot_propose() {
        let env = make_env();
        let (client, _) = deploy(&env, 3, 2);
        let outsider = Address::generate(&env);
        assert_eq!(
            client.try_propose(&outsider, &String::from_str(&env, "T"), &String::from_str(&env, "D"), &action(&env)),
            Err(Ok(Error::NotSigner))
        );
    }

    #[test]
    fn non_signer_cannot_approve() {
        let env = make_env();
        let (client, s) = deploy(&env, 3, 2);
        let id = client.propose(
            &s.get(0).unwrap(),
            &String::from_str(&env, "T"),
            &String::from_str(&env, "D"),
            &action(&env),
        );
        let outsider = Address::generate(&env);
        assert_eq!(
            client.try_approve(&outsider, &id),
            Err(Ok(Error::NotSigner))
        );
    }

    #[test]
    fn approve_accumulates_signatures() {
        let env = make_env();
        let (client, s) = deploy(&env, 3, 3);
        let id = client.propose(&s.get(0).unwrap(), &String::from_str(&env, "T"), &String::from_str(&env, "D"), &action(&env));
        client.approve(&s.get(1).unwrap(), &id);
        client.approve(&s.get(2).unwrap(), &id);
        let p = client.get_proposal(&id);
        assert_eq!(p.approvals.len(), 3);
    }

    #[test]
    fn double_approval_rejected() {
        let env = make_env();
        let (client, s) = deploy(&env, 3, 2);
        let id = client.propose(&s.get(0).unwrap(), &String::from_str(&env, "T"), &String::from_str(&env, "D"), &action(&env));
        assert_eq!(
            client.try_approve(&s.get(0).unwrap(), &id),
            Err(Ok(Error::AlreadyApproved))
        );
    }

    #[test]
    fn threshold_rejections_block_execution() {
        let env = make_env();
        let (client, s) = deploy(&env, 3, 2);
        let id = client.propose(
            &s.get(0).unwrap(),
            &String::from_str(&env, "T"),
            &String::from_str(&env, "D"),
            &action(&env),
        );
        client.reject(&s.get(1).unwrap(), &id);
        client.reject(&s.get(2).unwrap(), &id);
        env.ledger().with_mut(|l| l.timestamp += TIMELOCK_SECS + 1);
        assert_eq!(
            client.try_execute(&s.get(0).unwrap(), &id),
            Err(Ok(Error::ProposalRejected))
        );
    }

    #[test]
    fn expiry_window_starts_when_threshold_is_reached() {
        let env = make_env();
        let (client, s) = deploy(&env, 3, 2);
        let id = client.propose(
            &s.get(0).unwrap(),
            &String::from_str(&env, "T"),
            &String::from_str(&env, "D"),
            &action(&env),
        );
        assert_eq!(client.get_proposal(&id).expires_at, 0);
        client.approve(&s.get(1).unwrap(), &id);
        assert_eq!(
            client.get_proposal(&id).expires_at,
            env.ledger().timestamp() + PROPOSAL_EXPIRY_SECS
        );
    }

    #[test]
    fn timelock_prevents_early_execution() {
        let env = make_env();
        let (client, s) = deploy(&env, 2, 2);
        let id = client.propose(&s.get(0).unwrap(), &String::from_str(&env, "T"), &String::from_str(&env, "D"), &action(&env));
        client.approve(&s.get(1).unwrap(), &id);
        // Try to execute before timelock elapses.
        assert_eq!(
            client.try_execute(&s.get(0).unwrap(), &id),
            Err(Ok(Error::TimelockNotElapsed))
        );
    }

    #[test]
    fn execute_succeeds_after_timelock() {
        let env = make_env();
        let (client, s) = deploy(&env, 2, 2);
        let id = client.propose(&s.get(0).unwrap(), &String::from_str(&env, "T"), &String::from_str(&env, "D"), &action(&env));
        client.approve(&s.get(1).unwrap(), &id);
        // Advance past timelock.
        env.ledger().with_mut(|l| l.timestamp += TIMELOCK_SECS + 1);
        client.execute(&s.get(0).unwrap(), &id);
        let p = client.get_proposal(&id);
        assert!(p.executed);
    }

    #[test]
    fn execute_emits_event() {
        let env = make_env();
        let (client, s) = deploy(&env, 1, 1);
        let id = client.propose(&s.get(0).unwrap(), &String::from_str(&env, "T"), &String::from_str(&env, "D"), &action(&env));
        env.ledger().with_mut(|l| l.timestamp += TIMELOCK_SECS + 1);
        client.execute(&s.get(0).unwrap(), &id);
        let events = env.events().all();
        // propose + execute = 2 events (approve not separate from propose)
        let last = events.last().unwrap();
        assert_eq!(
            last.1,
            (Symbol::new(&env, "GovernanceExecuted"),).into_val(&env)
        );
    }

    #[test]
    fn insufficient_approvals_blocks_execution() {
        let env = make_env();
        let (client, s) = deploy(&env, 3, 2);
        let id = client.propose(&s.get(0).unwrap(), &String::from_str(&env, "T"), &String::from_str(&env, "D"), &action(&env));
        // Only 1 approval (proposer). Threshold is 2.
        env.ledger().with_mut(|l| l.timestamp += TIMELOCK_SECS + 1);
        assert_eq!(
            client.try_execute(&s.get(0).unwrap(), &id),
            Err(Ok(Error::InsufficientApprovals))
        );
    }

    #[test]
    fn cancel_by_proposer_works() {
        let env = make_env();
        let (client, s) = deploy(&env, 3, 2);
        let id = client.propose(&s.get(0).unwrap(), &String::from_str(&env, "T"), &String::from_str(&env, "D"), &action(&env));
        client.cancel(&s.get(0).unwrap(), &id);
        let p = client.get_proposal(&id);
        assert!(p.cancelled);
    }

    #[test]
    fn cancel_by_non_proposer_rejected() {
        let env = make_env();
        let (client, s) = deploy(&env, 3, 2);
        let id = client.propose(&s.get(0).unwrap(), &String::from_str(&env, "T"), &String::from_str(&env, "D"), &action(&env));
        assert_eq!(
            client.try_cancel(&s.get(1).unwrap(), &id),
            Err(Ok(Error::Unauthorized))
        );
    }

    #[test]
    fn expired_proposal_cannot_be_executed() {
        let env = make_env();
        let (client, s) = deploy(&env, 1, 1);
        let id = client.propose(&s.get(0).unwrap(), &String::from_str(&env, "T"), &String::from_str(&env, "D"), &action(&env));
        // Advance past expiry.
        env.ledger().with_mut(|l| l.timestamp += PROPOSAL_EXPIRY_SECS + 1);
        assert_eq!(
            client.try_execute(&s.get(0).unwrap(), &id),
            Err(Ok(Error::ProposalExpired))
        );
    }

    #[test]
    fn change_signers_action_updates_signer_list() {
        let env = make_env();
        let (client, s) = deploy(&env, 1, 1);
        let new_signer = Address::generate(&env);
        let mut new_list = Vec::new(&env);
        new_list.push_back(new_signer.clone());
        let change_action = GovernanceAction::ChangeSigners(new_list, 1);
        let id = client.propose(&s.get(0).unwrap(), &String::from_str(&env, "T"), &String::from_str(&env, "D"), &change_action);
        env.ledger().with_mut(|l| l.timestamp += TIMELOCK_SECS + 1);
        client.execute(&s.get(0).unwrap(), &id);
        let stored = client.get_signers();
        assert!(stored.contains(&new_signer));
    }

    // ── Threshold validation, action types, revocation tests (Issue #416) ────

    #[test]
    fn threshold_boundary_enforcement() {
        let env = make_env();
        let (client, s) = deploy(&env, 4, 3); // 3 of 4 required
        let id = client.propose(&s.get(0).unwrap(), &String::from_str(&env, "T"), &String::from_str(&env, "D"), &action(&env));

        // Advance past timelock
        env.ledger().with_mut(|l| l.timestamp += TIMELOCK_SECS + 1);

        // 1 approval (proposer) < 3 -> should fail
        assert_eq!(
            client.try_execute(&s.get(0).unwrap(), &id),
            Err(Ok(Error::InsufficientApprovals))
        );

        // Add 2nd approval (M-1 = 2 sigs) -> should still fail
        client.approve(&s.get(1).unwrap(), &id);
        assert_eq!(
            client.try_execute(&s.get(0).unwrap(), &id),
            Err(Ok(Error::InsufficientApprovals))
        );

        // Add 3rd approval (M = 3 sigs) -> strictly meets threshold, must execute!
        client.approve(&s.get(2).unwrap(), &id);
        let exec_res = client.execute(&s.get(0).unwrap(), &id);
        assert_eq!(exec_res, ());
    }

    #[test]
    fn signature_revocation_and_readdition() {
        let env = make_env();
        let (client, s) = deploy(&env, 3, 2);
        let id = client.propose(&s.get(0).unwrap(), &String::from_str(&env, "T"), &String::from_str(&env, "D"), &action(&env));

        // Signer 1 approves (now 2 approvals)
        client.approve(&s.get(1).unwrap(), &id);
        assert_eq!(client.get_proposal(&id).approvals.len(), 2);

        // Signer 1 revokes approval
        client.revoke(&s.get(1).unwrap(), &id);
        assert_eq!(client.get_proposal(&id).approvals.len(), 1);

        // Cannot execute now since approvals dropped to 1 < 2
        env.ledger().with_mut(|l| l.timestamp += TIMELOCK_SECS + 1);
        assert_eq!(
            client.try_execute(&s.get(0).unwrap(), &id),
            Err(Ok(Error::InsufficientApprovals))
        );

        // Signer 1 re-approves -> back to 2 approvals
        client.approve(&s.get(1).unwrap(), &id);
        assert_eq!(client.get_proposal(&id).approvals.len(), 2);
        client.execute(&s.get(0).unwrap(), &id);
        assert!(client.get_proposal(&id).executed);
    }

    #[test]
    fn action_type_threshold_differentiation() {
        let env = make_env();
        let (client, s) = deploy(&env, 5, 2); // global threshold = 2

        // Set action-specific threshold for upgrade action: 4 approvals required
        let upgrade_sym = Symbol::new(&env, "upgrade");
        client.set_action_threshold(&s.get(0).unwrap(), &upgrade_sym, &4);
        assert_eq!(client.get_action_threshold(&upgrade_sym), 4);

        let target = Address::generate(&env);
        let hash = soroban_sdk::BytesN::from_array(&env, &[1u8; 32]);
        let upgrade_action = GovernanceAction::UpgradeContract(
            target,
            hash,
            String::from_str(&env, "2.0"),
            String::from_str(&env, "Upgrade"),
        );

        let id = client.propose(&s.get(0).unwrap(), &String::from_str(&env, "T"), &String::from_str(&env, "D"), &upgrade_action);
        env.ledger().with_mut(|l| l.timestamp += TIMELOCK_SECS + 1);

        // 2 approvals is enough for normal action, but not for upgrade which requires 4
        client.approve(&s.get(1).unwrap(), &id);
        assert_eq!(
            client.try_execute(&s.get(0).unwrap(), &id),
            Err(Ok(Error::InsufficientApprovals))
        );

        client.approve(&s.get(2).unwrap(), &id); // 3 approvals
        assert_eq!(
            client.try_execute(&s.get(0).unwrap(), &id),
            Err(Ok(Error::InsufficientApprovals))
        );

        client.approve(&s.get(3).unwrap(), &id); // 4 approvals -> now meets action threshold
    }

    #[test]
    fn signature_collection_window_expiry() {
        let env = make_env();
        let (client, s) = deploy(&env, 3, 2);
        let id = client.propose(&s.get(0).unwrap(), &String::from_str(&env, "T"), &String::from_str(&env, "D"), &action(&env));

        // Advance ledger past collection window
        env.ledger().with_mut(|l| l.sequence_number += DEFAULT_WINDOW_LEDGERS + 10);

        // Approvals after window expiry must fail
        assert_eq!(
            client.try_approve(&s.get(1).unwrap(), &id),
            Err(Ok(Error::ProposalExpired))
        );
    }
}
