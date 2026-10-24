#![no_std]

use soroban_sdk::{
    contract, contracterror, contractevent, contractimpl, contracttype, Address, Env, String, Vec,
};

// ───────────────────────── Constants ─────────────────────────
pub const MAX_CAPABILITIES: u32 = 50;

// ───────────────────────── Errors ─────────────────────────
#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum RegistryError {
    NotAuthorized = 1,
    AgentAlreadyExists = 2,
    AgentNotFound = 3,
    TooManyCapabilities = 4,
    InvalidPrice = 5,
}

// ───────────────────────── Storage Keys ─────────────────────────
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum DataKey {
    Agent(u64),
    AgentCount,
}

// ───────────────────────── Data Types ─────────────────────────
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AgentRecord {
    pub agent_id: u64,
    pub name: String,
    pub capabilities: Vec<String>,
    pub price_xlm: i128,
    pub endpoint: String,
    pub owner: Address,
}

// ───────────────────────── Events ─────────────────────────
#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AgentRegistered {
    #[topic]
    pub agent_id: u64,
    #[topic]
    pub owner: Address,
    pub name: String,
}

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AgentDeregistered {
    #[topic]
    pub agent_id: u64,
    #[topic]
    pub owner: Address,
}

// ───────────────────────── Contract ─────────────────────────
#[contract]
pub struct AgentRegistry;

#[contractimpl]
impl AgentRegistry {
    /// Register a new agent. Returns the new agent_id.
    pub fn register_agent(
        env: Env,
        owner: Address,
        name: String,
        capabilities: Vec<String>,
        price_xlm: i128,
        endpoint: String,
    ) -> Result<u64, RegistryError> {
        owner.require_auth();

        if capabilities.len() > MAX_CAPABILITIES {
            return Err(RegistryError::TooManyCapabilities);
        }
        if price_xlm < 0 {
            return Err(RegistryError::InvalidPrice);
        }

        let mut count: u64 = env
            .storage()
            .persistent()
            .get(&DataKey::AgentCount)
            .unwrap_or(0u64);
        let agent_id = count + 1;

        if env
            .storage()
            .persistent()
            .has(&DataKey::Agent(agent_id))
        {
            return Err(RegistryError::AgentAlreadyExists);
        }

        let record = AgentRecord {
            agent_id,
            name: name.clone(),
            capabilities,
            price_xlm,
            endpoint,
            owner: owner.clone(),
        };

        env.storage()
            .persistent()
            .set(&DataKey::Agent(agent_id), &record);
        env.storage()
            .persistent()
            .set(&DataKey::AgentCount, &agent_id);

        AgentRegistered {
            agent_id,
            owner,
            name,
        }
        .publish(&env);

        Ok(agent_id)
    }

    /// Deregister an agent. Only the owner can call this.
    pub fn deregister_agent(env: Env, agent_id: u64) -> Result<(), RegistryError> {
        let record: AgentRecord = env
            .storage()
            .persistent()
            .get(&DataKey::Agent(agent_id))
            .ok_or(RegistryError::AgentNotFound)?;

        record.owner.require_auth();

        env.storage()
            .persistent()
            .remove(&DataKey::Agent(agent_id));

        AgentDeregistered {
            agent_id,
            owner: record.owner,
        }
        .publish(&env);

        Ok(())
    }

    /// Get a single agent by id.
    pub fn get_agent(env: Env, agent_id: u64) -> Result<AgentRecord, RegistryError> {
        env.storage()
            .persistent()
            .get(&DataKey::Agent(agent_id))
            .ok_or(RegistryError::AgentNotFound)
    }

    /// List agents with pagination. `cursor` is the last seen agent_id (0 = start).
    pub fn list_agents(env: Env, cursor: u64, limit: u32) -> Vec<AgentRecord> {
        let mut result: Vec<AgentRecord> = Vec::new(&env);
        if limit == 0 {
            return result;
        }

        let count: u64 = env
            .storage()
            .persistent()
            .get(&DataKey::AgentCount)
            .unwrap_or(0u64);

        let mut id = cursor + 1;
        let mut added: u32 = 0;

        while id <= count && added < limit {
            if let Some(record) = env
                .storage()
                .persistent()
                .get::<DataKey, AgentRecord>(&DataKey::Agent(id))
            {
                result.push_back(record);
                added += 1;
            }
            id += 1;
        }

        result
    }

    /// Update mutable fields of an agent. Only the owner can call this.
    pub fn update_agent(
        env: Env,
        agent_id: u64,
        name: Option<String>,
        capabilities: Option<Vec<String>>,
        price_xlm: Option<i128>,
        endpoint: Option<String>,
    ) -> Result<(), RegistryError> {
        let mut record: AgentRecord = env
            .storage()
            .persistent()
            .get(&DataKey::Agent(agent_id))
            .ok_or(RegistryError::AgentNotFound)?;

        record.owner.require_auth();

        if let Some(new_name) = name {
            record.name = new_name;
        }
        if let Some(new_caps) = capabilities {
            if new_caps.len() > MAX_CAPABILITIES {
                return Err(RegistryError::TooManyCapabilities);
            }
            record.capabilities = new_caps;
        }
        if let Some(new_price) = price_xlm {
            if new_price < 0 {
                return Err(RegistryError::InvalidPrice);
            }
            record.price_xlm = new_price;
        }
        if let Some(new_endpoint) = endpoint {
            record.endpoint = new_endpoint;
        }

        env.storage()
            .persistent()
            .set(&DataKey::Agent(agent_id), &record);

        Ok(())
    }
}

mod test;
