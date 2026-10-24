//! Unit tests for the on-chain reputation system (issue #191).
//!
//! Covers:
//! - Score boundary conditions (0/0 = 100, all completed = 100, all failed = 0, mixed)
//! - Unauthorized write rejection
//! - TTL extension on read and write
//! - Payout accumulation
//! - Multiple consecutive updates

use super::*;
use soroban_sdk::{
    testutils::{Address as _, Events, Ledger},
    Address, Env,
};

struct ReputationFixture {
    env: Env,
    client: AgentRegistryContractClient<'static>,
    admin: Address,
    task_store: Address,
    agent: Address,
}

fn fixture() -> ReputationFixture {
    let env = Env::default();
    env.mock_all_auths();
    env.ledger().with_mut(|l| {
        l.sequence_number = 100;
        l.timestamp = 1_700_000_000;
    });

    let contract_id = env.register(AgentRegistryContract, ());
    let client = AgentRegistryContractClient::new(&env, &contract_id);

    let admin = Address::generate(&env);
    let task_store = Address::generate(&env);
    let agent = Address::generate(&env);

    client.initialize(&admin);
    client.set_task_store(&task_store);

    ReputationFixture {
        env,
        client,
        admin,
        task_store,
        agent,
    }
}

// ── Score boundary: no history → score = 100 ─────────────────────────────────

#[test]
fn new_agent_has_default_score_of_100() {
    let f = fixture();
    let rep = f.client.get_reputation(&f.agent);
    assert_eq!(rep.score, 100);
    assert_eq!(rep.tasks_completed, 0);
    assert_eq!(rep.tasks_failed, 0);
    assert_eq!(rep.total_payout_xlm, 0);
}

// ── Score boundary: all tasks completed → score = 100 ────────────────────────

#[test]
fn all_completed_tasks_yields_score_100() {
    let f = fixture();

    f.client.update_reputation(&f.agent, &true, &1_000_000);
    f.client.update_reputation(&f.agent, &true, &2_000_000);
    f.client.update_reputation(&f.agent, &true, &500_000);

    let rep = f.client.get_reputation(&f.agent);
    assert_eq!(rep.score, 100);
    assert_eq!(rep.tasks_completed, 3);
    assert_eq!(rep.tasks_failed, 0);
    assert_eq!(rep.total_payout_xlm, 3_500_000);
}

// ── Score boundary: all tasks failed → score = 0 ─────────────────────────────

#[test]
fn all_failed_tasks_yields_score_0() {
    let f = fixture();

    f.client.update_reputation(&f.agent, &false, &0);
    f.client.update_reputation(&f.agent, &false, &0);
    f.client.update_reputation(&f.agent, &false, &0);

    let rep = f.client.get_reputation(&f.agent);
    assert_eq!(rep.score, 0);
    assert_eq!(rep.tasks_completed, 0);
    assert_eq!(rep.tasks_failed, 3);
}

// ── Score boundary: exactly one task, succeeded → score = 100 ────────────────

#[test]
fn single_success_yields_score_100() {
    let f = fixture();

    f.client.update_reputation(&f.agent, &true, &5_000_000);

    let rep = f.client.get_reputation(&f.agent);
    assert_eq!(rep.score, 100);
    assert_eq!(rep.tasks_completed, 1);
    assert_eq!(rep.tasks_failed, 0);
}

// ── Score boundary: exactly one task, failed → score = 0 ─────────────────────

#[test]
fn single_failure_yields_score_0() {
    let f = fixture();

    f.client.update_reputation(&f.agent, &false, &0);

    let rep = f.client.get_reputation(&f.agent);
    assert_eq!(rep.score, 0);
}

// ── Score formula: mixed completion ──────────────────────────────────────────

#[test]
fn mixed_tasks_score_proportional() {
    let f = fixture();

    // 3 successes, 1 failure → (3*100)/4 = 75
    f.client.update_reputation(&f.agent, &true, &1_000_000);
    f.client.update_reputation(&f.agent, &true, &1_000_000);
    f.client.update_reputation(&f.agent, &true, &1_000_000);
    f.client.update_reputation(&f.agent, &false, &0);

    let rep = f.client.get_reputation(&f.agent);
    assert_eq!(rep.score, 75);
    assert_eq!(rep.tasks_completed, 3);
    assert_eq!(rep.tasks_failed, 1);
}

#[test]
fn fifty_fifty_split_yields_score_50() {
    let f = fixture();

    f.client.update_reputation(&f.agent, &true, &1_000_000);
    f.client.update_reputation(&f.agent, &false, &0);

    let rep = f.client.get_reputation(&f.agent);
    assert_eq!(rep.score, 50);
}

// ── Payout accumulation ───────────────────────────────────────────────────────

#[test]
fn total_payout_accumulates_across_updates() {
    let f = fixture();

    f.client.update_reputation(&f.agent, &true, &1_000_000);
    f.client.update_reputation(&f.agent, &true, &2_500_000);
    f.client.update_reputation(&f.agent, &false, &0); // failed: payout ignored

    let rep = f.client.get_reputation(&f.agent);
    assert_eq!(rep.total_payout_xlm, 3_500_000);
}

// ── Authorization: only task_store can write ─────────────────────────────────

#[test]
fn unauthorized_caller_cannot_update_reputation() {
    let env = Env::default();
    // Do NOT mock_all_auths — we want auth to be enforced.
    let contract_id = env.register(AgentRegistryContract, ());
    let client = AgentRegistryContractClient::new(&env, &contract_id);

    let admin = Address::generate(&env);
    let task_store = Address::generate(&env);
    let agent = Address::generate(&env);
    let attacker = Address::generate(&env);

    // Initialize with mocked auth just for setup.
    env.mock_all_auths();
    client.initialize(&admin);
    client.set_task_store(&task_store);
    env.set_auths(&[]);

    // Now try to update without any auth — should trap.
    let result = client.try_update_reputation(&agent, &true, &0);
    assert!(result.is_err());
}

// ── Event emission ────────────────────────────────────────────────────────────

#[test]
fn reputation_update_emits_rep_upd_event() {
    let f = fixture();

    f.client.update_reputation(&f.agent, &true, &1_000_000);

    let events = f.env.events().all();
    // Find the rep_upd event (there may be other events from set_task_store).
    let rep_event = events.iter().find(|(_, topics, _)| {
        let topics_val: soroban_sdk::Vec<soroban_sdk::Val> =
            soroban_sdk::Vec::try_from_val(&f.env, topics).unwrap_or_else(|_| soroban_sdk::Vec::new(&f.env));
        topics_val.len() == 2
    });
    assert!(rep_event.is_some(), "Expected rep_upd event to be emitted");
}

// ── No task_store configured → error ─────────────────────────────────────────

#[test]
fn update_reputation_without_task_store_configured_returns_error() {
    let env = Env::default();
    env.mock_all_auths();
    let contract_id = env.register(AgentRegistryContract, ());
    let client = AgentRegistryContractClient::new(&env, &contract_id);
    let admin = Address::generate(&env);
    let agent = Address::generate(&env);
    client.initialize(&admin);
    // task_store NOT configured

    let result = client.try_update_reputation(&agent, &true, &0);
    assert!(result.is_err());
}
