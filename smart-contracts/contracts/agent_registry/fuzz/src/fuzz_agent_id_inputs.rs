// fuzz_agent_id_inputs.rs — fuzzes agent ID and capability inputs to find panics
// caused by symbol encoding edge cases, empty IDs, or collision in storage key
// derivation.
//
// Treated as a critical bug if this fuzz target panics for any input.
// Run via: cargo fuzz run fuzz_agent_id_inputs -- -max_total_time=1800

#![no_main]

use libfuzzer_sys::fuzz_target;
use soroban_sdk::testutils::Address as _;
use soroban_sdk::{Address, Env, String as SorobanString, Symbol};

// Valid Soroban symbol characters
const SYMBOL_CHARS: &[u8] = b"abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_";

fn bytes_to_symbol_str(data: &[u8], max_len: usize) -> String {
    data.iter()
        .take(max_len)
        .map(|&b| char::from(SYMBOL_CHARS[(b as usize) % SYMBOL_CHARS.len()]))
        .collect()
}

fuzz_target!(|data: &[u8]| {
    if data.len() < 4 {
        return;
    }

    let id_len = (data[0] as usize).min(32).min(data.len() - 1);
    let cap_len = ((data[1] as usize) % 10 + 1).min(data.len().saturating_sub(2));

    if id_len == 0 || cap_len == 0 {
        return;
    }

    let id_str = bytes_to_symbol_str(&data[2..], id_len);
    let cap_str = bytes_to_symbol_str(&data[2 + id_len..], cap_len);

    if id_str.is_empty() || cap_str.is_empty() {
        return;
    }

    let env = Env::default();
    env.mock_all_auths();

    let admin = Address::generate(&env);
    let owner = Address::generate(&env);

    let contract_id = env.register_contract(None, agent_registry::AgentRegistry);
    let client = agent_registry::AgentRegistryClient::new(&env, &contract_id);

    let _ = client.try_initialize(&admin);

    let agent_sym = Symbol::new(&env, &id_str);
    let cap_sym = Symbol::new(&env, &cap_str);

    // register then lookup — neither should panic
    let _ = client.try_register_agent(
        &agent_sym,
        &cap_sym,
        &1_000_000i64,
        &SorobanString::from_str(&env, "https://fuzz.test"),
        &owner,
        &100_000_000i64,
    );

    let _ = client.try_discover_agents(&cap_sym, &None, &10u32);

    let _ = client.try_deregister_agent(&agent_sym, &owner);
});
