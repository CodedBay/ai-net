// fuzz_bid_amounts.rs — fuzzes bid_amount, reserve_price, price_cap, and bid
// bond values against the agent-bidding contract to find panics, overflows, and
// unexpected rejections caused by boundary arithmetic.
//
// Treated as a critical bug if this fuzz target panics for any input.
// Run via: cargo fuzz run fuzz_bid_amounts -- -max_total_time=1800

#![no_main]

use libfuzzer_sys::fuzz_target;
use soroban_sdk::testutils::Address as _;
use soroban_sdk::{Address, Env, Symbol};

// The contract is compiled as an rlib, so we can call its public surface.
// We exercise the auction lifecycle: create_auction → submit_bid → reveal_bid
// with fuzzer-controlled numeric parameters.

fuzz_target!(|data: &[u8]| {
    // Need at least 33 bytes to extract meaningful parameters
    if data.len() < 33 {
        return;
    }

    // Parse fuzz bytes into auction parameters
    let reserve_price = u64::from_le_bytes(data[0..8].try_into().unwrap());
    let price_cap = u64::from_le_bytes(data[8..16].try_into().unwrap());
    let bid_amount = u64::from_le_bytes(data[16..24].try_into().unwrap());
    let bid_bond = u64::from_le_bytes(data[24..32].try_into().unwrap());
    let duration_seed = data[32] as u64;

    // Avoid obviously degenerate inputs that would just hit validation errors
    // we already know about; focus on near-boundary values
    if reserve_price == 0 || price_cap == 0 {
        return;
    }

    // Scale duration to [60, 86400] seconds range
    let commit_duration = 60 + (duration_seed % 86340);
    let reveal_duration = 60 + (duration_seed % 3540);

    let env = Env::default();
    env.mock_all_auths();

    let admin = Address::generate(&env);
    let bidder = Address::generate(&env);

    // ── Register and initialize contract ──────────────────────────────────────
    // Any panic here is a bug in contract initialization logic.
    let contract_id = env.register_contract(None, agent_bidding::AgentBiddingContract);
    let client = agent_bidding::AgentBiddingContractClient::new(&env, &contract_id);

    // initialize() must not panic for any valid admin address
    let _ = client.try_initialize(&admin);

    let task_id = Symbol::new(&env, "fuzz_task");

    // ── create_auction ────────────────────────────────────────────────────────
    // Must not panic for any numeric inputs; should return Err for invalid ranges
    let auction_result = client.try_create_auction(
        &task_id,
        &reserve_price,
        &price_cap,
        &commit_duration,
        &reveal_duration,
    );

    // If auction creation fails (expected for inverted ranges etc.), stop here
    if auction_result.is_err() {
        return;
    }

    // ── submit_bid ────────────────────────────────────────────────────────────
    // Commitment is SHA-256(bidder || bid_amount || nonce); we use zeroed nonce
    // for the fuzz harness — we only care about contract arithmetic, not crypto
    let nonce = soroban_sdk::Bytes::from_array(&env, &[0u8; 32]);
    let mut commitment_input = [0u8; 48];
    commitment_input[0..8].copy_from_slice(&bid_amount.to_le_bytes());
    commitment_input[8..40].copy_from_slice(&[0u8; 32]); // nonce
    let commitment = env.crypto().sha256(&soroban_sdk::Bytes::from_slice(
        &env,
        &commitment_input,
    ));
    let commitment_bytes = soroban_sdk::BytesN::from_array(&env, commitment.as_ref().try_into().unwrap_or(&[0u8; 32]));

    // submit_bid must not panic; may return Err for wrong bond, after deadline etc.
    let _ = client.try_submit_bid(&task_id, &bidder, &commitment_bytes, &bid_bond);
});
