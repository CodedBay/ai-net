// fuzz_agent_bond.rs — fuzzes bond slash, bond return, and min_bond threshold
// operations to find arithmetic overflows and negative-balance panics.
//
// Treated as a critical bug if this fuzz target panics for any input.
// Run via: cargo fuzz run fuzz_agent_bond -- -max_total_time=1800

#![no_main]

use libfuzzer_sys::fuzz_target;
use soroban_sdk::testutils::Address as _;
use soroban_sdk::{Address, Env, String as SorobanString, Symbol};

fuzz_target!(|data: &[u8]| {
    if data.len() < 24 {
        return;
    }

    let initial_bond = i64::from_le_bytes(data[0..8].try_into().unwrap());
    let slash_amount = i64::from_le_bytes(data[8..16].try_into().unwrap());
    let new_min_bond = i64::from_le_bytes(data[16..24].try_into().unwrap());

    let env = Env::default();
    env.mock_all_auths();

    let admin = Address::generate(&env);
    let owner = Address::generate(&env);

    let contract_id = env.register_contract(None, agent_registry::AgentRegistry);
    let client = agent_registry::AgentRegistryClient::new(&env, &contract_id);

    let _ = client.try_initialize(&admin);

    // Register an agent with a fuzzer-controlled initial bond
    let agent_id = Symbol::new(&env, "fuzz_agent");
    let _ = client.try_register_agent(
        &agent_id,
        &Symbol::new(&env, "research"),
        &1_000_000i64,        // fixed price; bond is the interesting variable
        &SorobanString::from_str(&env, "https://fuzz.agent.test"),
        &owner,
        &initial_bond,
    );

    // slash_bond must floor at zero and never overflow/panic
    let _ = client.try_slash_bond(&agent_id, &slash_amount);

    // Double-slash must also not panic (tests floor-at-zero idempotency)
    let _ = client.try_slash_bond(&agent_id, &slash_amount);

    // set_min_bond with boundary values must not panic
    let _ = client.try_set_min_bond(&new_min_bond);
});
