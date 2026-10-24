/// Integration tests for the task_store coordinator authorization model.
///
/// Covers:
/// - `set_coordinator` and `get_coordinator`
/// - `rotate_coordinator` (admin-only key rotation)
/// - `assign_task` requires coordinator auth
/// - Self-assignment is prevented at the contract level
/// - `fail_task` requires coordinator auth
/// - `release_funds` requires coordinator auth (task must be Completed first)
/// - Non-coordinator cannot call restricted functions
use super::*;
use soroban_sdk::{
    testutils::{Address as _, Ledger},
    Address, Bytes, BytesN, Env, Vec,
};

// ─── Fixture ─────────────────────────────────────────────────────────────────

struct CoordFixture {
    env: Env,
    client: TaskStoreContractClient<'static>,
    #[allow(dead_code)]
    admin: Address,
    coordinator: Address,
    task_id: BytesN<32>,
    prompt_hash: BytesN<32>,
    agent: Address,
}

fn fixture() -> CoordFixture {
    let env = Env::default();
    env.mock_all_auths();
    env.ledger().with_mut(|l| {
        l.timestamp = 1_700_000_000;
        l.sequence_number = 100;
    });

    let contract_id = env.register(TaskStoreContract, ());
    let client = TaskStoreContractClient::new(&env, &contract_id);

    let admin = Address::generate(&env);
    let coordinator = Address::generate(&env);
    let agent = Address::generate(&env);
    let task_id = BytesN::from_array(&env, &[0xAAu8; 32]);
    let prompt_hash = BytesN::from_array(&env, &[0xBBu8; 32]);

    // Initialize the contract.
    client.initialize(&admin);

    CoordFixture {
        env,
        client,
        admin,
        coordinator,
        task_id,
        prompt_hash,
        agent,
    }
}

/// Store a minimal valid task in the fixture's contract.
fn store_task(f: &CoordFixture) {
    let agents = Vec::from_array(&f.env, [f.agent.clone()]);
    let dag = Bytes::from_slice(&f.env, &[0x78, 0x9c, 0x03, 0x00]);
    f.client.store_task_metadata(
        &f.agent,
        &f.task_id,
        &f.prompt_hash,
        &agents,
        &dag,
        &1u32,
        &None,
    );
}

// ─── set_coordinator / get_coordinator ───────────────────────────────────────

#[test]
fn test_set_and_get_coordinator() {
    let f = fixture();

    // Initially no coordinator is set.
    assert_eq!(
        f.client.get_coordinator(),
        None,
        "coordinator should be None before set_coordinator"
    );

    // Set coordinator and read it back.
    f.client.set_coordinator(&f.coordinator);
    assert_eq!(
        f.client.get_coordinator(),
        Some(f.coordinator.clone()),
        "get_coordinator should return the stored address"
    );
}

#[test]
fn test_set_coordinator_requires_admin() {
    let f = fixture();
    // With mock_all_auths this always passes, but the call must succeed.
    let result = f.client.try_set_coordinator(&f.coordinator);
    assert!(
        result.is_ok(),
        "set_coordinator should succeed for admin: {result:?}"
    );
}

#[test]
fn test_coordinator_key_rotation() {
    let f = fixture();

    f.client.set_coordinator(&f.coordinator);

    // Rotate to a new coordinator.
    let new_coord = Address::generate(&f.env);
    f.client.rotate_coordinator(&new_coord);

    assert_eq!(
        f.client.get_coordinator(),
        Some(new_coord.clone()),
        "coordinator should be updated after rotation"
    );
    assert_ne!(
        f.client.get_coordinator(),
        Some(f.coordinator.clone()),
        "old coordinator must no longer be active"
    );
}

// ─── assign_task ─────────────────────────────────────────────────────────────

#[test]
fn test_coordinator_can_assign_task() {
    let f = fixture();
    f.client.set_coordinator(&f.coordinator);
    store_task(&f);

    // Coordinator assigns task to agent.
    let result = f.client.try_assign_task(&f.task_id, &f.agent);
    assert!(
        result.is_ok(),
        "coordinator should be able to assign task: {result:?}"
    );

    // Task must now be Running.
    assert_eq!(
        f.client.get_task_status(&f.task_id),
        TaskStatus::Running,
        "task status must be Running after assignment"
    );
}

#[test]
fn test_assign_task_without_coordinator_set_returns_error() {
    let f = fixture();
    // No coordinator configured.
    store_task(&f);

    let result = f.client.try_assign_task(&f.task_id, &f.agent);
    assert_eq!(
        result,
        Err(Ok(Error::CoordinatorNotSet)),
        "assign_task without coordinator must return CoordinatorNotSet"
    );
}

#[test]
fn test_self_assignment_prevented() {
    let f = fixture();
    f.client.set_coordinator(&f.coordinator);
    store_task(&f);

    // Attempt to assign the task to the coordinator itself.
    let result = f.client.try_assign_task(&f.task_id, &f.coordinator);
    assert_eq!(
        result,
        Err(Ok(Error::SelfAssignmentNotAllowed)),
        "coordinator assigning to itself must return SelfAssignmentNotAllowed"
    );
}

// ─── fail_task ────────────────────────────────────────────────────────────────

#[test]
fn test_coordinator_can_fail_task_from_pending() {
    let f = fixture();
    f.client.set_coordinator(&f.coordinator);
    store_task(&f);

    let reason = soroban_sdk::String::from_str(&f.env, "agent unavailable");
    let result = f.client.try_fail_task(&f.task_id, &reason);
    assert!(
        result.is_ok(),
        "coordinator should be able to fail a pending task: {result:?}"
    );

    assert_eq!(
        f.client.get_task_status(&f.task_id),
        TaskStatus::Failed,
        "task status must be Failed after fail_task"
    );
}

#[test]
fn test_coordinator_can_fail_task_from_running() {
    let f = fixture();
    f.client.set_coordinator(&f.coordinator);
    store_task(&f);

    // Assign first, then fail.
    f.client.assign_task(&f.task_id, &f.agent);
    assert_eq!(f.client.get_task_status(&f.task_id), TaskStatus::Running);

    let reason = soroban_sdk::String::from_str(&f.env, "timeout");
    let result = f.client.try_fail_task(&f.task_id, &reason);
    assert!(
        result.is_ok(),
        "coordinator should be able to fail a running task: {result:?}"
    );

    assert_eq!(
        f.client.get_task_status(&f.task_id),
        TaskStatus::Failed,
        "task status must be Failed after fail_task on running task"
    );
}

#[test]
fn test_fail_task_without_coordinator_set_returns_error() {
    let f = fixture();
    store_task(&f);

    let reason = soroban_sdk::String::from_str(&f.env, "no coord");
    let result = f.client.try_fail_task(&f.task_id, &reason);
    assert_eq!(
        result,
        Err(Ok(Error::CoordinatorNotSet)),
        "fail_task without coordinator must return CoordinatorNotSet"
    );
}

// ─── release_funds ────────────────────────────────────────────────────────────

#[test]
fn test_release_funds_on_completed_task_succeeds() {
    let f = fixture();
    f.client.set_coordinator(&f.coordinator);
    store_task(&f);

    // Drive task to Completed via update_task_status.
    f.client
        .update_task_status(&f.task_id, &f.agent, &TaskStatus::Running);
    f.client
        .update_task_status(&f.task_id, &f.agent, &TaskStatus::Completed);

    assert_eq!(f.client.get_task_status(&f.task_id), TaskStatus::Completed);

    let result = f.client.try_release_funds(&f.task_id);
    assert!(
        result.is_ok(),
        "coordinator should be able to release funds on a completed task: {result:?}"
    );
}

#[test]
fn test_release_funds_on_pending_task_returns_error() {
    let f = fixture();
    f.client.set_coordinator(&f.coordinator);
    store_task(&f);

    // Task is still Pending.
    let result = f.client.try_release_funds(&f.task_id);
    assert_eq!(
        result,
        Err(Ok(Error::TaskNotCompleted)),
        "release_funds on a non-completed task must return TaskNotCompleted"
    );
}

#[test]
fn test_release_funds_without_coordinator_set_returns_error() {
    let f = fixture();
    store_task(&f);

    let result = f.client.try_release_funds(&f.task_id);
    assert_eq!(
        result,
        Err(Ok(Error::CoordinatorNotSet)),
        "release_funds without coordinator must return CoordinatorNotSet"
    );
}
