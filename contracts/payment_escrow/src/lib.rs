#![no_std]

use soroban_sdk::{
    contract, contracterror, contractevent, contractimpl, contracttype, token, Address, BytesN,
    Env,
};

// ───────────────────────── Constants ─────────────────────────
/// 7 days in seconds (7 * 24 * 60 * 60)
pub const ESCROW_TIMEOUT_SECONDS: u64 = 604_800;

// ───────────────────────── Errors ─────────────────────────
#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum EscrowError {
    NotAuthorized = 1,
    EscrowNotFound = 2,
    EscrowAlreadyExists = 3,
    InvalidAmount = 4,
    EscrowNotActive = 5,
    TimeoutNotReached = 6,
    InsufficientBalance = 7,
}

// ───────────────────────── Storage Keys ─────────────────────────
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum DataKey {
    Escrow(u64),
    Coordinator,
    XlmToken,
}

// ───────────────────────── Data Types ─────────────────────────
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum EscrowStatus {
    Active,
    Released,
    Refunded,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct EscrowRecord {
    pub task_id: u64,
    pub submitter: Address,
    pub amount_xlm: i128,
    pub status: EscrowStatus,
    pub locked_at: u64,
    pub agent_id: Option<u64>,
}

// ───────────────────────── Events ─────────────────────────
#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct EscrowLocked {
    #[topic]
    pub task_id: u64,
    #[topic]
    pub submitter: Address,
    pub amount_xlm: i128,
    pub locked_at: u64,
}

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct EscrowReleased {
    #[topic]
    pub task_id: u64,
    #[topic]
    pub agent_id: u64,
    pub amount_xlm: i128,
    pub released_at: u64,
}

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct EscrowRefunded {
    #[topic]
    pub task_id: u64,
    #[topic]
    pub submitter: Address,
    pub amount_xlm: i128,
    pub refunded_at: u64,
    pub auto_refund: bool,
}

// ───────────────────────── Contract ─────────────────────────
#[contract]
pub struct PaymentEscrow;

#[contractimpl]
impl PaymentEscrow {
    /// Initialize the escrow with a coordinator and the XLM token address.
    pub fn initialize(env: Env, coordinator: Address, xlm_token: Address) {
        if env.storage().instance().has(&DataKey::Coordinator) {
            panic!("already initialized");
        }
        coordinator.require_auth();
        env.storage()
            .instance()
            .set(&DataKey::Coordinator, &coordinator);
        env.storage().instance().set(&DataKey::XlmToken, &xlm_token);
    }

    /// Lock funds for a task. Only the submitter can lock.
    pub fn lock_funds(
        env: Env,
        task_id: u64,
        submitter: Address,
        amount_xlm: i128,
    ) -> Result<(), EscrowError> {
        submitter.require_auth();

        if amount_xlm <= 0 {
            return Err(EscrowError::InvalidAmount);
        }

        // Prevent overwriting an existing escrow
        if env
            .storage()
            .persistent()
            .has(&DataKey::Escrow(task_id))
        {
            return Err(EscrowError::EscrowAlreadyExists);
        }

        let xlm_token: Address = env
            .storage()
            .instance()
            .get(&DataKey::XlmToken)
            .unwrap();

        // Transfer XLM from submitter to this contract
        token::TokenClient::new(&env, &xlm_token).transfer(
            &submitter,
            &env.current_contract_address(),
            &amount_xlm,
        );

        let now = env.ledger().timestamp();

        let record = EscrowRecord {
            task_id,
            submitter: submitter.clone(),
            amount_xlm,
            status: EscrowStatus::Active,
            locked_at: now,
            agent_id: None,
        };

        env.storage()
            .persistent()
            .set(&DataKey::Escrow(task_id), &record);

        EscrowLocked {
            task_id,
            submitter,
            amount_xlm,
            locked_at: now,
        }
        .publish(&env);

        Ok(())
    }

    /// Release funds to an agent. Only the coordinator can call.
    pub fn release_funds(
        env: Env,
        task_id: u64,
        agent_id: u64,
    ) -> Result<(), EscrowError> {
        let coordinator: Address = env
            .storage()
            .instance()
            .get(&DataKey::Coordinator)
            .ok_or(EscrowError::NotAuthorized)?;
        coordinator.require_auth();

        let mut record: EscrowRecord = env
            .storage()
            .persistent()
            .get(&DataKey::Escrow(task_id))
            .ok_or(EscrowError::EscrowNotFound)?;

        if record.status != EscrowStatus::Active {
            return Err(EscrowError::EscrowNotActive);
        }

        let xlm_token: Address = env
            .storage()
            .instance()
            .get(&DataKey::XlmToken)
            .unwrap();

        // Transfer XLM from this contract to the coordinator (who forwards to agent)
        // In production, the agent's address would be resolved from agent_id
        token::TokenClient::new(&env, &xlm_token).transfer(
            &env.current_contract_address(),
            &coordinator,
            &record.amount_xlm,
        );

        let now = env.ledger().timestamp();

        record.status = EscrowStatus::Released;
        record.agent_id = Some(agent_id);
        env.storage()
            .persistent()
            .set(&DataKey::Escrow(task_id), &record);

        EscrowReleased {
            task_id,
            agent_id,
            amount_xlm: record.amount_xlm,
            released_at: now,
        }
        .publish(&env);

        Ok(())
    }

    /// Refund funds to the submitter. Coordinator can call anytime;
    /// anyone can call after the 7-day timeout.
    pub fn refund_funds(env: Env, task_id: u64) -> Result<(), EscrowError> {
        let mut record: EscrowRecord = env
            .storage()
            .persistent()
            .get(&DataKey::Escrow(task_id))
            .ok_or(EscrowError::EscrowNotFound)?;

        if record.status != EscrowStatus::Active {
            return Err(EscrowError::EscrowNotActive);
        }

        let now = env.ledger().timestamp();
        let timeout_at = record.locked_at + ESCROW_TIMEOUT_SECONDS;

        // Determine caller and auth requirement
        let coordinator: Address = env
            .storage()
            .instance()
            .get(&DataKey::Coordinator)
            .unwrap();

        let is_timeout = now >= timeout_at;

        if is_timeout {
            // Timeout refund: anyone can trigger, no auth needed
        } else {
            // Before timeout: only coordinator can refund
            coordinator.require_auth();
        }

        let xlm_token: Address = env
            .storage()
            .instance()
            .get(&DataKey::XlmToken)
            .unwrap();

        // Transfer XLM back to submitter
        token::TokenClient::new(&env, &xlm_token).transfer(
            &env.current_contract_address(),
            &record.submitter,
            &record.amount_xlm,
        );

        record.status = EscrowStatus::Refunded;
        env.storage()
            .persistent()
            .set(&DataKey::Escrow(task_id), &record);

        EscrowRefunded {
            task_id,
            submitter: record.submitter,
            amount_xlm: record.amount_xlm,
            refunded_at: now,
            auto_refund: is_timeout,
        }
        .publish(&env);

        Ok(())
    }

    /// Get an escrow record by task_id.
    pub fn get_escrow(env: Env, task_id: u64) -> Result<EscrowRecord, EscrowError> {
        env.storage()
            .persistent()
            .get(&DataKey::Escrow(task_id))
            .ok_or(EscrowError::EscrowNotFound)
    }

    /// Check if an escrow is past the 7-day timeout.
    pub fn is_timed_out(env: Env, task_id: u64) -> Result<bool, EscrowError> {
        let record: EscrowRecord = env
            .storage()
            .persistent()
            .get(&DataKey::Escrow(task_id))
            .ok_or(EscrowError::EscrowNotFound)?;

        if record.status != EscrowStatus::Active {
            return Ok(false);
        }

        let now = env.ledger().timestamp();
        Ok(now >= record.locked_at + ESCROW_TIMEOUT_SECONDS)
    }
}

mod test;
