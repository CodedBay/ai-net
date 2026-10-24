//! Cursor-based pagination tests for the AgentRegistry contract (Issue #2).
//!
//! Verifies that `get_agents` uses bounded, cursor-based pagination so that:
//! - Reading page 1 never loads more than `limit` records into memory.
//! - `next_cursor` is `Some` whenever more agents exist beyond the page.
//! - `total_count` always reflects the full active registry size.
//! - Storage cost per page read is O(page_size), not O(total_agents).

#![cfg(test)]

extern crate std;

use super::*;
use soroban_sdk::{
    testutils::Address as _,
    Address, Env, Map, String, Symbol,
};

// ─── Helpers ─────────────────────────────────────────────────────────────────

fn setup_with_admin() -> (Env, AgentRegistryContractClient<'static>, Address) {
    let env = Env::default();
    env.mock_all_auths();
    let id = env.register(AgentRegistryContract, ());
    let client = AgentRegistryContractClient::new(&env, &id);
    let admin = Address::generate(&env);
    client.initialize(&admin);
    (env, client, admin)
}

fn make_agent(env: &Env, id: &str, capability: &str, owner: Address) -> AgentRecord {
    AgentRecord {
        id: Symbol::new(env, id),
        capability: Symbol::new(env, capability),
        price_stroops: 1_000,
        endpoint: String::from_str(env, "https://agent.example.com"),
        owner,
        metadata: Map::new(env),
        bond_amount: DEFAULT_MIN_BOND_STROOPS,
    }
}

/// Register `count` agents with sequential IDs and return them.
fn register_n_agents(
    env: &Env,
    client: &AgentRegistryContractClient,
    capability: &str,
    count: u32,
) -> soroban_sdk::Vec<AgentRecord> {
    let mut records = soroban_sdk::Vec::new(env);
    for i in 0..count {
        let id = std::format!("agent{i:04}");
        let owner = Address::generate(env);
        let record = make_agent(env, &id, capability, owner);
        client.register_agent(&record);
        records.push_back(record);
    }
    records
}

// ─── Tests ───────────────────────────────────────────────────────────────────

/// An empty registry returns an empty page with no next_cursor.
#[test]
fn test_get_agents_empty_registry_returns_empty_page() {
    let (_, client, _) = setup_with_admin();

    let page = client.get_agents(&None, &None);

    assert_eq!(page.agents.len(), 0, "empty registry must return zero agents");
    assert_eq!(page.next_cursor, None, "no next_cursor on empty registry");
    assert_eq!(page.total_count, 0, "total_count must be 0 for empty registry");
}

/// Registering fewer agents than DEFAULT_PAGE_SIZE returns them all on one page.
#[test]
fn test_get_agents_fewer_than_page_size_returns_all() {
    let (env, client, _) = setup_with_admin();

    let count = DEFAULT_PAGE_SIZE / 2; // 10 agents
    register_n_agents(&env, &client, "research", count);

    let page = client.get_agents(&None, &None);

    assert_eq!(
        page.agents.len(),
        count,
        "all agents should be on the first page"
    );
    assert_eq!(
        page.next_cursor, None,
        "no next_cursor when all agents fit on one page"
    );
    assert_eq!(page.total_count, count, "total_count must equal registered count");
}

/// Registering exactly DEFAULT_PAGE_SIZE agents returns them on one page with no cursor.
#[test]
fn test_get_agents_exactly_page_size_no_next_cursor() {
    let (env, client, _) = setup_with_admin();

    register_n_agents(&env, &client, "risk", DEFAULT_PAGE_SIZE);

    let page = client.get_agents(&None, &None);

    assert_eq!(
        page.agents.len(),
        DEFAULT_PAGE_SIZE,
        "exactly DEFAULT_PAGE_SIZE agents should be returned"
    );
    assert_eq!(
        page.next_cursor, None,
        "no next_cursor when agents == page size"
    );
    assert_eq!(page.total_count, DEFAULT_PAGE_SIZE);
}

/// Registering more than DEFAULT_PAGE_SIZE agents triggers pagination.
/// Only `limit` records are loaded — the rest are deferred to subsequent pages.
#[test]
fn test_get_agents_more_than_page_size_paginates() {
    let (env, client, _) = setup_with_admin();

    let total = DEFAULT_PAGE_SIZE + 5; // 25 agents
    register_n_agents(&env, &client, "coding", total);

    let page1 = client.get_agents(&None, &None);

    // Page 1 must return exactly DEFAULT_PAGE_SIZE agents
    assert_eq!(
        page1.agents.len(),
        DEFAULT_PAGE_SIZE,
        "first page must contain exactly DEFAULT_PAGE_SIZE agents"
    );
    // next_cursor must be set so the caller can fetch page 2
    assert!(
        page1.next_cursor.is_some(),
        "next_cursor must be Some when more agents exist"
    );
    // total_count reflects the full registry, not just this page
    assert_eq!(
        page1.total_count, total,
        "total_count must equal total registered agents"
    );
}

/// Fetching the second page via next_cursor returns the remaining agents.
#[test]
fn test_get_agents_second_page_via_cursor() {
    let (env, client, _) = setup_with_admin();

    let total = DEFAULT_PAGE_SIZE + 7; // 27 agents
    register_n_agents(&env, &client, "design", total);

    // Fetch page 1
    let page1 = client.get_agents(&None, &None);
    let cursor = page1.next_cursor;
    assert!(cursor.is_some(), "must have a cursor after page 1");

    // Fetch page 2 using the cursor
    let page2 = client.get_agents(&cursor, &None);

    let remaining = total - DEFAULT_PAGE_SIZE;
    assert_eq!(
        page2.agents.len(),
        remaining,
        "page 2 must contain the remaining {remaining} agents"
    );
    assert_eq!(
        page2.next_cursor, None,
        "no next_cursor on the last page"
    );
    assert_eq!(
        page2.total_count, total,
        "total_count is consistent across pages"
    );
}

/// All agents returned across pages collectively equal the full registry.
#[test]
fn test_get_agents_full_iteration_collects_all() {
    let (env, client, _) = setup_with_admin();

    let total = DEFAULT_PAGE_SIZE * 2 + 3; // 43 agents
    register_n_agents(&env, &client, "report", total);

    let mut seen = 0u32;
    let mut cursor: Option<u32> = None;

    loop {
        let page = client.get_agents(&cursor, &None);
        seen += page.agents.len();
        cursor = page.next_cursor;
        if cursor.is_none() {
            break;
        }
    }

    assert_eq!(
        seen, total,
        "iterating all pages must yield exactly total registered agents"
    );
}

/// A custom limit of 5 is respected and produces the correct number of pages.
#[test]
fn test_get_agents_custom_limit_respected() {
    let (env, client, _) = setup_with_admin();

    let total = 13u32;
    let limit: u32 = 5;
    register_n_agents(&env, &client, "research", total);

    let page1 = client.get_agents(&None, &Some(limit));
    assert_eq!(page1.agents.len(), limit, "custom limit must be respected");
    assert!(page1.next_cursor.is_some(), "must have cursor when total > limit");

    let page2 = client.get_agents(&page1.next_cursor, &Some(limit));
    assert_eq!(page2.agents.len(), limit);
    assert!(page2.next_cursor.is_some());

    let page3 = client.get_agents(&page2.next_cursor, &Some(limit));
    assert_eq!(page3.agents.len(), total - limit * 2, "last page has remainder");
    assert_eq!(page3.next_cursor, None, "last page has no next_cursor");
}

/// A limit exceeding MAX_PAGE_SIZE is silently capped to MAX_PAGE_SIZE.
#[test]
fn test_get_agents_limit_capped_at_max_page_size() {
    let (env, client, _) = setup_with_admin();

    // Register one more than MAX_PAGE_SIZE
    let total = MAX_PAGE_SIZE + 1;
    register_n_agents(&env, &client, "risk", total);

    // Request more than MAX_PAGE_SIZE
    let oversized: u32 = MAX_PAGE_SIZE + 100;
    let page = client.get_agents(&None, &Some(oversized));

    assert_eq!(
        page.agents.len(),
        MAX_PAGE_SIZE,
        "limit must be capped at MAX_PAGE_SIZE regardless of the caller's request"
    );
    assert!(
        page.next_cursor.is_some(),
        "must still have a next_cursor for the remaining agent"
    );
}

/// Deregistering agents mid-iteration does not break pagination.
/// total_count decrements and pages remain stable for their own cursor window.
#[test]
fn test_get_agents_pagination_stable_after_deregister() {
    let (env, client, _) = setup_with_admin();

    let total = DEFAULT_PAGE_SIZE + 3;
    let records = register_n_agents(&env, &client, "coding", total);

    // Fetch page 1 and obtain a cursor
    let page1 = client.get_agents(&None, &None);
    assert_eq!(page1.agents.len(), DEFAULT_PAGE_SIZE);
    let cursor = page1.next_cursor;
    assert!(cursor.is_some());

    // Deregister the first agent (simulates concurrent removal)
    let first = records.get(0).unwrap();
    client.deregister_agent(&first.id, &first.owner);

    // Page 2 must still be fetchable; total_count reflects the deregistration
    let page2 = client.get_agents(&cursor, &None);
    assert!(
        page2.agents.len() <= 3,
        "page 2 has at most the remaining 3 agents"
    );
    assert_eq!(
        page2.total_count,
        total - 1,
        "total_count decrements after deregistration"
    );
}

/// A zero limit defaults to DEFAULT_PAGE_SIZE.
#[test]
fn test_get_agents_zero_limit_defaults_to_page_size() {
    let (env, client, _) = setup_with_admin();

    let total = DEFAULT_PAGE_SIZE + 2;
    register_n_agents(&env, &client, "design", total);

    // Passing limit = 0 should be treated as "use default"
    let page = client.get_agents(&None, &Some(0));
    assert_eq!(
        page.agents.len(),
        DEFAULT_PAGE_SIZE,
        "limit=0 must fall back to DEFAULT_PAGE_SIZE"
    );
}

#[test]
fn list_agents_exact_page_has_no_next_cursor() {
    let (env, client, _) = setup_with_admin();
    register_n_agents(&env, &client, "coding", 3);

    let page = client.list_agents(&None, &3);

    assert_eq!(page.agents.len(), 3);
    assert_eq!(page.next_cursor, None);
    assert_eq!(page.total_count, 3);
}

#[test]
fn list_agents_returns_last_agent_cursor_for_partial_final_page() {
    let (env, client, _) = setup_with_admin();
    register_n_agents(&env, &client, "coding", 5);

    let first = client.list_agents(&None, &3);
    assert_eq!(first.agents.len(), 3);
    assert_eq!(first.next_cursor, Some(first.agents.get(2).unwrap().id));

    let final_page = client.list_agents(&first.next_cursor, &3);
    assert_eq!(final_page.agents.len(), 2);
    assert_eq!(final_page.next_cursor, None);
}

#[test]
fn list_agents_obeys_admin_configured_page_cap() {
    let (env, client, _) = setup_with_admin();
    client.set_max_page_size(&2);
    register_n_agents(&env, &client, "coding", 3);

    let page = client.list_agents(&None, &MAX_PAGE_SIZE);

    assert_eq!(page.agents.len(), 2);
    assert!(page.next_cursor.is_some());
}
