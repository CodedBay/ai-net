/// Integration tests for the TaskStore contract covering the full task lifecycle.
///
/// Tests:
/// - Create and get task metadata
/// - Full happy path: Pending → Running → Completed
/// - Fail path: Pending → Failed
/// - Fail path: Running → Failed
/// - Unauthorized agent cannot update status
/// - Duplicate task creation rejected
/// - Task not found returns error
/// - Expired task returns Expired error
#[cfg(test)]
mod tests {
    use crate::{Error, TaskStatus, TaskStoreContract, TaskStoreContractClient};
    use soroban_sdk::{
        testutils::{Address as _, Ledger},
        Address, Bytes, BytesN, Env, Vec,
    };

    const SECONDS_PER_DAY: u64 = 86_400;

    struct TaskFixture {
        env: Env,
        client: TaskStoreContractClient<'static>,
        submitter: Address,
        agent: Address,
        task_id: BytesN<32>,
        prompt_hash: BytesN<32>,
    }

    fn fixture() -> TaskFixture {
        let env = Env::default();
        env.mock_all_auths();
        env.ledger().with_mut(|l| {
            l.timestamp = 1_700_000_000;
            l.sequence_number = 100;
        });

        let contract_id = env.register(TaskStoreContract, ());
        let client = TaskStoreContractClient::new(&env, &contract_id);

        TaskFixture {
            submitter: Address::generate(&env),
            agent: Address::generate(&env),
            task_id: BytesN::from_array(&env, &[0x01u8; 32]),
            prompt_hash: BytesN::from_array(&env, &[0x02u8; 32]),
            env,
            client,
        }
    }

    fn store(f: &TaskFixture) {
        let agents = Vec::from_array(&f.env, [f.agent.clone()]);
        let dag = Bytes::from_slice(&f.env, &[0x78, 0x9c, 0x03, 0x00]);
        f.client.store_task_metadata(
            &f.submitter,
            &f.task_id,
            &f.prompt_hash,
            &agents,
            &dag,
            &1u32,
            &None,
        );
    }

    // ─── Tests ───────────────────────────────────────────────────────────────

    #[test]
    fn test_task_create_and_get() {
        let f = fixture();
        store(&f);

        let metadata = f.client.get_task_metadata(&f.task_id);
        assert_eq!(metadata.task_id, f.task_id);
        assert_eq!(metadata.prompt_hash, f.prompt_hash);
        assert_eq!(metadata.status, TaskStatus::Pending);
        assert_eq!(metadata.assigned_agents.len(), 1);
        assert_eq!(metadata.assigned_agents.get(0).unwrap(), f.agent);
        assert_eq!(metadata.quoted_price_stroops, None);
    }

    #[test]
    fn test_task_not_found_returns_error() {
        let f = fixture();
        let missing_id = BytesN::from_array(&f.env, &[0xFFu8; 32]);
        let result = f.client.try_get_task_metadata(&missing_id);
        assert_eq!(result, Err(Ok(Error::NotFound)));
    }

    #[test]
    fn test_task_full_lifecycle_pending_running_completed() {
        let f = fixture();
        store(&f);

        // Pending → Running
        f.client
            .update_task_status(&f.task_id, &f.agent, &TaskStatus::Running);
        assert_eq!(f.client.get_task_status(&f.task_id), TaskStatus::Running);

        // Running → Completed
        f.client
            .update_task_status(&f.task_id, &f.agent, &TaskStatus::Completed);
        assert_eq!(f.client.get_task_status(&f.task_id), TaskStatus::Completed);
    }

    #[test]
    fn test_task_fail_path_from_pending() {
        let f = fixture();
        store(&f);

        f.client
            .update_task_status(&f.task_id, &f.agent, &TaskStatus::Failed);
        assert_eq!(f.client.get_task_status(&f.task_id), TaskStatus::Failed);
    }

    #[test]
    fn test_task_fail_path_from_running() {
        let f = fixture();
        store(&f);

        f.client
            .update_task_status(&f.task_id, &f.agent, &TaskStatus::Running);
        f.client
            .update_task_status(&f.task_id, &f.agent, &TaskStatus::Failed);
        assert_eq!(f.client.get_task_status(&f.task_id), TaskStatus::Failed);
    }

    #[test]
    fn test_invalid_transition_pending_to_completed_rejected() {
        let f = fixture();
        store(&f);

        // Cannot skip Running → go directly Pending → Completed.
        let result = f
            .client
            .try_update_task_status(&f.task_id, &f.agent, &TaskStatus::Completed);
        assert_eq!(result, Err(Ok(Error::InvalidStatusTransition)));
    }

    #[test]
    fn test_unassigned_agent_cannot_update_status() {
        let f = fixture();
        store(&f);

        let stranger = Address::generate(&f.env);
        let result = f
            .client
            .try_update_task_status(&f.task_id, &stranger, &TaskStatus::Running);
        assert_eq!(result, Err(Ok(Error::NotAssignedAgent)));
    }

    #[test]
    fn test_duplicate_task_creation_rejected() {
        let f = fixture();
        store(&f);

        // Second store with same task_id must fail.
        let agents = Vec::from_array(&f.env, [f.agent.clone()]);
        let dag = Bytes::from_slice(&f.env, &[0x78, 0x9c, 0x03, 0x00]);
        let result = f.client.try_store_task_metadata(
            &f.submitter,
            &f.task_id,
            &f.prompt_hash,
            &agents,
            &dag,
            &1u32,
            &None,
        );
        assert_eq!(result, Err(Ok(Error::AlreadyExists)));
    }

    #[test]
    fn test_expired_task_returns_expired_error() {
        let f = fixture();
        store(&f);

        // Advance ledger past 1-day TTL.
        f.env.ledger().with_mut(|l| {
            l.timestamp += SECONDS_PER_DAY + 1;
        });

        let result = f.client.try_get_task_metadata(&f.task_id);
        assert_eq!(result, Err(Ok(Error::Expired)));
    }

    #[test]
    fn test_empty_assigned_agents_rejected() {
        let f = fixture();
        let empty_agents: Vec<Address> = Vec::new(&f.env);
        let dag = Bytes::from_slice(&f.env, &[0x78, 0x9c, 0x03, 0x00]);

        let result = f.client.try_store_task_metadata(
            &f.submitter,
            &f.task_id,
            &f.prompt_hash,
            &empty_agents,
            &dag,
            &1u32,
            &None,
        );
        assert_eq!(result, Err(Ok(Error::NoAssignedAgents)));
    }
}
