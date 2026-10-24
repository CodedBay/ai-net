// fuzz_agent_ids.rs — fuzzes agent/task identifier inputs to find panics caused
// by unexpected symbol lengths, encoding edge cases, or collision in storage
// key derivation.
//
// Treated as a critical bug if this fuzz target panics for any input.
// Run via: cargo fuzz run fuzz_agent_ids -- -max_total_time=1800

#![no_main]

use libfuzzer_sys::fuzz_target;
use soroban_sdk::testutils::Address as _;
use soroban_sdk::{Address, Bytes, Env};

fuzz_target!(|data: &[u8]| {
    // Need at least 1 byte for task ID length, 8 for reserve, 8 for cap
    if data.len() < 17 {
        return;
    }

    let id_len = (data[0] as usize).min(data.len() - 17).min(32);
    let id_bytes = &data[1..1 + id_len];
    let reserve_price = u64::from_le_bytes(data[1 + id_len..9 + id_len].try_into().unwrap_or([1u8; 8]));
    let price_cap = u64::from_le_bytes(data[9 + id_len..17 + id_len].try_into().unwrap_or([255u8; 8]));

    let env = Env::default();
    env.mock_all_auths();

    let admin = Address::generate(&env);
    let contract_id = env.register_contract(None, agent_bidding::AgentBiddingContract);
    let client = agent_bidding::AgentBiddingContractClient::new(&env, &contract_id);

    let _ = client.try_initialize(&admin);

    // Build a task ID from arbitrary fuzz bytes.
    // Soroban Symbols have limited character sets; try_create_auction must not
    // panic on invalid symbol bytes — it should return an error.
    let raw_bytes = Bytes::from_slice(&env, id_bytes);

    // We cannot construct an arbitrary Symbol directly from bytes (it validates
    // character set), so we exercise storage operations with a small set of
    // derived deterministic symbols that cover boundary lengths.
    let lengths = [0usize, 1, 8, 9, 10, 31, 32];
    for &len in &lengths {
        let symbol_str: String = id_bytes
            .iter()
            .take(len)
            .map(|&b| {
                // Map byte to valid Soroban symbol chars: [a-zA-Z0-9_]
                let chars: &[u8] = b"abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_";
                char::from(chars[(b as usize) % chars.len()])
            })
            .collect();

        if symbol_str.is_empty() {
            continue;
        }

        let task_sym = soroban_sdk::Symbol::new(&env, &symbol_str);
        let _ = client.try_create_auction(&task_sym, &reserve_price, &price_cap, &120u64, &60u64);
    }

    // Suppress unused variable warning
    let _ = raw_bytes;
});
