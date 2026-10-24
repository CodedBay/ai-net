// fuzz_auction_params.rs — fuzzes auction duration, deadline, and reveal window
// parameters to find off-by-one errors, overflow in deadline arithmetic, and
// unexpected panics when the fuzzer supplies out-of-range durations.
//
// Treated as a critical bug if this fuzz target panics for any input.
// Run via: cargo fuzz run fuzz_auction_params -- -max_total_time=1800

#![no_main]

use libfuzzer_sys::fuzz_target;
use soroban_sdk::testutils::Address as _;
use soroban_sdk::{Address, Env, Symbol};

fuzz_target!(|data: &[u8]| {
    if data.len() < 24 {
        return;
    }

    // Extract four 6-byte fields interpreted as u48 values in [0, 2^48)
    // to get a wide range including boundary values like 0, u32::MAX, u64::MAX
    let commit_duration = u64::from_le_bytes({
        let mut b = [0u8; 8];
        b[..6].copy_from_slice(&data[0..6]);
        b
    });
    let reveal_duration = u64::from_le_bytes({
        let mut b = [0u8; 8];
        b[..6].copy_from_slice(&data[6..12]);
        b
    });
    let reserve_price = u64::from_le_bytes({
        let mut b = [0u8; 8];
        b[..6].copy_from_slice(&data[12..18]);
        b
    });
    let price_cap = u64::from_le_bytes({
        let mut b = [0u8; 8];
        b[..6].copy_from_slice(&data[18..24]);
        b
    });

    let env = Env::default();
    env.mock_all_auths();

    let admin = Address::generate(&env);
    let contract_id = env.register_contract(None, agent_bidding::AgentBiddingContract);
    let client = agent_bidding::AgentBiddingContractClient::new(&env, &contract_id);

    let _ = client.try_initialize(&admin);

    let task_id = Symbol::new(&env, "fuzz_params");

    // create_auction must handle all numeric inputs without panicking.
    // It is expected to return Err for nonsensical inputs.
    let _ = client.try_create_auction(
        &task_id,
        &reserve_price,
        &price_cap,
        &commit_duration,
        &reveal_duration,
    );
});
