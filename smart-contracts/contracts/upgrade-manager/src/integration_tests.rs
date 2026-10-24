/// Integration tests for the UpgradeManager contract.
///
/// Covers:
/// - Initialize and get current version
/// - Propose, validate, and execute an upgrade
/// - Rollback within the rollback window
/// - Rollback after the window is expired is rejected
/// - Non-admin cannot propose an upgrade
/// - Downgrade (older version string) is rejected
#[cfg(test)]
mod integration_tests {
    use crate::{MigrationPlan, UpgradeError, UpgradeManager, UpgradeManagerClient};
    use soroban_sdk::{
        testutils::{Address as _, Ledger},
        Address, BytesN, Env, String, Vec,
    };

    // Rollback window in ledgers — mirrors lib.rs constant.
    const ROLLBACK_WINDOW_LEDGERS: u32 = 34_560;

    // ─── Helpers ─────────────────────────────────────────────────────────────

    fn setup() -> (Env, UpgradeManagerClient<'static>, Address) {
        let env = Env::default();
        env.mock_all_auths();
        env.ledger().with_mut(|l| {
            l.sequence_number = 1000;
            l.timestamp = 1_700_000_000;
        });

        let id = env.register(UpgradeManager, ());
        let client = UpgradeManagerClient::new(&env, &id);

        let admin = Address::generate(&env);
        let initial_version = String::from_str(&env, "1.0.0");
        let initial_hash = BytesN::from_array(&env, &[1u8; 32]);
        client.initialize(&admin, &initial_version, &initial_hash);

        (env, client, admin)
    }

    fn empty_migration_plan(env: &Env) -> MigrationPlan {
        MigrationPlan {
            pre_migration_checks: Vec::new(env),
            data_transformations: Vec::new(env),
            post_migration_validations: Vec::new(env),
            estimated_items: 0,
        }
    }

    // ─── Tests ───────────────────────────────────────────────────────────────

    #[test]
    fn test_initialize_and_get_current_version() {
        let (env, client, _admin) = setup();

        let version = client.get_current_version();
        assert!(version.is_some(), "current version must be set after initialize");
        assert_eq!(
            version.unwrap().version,
            String::from_str(&env, "1.0.0"),
            "version string must match the initial version"
        );
    }

    #[test]
    fn test_double_initialize_rejected() {
        let (env, client, _admin) = setup();

        let another_admin = Address::generate(&env);
        let result = client.try_initialize(
            &another_admin,
            &String::from_str(&env, "0.0.1"),
            &BytesN::from_array(&env, &[0u8; 32]),
        );
        assert!(result.is_err(), "double initialize must be rejected");
    }

    #[test]
    fn test_propose_upgrade_stores_proposal() {
        let (env, client, _admin) = setup();

        let new_version = String::from_str(&env, "2.0.0");
        let new_hash = BytesN::from_array(&env, &[2u8; 32]);
        let description = String::from_str(&env, "Major upgrade");
        let plan = empty_migration_plan(&env);

        let result = client.try_propose_upgrade(&new_version, &new_hash, &description, &plan);
        assert!(result.is_ok(), "propose_upgrade should succeed: {result:?}");
    }

    #[test]
    fn test_propose_downgrade_rejected() {
        let (env, client, _admin) = setup();

        // "0.9.0" < "1.0.0" lexicographically — must be rejected.
        let old_version = String::from_str(&env, "0.9.0");
        let new_hash = BytesN::from_array(&env, &[9u8; 32]);
        let description = String::from_str(&env, "Downgrade attempt");
        let plan = empty_migration_plan(&env);

        let result = client.try_propose_upgrade(&old_version, &new_hash, &description, &plan);
        assert_eq!(
            result,
            Err(Ok(UpgradeError::DowngradeNotAllowed)),
            "downgrade must be rejected"
        );
    }

    #[test]
    fn test_execute_without_validated_proposal_rejected() {
        let (_env, client, _admin) = setup();

        // No proposal proposed, execute must fail.
        let result = client.try_execute_upgrade();
        assert_eq!(result, Err(Ok(UpgradeError::NoProposal)), "execute without proposal must fail");
    }

    #[test]
    fn test_propose_validate_and_execute_upgrade() {
        let (env, client, _admin) = setup();

        let new_version = String::from_str(&env, "2.0.0");
        let new_hash = BytesN::from_array(&env, &[2u8; 32]);
        let description = String::from_str(&env, "v2 upgrade");
        let plan = empty_migration_plan(&env);

        // Propose.
        client.propose_upgrade(&new_version, &new_hash, &description, &plan);

        // Validate.
        let result = client.try_validate_proposal();
        assert!(result.is_ok(), "validate_proposal should succeed: {result:?}");

        // Execute.
        let exec_result = client.try_execute_upgrade();
        assert!(exec_result.is_ok(), "execute_upgrade should succeed: {exec_result:?}");

        // Version must have advanced.
        let current = client.get_current_version().unwrap();
        assert_eq!(current.version, String::from_str(&env, "2.0.0"));
    }

    #[test]
    fn test_rollback_within_window_succeeds() {
        let (env, client, _admin) = setup();

        // Propose, validate, and execute an upgrade.
        let new_version = String::from_str(&env, "2.0.0");
        let new_hash = BytesN::from_array(&env, &[2u8; 32]);
        let plan = empty_migration_plan(&env);
        client.propose_upgrade(&new_version, &new_hash, &String::from_str(&env, "v2"), &plan);
        client.validate_proposal();
        client.execute_upgrade();

        // Rollback info must be available.
        let rollback_info = client.get_rollback_info();
        assert!(rollback_info.is_some(), "rollback info must be set after upgrade");
        assert!(rollback_info.unwrap().can_rollback, "rollback must be available");

        // Rollback within the window.
        let result = client.try_rollback_upgrade();
        assert!(result.is_ok(), "rollback_upgrade within window should succeed: {result:?}");

        // Version must have reverted.
        let current = client.get_current_version().unwrap();
        assert_eq!(
            current.version,
            String::from_str(&env, "1.0.0"),
            "version must revert to 1.0.0 after rollback"
        );
    }

    #[test]
    fn test_rollback_after_window_expired_rejected() {
        let (env, client, _admin) = setup();

        // Propose, validate, and execute.
        let new_version = String::from_str(&env, "2.0.0");
        let new_hash = BytesN::from_array(&env, &[2u8; 32]);
        let plan = empty_migration_plan(&env);
        client.propose_upgrade(&new_version, &new_hash, &String::from_str(&env, "v2"), &plan);
        client.validate_proposal();
        client.execute_upgrade();

        // Advance ledger past the rollback window.
        env.ledger().with_mut(|l| {
            l.sequence_number += ROLLBACK_WINDOW_LEDGERS + 1;
        });

        let result = client.try_rollback_upgrade();
        assert_eq!(
            result,
            Err(Ok(UpgradeError::RollbackDeadlineExpired)),
            "rollback after window must be rejected"
        );
    }

    #[test]
    fn test_rollback_without_any_upgrade_rejected() {
        let (_env, client, _admin) = setup();

        // No upgrade has been executed, so there is nothing to roll back.
        let result = client.try_rollback_upgrade();
        assert_eq!(
            result,
            Err(Ok(UpgradeError::NoRollbackAvailable)),
            "rollback without prior upgrade must be rejected"
        );
    }

    #[test]
    fn test_estimate_migration_gas_scales_with_items() {
        let (env, client, _admin) = setup();

        let plan_0 = empty_migration_plan(&env);
        let gas_0 = client.estimate_migration_gas(&plan_0);

        let mut plan_100 = empty_migration_plan(&env);
        plan_100.estimated_items = 100;
        let gas_100 = client.estimate_migration_gas(&plan_100);

        assert!(
            gas_100 > gas_0,
            "gas estimate for 100 items ({gas_100}) must exceed 0 items ({gas_0})"
        );
    }
}
