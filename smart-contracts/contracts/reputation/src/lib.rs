#![no_std]

//! # On-Chain Reputation Contract
//!
//! Tracks reputation scores for agents based on task outcomes.
//!
//! ## Scoring Rules
//!
//! | Event                    | Score change       |
//! |--------------------------|--------------------|
//! | Successful task          | +10 points         |
//! | Failed task              | -20 points         |
//! | 5-star rating multiplier | × 1.5              |
//! | Time decay (per week)    | -5 % of current    |
//!
//! Scores are stored as fixed-point integers multiplied by 100 to retain two
//! decimal places (e.g., a score of 100.00 is stored as 10_000). The floor
//! is 0 — a score never goes negative.
//!
//! ## Authorization
//!
//! Only addresses registered via `add_authorized_caller` (typically the
//! `task_store` or coordinator contract) may call `record_outcome`.
//! `decay_reputation` is permissionless so it can be called by cron jobs or
//! any operator.
//!
//! ## Events
//!
//! | Event               | Topics                         |
//! |---------------------|--------------------------------|
//! | Outcome recorded    | `(reputation, outcome)`        |
//! | Decay applied       | `(reputation, decayed)`        |

mod errors;

pub use errors::Error;

use soroban_sdk::{
    contract, contractimpl, contracttype, symbol_short, Address, Env, Symbol, Vec,
};

// ─── Scoring constants ────────────────────────────────────────────────────────

/// Points awarded for a successful task (scaled ×100).
pub const SUCCESS_POINTS: i64 = 1_000; // 10.00 points
/// Points deducted for a failed task (scaled ×100).
pub const FAILURE_POINTS: i64 = 2_000; // 20.00 points
/// 5-star rating multiplier numerator (×100 precision: 150 = 1.5×).
pub const FIVE_STAR_MULTIPLIER_BPS: i64 = 150;
/// Weekly decay rate in basis points (5 % = 500 bps out of 10_000).
pub const DECAY_RATE_BPS: i64 = 500;
/// Seconds per week (7 × 86_400).
pub const SECONDS_PER_WEEK: u64 = 604_800;
/// Initial score for a first-time agent (scaled ×100).
pub const INITIAL_SCORE: i64 = 5_000; // 50.00 points

/// TTL threshold / target (ledgers).
const TTL_THRESHOLD: u32 = 50_000;
const TTL_EXTEND_TO: u32 = 241_920;

// ─── Types ────────────────────────────────────────────────────────────────────

/// Per-agent reputation record.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ReputationScore {
    /// The agent's identifier.
    pub agent_id: Symbol,
    /// Current score, scaled ×100 (e.g., 10_000 = 100.00 points).
    pub score: i64,
    /// Number of successful tasks.
    pub successful_tasks: u64,
    /// Number of failed tasks.
    pub failed_tasks: u64,
    /// UNIX timestamp (seconds) of the last outcome recorded.
    pub last_activity: u64,
    /// UNIX timestamp (seconds) of the most recent decay application.
    pub last_decay_at: u64,
}

/// Event emitted when an outcome is recorded for an agent.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct OutcomeRecordedEvent {
    pub agent_id: Symbol,
    pub task_id: Symbol,
    pub success: bool,
    pub rating: u32,
    pub new_score: i64,
}

/// Event emitted when time-decay is applied to an agent's score.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ReputationDecayedEvent {
    pub agent_id: Symbol,
    pub old_score: i64,
    pub new_score: i64,
    pub weeks_elapsed: u64,
}

/// Storage key enumeration.
#[contracttype]
#[derive(Clone)]
pub enum DataKey {
    Admin,
    /// Set of authorized caller addresses (e.g. task_store contract).
    AuthorizedCallers,
    /// Reputation record for an agent.
    Reputation(Symbol),
}

// ─── Contract ────────────────────────────────────────────────────────────────

#[contract]
pub struct ReputationContract;

// ─── Helpers ─────────────────────────────────────────────────────────────────

fn require_initialized(env: &Env) -> Result<(), Error> {
    if env.storage().instance().has(&DataKey::Admin) {
        Ok(())
    } else {
        Err(Error::NotInitialized)
    }
}

fn is_authorized_caller(env: &Env, addr: &Address) -> bool {
    let callers: Vec<Address> = env
        .storage()
        .instance()
        .get(&DataKey::AuthorizedCallers)
        .unwrap_or_else(|| Vec::new(env));
    callers.contains(addr)
}

fn load_or_create_score(env: &Env, agent_id: &Symbol) -> ReputationScore {
    env.storage()
        .persistent()
        .get(&DataKey::Reputation(agent_id.clone()))
        .unwrap_or_else(|| ReputationScore {
            agent_id: agent_id.clone(),
            score: INITIAL_SCORE,
            successful_tasks: 0,
            failed_tasks: 0,
            last_activity: env.ledger().timestamp(),
            last_decay_at: env.ledger().timestamp(),
        })
}

fn save_score(env: &Env, score: &ReputationScore) {
    env.storage()
        .persistent()
        .set(&DataKey::Reputation(score.agent_id.clone()), score);
    env.storage()
        .persistent()
        .extend_ttl(
            &DataKey::Reputation(score.agent_id.clone()),
            TTL_THRESHOLD,
            TTL_EXTEND_TO,
        );
}

/// Apply compound time-decay for `weeks_elapsed` weeks:
///   new_score = old_score × (1 - DECAY_RATE_BPS/10_000)^weeks
/// We iterate to avoid floating point; each iteration multiplies by
/// (10_000 - 500) / 10_000 = 0.95 in fixed-point.
fn apply_decay(score: i64, weeks_elapsed: u64) -> i64 {
    if weeks_elapsed == 0 {
        return score;
    }
    let mut s = score;
    for _ in 0..weeks_elapsed {
        // s *= (10_000 - DECAY_RATE_BPS) / 10_000
        s = s * (10_000 - DECAY_RATE_BPS) / 10_000;
    }
    s.max(0)
}

// ─── Implementation ───────────────────────────────────────────────────────────

#[contractimpl]
impl ReputationContract {
    // ── Initialization ────────────────────────────────────────────────────────

    /// Initialize the contract with an admin address.
    pub fn initialize(env: Env, admin: Address) -> Result<(), Error> {
        if env.storage().instance().has(&DataKey::Admin) {
            return Err(Error::AlreadyInitialized);
        }
        admin.require_auth();
        env.storage().instance().set(&DataKey::Admin, &admin);
        let empty: Vec<Address> = Vec::new(&env);
        env.storage()
            .instance()
            .set(&DataKey::AuthorizedCallers, &empty);
        env.storage()
            .instance()
            .extend_ttl(TTL_THRESHOLD, TTL_EXTEND_TO);
        Ok(())
    }

    // ── Authorization management ──────────────────────────────────────────────

    /// Add an address that is allowed to call `record_outcome`.
    ///
    /// Only the admin may add authorized callers.
    pub fn add_authorized_caller(env: Env, caller: Address) -> Result<(), Error> {
        require_initialized(&env)?;
        let admin: Address = env
            .storage()
            .instance()
            .get(&DataKey::Admin)
            .ok_or(Error::NotInitialized)?;
        admin.require_auth();

        let mut callers: Vec<Address> = env
            .storage()
            .instance()
            .get(&DataKey::AuthorizedCallers)
            .unwrap_or_else(|| Vec::new(&env));

        if callers.contains(&caller) {
            return Err(Error::CallerAlreadyRegistered);
        }

        callers.push_back(caller);
        env.storage()
            .instance()
            .set(&DataKey::AuthorizedCallers, &callers);
        env.storage()
            .instance()
            .extend_ttl(TTL_THRESHOLD, TTL_EXTEND_TO);

        Ok(())
    }

    /// Remove an authorized caller.
    pub fn remove_authorized_caller(env: Env, caller: Address) -> Result<(), Error> {
        require_initialized(&env)?;
        let admin: Address = env
            .storage()
            .instance()
            .get(&DataKey::Admin)
            .ok_or(Error::NotInitialized)?;
        admin.require_auth();

        let callers: Vec<Address> = env
            .storage()
            .instance()
            .get(&DataKey::AuthorizedCallers)
            .unwrap_or_else(|| Vec::new(&env));

        let mut updated = Vec::new(&env);
        let mut found = false;
        for c in callers.iter() {
            if c == caller {
                found = true;
            } else {
                updated.push_back(c);
            }
        }

        if !found {
            return Err(Error::CallerNotFound);
        }

        env.storage()
            .instance()
            .set(&DataKey::AuthorizedCallers, &updated);
        env.storage()
            .instance()
            .extend_ttl(TTL_THRESHOLD, TTL_EXTEND_TO);

        Ok(())
    }

    // ── Core operations ───────────────────────────────────────────────────────

    /// Record a task outcome for an agent.
    ///
    /// Only addresses registered via `add_authorized_caller` may call this.
    /// The caller must authorise the transaction.
    ///
    /// `rating` must be in the range `[0, 5]`.
    ///
    /// Scoring:
    /// - `success = true`:  +10 points (× 1.5 if rating == 5)
    /// - `success = false`: -20 points
    ///
    /// Emits `(reputation, outcome)`.
    pub fn record_outcome(
        env: Env,
        caller: Address,
        agent_id: Symbol,
        task_id: Symbol,
        success: bool,
        rating: u32,
    ) -> Result<(), Error> {
        require_initialized(&env)?;

        if !is_authorized_caller(&env, &caller) {
            return Err(Error::Unauthorized);
        }
        caller.require_auth();

        if rating > 5 {
            return Err(Error::InvalidRating);
        }

        let mut rep = load_or_create_score(&env, &agent_id);
        let old_score = rep.score;

        let delta: i64 = if success {
            let base = SUCCESS_POINTS;
            if rating == 5 {
                base * FIVE_STAR_MULTIPLIER_BPS / 100
            } else {
                base
            }
        } else {
            -FAILURE_POINTS
        };

        rep.score = (old_score + delta).max(0);

        if success {
            rep.successful_tasks += 1;
        } else {
            rep.failed_tasks += 1;
        }
        rep.last_activity = env.ledger().timestamp();

        save_score(&env, &rep);

        env.events().publish(
            (symbol_short!("reputat"), symbol_short!("outcome")),
            OutcomeRecordedEvent {
                agent_id,
                task_id,
                success,
                rating,
                new_score: rep.score,
            },
        );

        Ok(())
    }

    /// Apply time-decay to an agent's reputation score.
    ///
    /// Calculates the number of complete weeks since the last decay and
    /// applies 5 % compound decay per week.
    ///
    /// This function is **permissionless** — any caller may invoke it (e.g.,
    /// a cron operator or the agent themselves).
    ///
    /// Emits `(reputation, decayed)` if any decay was applied.
    pub fn decay_reputation(env: Env, agent_id: Symbol) -> Result<(), Error> {
        require_initialized(&env)?;

        let mut rep = load_or_create_score(&env, &agent_id);

        let now = env.ledger().timestamp();
        let elapsed_secs = now.saturating_sub(rep.last_decay_at);
        let weeks_elapsed = elapsed_secs / SECONDS_PER_WEEK;

        if weeks_elapsed == 0 {
            return Ok(());
        }

        let old_score = rep.score;
        rep.score = apply_decay(old_score, weeks_elapsed);
        rep.last_decay_at = rep.last_decay_at + weeks_elapsed * SECONDS_PER_WEEK;

        save_score(&env, &rep);

        env.events().publish(
            (symbol_short!("reputat"), symbol_short!("decayed")),
            ReputationDecayedEvent {
                agent_id,
                old_score,
                new_score: rep.score,
                weeks_elapsed,
            },
        );

        Ok(())
    }

    // ── Query functions ───────────────────────────────────────────────────────

    /// Return the full reputation record for an agent.
    pub fn get_reputation(env: Env, agent_id: Symbol) -> Result<ReputationScore, Error> {
        require_initialized(&env)?;
        env.storage()
            .persistent()
            .get(&DataKey::Reputation(agent_id))
            .ok_or(Error::AgentNotFound)
    }

    /// Return the current score for an agent (scaled ×100).
    pub fn get_score(env: Env, agent_id: Symbol) -> i64 {
        env.storage()
            .persistent()
            .get::<DataKey, ReputationScore>(&DataKey::Reputation(agent_id))
            .map(|r| r.score)
            .unwrap_or(INITIAL_SCORE)
    }

    /// Return the list of authorized callers.
    pub fn get_authorized_callers(env: Env) -> Vec<Address> {
        env.storage()
            .instance()
            .get(&DataKey::AuthorizedCallers)
            .unwrap_or_else(|| Vec::new(&env))
    }
}

// ─── Tests ────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod test {
    use super::*;
    use soroban_sdk::{
        testutils::{Address as _, Events, Ledger},
        Address, Env, IntoVal, Symbol,
    };

    fn make_fixture() -> (Env, ReputationContractClient<'static>, Address, Address) {
        let env = Env::default();
        env.mock_all_auths();
        env.ledger().with_mut(|l| l.timestamp = 1_000_000);
        let contract_id = env.register(ReputationContract, ());
        let client = ReputationContractClient::new(&env, &contract_id);
        let admin = Address::generate(&env);
        let task_store = Address::generate(&env);
        client.initialize(&admin);
        client.add_authorized_caller(&task_store);
        (env, client, admin, task_store)
    }

    fn agent(env: &Env) -> Symbol {
        Symbol::new(env, "agent1")
    }

    fn task(env: &Env) -> Symbol {
        Symbol::new(env, "task1")
    }

    // ── record_outcome ────────────────────────────────────────────────────────

    #[test]
    fn success_increases_score() {
        let (env, client, _, caller) = make_fixture();
        let a = agent(&env);
        client.record_outcome(&caller, &a, &task(&env), &true, &0u32);
        let rep = client.get_reputation(&a);
        // Initial 50.00 (5_000) + 10.00 (1_000) = 60.00 (6_000)
        assert_eq!(rep.score, INITIAL_SCORE + SUCCESS_POINTS);
    }

    #[test]
    fn failure_decreases_score() {
        let (env, client, _, caller) = make_fixture();
        let a = agent(&env);
        client.record_outcome(&caller, &a, &task(&env), &false, &0u32);
        let rep = client.get_reputation(&a);
        // Initial 50.00 (5_000) - 20.00 (2_000) = 30.00 (3_000)
        assert_eq!(rep.score, INITIAL_SCORE - FAILURE_POINTS);
    }

    #[test]
    fn five_star_applies_multiplier() {
        let (env, client, _, caller) = make_fixture();
        let a = agent(&env);
        client.record_outcome(&caller, &a, &task(&env), &true, &5u32);
        let rep = client.get_reputation(&a);
        // 10.00 × 1.5 = 15.00 (1_500 scaled)
        let expected = INITIAL_SCORE + SUCCESS_POINTS * FIVE_STAR_MULTIPLIER_BPS / 100;
        assert_eq!(rep.score, expected);
    }

    #[test]
    fn score_cannot_go_below_zero() {
        let (env, client, _, caller) = make_fixture();
        let a = agent(&env);
        // Record 100 failures: 100 × 2_000 = 200_000 >> INITIAL_SCORE (5_000).
        for _ in 0..100u32 {
            client.record_outcome(&caller, &a, &task(&env), &false, &0u32);
        }
        let rep = client.get_reputation(&a);
        assert_eq!(rep.score, 0);
    }

    #[test]
    fn unauthorized_caller_rejected() {
        let (env, client, _, _) = make_fixture();
        let stranger = Address::generate(&env);
        assert_eq!(
            client.try_record_outcome(&stranger, &agent(&env), &task(&env), &true, &0u32),
            Err(Ok(Error::Unauthorized))
        );
    }

    #[test]
    fn invalid_rating_rejected() {
        let (env, client, _, caller) = make_fixture();
        assert_eq!(
            client.try_record_outcome(&caller, &agent(&env), &task(&env), &true, &6u32),
            Err(Ok(Error::InvalidRating))
        );
    }

    #[test]
    fn outcome_emits_event() {
        let (env, client, _, caller) = make_fixture();
        client.record_outcome(&caller, &agent(&env), &task(&env), &true, &3u32);
        let events = env.events().all();
        assert_eq!(events.len(), 1);
        assert_eq!(
            events.get(0).unwrap().1,
            (symbol_short!("reputat"), symbol_short!("outcome")).into_val(&env)
        );
    }

    // ── decay_reputation ──────────────────────────────────────────────────────

    #[test]
    fn decay_applies_after_one_week() {
        let (env, client, _, caller) = make_fixture();
        let a = agent(&env);
        client.record_outcome(&caller, &a, &task(&env), &true, &0u32);
        let before = client.get_reputation(&a).score;

        // Advance 1 week + 1 second.
        env.ledger()
            .with_mut(|l| l.timestamp += SECONDS_PER_WEEK + 1);
        client.decay_reputation(&a);

        let after = client.get_reputation(&a).score;
        // Expect 5 % reduction.
        let expected = before * (10_000 - DECAY_RATE_BPS) / 10_000;
        assert_eq!(after, expected);
    }

    #[test]
    fn decay_emits_event() {
        let (env, client, _, caller) = make_fixture();
        let a = agent(&env);
        client.record_outcome(&caller, &a, &task(&env), &true, &0u32);
        env.ledger()
            .with_mut(|l| l.timestamp += SECONDS_PER_WEEK + 1);
        client.decay_reputation(&a);
        let events = env.events().all();
        let last = events.last().unwrap();
        assert_eq!(
            last.1,
            (symbol_short!("reputat"), symbol_short!("decayed")).into_val(&env)
        );
    }

    #[test]
    fn no_decay_before_one_week() {
        let (env, client, _, caller) = make_fixture();
        let a = agent(&env);
        client.record_outcome(&caller, &a, &task(&env), &true, &0u32);
        let before = client.get_reputation(&a).score;

        // Less than 1 week elapsed.
        env.ledger()
            .with_mut(|l| l.timestamp += SECONDS_PER_WEEK - 1);
        client.decay_reputation(&a);

        assert_eq!(client.get_reputation(&a).score, before);
    }

    #[test]
    fn multi_week_compound_decay() {
        let (env, client, _, caller) = make_fixture();
        let a = agent(&env);
        client.record_outcome(&caller, &a, &task(&env), &true, &0u32);
        let before = client.get_reputation(&a).score;

        env.ledger()
            .with_mut(|l| l.timestamp += 3 * SECONDS_PER_WEEK + 1);
        client.decay_reputation(&a);
        let after = client.get_reputation(&a).score;
        let expected = apply_decay(before, 3);
        assert_eq!(after, expected);
    }

    // ── get_reputation ────────────────────────────────────────────────────────

    #[test]
    fn get_reputation_returns_not_found_for_unknown_agent() {
        let (env, client, _, _) = make_fixture();
        let unknown = Symbol::new(&env, "unknown1");
        assert_eq!(
            client.try_get_reputation(&unknown),
            Err(Ok(Error::AgentNotFound))
        );
    }
}
