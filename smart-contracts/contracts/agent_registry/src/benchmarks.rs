/// Gas-cost benchmark tests for the AgentRegistry contract.
///
/// These tests are compiled only when the `benchmarks` Cargo feature is
/// enabled.  Run with:
///
/// ```bash
/// cargo test --features benchmarks -- benchmark --nocapture
/// ```
///
/// Each benchmark:
/// 1. Resets the environment budget to unlimited (`reset_unlimited`) so the
///    call is never aborted before measurements are taken.
/// 2. Calls the target function once.
/// 3. Reads `env.budget().cpu_instruction_count()` and asserts two thresholds:
///    - Hard ceiling:       < 10,000,000 CU  (Stellar network per-tx limit)
///    - Regression guard:   < baseline × 1.20  (20 % tolerance)
///
/// Baselines are taken from `smart-contracts/docs/GAS_ESTIMATES.md`.
#[cfg(feature = "benchmarks")]
mod benchmarks {
    extern crate std;

    use crate::{
        AgentRecord, AgentRegistryContract, AgentRegistryContractClient, DEFAULT_MIN_BOND_STROOPS,
    };
    use soroban_sdk::{
        testutils::Address as _,
        Address, Env, Map, String, Symbol,
    };

    // ─── Baseline constants ───────────────────────────────────────────────────
    // These values mirror the rows in GAS_ESTIMATES.md.
    // If a benchmark exceeds BASELINE × 1.20 the CI job fails.

    /// Baseline for a single `register_agent` call (CU).
    const BASELINE_REGISTER_AGENT: u64 = 82_000;
    /// Baseline for `register_agents` with a batch of 10 (CU).
    const BASELINE_REGISTER_AGENTS_10: u64 = 464_500;
    /// Baseline for a single `deregister_agent` call (CU).
    const BASELINE_DEREGISTER_AGENT: u64 = 68_000;
    /// Baseline for listing agents with `get_agents` (CU).
    const BASELINE_LIST_AGENTS: u64 = 15_000;
    /// Baseline for a single-agent `lookup_agents` call (CU).
    const BASELINE_GET_AGENT: u64 = 12_000;

    /// 20 % tolerance applied to every baseline.
    const TOLERANCE: f64 = 1.20;

    fn guard(cpu: u64, baseline: u64, name: &str) {
        let ceiling: u64 = 10_000_000;
        assert!(
            cpu < ceiling,
            "{name}: {cpu} CU exceeds hard ceiling of {ceiling} CU"
        );
        let regression_limit = (baseline as f64 * TOLERANCE) as u64;
        assert!(
            cpu < regression_limit,
            "{name}: {cpu} CU exceeds 20% regression guard (baseline={baseline}, limit={regression_limit})"
        );
    }

    // ─── Helpers ─────────────────────────────────────────────────────────────

    fn setup() -> (Env, AgentRegistryContractClient<'static>) {
        let env = Env::default();
        env.mock_all_auths();
        let id = env.register(AgentRegistryContract, ());
        let client = AgentRegistryContractClient::new(&env, &id);
        let admin = Address::generate(&env);
        client.initialize(&admin);
        (env, client)
    }

    fn make_record(env: &Env, id: &str, capability: &str, owner: Address) -> AgentRecord {
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

    // ─── Benchmarks ───────────────────────────────────────────────────────────

    /// Benchmark: single `register_agent` call.
    ///
    /// Baseline: 82,000 CU  |  Regression guard: < 98,400 CU
    #[test]
    fn benchmark_register_agent() {
        let (env, client) = setup();
        let owner = Address::generate(&env);
        let record = make_record(&env, "bmAgent1", "research", owner);

        env.budget().reset_unlimited();
        client.register_agent(&record);
        let cpu = env.budget().cpu_instruction_count();

        std::println!("[benchmark_register_agent] cpu_instruction_count = {cpu}");
        guard(cpu, BASELINE_REGISTER_AGENT, "benchmark_register_agent");
    }

    /// Benchmark: `register_agents` with a batch of 10 agents.
    ///
    /// Baseline: 464,500 CU  |  Regression guard: < 557,400 CU
    #[test]
    fn benchmark_register_agents_batch_10() {
        let (env, client) = setup();

        let records: soroban_sdk::Vec<AgentRecord> = {
            let mut v = soroban_sdk::Vec::new(&env);
            for i in 0u32..10 {
                let owner = Address::generate(&env);
                // Agent IDs must be ≤ 9 chars for Soroban Symbol; use "bm0".."bm9".
                let id = std::format!("bm{i}");
                v.push_back(make_record(&env, &id, "batch", owner));
            }
            v
        };

        env.budget().reset_unlimited();
        client.register_agents(&records);
        let cpu = env.budget().cpu_instruction_count();

        std::println!("[benchmark_register_agents_batch_10] cpu_instruction_count = {cpu}");
        guard(cpu, BASELINE_REGISTER_AGENTS_10, "benchmark_register_agents_batch_10");
    }

    /// Benchmark: `deregister_agent`.
    ///
    /// Baseline: 68,000 CU  |  Regression guard: < 81,600 CU
    #[test]
    fn benchmark_deregister_agent() {
        let (env, client) = setup();
        let owner = Address::generate(&env);
        let record = make_record(&env, "bmDereg", "coding", owner);
        client.register_agent(&record);

        env.budget().reset_unlimited();
        client.deregister_agent(&Symbol::new(&env, "bmDereg"));
        let cpu = env.budget().cpu_instruction_count();

        std::println!("[benchmark_deregister_agent] cpu_instruction_count = {cpu}");
        guard(cpu, BASELINE_DEREGISTER_AGENT, "benchmark_deregister_agent");
    }

    /// Benchmark: `get_agents` (paginated listing).
    ///
    /// Baseline: 15,000 CU  |  Regression guard: < 18,000 CU
    #[test]
    fn benchmark_list_agents() {
        let (env, client) = setup();
        // Register a handful of agents so the listing is non-trivial.
        for i in 0u32..3 {
            let owner = Address::generate(&env);
            let id = std::format!("lst{i}");
            client.register_agent(&make_record(&env, &id, "risk", owner));
        }

        env.budget().reset_unlimited();
        client.get_agents(&0u32, &None);
        let cpu = env.budget().cpu_instruction_count();

        std::println!("[benchmark_list_agents] cpu_instruction_count = {cpu}");
        guard(cpu, BASELINE_LIST_AGENTS, "benchmark_list_agents");
    }

    /// Benchmark: `lookup_agents` for a capability with a single registered agent.
    ///
    /// Baseline: 12,000 CU  |  Regression guard: < 14,400 CU
    #[test]
    fn benchmark_get_agent() {
        let (env, client) = setup();
        let owner = Address::generate(&env);
        let record = make_record(&env, "bmLookup", "design", owner);
        client.register_agent(&record);

        let cap = Symbol::new(&env, "design");
        env.budget().reset_unlimited();
        client.lookup_agents(&cap);
        let cpu = env.budget().cpu_instruction_count();

        std::println!("[benchmark_get_agent] cpu_instruction_count = {cpu}");
        guard(cpu, BASELINE_GET_AGENT, "benchmark_get_agent");
    }
}
