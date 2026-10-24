// fuzz_task_ids.rs — fuzzes task ID inputs, expiry values, and metadata sizes
// to find panics in task_store storage operations, key encoding, and TTL
// arithmetic.
//
// Treated as a critical bug if this fuzz target panics for any input.
// Run via: cargo fuzz run fuzz_task_ids -- -max_total_time=1800

#![no_main]

use libfuzzer_sys::fuzz_target;
use soroban_sdk::testutils::Address as _;
use soroban_sdk::{Address, Bytes, Env, String as SorobanString, Symbol};

const SYMBOL_CHARS: &[u8] = b"abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_";

fn to_symbol_str(data: &[u8], max_len: usize) -> String {
    data.iter()
        .take(max_len.min(32))
        .map(|&b| char::from(SYMBOL_CHARS[(b as usize) % SYMBOL_CHARS.len()]))
        .collect()
}

fuzz_target!(|data: &[u8]| {
    if data.len() < 10 {
        return;
    }

    let id_len = ((data[0] as usize) % 31 + 1).min(data.len().saturating_sub(9));
    let id_str = to_symbol_str(&data[1..], id_len);
    if id_str.is_empty() {
        return;
    }

    // Extract a metadata blob of variable size from remaining bytes
    let meta_offset = 1 + id_len;
    let ttl_ledgers = u32::from_le_bytes(
        data[meta_offset.min(data.len().saturating_sub(4))
            ..meta_offset.min(data.len().saturating_sub(4)) + 4]
            .try_into()
            .unwrap_or([0u8; 4]),
    );

    let env = Env::default();
    env.mock_all_auths();

    let admin = Address::generate(&env);
    let agent = Address::generate(&env);

    let contract_id = env.register_contract(None, task_store::TaskStore);
    let client = task_store::TaskStoreClient::new(&env, &contract_id);

    let _ = client.try_initialize(&admin);

    let task_id = Symbol::new(&env, &id_str);

    // Build compressed metadata from remaining fuzz bytes (empty is valid)
    let meta_start = (meta_offset + 4).min(data.len());
    let compressed_meta = Bytes::from_slice(&env, &data[meta_start..]);

    // store_task must not panic for any metadata size or TTL
    let _ = client.try_store_task(
        &task_id,
        &agent,
        &compressed_meta,
        &ttl_ledgers,
    );

    // get_task must not panic even if the task was never stored
    let _ = client.try_get_task(&task_id);
});
