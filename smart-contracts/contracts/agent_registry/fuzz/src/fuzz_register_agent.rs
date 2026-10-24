// fuzz_register_agent.rs — fuzzes agent registration with boundary price and
// bond values to find overflows, underflows, and panics in the agent-registry
// contract's input validation and storage arithmetic.
//
// Treated as a critical bug if this fuzz target panics for any input.
// Run via: cargo fuzz run fuzz_register_agent -- -max_total_time=1800

#![no_main]

use libfuzzer_sys::fuzz_target;
use soroban_sdk::testutils::Address as _;
use soroban_sdk::{Address, Env, String as SorobanString, Symbol};

fuzz_target!(|data: &[u8]| {
    if data.len() < 20 {
        return;
    }

    let price_stroops = i64::from_le_bytes(data[0..8].try_into().unwrap());
    let bond_amount = i64::from_le_bytes(data[8..16].try_into().unwrap());
    let capability_seed = data[16];
    let id_seed = data[17];
    let endpoint_len = (data[18] as usize).min(data.len().saturating_sub(19)).min(100);
    let endpoint_bytes = &data[19..19 + endpoint_len];

    let env = Env::default();
    env.mock_all_auths();

    let admin = Address::generate(&env);
    let owner = Address::generate(&env);

    let contract_id = env.register_contract(None, agent_registry::AgentRegistry);
    let client = agent_registry::AgentRegistryClient::new(&env, &contract_id);

    let _ = client.try_initialize(&admin);

    // Derive a capability symbol from the seed byte
    let cap_chars = ["research", "coding", "risk", "design", "report"];
    let capability = cap_chars[(capability_seed as usize) % cap_chars.len()];

    // Derive a unique agent ID
    let id_str = format!("agent_{:03}", id_seed);

    // Build an endpoint string from fuzz bytes (mapped to printable ASCII)
    let endpoint_str: String = endpoint_bytes
        .iter()
        .map(|&b| {
            // Map to printable ASCII range (0x20–0x7E)
            char::from(0x20u8 + (b % 0x5F))
        })
        .collect();

    // register_agent must not panic for any numeric input; it should return
    // typed errors for invalid prices, bonds, etc.
    let _ = client.try_register_agent(
        &Symbol::new(&env, &id_str),
        &Symbol::new(&env, capability),
        &price_stroops,
        &SorobanString::from_str(&env, &endpoint_str),
        &owner,
        &bond_amount,
    );
});
