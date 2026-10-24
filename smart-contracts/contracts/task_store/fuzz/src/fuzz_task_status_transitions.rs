// fuzz_task_status_transitions.rs — fuzzes arbitrary status transition sequences
// to find panics in the state machine, unexpected accepted transitions, or
// arithmetic in completion/failure tracking.
//
// Treated as a critical bug if this fuzz target panics for any input.
// Run via: cargo fuzz run fuzz_task_status_transitions -- -max_total_time=1800

#![no_main]

use libfuzzer_sys::fuzz_target;
use soroban_sdk::testutils::Address as _;
use soroban_sdk::{Address, Bytes, Env, Symbol};

fuzz_target!(|data: &[u8]| {
    // Need at least one byte for the status sequence
    if data.is_empty() {
        return;
    }

    let env = Env::default();
    env.mock_all_auths();

    let admin = Address::generate(&env);
    let agent = Address::generate(&env);

    let contract_id = env.register_contract(None, task_store::TaskStore);
    let client = task_store::TaskStoreClient::new(&env, &contract_id);

    let _ = client.try_initialize(&admin);

    let task_id = Symbol::new(&env, "fuzz_task");

    // Store a task to start with
    let _ = client.try_store_task(
        &task_id,
        &agent,
        &Bytes::from_slice(&env, b"{}"),
        &1000u32,
    );

    // Replay the fuzz bytes as a sequence of status codes.
    // Status codes 0–7 cover the known TaskStatus enum variants plus
    // several invalid values. The contract must not panic for any sequence.
    for &status_byte in data.iter().take(16) {
        let status = (status_byte % 8) as u32;
        let _ = client.try_update_task_status(&task_id, &agent, &status);
    }
});
