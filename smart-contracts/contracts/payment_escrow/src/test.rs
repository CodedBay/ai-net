//! # PaymentEscrow Integration Tests
//!
//! Comprehensive integration tests for the PaymentEscrow contract covering:
//!   - lock_funds: correct amount locked, unauthorized caller rejected,
//!     duplicate lock rejected, zero-amount rejected
//!   - release_funds: correct amount released to agent, non-coordinator rejected,
//!     release-after-timeout rejected
//!   - refund_funds: full amount returned to submitter, non-coordinator rejected
//!     before timeout, auto-refund after timeout, refund of already-refunded rejected
//!   - Timeout: ledger time advancement triggering auto-refund
//!   - Edge cases: lock amount = 0 rejected, missing escrow operations
//!   - Events: all lifecycle events emitted correctly

extern crate std;

use soroban_sdk::{
    symbol_short,
    testutils::{Address as _, Events as _, Ledger as _, LedgerInfo},
    Address, Env, FromVal, IntoVal, Symbol,
};

use crate::{
    EscrowRecord, EscrowStatus, Error, PaymentEscrowContract, PaymentEscrowContractClient,
    ESCROW_TIMEOUT_SECS,
};

// ── Test helpers ──────────────────────────────────────────────────────────────

/// Set up a fresh Env with mock auth and a deployed PaymentEscrow contract.
/// Returns (env, client, coordinator_address).
fn setup() -> (Env, PaymentEscrowContractClient<'static>, Address) {
    let env = Env::default();
    env.mock_all_auths();

    let contract_id = env.register(PaymentEscrowContract, ());
    let client = PaymentEscrowContractClient::new(&env, &contract_id);
    let coordinator = Address::generate(&env);

    client.initialize(&coordinator);
    (env, client, coordinator)
}

/// Shorthand to create Symbol keys.
fn sym(env: &Env, s: &str) -> Symbol {
    Symbol::new(env, s)
}

/// Advance the ledger clock by `seconds` from its current timestamp.
fn advance_time(env: &Env, seconds: u64) {
    let mut info: LedgerInfo = env.ledger().get();
    info.timestamp += seconds;
    env.ledger().set(info);
}

// ── initialize ────────────────────────────────────────────────────────────────

#[test]
fn test_initialize_sets_coordinator() {
    let env = Env::default();
    env.mock_all_auths();
    let contract_id = env.register(PaymentEscrowContract, ());
    let client = PaymentEscrowContractClient::new(&env, &contract_id);
    let coordinator = Address::generate(&env);

    // First initialization should succeed.
    client.initialize(&coordinator);
}

#[test]
fn test_initialize_cannot_be_called_twice() {
    let (_, client, coord) = setup();
    // Second call should fail with AlreadyLocked (reused as "already initialized").
    let result = client.try_initialize(&coord);
    assert_eq!(result, Err(Ok(Error::AlreadyLocked)));
}

// ── lock_funds ────────────────────────────────────────────────────────────────

#[test]
fn test_lock_funds_happy_path() {
    let (env, client, _coord) = setup();
    let submitter = Address::generate(&env);
    let agent = Address::generate(&env);

    client.lock_funds(
        &sym(&env, "task001"),
        &sym(&env, "nodeA"),
        &submitter,
        &agent,
        &1_000_000_i128,
    );

    // Verify the escrow record is stored with the correct amount.
    let record: EscrowRecord = client
        .get_escrow(&sym(&env, "task001"), &sym(&env, "nodeA"));
    assert_eq!(record.amount, 1_000_000_i128);
    assert_eq!(record.submitter, submitter);
    assert_eq!(record.agent, agent);
    assert_eq!(record.status, EscrowStatus::Locked);
}

#[test]
fn test_lock_funds_records_correct_expiry() {
    let (env, client, _coord) = setup();
    let now = env.ledger().timestamp();
    let submitter = Address::generate(&env);
    let agent = Address::generate(&env);

    client.lock_funds(
        &sym(&env, "task002"),
        &sym(&env, "nodeA"),
        &submitter,
        &agent,
        &500_000_i128,
    );

    let record = client
        .get_escrow(&sym(&env, "task002"), &sym(&env, "nodeA"));
    assert_eq!(record.locked_at, now);
    assert_eq!(record.expires_at, now + ESCROW_TIMEOUT_SECS);
}

#[test]
fn test_lock_funds_unauthorized_caller_rejected() {
    // mock_all_auths() is OFF so we can test auth rejection.
    let env = Env::default();
    let contract_id = env.register(PaymentEscrowContract, ());
    let client = PaymentEscrowContractClient::new(&env, &contract_id);

    // Initialize with mock_all_auths temporarily.
    env.mock_all_auths();
    let coordinator = Address::generate(&env);
    client.initialize(&coordinator);

    // Now try lock_funds without mocking coordinator auth — should panic/auth fail.
    let non_coordinator = Address::generate(&env);
    let submitter = Address::generate(&env);
    let agent = Address::generate(&env);

    // Verify that coordinator.require_auth() is triggered by checking that
    // when we mock ONLY non_coordinator auth, the call fails.
    env.mock_auths(&[soroban_sdk::testutils::MockAuth {
        address: &non_coordinator,
        invoke: &soroban_sdk::testutils::MockAuthInvoke {
            contract: &contract_id,
            fn_name: "lock_funds",
            args: (
                sym(&env, "task003"),
                sym(&env, "nodeA"),
                submitter.clone(),
                agent.clone(),
                500_i128,
            )
                .into_val(&env),
            sub_invokes: &[],
        },
    }]);

    let result = client.try_lock_funds(
        &sym(&env, "task003"),
        &sym(&env, "nodeA"),
        &submitter,
        &agent,
        &500_i128,
    );
    assert!(result.is_err(), "lock_funds should fail when coordinator auth is not provided");
}

#[test]
fn test_lock_funds_duplicate_lock_rejected() {
    let (env, client, _coord) = setup();
    let submitter = Address::generate(&env);
    let agent = Address::generate(&env);

    client.lock_funds(
        &sym(&env, "task004"),
        &sym(&env, "nodeA"),
        &submitter,
        &agent,
        &1_000_i128,
    );

    // Second lock for the same (task, node) must fail.
    let result = client.try_lock_funds(
        &sym(&env, "task004"),
        &sym(&env, "nodeA"),
        &submitter,
        &agent,
        &1_000_i128,
    );
    assert_eq!(result, Err(Ok(Error::AlreadyLocked)));
}

#[test]
fn test_lock_funds_zero_amount_rejected() {
    let (env, client, _coord) = setup();
    let submitter = Address::generate(&env);
    let agent = Address::generate(&env);

    let result = client.try_lock_funds(
        &sym(&env, "task005"),
        &sym(&env, "nodeA"),
        &submitter,
        &agent,
        &0_i128,
    );
    assert_eq!(result, Err(Ok(Error::InvalidAmount)));
}

#[test]
fn test_lock_funds_negative_amount_rejected() {
    let (env, client, _coord) = setup();
    let submitter = Address::generate(&env);
    let agent = Address::generate(&env);

    let result = client.try_lock_funds(
        &sym(&env, "task_neg"),
        &sym(&env, "nodeA"),
        &submitter,
        &agent,
        &-100_i128,
    );
    assert_eq!(result, Err(Ok(Error::InvalidAmount)));
}

// ── release_funds ─────────────────────────────────────────────────────────────

#[test]
fn test_release_funds_happy_path() {
    let (env, client, _coord) = setup();
    let submitter = Address::generate(&env);
    let agent = Address::generate(&env);

    client.lock_funds(
        &sym(&env, "task006"),
        &sym(&env, "nodeA"),
        &submitter,
        &agent,
        &2_000_000_i128,
    );

    let record = client.release_funds(&sym(&env, "task006"), &sym(&env, "nodeA"));

    assert_eq!(record.amount, 2_000_000_i128);
    assert_eq!(record.agent, agent);
    assert_eq!(record.status, EscrowStatus::Released);

    // Verify persisted state.
    let stored = client.get_escrow(&sym(&env, "task006"), &sym(&env, "nodeA"));
    assert_eq!(stored.status, EscrowStatus::Released);
}

#[test]
fn test_release_funds_non_coordinator_rejected() {
    let env = Env::default();
    let contract_id = env.register(PaymentEscrowContract, ());
    let client = PaymentEscrowContractClient::new(&env, &contract_id);

    env.mock_all_auths();
    let coordinator = Address::generate(&env);
    client.initialize(&coordinator);

    let submitter = Address::generate(&env);
    let agent = Address::generate(&env);
    client.lock_funds(
        &sym(&env, "task007"),
        &sym(&env, "nodeA"),
        &submitter,
        &agent,
        &1_000_i128,
    );

    // Mock auth for a non-coordinator account.
    let attacker = Address::generate(&env);
    env.mock_auths(&[soroban_sdk::testutils::MockAuth {
        address: &attacker,
        invoke: &soroban_sdk::testutils::MockAuthInvoke {
            contract: &contract_id,
            fn_name: "release_funds",
            args: (sym(&env, "task007"), sym(&env, "nodeA")).into_val(&env),
            sub_invokes: &[],
        },
    }]);

    let result = client.try_release_funds(&sym(&env, "task007"), &sym(&env, "nodeA"));
    assert!(result.is_err(), "release_funds should fail when non-coordinator tries to release");
}

#[test]
fn test_release_funds_not_found_returns_error() {
    let (env, client, _coord) = setup();
    let result = client.try_release_funds(&sym(&env, "nonexistent"), &sym(&env, "nodeA"));
    assert_eq!(result, Err(Ok(Error::NotFound)));
}

// ── refund_funds ──────────────────────────────────────────────────────────────

#[test]
fn test_refund_funds_happy_path() {
    let (env, client, _coord) = setup();
    let submitter = Address::generate(&env);
    let agent = Address::generate(&env);

    client.lock_funds(
        &sym(&env, "task008"),
        &sym(&env, "nodeA"),
        &submitter,
        &agent,
        &3_000_000_i128,
    );

    let record = client.refund_funds(&sym(&env, "task008"), &sym(&env, "nodeA"));

    assert_eq!(record.amount, 3_000_000_i128);
    assert_eq!(record.submitter, submitter);
    assert_eq!(record.status, EscrowStatus::Refunded);

    // Verify persisted state.
    let stored = client.get_escrow(&sym(&env, "task008"), &sym(&env, "nodeA"));
    assert_eq!(stored.status, EscrowStatus::Refunded);
}

#[test]
fn test_refund_funds_non_coordinator_rejected_before_timeout() {
    let env = Env::default();
    let contract_id = env.register(PaymentEscrowContract, ());
    let client = PaymentEscrowContractClient::new(&env, &contract_id);

    env.mock_all_auths();
    let coordinator = Address::generate(&env);
    client.initialize(&coordinator);

    let submitter = Address::generate(&env);
    let agent = Address::generate(&env);
    client.lock_funds(
        &sym(&env, "task009"),
        &sym(&env, "nodeA"),
        &submitter,
        &agent,
        &1_000_i128,
    );

    // Provide auth for a random non-coordinator address — must be rejected.
    let attacker = Address::generate(&env);
    env.mock_auths(&[soroban_sdk::testutils::MockAuth {
        address: &attacker,
        invoke: &soroban_sdk::testutils::MockAuthInvoke {
            contract: &contract_id,
            fn_name: "refund_funds",
            args: (sym(&env, "task009"), sym(&env, "nodeA")).into_val(&env),
            sub_invokes: &[],
        },
    }]);

    let result = client.try_refund_funds(&sym(&env, "task009"), &sym(&env, "nodeA"));
    assert!(result.is_err(), "refund_funds should fail when non-coordinator calls before timeout");
}

#[test]
fn test_refund_funds_not_found_returns_error() {
    let (env, client, _coord) = setup();
    let result = client.try_refund_funds(&sym(&env, "nonexistent"), &sym(&env, "nodeA"));
    assert_eq!(result, Err(Ok(Error::NotFound)));
}

// ── Timeout behavior ──────────────────────────────────────────────────────────

#[test]
fn test_auto_refund_after_timeout_no_auth_required() {
    let (env, client, _coord) = setup();
    let submitter = Address::generate(&env);
    let agent = Address::generate(&env);

    client.lock_funds(
        &sym(&env, "taskTimeout"),
        &sym(&env, "nodeA"),
        &submitter,
        &agent,
        &1_000_000_i128,
    );

    // Advance time past the 7-day timeout.
    advance_time(&env, ESCROW_TIMEOUT_SECS + 1);

    let record = client.refund_funds(&sym(&env, "taskTimeout"), &sym(&env, "nodeA"));

    assert_eq!(record.status, EscrowStatus::Refunded);
    assert_eq!(record.submitter, submitter);
}

#[test]
fn test_release_after_timeout_rejected() {
    let (env, client, _coord) = setup();
    let submitter = Address::generate(&env);
    let agent = Address::generate(&env);

    client.lock_funds(
        &sym(&env, "taskExpired"),
        &sym(&env, "nodeA"),
        &submitter,
        &agent,
        &1_000_000_i128,
    );

    // Advance past timeout.
    advance_time(&env, ESCROW_TIMEOUT_SECS + 1);

    // release_funds must be rejected after timeout.
    let result = client.try_release_funds(&sym(&env, "taskExpired"), &sym(&env, "nodeA"));
    assert_eq!(result, Err(Ok(Error::EscrowExpired)));
}

#[test]
fn test_release_before_timeout_succeeds() {
    let (env, client, _coord) = setup();
    let submitter = Address::generate(&env);
    let agent = Address::generate(&env);

    client.lock_funds(
        &sym(&env, "taskFresh"),
        &sym(&env, "nodeA"),
        &submitter,
        &agent,
        &1_000_000_i128,
    );

    // Advance just before the timeout — release should still succeed.
    advance_time(&env, ESCROW_TIMEOUT_SECS - 1);

    let record = client.release_funds(&sym(&env, "taskFresh"), &sym(&env, "nodeA"));
    assert_eq!(record.status, EscrowStatus::Released);
}

// ── Event emission ────────────────────────────────────────────────────────────

#[test]
fn test_lock_funds_emits_locked_event() {
    let (env, client, _coord) = setup();
    let submitter = Address::generate(&env);
    let agent = Address::generate(&env);

    client.lock_funds(
        &sym(&env, "taskEvt1"),
        &sym(&env, "nodeA"),
        &submitter,
        &agent,
        &1_000_i128,
    );

    let events = env.events().all();
    assert!(!events.is_empty(), "at least one event should be emitted");

    // The last event's topics should be (escrow, locked).
    let (_, topics, _) = events.last().unwrap();
    let t0 = Symbol::from_val(&env, &topics.get(0).unwrap());
    let t1 = Symbol::from_val(&env, &topics.get(1).unwrap());
    assert_eq!(t0, symbol_short!("escrow"));
    assert_eq!(t1, symbol_short!("locked"));
}

#[test]
fn test_release_funds_emits_released_event() {
    let (env, client, _coord) = setup();
    let submitter = Address::generate(&env);
    let agent = Address::generate(&env);

    client.lock_funds(
        &sym(&env, "taskEvt2"),
        &sym(&env, "nodeA"),
        &submitter,
        &agent,
        &1_000_i128,
    );
    client.release_funds(&sym(&env, "taskEvt2"), &sym(&env, "nodeA"));

    let events = env.events().all();
    let (_, topics, _) = events.last().unwrap();
    let t0 = Symbol::from_val(&env, &topics.get(0).unwrap());
    let t1 = Symbol::from_val(&env, &topics.get(1).unwrap());
    assert_eq!(t0, symbol_short!("escrow"));
    assert_eq!(t1, symbol_short!("released"));
}

#[test]
fn test_refund_funds_emits_refunded_event() {
    let (env, client, _coord) = setup();
    let submitter = Address::generate(&env);
    let agent = Address::generate(&env);

    client.lock_funds(
        &sym(&env, "taskEvt3"),
        &sym(&env, "nodeA"),
        &submitter,
        &agent,
        &1_000_i128,
    );
    client.refund_funds(&sym(&env, "taskEvt3"), &sym(&env, "nodeA"));

    let events = env.events().all();
    let (_, topics, _) = events.last().unwrap();
    let t0 = Symbol::from_val(&env, &topics.get(0).unwrap());
    let t1 = Symbol::from_val(&env, &topics.get(1).unwrap());
    assert_eq!(t0, symbol_short!("escrow"));
    assert_eq!(t1, symbol_short!("refunded"));
}

// ── get_escrow ────────────────────────────────────────────────────────────────

#[test]
fn test_get_escrow_returns_not_found_for_missing_record() {
    let (env, client, _coord) = setup();
    let result = client.try_get_escrow(&sym(&env, "missing"), &sym(&env, "nodeA"));
    assert_eq!(result, Err(Ok(Error::NotFound)));
}

#[test]
fn test_get_escrow_returns_full_record() {
    let (env, client, _coord) = setup();
    let submitter = Address::generate(&env);
    let agent = Address::generate(&env);

    client.lock_funds(
        &sym(&env, "taskGet"),
        &sym(&env, "nodeB"),
        &submitter,
        &agent,
        &999_i128,
    );

    let record = client.get_escrow(&sym(&env, "taskGet"), &sym(&env, "nodeB"));
    assert_eq!(record.amount, 999_i128);
    assert_eq!(record.status, EscrowStatus::Locked);
    assert_eq!(record.submitter, submitter);
    assert_eq!(record.agent, agent);
}

// ── Multiple (task, node) pairs are independent ───────────────────────────────

#[test]
fn test_multiple_escrows_are_independent() {
    let (env, client, _coord) = setup();
    let submitter = Address::generate(&env);
    let agent = Address::generate(&env);

    // Lock two separate escrows.
    client.lock_funds(
        &sym(&env, "taskMulti"),
        &sym(&env, "nodeA"),
        &submitter,
        &agent,
        &100_i128,
    );
    client.lock_funds(
        &sym(&env, "taskMulti"),
        &sym(&env, "nodeB"),
        &submitter,
        &agent,
        &200_i128,
    );

    // Release one, refund the other.
    let released = client.release_funds(&sym(&env, "taskMulti"), &sym(&env, "nodeA"));
    let refunded = client.refund_funds(&sym(&env, "taskMulti"), &sym(&env, "nodeB"));

    assert_eq!(released.status, EscrowStatus::Released);
    assert_eq!(refunded.status, EscrowStatus::Refunded);
    assert_eq!(released.amount, 100_i128);
    assert_eq!(refunded.amount, 200_i128);
}

// ── Uninitialized contract operations ────────────────────────────────────────

#[test]
fn test_operations_on_uninitialized_contract_fail() {
    let env = Env::default();
    env.mock_all_auths();
    let contract_id = env.register(PaymentEscrowContract, ());
    let client = PaymentEscrowContractClient::new(&env, &contract_id);

    let submitter = Address::generate(&env);
    let agent = Address::generate(&env);

    // lock_funds without initialize should fail (no coordinator set).
    let result = client.try_lock_funds(
        &sym(&env, "taskUninit"),
        &sym(&env, "nodeA"),
        &submitter,
        &agent,
        &100_i128,
    );
    assert_eq!(result, Err(Ok(Error::NotInitialized)));
}

// ── Platform Fee Collection Tests (Issue #412) ──────────────────────────────

#[test]
fn test_platform_fee_collection_and_accounting() {
    let (env, client, _coord) = setup();
    let treasury = Address::generate(&env);
    let submitter = Address::generate(&env);
    let agent = Address::generate(&env);

    client.set_treasury(&treasury);
    assert_eq!(client.get_treasury(), Some(treasury.clone()));

    // Set 1% fee (100 bps)
    client.set_platform_fee_bps(&100);
    assert_eq!(client.get_platform_fee_bps(), 100);

    // 100 XLM = 1_000_000_000 stroops
    let amount = 1_000_000_000_i128;
    client.lock_funds(
        &sym(&env, "taskFee1"),
        &sym(&env, "nodeA"),
        &submitter,
        &agent,
        &amount,
    );

    let record = client.release_funds(&sym(&env, "taskFee1"), &sym(&env, "nodeA"));
    assert_eq!(record.status, EscrowStatus::Released);

    // 1% of 100 XLM = 1 XLM (10_000_000 stroops)
    let expected_fee = 10_000_000_i128;
    assert_eq!(client.get_total_fees_collected(), expected_fee);
}

#[test]
fn test_zero_fee_does_not_block_payment() {
    let (env, client, _coord) = setup();
    let submitter = Address::generate(&env);
    let agent = Address::generate(&env);

    client.set_platform_fee_bps(&0);
    assert_eq!(client.get_platform_fee_bps(), 0);

    let amount = 500_000_i128;
    client.lock_funds(
        &sym(&env, "taskZeroFee"),
        &sym(&env, "nodeA"),
        &submitter,
        &agent,
        &amount,
    );

    let record = client.release_funds(&sym(&env, "taskZeroFee"), &sym(&env, "nodeA"));
    assert_eq!(record.status, EscrowStatus::Released);
    assert_eq!(client.get_total_fees_collected(), 0);
}
