#![cfg(test)]

use super::*;
use soroban_sdk::{
    testutils::{Address as _, Ledger as _, Events as _},
    Address, BytesN, Env,
};

fn setup() -> (Env, UpgradeManagerClient<'static>, Address) {
    let env = Env::default();
    env.mock_all_auths();
    let contract_id = env.register(UpgradeManager, ());
    let client = UpgradeManagerClient::new(&env, &contract_id);
    let admin = Address::generate(&env);
    let v1 = Version { major: 1, minor: 0, patch: 0 };
    let h1 = BytesN::from_array(&env, &[1u8; 32]);
    client.initialize(&admin, &v1, &h1);
    (env, client, admin)
}

fn new_hash(env: &Env, seed: u8) -> BytesN<32> {
    BytesN::from_array(env, &[seed; 32])
}

// ───────────────────── Timelock Tests ─────────────────────

#[test]
fn test_cannot_execute_before_timelock() {
    let (env, client, _admin) = setup();
    let v2 = Version { major: 1, minor: 1, patch: 0 };
    let h2 = new_hash(&env, 2);

    client.propose_upgrade(&h2, &v2);

    // Try to execute immediately — must fail
    let res = client.try_execute_upgrade();
    assert!(res.is_err());
}

#[test]
fn test_can_execute_after_timelock() {
    let (env, client, _admin) = setup();
    let v2 = Version { major: 1, minor: 1, patch: 0 };
    let h2 = new_hash(&env, 2);

    client.propose_upgrade(&h2, &v2);

    // Advance time past timelock
    env.ledger().set_timestamp(TIMELOCK_SECONDS + 1);
    client.execute_upgrade();

    assert_eq!(client.get_version(), v2);
}

// ───────────────────── Version Compatibility ─────────────────────

#[test]
fn test_version_must_be_greater() {
    let (env, client, _admin) = setup();
    let old_v = Version { major: 1, minor: 0, patch: 0 };
    let h2 = new_hash(&env, 2);

    let res = client.try_propose_upgrade(&h2, &old_v);
    assert!(res.is_err());
}

#[test]
fn test_version_must_be_same_major() {
    let (env, client, _admin) = setup();
    let v3 = Version { major: 2, minor: 0, patch: 0 };
    let h2 = new_hash(&env, 2);

    let res = client.try_propose_upgrade(&h2, &v3);
    assert!(res.is_err());
}

// ───────────────────── Rollback Tests ─────────────────────

#[test]
fn test_rollback_restores_previous() {
    let (env, client, _admin) = setup();
    let v1 = Version { major: 1, minor: 0, patch: 0 };
    let v2 = Version { major: 1, minor: 1, patch: 0 };
    let h2 = new_hash(&env, 2);

    client.propose_upgrade(&h2, &v2);
    env.ledger().set_timestamp(TIMELOCK_SECONDS + 1);
    client.execute_upgrade();

    // Rollback
    client.rollback();

    assert_eq!(client.get_version(), v1);
}

#[test]
fn test_rollback_window_closed() {
    let (env, client, _admin) = setup();
    let v2 = Version { major: 1, minor: 1, patch: 0 };
    let h2 = new_hash(&env, 2);

    client.propose_upgrade(&h2, &v2);
    env.ledger().set_timestamp(TIMELOCK_SECONDS + 1);
    client.execute_upgrade();

    // Advance past rollback window
    env.ledger().set_timestamp(TIMELOCK_SECONDS + 1 + ROLLBACK_WINDOW_SECONDS + 1);

    let res = client.try_rollback();
    assert!(res.is_err());
}

// ───────────────────── Migration Hook ─────────────────────

#[test]
fn test_migrate_runs_once() {
    let (env, client, _admin) = setup();
    let v2 = Version { major: 1, minor: 1, patch: 0 };
    let h2 = new_hash(&env, 2);

    client.propose_upgrade(&h2, &v2);
    env.ledger().set_timestamp(TIMELOCK_SECONDS + 1);
    client.execute_upgrade();

    // First migrate: OK
    client.migrate();

    // Second migrate: must fail
    let res = client.try_migrate();
    assert!(res.is_err());
}

// ───────────────────── Event Emission ─────────────────────

#[test]
fn test_events_emitted() {
    let (env, client, _admin) = setup();
    let v2 = Version { major: 1, minor: 1, patch: 0 };
    let h2 = new_hash(&env, 2);

    client.propose_upgrade(&h2, &v2);

    let events = env.events().all();
    assert!(events.len() >= 1);

    env.ledger().set_timestamp(TIMELOCK_SECONDS + 1);
    client.execute_upgrade();

    let events = env.events().all();
    assert!(events.len() >= 2);
}

// ───────────────────── Auth Tests ─────────────────────

#[test]
fn test_non_admin_cannot_propose() {
    let env = Env::default();
    let contract_id = env.register(UpgradeManager, ());
    let client = UpgradeManagerClient::new(&env, &contract_id);

    let admin = Address::generate(&env);
    let attacker = Address::generate(&env);
    let v1 = Version { major: 1, minor: 0, patch: 0 };
    let h1 = new_hash(&env, 1);
    let h2 = new_hash(&env, 2);
    let v2 = Version { major: 1, minor: 1, patch: 0 };

    env.mock_all_auths();
    client.initialize(&admin, &v1, &h1);

    // Only allow attacker auth — should be rejected since admin != attacker
    env.mock_auths(&[soroban_sdk::testutils::MockAuth {
        address: &attacker,
        invoke: &soroban_sdk::testutils::MockAuthInvoke {
            contract: &contract_id,
            fn_name: "propose_upgrade",
            args: (h2.clone(), v2.clone()).into_val(&env),
            sub_invokes: &[],
        },
    }]);

    let res = client.try_propose_upgrade(&h2, &v2);
    assert!(res.is_err());
}

// ───────────────────── Gas Estimation Notes ─────────────────────
// Soroban does not have a native gas estimation function in the SDK.
// Gas estimation is done off-chain via simulation.
// See: docs/UPGRADE_GUIDE.md for the gas benchmarking methodology.
// Approximate costs (from community benchmarks):
// - Storage write: ~25,000 gas
// - Auth check: ~20,000 gas
// - Event emission: ~10,000 gas
// - WASM update: ~50,000 gas (variable)
