#![cfg(test)]

use super::*;
use soroban_sdk::{
    testutils::{Address as _, Events as _, Ledger as _},
    token::{Client as TokenClient, StellarAssetClient},
    Address, Env,
};

/// Helper: deploy a mock XLM token and mint some to the submitter.
fn setup() -> (
    Env,
    PaymentEscrowClient<'static>,
    Address, // contract_id
    Address, // coordinator
    Address, // submitter
    Address, // xlm_token
) {
    let env = Env::default();
    env.mock_all_auths();

    let contract_id = env.register(PaymentEscrow, ());
    let client = PaymentEscrowClient::new(&env, &contract_id);

    let coordinator = Address::generate(&env);
    let submitter = Address::generate(&env);

    // Deploy a Stellar Asset Contract for XLM
    let xlm_admin = Address::generate(&env);
    let xlm_token = env.register_stellar_asset_contract_v2(xlm_admin.clone());
    let xlm_addr = xlm_token.address();

    // Mint XLM to submitter
    let sac = StellarAssetClient::new(&env, &xlm_addr);
    sac.mint(&submitter, &10_000i128);

    client.initialize(&coordinator, &xlm_addr);

    (env, client, contract_id, coordinator, submitter, xlm_addr)
}

#[test]
fn test_lock_funds_success() {
    let (env, client, contract_id, _coord, submitter, xlm_addr) = setup();

    client.lock_funds(&1u64, &submitter, &500i128);

    let record = client.get_escrow(&1u64);
    assert_eq!(record.task_id, 1);
    assert_eq!(record.submitter, submitter);
    assert_eq!(record.amount_xlm, 500);
    assert_eq!(record.status, EscrowStatus::Active);

    // Contract should hold the XLM
    let token = TokenClient::new(&env, &xlm_addr);
    assert_eq!(token.balance(&contract_id), 500);
    assert_eq!(token.balance(&submitter), 9_500);
}

#[test]
fn test_lock_zero_amount_rejected() {
    let (_env, client, _contract_id, _coord, submitter, _xlm) = setup();
    let res = client.try_lock_funds(&1u64, &submitter, &0i128);
    assert!(res.is_err());
}

#[test]
fn test_double_lock_rejected() {
    let (_env, client, _contract_id, _coord, submitter, _xlm) = setup();
    client.lock_funds(&1u64, &submitter, &100i128);
    let res = client.try_lock_funds(&1u64, &submitter, &200i128);
    assert!(res.is_err());
}

#[test]
fn test_release_funds_to_agent() {
    let (env, client, contract_id, _coord, submitter, xlm_addr) = setup();

    client.lock_funds(&1u64, &submitter, &500i128);
    client.release_funds(&1u64, &42u64);

    let record = client.get_escrow(&1u64);
    assert_eq!(record.status, EscrowStatus::Released);
    assert_eq!(record.agent_id, Some(42));

    // Contract should no longer hold the XLM
    let token = TokenClient::new(&env, &xlm_addr);
    assert_eq!(token.balance(&contract_id), 0);
}

#[test]
fn test_release_unauthorized() {
    let env = Env::default();
    let contract_id = env.register(PaymentEscrow, ());
    let client = PaymentEscrowClient::new(&env, &contract_id);

    let coordinator = Address::generate(&env);
    let submitter = Address::generate(&env);
    let attacker = Address::generate(&env);

    let xlm_admin = Address::generate(&env);
    let xlm_token = env.register_stellar_asset_contract_v2(xlm_admin.clone());
    let xlm_addr = xlm_token.address();

    env.mock_all_auths();
    let sac = StellarAssetClient::new(&env, &xlm_addr);
    sac.mint(&submitter, &1_000i128);

    client.initialize(&coordinator, &xlm_addr);
    client.lock_funds(&1u64, &submitter, &500i128);

    // Only authorize attacker
    env.mock_auths(&[soroban_sdk::testutils::MockAuth {
        address: &attacker,
        invoke: &soroban_sdk::testutils::MockAuthInvoke {
            contract: &contract_id,
            fn_name: "release_funds",
            args: (1u64, 42u64).into_val(&env),
            sub_invokes: &[],
        },
    }]);

    let res = client.try_release_funds(&1u64, &42u64);
    assert!(res.is_err());
}

#[test]
fn test_refund_funds_by_coordinator() {
    let (env, client, contract_id, _coord, submitter, xlm_addr) = setup();

    client.lock_funds(&1u64, &submitter, &500i128);
    client.refund_funds(&1u64);

    let record = client.get_escrow(&1u64);
    assert_eq!(record.status, EscrowStatus::Refunded);

    // Submitter should get XLM back
    let token = TokenClient::new(&env, &xlm_addr);
    assert_eq!(token.balance(&contract_id), 0);
    assert_eq!(token.balance(&submitter), 10_000);
}

#[test]
fn test_timeout_auto_refund() {
    let (env, client, contract_id, _coord, submitter, xlm_addr) = setup();

    client.lock_funds(&1u64, &submitter, &500i128);

    // Advance time past 7-day timeout
    env.ledger()
        .set_timestamp(ESCROW_TIMEOUT_SECONDS + 1);

    // Anyone can trigger timeout refund
    client.refund_funds(&1u64);

    let record = client.get_escrow(&1u64);
    assert_eq!(record.status, EscrowStatus::Refunded);

    let token = TokenClient::new(&env, &xlm_addr);
    assert_eq!(token.balance(&submitter), 10_000);
}

#[test]
fn test_is_timed_out() {
    let (env, client, _contract_id, _coord, submitter, _xlm) = setup();

    client.lock_funds(&1u64, &submitter, &500i128);

    assert!(!client.is_timed_out(&1u64));

    env.ledger()
        .set_timestamp(ESCROW_TIMEOUT_SECONDS + 1);

    assert!(client.is_timed_out(&1u64));
}

#[test]
fn test_refund_before_timeout_needs_coordinator() {
    let env = Env::default();
    let contract_id = env.register(PaymentEscrow, ());
    let client = PaymentEscrowClient::new(&env, &contract_id);

    let coordinator = Address::generate(&env);
    let submitter = Address::generate(&env);
    let attacker = Address::generate(&env);

    let xlm_admin = Address::generate(&env);
    let xlm_token = env.register_stellar_asset_contract_v2(xlm_admin.clone());
    let xlm_addr = xlm_token.address();

    env.mock_all_auths();
    let sac = StellarAssetClient::new(&env, &xlm_addr);
    sac.mint(&submitter, &1_000i128);

    client.initialize(&coordinator, &xlm_addr);
    client.lock_funds(&1u64, &submitter, &500i128);

    // Before timeout: attacker without coordinator auth should fail
    env.mock_auths(&[soroban_sdk::testutils::MockAuth {
        address: &attacker,
        invoke: &soroban_sdk::testutils::MockAuthInvoke {
            contract: &contract_id,
            fn_name: "refund_funds",
            args: (1u64,).into_val(&env),
            sub_invokes: &[],
        },
    }]);

    let res = client.try_refund_funds(&1u64);
    assert!(res.is_err());
}

#[test]
fn test_events_emitted() {
    let (env, client, _contract_id, _coord, submitter, _xlm) = setup();

    client.lock_funds(&1u64, &submitter, &500i128);
    let events_after_lock = env.events().all();
    assert!(!events_after_lock.is_empty());

    client.release_funds(&1u64, &42u64);
    let events_after_release = env.events().all();
    assert!(events_after_release.len() >= 2);
}

#[test]
fn test_refund_event_emitted() {
    let (env, client, _contract_id, _coord, submitter, _xlm) = setup();

    client.lock_funds(&1u64, &submitter, &500i128);
    client.refund_funds(&1u64);

    let events = env.events().all();
    // EscrowLocked + EscrowRefunded
    assert!(events.len() >= 2);
}
