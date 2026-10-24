#![cfg(test)]

use super::*;
use soroban_sdk::{
    testutils::{Address as _, Ledger},
    BytesN, Env, String,
};

// Timestamp constants for deadline arithmetic:
//   evidence_deadline = 0 + 259_200        = 259_200
//   voting_deadline   = 259_200 + 172_800  = 432_000
//   appeal_deadline   = 432_000 + 172_800  = 604_800
const EVIDENCE_DEADLINE: u64 = 259_200;
const VOTING_DEADLINE: u64 = 432_000;
const APPEAL_DEADLINE: u64 = 604_800;

// ────────────────────────────────────────────────────────────────────────────
// Setup helpers
// ────────────────────────────────────────────────────────────────────────────

fn setup() -> (Env, DisputeResolutionContractClient<'static>) {
    let env = Env::default();
    env.mock_all_auths();
    let id = env.register_contract(None, DisputeResolutionContract);
    let client = DisputeResolutionContractClient::new(&env, &id);
    (env, client)
}

fn five_arbiters(env: &Env) -> Vec<Address> {
    let mut v = Vec::new(env);
    for _ in 0..5 {
        v.push_back(Address::generate(env));
    }
    v
}

fn setup_with_jurors(
) -> (
    Env,
    DisputeResolutionContractClient<'static>,
    Address,
    Vec<'static, Address>,
) {
    let (env, client, admin) = setup_with_admin();
    let jurors = soroban_sdk::vec![
        &env,
        Address::generate(&env),
        Address::generate(&env),
        Address::generate(&env),
        Address::generate(&env),
        Address::generate(&env),
    ];
    client.set_jurors(&jurors);
    (env, client, admin, jurors)
}

/// Helper: file a dispute and return the default dispute_id Symbol.
fn file_default_dispute(
    env: &Env,
    client: &DisputeResolutionContractClient,
    filer: &Address,
) -> Symbol {
    let dispute_id = Symbol::new(env, "disp1");
    client.file_dispute(filer, &Symbol::new(env, "agent1"), &dispute_id);
    dispute_id
}

/// Helper: create a BytesN<32> with a specific first byte.
fn make_hash(env: &Env, first_byte: u8) -> BytesN<32> {
    let mut arr = [0u8; 32];
    arr[0] = first_byte;
    BytesN::from_array(env, &arr)
}

/// Helper: advance the ledger timestamp.
fn set_timestamp(env: &Env, ts: u64) {
    env.ledger().with_mut(|l| {
        l.timestamp = ts;
    });
}

// ────────────────────────────────────────────────────────────────────────────
// Existing tests (preserved, with timestamp fixes)
// ────────────────────────────────────────────────────────────────────────────

#[test]
fn test_initialize_ok() {
    let (env, client) = setup();
    let admin = Address::generate(&env);
    client.initialize(&admin);
}

#[test]
fn test_initialize_twice_fails() {
    let (env, client) = setup();
    let admin = Address::generate(&env);
    client.initialize(&admin);
    assert!(client.try_initialize(&admin).is_err());
}

// ─── raise_dispute ────────────────────────────────────────────────────────────

#[test]
fn test_raise_dispute_returns_id() {
    let (env, client) = setup();
    let admin = Address::generate(&env);
    client.initialize(&admin);
    client.set_arbiters(&five_arbiters(&env));

    let submitter = Address::generate(&env);
    let now = 1_000_000u64;
    env.ledger().set_timestamp(now);
    fund_task(
        &env,
        &client,
        &submitter,
        &symbol_short!("task1"),
        now,
    );

    let id = client.raise_dispute(
        &submitter,
        &symbol_short!("task1"),
        &zero_hash(&env),
        &String::from_str(&env, "not delivered"),
    );
    assert_eq!(id, 1u64);
}

#[test]
fn submit_evidence_success() {
    let (env, client, _admin, _jurors) = setup_with_jurors();
    let filer = Address::generate(&env);
    let dispute_id = Symbol::new(&env, "disp1");
    client.file_dispute(&filer, &Symbol::new(&env, "agent1"), &dispute_id);

    let hash = make_hash(&env, 42);
    client.submit_evidence(&dispute_id, &filer, &hash);

    let result = client.try_raise_dispute(
        &submitter,
        &symbol_short!("task1"),
        &zero_hash(&env),
        &String::from_str(&env, "late"),
    );
    assert!(result.is_err());
}

#[test]
fn test_raise_dispute_no_arbiters_fails() {
    let (env, client) = setup();
    let admin = Address::generate(&env);
    client.initialize(&admin);
    // no arbiters set

    let now = 1_000_000u64;
    env.ledger().set_timestamp(now);
    let submitter = Address::generate(&env);
    fund_task(
        &env,
        &client,
        &submitter,
        &symbol_short!("task1"),
        now,
    );

    let result = client.try_raise_dispute(
        &submitter,
        &symbol_short!("task1"),
        &zero_hash(&env),
        &String::from_str(&env, "reason"),
    );
    assert!(result.is_err());
}

#[test]
fn test_undisputed_escrow_releases_to_agent_after_raise_window() {
    let (env, client) = setup();
    let admin = Address::generate(&env);
    client.initialize(&admin);
    let submitter = Address::generate(&env);
    let completed_at = 1_000_000u64;
    env.ledger().set_timestamp(completed_at);
    let (asset, agent) = fund_task(
        &env,
        &client,
        &submitter,
        &symbol_short!("ordinary"),
        completed_at,
    );

    assert!(client
        .try_settle_undisputed_task(&symbol_short!("ordinary"))
        .is_err());
    env.ledger()
        .set_timestamp(completed_at + RAISE_WINDOW_SECS);
    client.settle_undisputed_task(&symbol_short!("ordinary"));

    let token = token::Client::new(&env, &asset);
    assert_eq!(token.balance(&agent), 10_000_000);
    assert!(client
        .try_settle_undisputed_task(&symbol_short!("ordinary"))
        .is_err());
}

// ─── vote_on_dispute ──────────────────────────────────────────────────────────

#[test]
fn test_arbiter_votes_recorded() {
    let (env, client) = setup();
    let admin = Address::generate(&env);
    client.initialize(&admin);
    let arbiters = five_arbiters(&env);
    client.set_arbiters(&arbiters);

    let now = 1_000_000u64;
    env.ledger().set_timestamp(now);
    let submitter = Address::generate(&env);
    fund_task(&env, &client, &submitter, &symbol_short!("t1"), now);

    let id = client.raise_dispute(
        &submitter,
        &symbol_short!("t1"),
        &zero_hash(&env),
        &String::from_str(&env, "reason"),
    );

    client.vote_on_dispute(&arbiters.get(0).unwrap(), &id, &Vote::Approve);
    client.vote_on_dispute(&arbiters.get(1).unwrap(), &id, &Vote::Approve);
    client.vote_on_dispute(&arbiters.get(2).unwrap(), &id, &Vote::Reject);

    let rec = client.get_dispute(&id).unwrap();
    assert_eq!(rec.approve_votes, 2);
    assert_eq!(rec.reject_votes, 1);
}

#[test]
fn test_non_arbiter_cannot_vote() {
    let (env, client) = setup();
    let admin = Address::generate(&env);
    client.initialize(&admin);
    client.set_arbiters(&five_arbiters(&env));

    let now = 1_000_000u64;
    env.ledger().set_timestamp(now);
    let submitter = Address::generate(&env);
    fund_task(&env, &client, &submitter, &symbol_short!("t1"), now);
    let id = client.raise_dispute(
        &submitter,
        &symbol_short!("t1"),
        &zero_hash(&env),
        &String::from_str(&env, "reason"),
    );

    let stranger = Address::generate(&env);
    assert!(client.try_vote_on_dispute(&stranger, &id, &Vote::Approve).is_err());
}

    // Advance timestamp past voting deadline
    set_timestamp(&env, VOTING_DEADLINE + 1);

    client.vote_on_dispute(&arbiters.get(0).unwrap(), &id, &Vote::Approve);
    assert!(client.try_vote_on_dispute(&arbiters.get(0).unwrap(), &id, &Vote::Reject).is_err());
}

#[test]
fn test_task_cannot_be_disputed_twice() {
    let (env, client) = setup();
    let admin = Address::generate(&env);
    client.initialize(&admin);
    client.set_arbiters(&five_arbiters(&env));

    let completed_at = 1_000_000u64;
    env.ledger().set_timestamp(completed_at);
    let submitter = Address::generate(&env);
    fund_task(&env, &client, &submitter, &symbol_short!("onecase"), completed_at);
    client.raise_dispute(
        &submitter,
        &symbol_short!("onecase"),
        &zero_hash(&env),
        &String::from_str(&env, "reason"),
    );
    assert!(client
        .try_raise_dispute(
            &submitter,
            &symbol_short!("onecase"),
            &zero_hash(&env),
            &String::from_str(&env, "second dispute"),
        )
        .is_err());
}

#[test]
fn test_cannot_vote_after_deadline() {
    let (env, client) = setup();
    let admin = Address::generate(&env);
    client.initialize(&admin);
    let arbiters = five_arbiters(&env);
    client.set_arbiters(&arbiters);

    let start = 1_000_000u64;
    env.ledger().set_timestamp(start);
    let submitter = Address::generate(&env);
    fund_task(&env, &client, &submitter, &symbol_short!("t1"), start);
    let id = client.raise_dispute(
        &submitter,
        &symbol_short!("t1"),
        &zero_hash(&env),
        &String::from_str(&env, "reason"),
    );

    // Advance past 72-hour voting deadline
    env.ledger().set_timestamp(start + VOTING_PERIOD_SECS + 1);
    assert!(client.try_vote_on_dispute(&arbiters.get(0).unwrap(), &id, &Vote::Approve).is_err());
}

// ─── resolve_dispute ──────────────────────────────────────────────────────────

    // Advance past voting deadline
    set_timestamp(&env, VOTING_DEADLINE + 1);

    // 3 approve, 2 reject
    client.vote_on_dispute(&arbiters.get(0).unwrap(), &id, &Vote::Approve);
    client.vote_on_dispute(&arbiters.get(1).unwrap(), &id, &Vote::Approve);
    client.vote_on_dispute(&arbiters.get(2).unwrap(), &id, &Vote::Approve);
    client.vote_on_dispute(&arbiters.get(3).unwrap(), &id, &Vote::Reject);
    client.vote_on_dispute(&arbiters.get(4).unwrap(), &id, &Vote::Reject);

    env.ledger().set_timestamp(start + VOTING_PERIOD_SECS + 1);
    let resolution = client.resolve_dispute(&id);
    assert_eq!(resolution, Resolution::Approve);

    let rec = client.get_dispute(&id).unwrap();
    assert_eq!(rec.status, DisputeStatus::Resolved);
    assert_eq!(rec.resolution, Some(Resolution::Approve));
    let token = token::Client::new(&env, &asset);
    assert_eq!(token.balance(&agent), 10_000_000);
}

#[test]
fn test_resolve_reject_below_threshold() {
    let (env, client) = setup();
    let admin = Address::generate(&env);
    client.initialize(&admin);
    let arbiters = five_arbiters(&env);
    client.set_arbiters(&arbiters);

    let start = 1_000_000u64;
    env.ledger().set_timestamp(start);
    let submitter = Address::generate(&env);
    let (asset, _) = fund_task(&env, &client, &submitter, &symbol_short!("t1"), start);
    let id = client.raise_dispute(
        &submitter,
        &symbol_short!("t1"),
        &zero_hash(&env),
        &String::from_str(&env, "reason"),
    );

    // Only 2 approve votes — below 3-of-5 threshold
    client.vote_on_dispute(&arbiters.get(0).unwrap(), &id, &Vote::Approve);
    client.vote_on_dispute(&arbiters.get(1).unwrap(), &id, &Vote::Approve);

    env.ledger().set_timestamp(start + VOTING_PERIOD_SECS + 1);
    let resolution = client.resolve_dispute(&id);
    assert_eq!(resolution, Resolution::Reject);
    let token = token::Client::new(&env, &asset);
    assert_eq!(token.balance(&submitter), 20_000_000);
}

#[test]
fn test_resolve_before_deadline_fails() {
    let (env, client) = setup();
    let admin = Address::generate(&env);
    client.initialize(&admin);
    client.set_arbiters(&five_arbiters(&env));

    let now = 1_000_000u64;
    env.ledger().set_timestamp(now);
    let submitter = Address::generate(&env);
    fund_task(&env, &client, &submitter, &symbol_short!("t1"), now);
    let id = client.raise_dispute(
        &submitter,
        &symbol_short!("t1"),
        &zero_hash(&env),
        &String::from_str(&env, "reason"),
    );

    // Still within voting period
    assert!(client.try_resolve_dispute(&id).is_err());
}

#[test]
fn test_resolve_twice_fails() {
    let (env, client) = setup();
    let admin = Address::generate(&env);
    client.initialize(&admin);
    client.set_arbiters(&five_arbiters(&env));

    let start = 1_000_000u64;
    env.ledger().set_timestamp(start);
    let submitter = Address::generate(&env);
    fund_task(&env, &client, &submitter, &symbol_short!("t1"), start);
    let id = client.raise_dispute(
        &submitter,
        &symbol_short!("t1"),
        &zero_hash(&env),
        &String::from_str(&env, "reason"),
    );

    // Advance past voting deadline to resolve
    set_timestamp(&env, VOTING_DEADLINE + 1);
    client.resolve_dispute(&dispute_id);

    // Advance past appeal deadline
    set_timestamp(&env, APPEAL_DEADLINE + 1);

    let appellant = Address::generate(&env);
    assert_eq!(
        client.try_appeal_dispute(&dispute_id, &appellant),
        Err(Ok(Error::AppealWindowClosed))
    );
}

// ─── is_arbiter helper ────────────────────────────────────────────────────────

#[test]
fn test_is_arbiter() {
    let (env, client) = setup();
    let admin = Address::generate(&env);
    client.initialize(&admin);
    let arbiters = five_arbiters(&env);
    client.set_arbiters(&arbiters);

    assert!(client.is_arbiter(&arbiters.get(0).unwrap()));
    assert!(!client.is_arbiter(&Address::generate(&env)));
}

// ────────────────────────────────────────────────────────────────────────────
// New comprehensive integration tests
// ────────────────────────────────────────────────────────────────────────────

// ── 1. file_dispute: duplicate rejected ─────────────────────────────────────

#[test]
fn file_dispute_duplicate_rejected() {
    let (env, client, _admin, _jurors) = setup_with_jurors();
    let filer = Address::generate(&env);
    let dispute_id = Symbol::new(&env, "disp_dup");

    client.file_dispute(&filer, &Symbol::new(&env, "agent1"), &dispute_id);

    // Filing the same dispute_id a second time must return AlreadyExists
    assert_eq!(
        client.try_file_dispute(&filer, &Symbol::new(&env, "agent1"), &dispute_id),
        Err(Ok(Error::AlreadyExists))
    );
}

// ── 2. submit_evidence: outside evidence window rejected ────────────────────

#[test]
fn submit_evidence_after_deadline_fails() {
    let (env, client, _admin, _jurors) = setup_with_jurors();
    env.ledger().set_max_entry_ttl(100_000_000);

    let filer = Address::generate(&env);
    let dispute_id = Symbol::new(&env, "disp_ev");
    client.file_dispute(&filer, &Symbol::new(&env, "agent1"), &dispute_id);

    // Advance past the evidence deadline
    set_timestamp(&env, EVIDENCE_DEADLINE + 1);

    let hash = make_hash(&env, 7);
    assert_eq!(
        client.try_submit_evidence(&dispute_id, &filer, &hash),
        Err(Ok(Error::DisputeExpired))
    );
}

// ── 3. cast_vote: arbiter vote recorded correctly ───────────────────────────

#[test]
fn cast_vote_arbiter_recorded() {
    let (env, client, _admin, jurors) = setup_with_jurors();
    let filer = Address::generate(&env);
    let dispute_id = file_default_dispute(&env, &client, &filer);

    let juror = jurors.get(2).unwrap();
    client.cast_vote(&dispute_id, &juror, &VoteSide::Agent);

    // Status transitions to Voting
    let dispute = client.get_dispute(&dispute_id).unwrap();
    assert_eq!(dispute.status, DisputeStatus::Voting);

    // Confirm vote stored — double-vote attempt must fail with JurorAlreadyVoted
    assert_eq!(
        client.try_cast_vote(&dispute_id, &juror, &VoteSide::Client),
        Err(Ok(Error::JurorAlreadyVoted))
    );
}

// ── 4. resolve_dispute: 3-of-5 Client → resolution = 0 (client wins) ───────

#[test]
fn resolve_dispute_3_client_2_agent_client_wins() {
    let (env, client, _admin, jurors) = setup_with_jurors();
    env.ledger().set_max_entry_ttl(100_000_000);

    let filer = Address::generate(&env);
    let dispute_id = file_default_dispute(&env, &client, &filer);

    client.cast_vote(&dispute_id, &jurors.get(0).unwrap(), &VoteSide::Client);
    client.cast_vote(&dispute_id, &jurors.get(1).unwrap(), &VoteSide::Client);
    client.cast_vote(&dispute_id, &jurors.get(2).unwrap(), &VoteSide::Client);
    client.cast_vote(&dispute_id, &jurors.get(3).unwrap(), &VoteSide::Agent);
    client.cast_vote(&dispute_id, &jurors.get(4).unwrap(), &VoteSide::Agent);

    set_timestamp(&env, VOTING_DEADLINE + 1);
    client.resolve_dispute(&dispute_id);

    let dispute = client.get_dispute(&dispute_id).unwrap();
    assert_eq!(dispute.status, DisputeStatus::Resolved);
    assert_eq!(dispute.resolution, Some(0)); // client wins
}

// ── 5. resolve_dispute: 3-of-5 Agent → resolution = 1 (agent wins) ─────────

#[test]
fn resolve_dispute_3_agent_2_client_agent_wins() {
    let (env, client, _admin, jurors) = setup_with_jurors();
    env.ledger().set_max_entry_ttl(100_000_000);

    let filer = Address::generate(&env);
    let dispute_id = file_default_dispute(&env, &client, &filer);

    client.cast_vote(&dispute_id, &jurors.get(0).unwrap(), &VoteSide::Agent);
    client.cast_vote(&dispute_id, &jurors.get(1).unwrap(), &VoteSide::Agent);
    client.cast_vote(&dispute_id, &jurors.get(2).unwrap(), &VoteSide::Agent);
    client.cast_vote(&dispute_id, &jurors.get(3).unwrap(), &VoteSide::Client);
    client.cast_vote(&dispute_id, &jurors.get(4).unwrap(), &VoteSide::Client);

    set_timestamp(&env, VOTING_DEADLINE + 1);
    client.resolve_dispute(&dispute_id);

    let dispute = client.get_dispute(&dispute_id).unwrap();
    assert_eq!(dispute.status, DisputeStatus::Resolved);
    assert_eq!(dispute.resolution, Some(1)); // agent wins
}

// ── 6. Auto-resolve: voting period expires, majority wins ───────────────────
//
//    Simulates a scenario where no one resolves during the window;
//    resolution is called long after the deadline — the vote tally
//    still determines the outcome.

#[test]
fn resolve_dispute_long_after_deadline_majority_wins() {
    let (env, client, _admin, jurors) = setup_with_jurors();
    env.ledger().set_max_entry_ttl(100_000_000);

    let filer = Address::generate(&env);
    let dispute_id = file_default_dispute(&env, &client, &filer);

    // 4 agent votes, 1 client vote
    client.cast_vote(&dispute_id, &jurors.get(0).unwrap(), &VoteSide::Agent);
    client.cast_vote(&dispute_id, &jurors.get(1).unwrap(), &VoteSide::Agent);
    client.cast_vote(&dispute_id, &jurors.get(2).unwrap(), &VoteSide::Agent);
    client.cast_vote(&dispute_id, &jurors.get(3).unwrap(), &VoteSide::Agent);
    client.cast_vote(&dispute_id, &jurors.get(4).unwrap(), &VoteSide::Client);

    // Advance to long after appeal deadline
    set_timestamp(&env, APPEAL_DEADLINE + 86_400);
    client.resolve_dispute(&dispute_id);

    let dispute = client.get_dispute(&dispute_id).unwrap();
    assert_eq!(dispute.status, DisputeStatus::Resolved);
    assert_eq!(dispute.resolution, Some(1)); // agent wins (4 vs 1)
}

// ── 7. Edge case: 2-2 tie → resolution = 1 (agent wins) ────────────────────
//
//    When client_votes == agent_votes, client_votes > agent_votes is false,
//    so the condition resolves to 1 (agent wins).

#[test]
fn resolve_dispute_tie_agent_wins() {
    let (env, client, _admin, jurors) = setup_with_jurors();
    env.ledger().set_max_entry_ttl(100_000_000);

    let filer = Address::generate(&env);
    let dispute_id = file_default_dispute(&env, &client, &filer);

    // 2 client, 2 agent, 1 abstains (no vote)
    client.cast_vote(&dispute_id, &jurors.get(0).unwrap(), &VoteSide::Client);
    client.cast_vote(&dispute_id, &jurors.get(1).unwrap(), &VoteSide::Client);
    client.cast_vote(&dispute_id, &jurors.get(2).unwrap(), &VoteSide::Agent);
    client.cast_vote(&dispute_id, &jurors.get(3).unwrap(), &VoteSide::Agent);
    // juror[4] does not vote

    set_timestamp(&env, VOTING_DEADLINE + 1);
    client.resolve_dispute(&dispute_id);

    let dispute = client.get_dispute(&dispute_id).unwrap();
    assert_eq!(dispute.status, DisputeStatus::Resolved);
    // client_votes (2) is NOT > agent_votes (2) → resolution = 1
    assert_eq!(dispute.resolution, Some(1));
}

// ── 8. resolve_dispute before voting deadline fails ─────────────────────────

#[test]
fn resolve_dispute_before_deadline_fails() {
    let (env, client, _admin, jurors) = setup_with_jurors();
    let filer = Address::generate(&env);
    let dispute_id = file_default_dispute(&env, &client, &filer);

    client.cast_vote(&dispute_id, &jurors.get(0).unwrap(), &VoteSide::Client);

    // Timestamp is still 0 (before voting_deadline = 432_000)
    assert_eq!(
        client.try_resolve_dispute(&dispute_id),
        Err(Ok(Error::DisputeExpired))
    );
}

// ── 9. All 5 jurors vote Client → resolution = 0 ────────────────────────────

#[test]
fn resolve_dispute_all_five_client_wins() {
    let (env, client, _admin, jurors) = setup_with_jurors();
    env.ledger().set_max_entry_ttl(100_000_000);

    let filer = Address::generate(&env);
    let dispute_id = file_default_dispute(&env, &client, &filer);

    for i in 0..5 {
        client.cast_vote(&dispute_id, &jurors.get(i).unwrap(), &VoteSide::Client);
    }

    set_timestamp(&env, VOTING_DEADLINE + 1);
    client.resolve_dispute(&dispute_id);

    let dispute = client.get_dispute(&dispute_id).unwrap();
    assert_eq!(dispute.status, DisputeStatus::Resolved);
    assert_eq!(dispute.resolution, Some(0)); // unanimous client win
}

// ── 10. All 5 jurors vote Agent → resolution = 1 ────────────────────────────

#[test]
fn resolve_dispute_all_five_agent_wins() {
    let (env, client, _admin, jurors) = setup_with_jurors();
    env.ledger().set_max_entry_ttl(100_000_000);

    let filer = Address::generate(&env);
    let dispute_id = file_default_dispute(&env, &client, &filer);

    for i in 0..5 {
        client.cast_vote(&dispute_id, &jurors.get(i).unwrap(), &VoteSide::Agent);
    }

    set_timestamp(&env, VOTING_DEADLINE + 1);
    client.resolve_dispute(&dispute_id);

    let dispute = client.get_dispute(&dispute_id).unwrap();
    assert_eq!(dispute.status, DisputeStatus::Resolved);
    assert_eq!(dispute.resolution, Some(1)); // unanimous agent win
}

// ── 11. resolve_dispute twice fails ─────────────────────────────────────────

#[test]
fn resolve_dispute_twice_fails() {
    let (env, client, _admin, jurors) = setup_with_jurors();
    env.ledger().set_max_entry_ttl(100_000_000);

    let filer = Address::generate(&env);
    let dispute_id = file_default_dispute(&env, &client, &filer);

    client.cast_vote(&dispute_id, &jurors.get(0).unwrap(), &VoteSide::Client);

    set_timestamp(&env, VOTING_DEADLINE + 1);
    client.resolve_dispute(&dispute_id);

    assert_eq!(
        client.try_resolve_dispute(&dispute_id),
        Err(Ok(Error::DisputeAlreadyResolved))
    );
}

// ── 12. Multiple evidence submissions within window ──────────────────────────

#[test]
fn submit_multiple_evidence_within_window() {
    let (env, client, _admin, _jurors) = setup_with_jurors();
    let filer = Address::generate(&env);
    let dispute_id = file_default_dispute(&env, &client, &filer);

    let other_party = Address::generate(&env);

    client.submit_evidence(&dispute_id, &filer, &make_hash(&env, 1));
    client.submit_evidence(&dispute_id, &other_party, &make_hash(&env, 2));
    client.submit_evidence(&dispute_id, &filer, &make_hash(&env, 3));

    assert_eq!(client.get_evidence_count(&dispute_id), 3);
}

// ── 13. Evidence submission moves status to EvidenceSubmission ───────────────

#[test]
fn submit_evidence_transitions_status() {
    let (env, client, _admin, _jurors) = setup_with_jurors();
    let filer = Address::generate(&env);
    let dispute_id = file_default_dispute(&env, &client, &filer);

    let before = client.get_dispute(&dispute_id).unwrap();
    assert_eq!(before.status, DisputeStatus::Filed);

    client.submit_evidence(&dispute_id, &filer, &make_hash(&env, 10));

    let after = client.get_dispute(&dispute_id).unwrap();
    assert_eq!(after.status, DisputeStatus::EvidenceSubmission);
}

// ── 14. Appeal on unresolved dispute fails ───────────────────────────────────

#[test]
fn appeal_unresolved_dispute_fails() {
    let (env, client, _admin, _jurors) = setup_with_jurors();
    let filer = Address::generate(&env);
    let dispute_id = file_default_dispute(&env, &client, &filer);

    let appellant = Address::generate(&env);
    // Dispute is still in Filed status — not Resolved
    assert_eq!(
        client.try_appeal_dispute(&dispute_id, &appellant),
        Err(Ok(Error::DisputeAlreadyResolved))
    );
}

// ── 15. Appeal twice fails ───────────────────────────────────────────────────

#[test]
fn appeal_twice_fails() {
    let (env, client, _admin, jurors) = setup_with_jurors();
    env.ledger().set_max_entry_ttl(100_000_000);

    let filer = Address::generate(&env);
    let dispute_id = file_default_dispute(&env, &client, &filer);

    client.cast_vote(&dispute_id, &jurors.get(0).unwrap(), &VoteSide::Client);

    set_timestamp(&env, VOTING_DEADLINE + 1);
    client.resolve_dispute(&dispute_id);

    let appellant = Address::generate(&env);
    client.appeal_dispute(&dispute_id, &appellant);

    // Second appeal must fail with AlreadyExists
    assert_eq!(
        client.try_appeal_dispute(&dispute_id, &appellant),
        Err(Ok(Error::AlreadyExists))
    );
}

// ── 16. Casting vote on already-resolved dispute fails ───────────────────────

#[test]
fn cast_vote_on_resolved_dispute_fails() {
    let (env, client, _admin, jurors) = setup_with_jurors();
    env.ledger().set_max_entry_ttl(100_000_000);

    let filer = Address::generate(&env);
    let dispute_id = file_default_dispute(&env, &client, &filer);

    // Advance past voting deadline and resolve without any votes
    set_timestamp(&env, VOTING_DEADLINE + 1);
    client.resolve_dispute(&dispute_id);

    // Now try to cast a vote — voting_deadline is in the past so DisputeExpired
    assert_eq!(
        client.try_cast_vote(&dispute_id, &jurors.get(0).unwrap(), &VoteSide::Client),
        Err(Ok(Error::DisputeExpired))
    );
}

// ── 17. Pausing unpauses correctly ───────────────────────────────────────────

#[test]
fn pause_and_unpause() {
    let (env, client, _admin) = setup_with_admin();

    // Re-set jurors so we can test filing after unpause
    let jurors = soroban_sdk::vec![
        &env,
        Address::generate(&env),
        Address::generate(&env),
        Address::generate(&env),
        Address::generate(&env),
        Address::generate(&env),
    ];
    client.set_jurors(&jurors);

    // Pause
    client.pause(&true);
    let filer = Address::generate(&env);
    assert_eq!(
        client.try_file_dispute(
            &filer,
            &Symbol::new(&env, "agent1"),
            &Symbol::new(&env, "disp_p")
        ),
        Err(Ok(Error::ContractPaused))
    );

    // Unpause — filing should succeed
    client.pause(&false);
    client.file_dispute(&filer, &Symbol::new(&env, "agent1"), &Symbol::new(&env, "disp_p"));
    let dispute = client.get_dispute(&Symbol::new(&env, "disp_p")).unwrap();
    assert_eq!(dispute.status, DisputeStatus::Filed);
}

// ── 18. get_dispute returns None for unknown dispute_id ──────────────────────

#[test]
fn get_dispute_unknown_returns_none() {
    let (env, client, _admin, _jurors) = setup_with_jurors();
    let result = client.get_dispute(&Symbol::new(&env, "nonexistent"));
    assert!(result.is_none());
}

// ── 19. No-vote resolution defaults to agent wins (0 client vs 0 agent) ─────

#[test]
fn resolve_dispute_no_votes_agent_wins() {
    let (env, client, _admin, _jurors) = setup_with_jurors();
    env.ledger().set_max_entry_ttl(100_000_000);

    let filer = Address::generate(&env);
    let dispute_id = file_default_dispute(&env, &client, &filer);

    // No one votes; advance past deadline
    set_timestamp(&env, VOTING_DEADLINE + 1);
    client.resolve_dispute(&dispute_id);

    let dispute = client.get_dispute(&dispute_id).unwrap();
    assert_eq!(dispute.status, DisputeStatus::Resolved);
    // 0 client vs 0 agent: client_votes (0) > agent_votes (0) is false → 1
    assert_eq!(dispute.resolution, Some(1));
}
