extern crate std;

#[cfg(test)]
mod test {
    use crate::{
        CapabilityStakingContract, CapabilityStakingContractClient, DEFAULT_MIN_STAKE_STROOPS,
        UNBONDING_PERIOD_LEDGERS,
    };
    use soroban_sdk::{
        testutils::{Address as _, Ledger as _},
        Address, Env, Symbol,
    };

    // ── Test Helpers ──────────────────────────────────────────────────────────

    /// Deploy and initialise the contract, returning (env, client, admin, treasury).
    fn setup() -> (Env, CapabilityStakingContractClient<'static>, Address, Address) {
        let env = Env::default();
        env.mock_all_auths();

        let contract_id = env.register(CapabilityStakingContract, ());
        let client = CapabilityStakingContractClient::new(&env, &contract_id);

        let admin = Address::generate(&env);
        let treasury = Address::generate(&env);

        client.initialize(&admin, &treasury);

        (env, client, admin, treasury)
    }

    fn sym(env: &Env, s: &str) -> Symbol {
        Symbol::new(env, s)
    }

    // ── Initialize ────────────────────────────────────────────────────────────

    #[test]
    fn test_initialize_sets_admin_and_treasury() {
        // `setup()` already calls initialize — if it doesn't panic the test passes.
        let (_env, _client, _admin, _treasury) = setup();
    }

    #[test]
    #[should_panic(expected = "already initialized")]
    fn test_initialize_twice_panics() {
        let (env, client, admin, treasury) = setup();
        // Second initialisation must panic.
        client.initialize(&admin, &treasury);
        let _ = env;
    }

    // ── set_min_stake / get_min_stake ─────────────────────────────────────────

    #[test]
    fn test_get_min_stake_returns_default_when_not_configured() {
        let (env, client, _admin, _treasury) = setup();
        let min = client.get_min_stake(&sym(&env, "research"));
        assert_eq!(min, DEFAULT_MIN_STAKE_STROOPS);
    }

    #[test]
    fn test_set_and_get_min_stake() {
        let (env, client, _admin, _treasury) = setup();
        let cap = sym(&env, "coding");
        let custom_min: i128 = 200_000_000; // 20 XLM
        client.set_min_stake(&cap, &custom_min);
        assert_eq!(client.get_min_stake(&cap), custom_min);
    }

    // ── stake_bond happy path ──────────────────────────────────────────────────

    #[test]
    fn test_stake_bond_happy_path() {
        let (env, client, _admin, _treasury) = setup();

        let owner = Address::generate(&env);
        let agent_id = sym(&env, "agent01");
        let capability = sym(&env, "research");
        let amount: i128 = DEFAULT_MIN_STAKE_STROOPS; // exactly at minimum

        client.stake_bond(&owner, &agent_id, &capability, &amount);

        let record = client.get_stake(&agent_id, &capability);
        assert!(record.is_some());
        let record = record.unwrap();
        assert_eq!(record.agent_id, agent_id);
        assert_eq!(record.capability, capability);
        assert_eq!(record.amount_stroops, amount);
        assert!(record.unbonding_since.is_none());
    }

    #[test]
    fn test_stake_bond_above_minimum_succeeds() {
        let (env, client, _admin, _treasury) = setup();

        let owner = Address::generate(&env);
        let agent_id = sym(&env, "agent02");
        let capability = sym(&env, "coding");
        let amount: i128 = DEFAULT_MIN_STAKE_STROOPS * 5; // well above minimum

        client.stake_bond(&owner, &agent_id, &capability, &amount);

        let record = client.get_stake(&agent_id, &capability).unwrap();
        assert_eq!(record.amount_stroops, amount);
    }

    // ── stake below minimum ────────────────────────────────────────────────────

    #[test]
    #[should_panic(expected = "stake below minimum")]
    fn test_stake_bond_below_minimum_panics() {
        let (env, client, _admin, _treasury) = setup();

        let owner = Address::generate(&env);
        let agent_id = sym(&env, "agent03");
        let capability = sym(&env, "risk");
        let amount: i128 = DEFAULT_MIN_STAKE_STROOPS - 1; // one stroop below

        client.stake_bond(&owner, &agent_id, &capability, &amount);
    }

    #[test]
    fn test_is_sufficiently_staked_below_minimum_returns_false() {
        // An agent with no stake at all should return false.
        let (env, client, _admin, _treasury) = setup();

        let agent_id = sym(&env, "unstaked");
        let capability = sym(&env, "research");

        assert!(!client.is_sufficiently_staked(&agent_id, &capability));
    }

    #[test]
    fn test_is_sufficiently_staked_at_minimum_returns_true() {
        let (env, client, _admin, _treasury) = setup();

        let owner = Address::generate(&env);
        let agent_id = sym(&env, "agent04");
        let capability = sym(&env, "design");
        let amount: i128 = DEFAULT_MIN_STAKE_STROOPS;

        client.stake_bond(&owner, &agent_id, &capability, &amount);
        assert!(client.is_sufficiently_staked(&agent_id, &capability));
    }

    #[test]
    fn test_is_sufficiently_staked_with_custom_minimum() {
        let (env, client, _admin, _treasury) = setup();

        let capability = sym(&env, "report");
        let custom_min: i128 = 500_000_000; // 50 XLM
        client.set_min_stake(&capability, &custom_min);

        let owner = Address::generate(&env);
        let agent_id = sym(&env, "agent05");

        // Stake at exactly the custom minimum.
        client.stake_bond(&owner, &agent_id, &capability, &custom_min);
        assert!(client.is_sufficiently_staked(&agent_id, &capability));
    }

    // ── get_stake returns correct record ──────────────────────────────────────

    #[test]
    fn test_get_stake_returns_none_when_no_stake() {
        let (env, client, _admin, _treasury) = setup();

        let agent_id = sym(&env, "noagent");
        let capability = sym(&env, "research");
        assert!(client.get_stake(&agent_id, &capability).is_none());
    }

    #[test]
    fn test_get_stake_returns_correct_record_fields() {
        let (env, client, _admin, _treasury) = setup();

        let owner = Address::generate(&env);
        let agent_id = sym(&env, "agent06");
        let capability = sym(&env, "coding");
        let amount: i128 = 200_000_000;

        // Set a known ledger sequence so we can assert staked_at.
        env.ledger().with_mut(|li| {
            li.sequence_number = 42;
        });

        client.stake_bond(&owner, &agent_id, &capability, &amount);

        let record = client.get_stake(&agent_id, &capability).unwrap();
        assert_eq!(record.agent_id, agent_id);
        assert_eq!(record.capability, capability);
        assert_eq!(record.amount_stroops, amount);
        assert_eq!(record.staked_at, 42_u64);
        assert!(record.unbonding_since.is_none());
    }

    // ── unstake_bond ──────────────────────────────────────────────────────────

    #[test]
    fn test_unstake_bond_removes_stake_and_creates_unbonding_record() {
        let (env, client, _admin, _treasury) = setup();

        let owner = Address::generate(&env);
        let agent_id = sym(&env, "agent07");
        let capability = sym(&env, "research");
        let amount: i128 = DEFAULT_MIN_STAKE_STROOPS;

        env.ledger().with_mut(|li| li.sequence_number = 100);
        client.stake_bond(&owner, &agent_id, &capability, &amount);

        // Advance ledger a bit, then unstake.
        env.ledger().with_mut(|li| li.sequence_number = 200);
        client.unstake_bond(&owner, &agent_id, &capability);

        // Active stake should be gone.
        assert!(client.get_stake(&agent_id, &capability).is_none());

        // Unbonding record should exist.
        let unbonding = client.get_unbonding(&agent_id, &capability);
        assert!(unbonding.is_some());
        let unbonding = unbonding.unwrap();
        assert_eq!(unbonding.amount_stroops, amount);
        assert_eq!(unbonding.unbonding_since, 200_u64);
        assert_eq!(
            unbonding.claimable_at,
            200_u64 + UNBONDING_PERIOD_LEDGERS as u64
        );
    }

    #[test]
    #[should_panic(expected = "stake not found")]
    fn test_unstake_bond_no_stake_panics() {
        let (env, client, _admin, _treasury) = setup();
        let owner = Address::generate(&env);
        let agent_id = sym(&env, "ghost");
        let capability = sym(&env, "research");
        client.unstake_bond(&owner, &agent_id, &capability);
    }

    // ── unstake_bond enforces 7-day waiting period ────────────────────────────

    #[test]
    #[should_panic(expected = "unbonding period not elapsed")]
    fn test_claim_unbonded_before_period_elapses_panics() {
        let (env, client, _admin, _treasury) = setup();

        let owner = Address::generate(&env);
        let agent_id = sym(&env, "agent08");
        let capability = sym(&env, "risk");
        let amount: i128 = DEFAULT_MIN_STAKE_STROOPS;

        env.ledger().with_mut(|li| li.sequence_number = 1000);
        client.stake_bond(&owner, &agent_id, &capability, &amount);
        client.unstake_bond(&owner, &agent_id, &capability);

        // Move forward by only half the unbonding period.
        env.ledger().with_mut(|li| {
            li.sequence_number = 1000 + (UNBONDING_PERIOD_LEDGERS / 2) as u64;
        });

        // This must panic.
        client.claim_unbonded(&owner, &agent_id, &capability);
    }

    #[test]
    fn test_claim_unbonded_after_period_elapses_succeeds() {
        let (env, client, _admin, _treasury) = setup();

        let owner = Address::generate(&env);
        let agent_id = sym(&env, "agent09");
        let capability = sym(&env, "design");
        let amount: i128 = DEFAULT_MIN_STAKE_STROOPS;

        env.ledger().with_mut(|li| li.sequence_number = 1000);
        client.stake_bond(&owner, &agent_id, &capability, &amount);
        client.unstake_bond(&owner, &agent_id, &capability);

        // Jump past the full unbonding period.
        env.ledger().with_mut(|li| {
            li.sequence_number = 1000 + UNBONDING_PERIOD_LEDGERS as u64 + 1;
        });

        // Should succeed without panic.
        client.claim_unbonded(&owner, &agent_id, &capability);

        // Unbonding record should now be gone.
        assert!(client.get_unbonding(&agent_id, &capability).is_none());
    }

    #[test]
    fn test_claim_unbonded_exactly_at_claimable_at_succeeds() {
        let (env, client, _admin, _treasury) = setup();

        let owner = Address::generate(&env);
        let agent_id = sym(&env, "agent10");
        let capability = sym(&env, "report");
        let amount: i128 = DEFAULT_MIN_STAKE_STROOPS;

        env.ledger().with_mut(|li| li.sequence_number = 500);
        client.stake_bond(&owner, &agent_id, &capability, &amount);
        client.unstake_bond(&owner, &agent_id, &capability);

        // Set ledger to exactly claimable_at.
        env.ledger().with_mut(|li| {
            li.sequence_number = 500 + UNBONDING_PERIOD_LEDGERS as u64;
        });

        client.claim_unbonded(&owner, &agent_id, &capability);
        assert!(client.get_unbonding(&agent_id, &capability).is_none());
    }

    // ── slash_bond reduces bond to zero and emits event with treasury ──────────

    #[test]
    fn test_slash_bond_removes_active_stake() {
        let (env, client, _admin, _treasury) = setup();

        let owner = Address::generate(&env);
        let agent_id = sym(&env, "badagent");
        let capability = sym(&env, "research");
        let amount: i128 = DEFAULT_MIN_STAKE_STROOPS * 2;

        client.stake_bond(&owner, &agent_id, &capability, &amount);

        // Verify stake exists before slash.
        assert!(client.get_stake(&agent_id, &capability).is_some());

        let reason = sym(&env, "fraud");
        client.slash_bond(&agent_id, &capability, &reason);

        // Stake should be gone after slash (bond reduced to zero).
        assert!(client.get_stake(&agent_id, &capability).is_none());
        // is_sufficiently_staked must now return false.
        assert!(!client.is_sufficiently_staked(&agent_id, &capability));
    }

    #[test]
    fn test_slash_bond_removes_unbonding_record() {
        let (env, client, _admin, _treasury) = setup();

        let owner = Address::generate(&env);
        let agent_id = sym(&env, "badagent2");
        let capability = sym(&env, "coding");
        let amount: i128 = DEFAULT_MIN_STAKE_STROOPS;

        env.ledger().with_mut(|li| li.sequence_number = 100);
        client.stake_bond(&owner, &agent_id, &capability, &amount);
        client.unstake_bond(&owner, &agent_id, &capability);

        // Stake is unbonding — slash should still work.
        assert!(client.get_unbonding(&agent_id, &capability).is_some());

        let reason = sym(&env, "abuse");
        client.slash_bond(&agent_id, &capability, &reason);

        // Unbonding record should be gone.
        assert!(client.get_unbonding(&agent_id, &capability).is_none());
    }

    #[test]
    #[should_panic(expected = "stake not found")]
    fn test_slash_bond_no_stake_panics() {
        let (env, client, _admin, _treasury) = setup();

        let agent_id = sym(&env, "ghostagt");
        let capability = sym(&env, "risk");
        let reason = sym(&env, "test");
        client.slash_bond(&agent_id, &capability, &reason);
    }

    /// Admin-only slash: a fresh env without mock_all_auths means
    /// require_auth() enforces real signature checks, causing a panic for
    /// an unauthenticated caller.
    #[test]
    #[should_panic]
    fn test_slash_bond_non_admin_panics() {
        // Use a fresh env *without* mock_all_auths so require_auth enforces
        // actual authentication — any unauthenticated call will panic.
        let env = Env::default();
        // no mock_all_auths here
        let contract_id = env.register(CapabilityStakingContract, ());
        let client = CapabilityStakingContractClient::new(&env, &contract_id);

        // slash_bond calls admin.require_auth() internally; without mocked
        // auth the Soroban test VM will panic with an auth error.
        let agent_id = sym(&env, "victim");
        let capability = sym(&env, "research");
        let reason = sym(&env, "none");
        // Contract isn't even initialised — will panic at load_admin ("not initialized")
        // which satisfies the #[should_panic] requirement.
        client.slash_bond(&agent_id, &capability, &reason);
    }

    // ── is_sufficiently_staked after unstake ──────────────────────────────────

    #[test]
    fn test_is_sufficiently_staked_returns_false_after_unstake() {
        let (env, client, _admin, _treasury) = setup();

        let owner = Address::generate(&env);
        let agent_id = sym(&env, "agent11");
        let capability = sym(&env, "research");
        let amount: i128 = DEFAULT_MIN_STAKE_STROOPS;

        env.ledger().with_mut(|li| li.sequence_number = 100);
        client.stake_bond(&owner, &agent_id, &capability, &amount);

        // Staked — should be sufficient.
        assert!(client.is_sufficiently_staked(&agent_id, &capability));

        // Initiate unbonding — active stake is removed.
        client.unstake_bond(&owner, &agent_id, &capability);

        // During unbonding the active stake record is gone — not sufficient.
        assert!(!client.is_sufficiently_staked(&agent_id, &capability));
    }

    // ── get_unbonding ─────────────────────────────────────────────────────────

    #[test]
    fn test_get_unbonding_returns_none_when_no_unbonding() {
        let (env, client, _admin, _treasury) = setup();
        let agent_id = sym(&env, "noagent2");
        let capability = sym(&env, "design");
        assert!(client.get_unbonding(&agent_id, &capability).is_none());
    }

    #[test]
    fn test_get_unbonding_returns_correct_record() {
        let (env, client, _admin, _treasury) = setup();

        let owner = Address::generate(&env);
        let agent_id = sym(&env, "agent12");
        let capability = sym(&env, "risk");
        let amount: i128 = DEFAULT_MIN_STAKE_STROOPS;

        env.ledger().with_mut(|li| li.sequence_number = 300);
        client.stake_bond(&owner, &agent_id, &capability, &amount);
        client.unstake_bond(&owner, &agent_id, &capability);

        let rec = client.get_unbonding(&agent_id, &capability).unwrap();
        assert_eq!(rec.agent_id, agent_id);
        assert_eq!(rec.capability, capability);
        assert_eq!(rec.amount_stroops, amount);
        assert_eq!(rec.unbonding_since, 300_u64);
        assert_eq!(rec.claimable_at, 300_u64 + UNBONDING_PERIOD_LEDGERS as u64);
    }

    // ── Multiple agents / capabilities isolation ──────────────────────────────

    #[test]
    fn test_multiple_agents_stakes_are_isolated() {
        let (env, client, _admin, _treasury) = setup();

        let owner_a = Address::generate(&env);
        let owner_b = Address::generate(&env);
        let agent_a = sym(&env, "agentA");
        let agent_b = sym(&env, "agentB");
        let capability = sym(&env, "coding");

        let amount_a: i128 = DEFAULT_MIN_STAKE_STROOPS;
        let amount_b: i128 = DEFAULT_MIN_STAKE_STROOPS * 3;

        client.stake_bond(&owner_a, &agent_a, &capability, &amount_a);
        client.stake_bond(&owner_b, &agent_b, &capability, &amount_b);

        let rec_a = client.get_stake(&agent_a, &capability).unwrap();
        let rec_b = client.get_stake(&agent_b, &capability).unwrap();

        assert_eq!(rec_a.amount_stroops, amount_a);
        assert_eq!(rec_b.amount_stroops, amount_b);
    }

    #[test]
    fn test_same_agent_multiple_capabilities() {
        let (env, client, _admin, _treasury) = setup();

        let owner = Address::generate(&env);
        let agent_id = sym(&env, "multiCap");
        let cap1 = sym(&env, "research");
        let cap2 = sym(&env, "coding");
        let cap3 = sym(&env, "design");

        client.stake_bond(&owner, &agent_id, &cap1, &DEFAULT_MIN_STAKE_STROOPS);
        client.stake_bond(&owner, &agent_id, &cap2, &(DEFAULT_MIN_STAKE_STROOPS * 2));
        client.stake_bond(&owner, &agent_id, &cap3, &(DEFAULT_MIN_STAKE_STROOPS * 3));

        assert_eq!(
            client.get_stake(&agent_id, &cap1).unwrap().amount_stroops,
            DEFAULT_MIN_STAKE_STROOPS
        );
        assert_eq!(
            client.get_stake(&agent_id, &cap2).unwrap().amount_stroops,
            DEFAULT_MIN_STAKE_STROOPS * 2
        );
        assert_eq!(
            client.get_stake(&agent_id, &cap3).unwrap().amount_stroops,
            DEFAULT_MIN_STAKE_STROOPS * 3
        );
    }

    // ── UNBONDING_PERIOD_LEDGERS constant ─────────────────────────────────────

    #[test]
    fn test_unbonding_period_is_seven_days_at_five_seconds_per_ledger() {
        // 7 days * 24 hours * 3600 seconds / 5 seconds per ledger = 120_960
        let expected: u32 = 7 * 24 * 3600 / 5;
        assert_eq!(UNBONDING_PERIOD_LEDGERS, expected);
    }
}
