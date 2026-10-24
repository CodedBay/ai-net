#![no_std]

use soroban_sdk::{
    contract, contracterror, contractevent, contractimpl, contracttype, Address, BytesN, Env,
    String, Symbol, Vec,
};

// ───────────────────────── Constants ─────────────────────────
/// 48 hours in seconds (48 * 60 * 60)
pub const TIMELOCK_SECONDS: u64 = 172_800;
/// 48 hours rollback window in seconds
pub const ROLLBACK_WINDOW_SECONDS: u64 = 172_800;
/// 1 hour in seconds — emergency rollback after this window closes
pub const EMERGENCY_ROLLBACK_WINDOW: u64 = 3_600;

// ───────────────────────── Errors ─────────────────────────
#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum UpgradeError {
    NotAuthorized = 1,
    NoPendingUpgrade = 2,
    TimelockNotExpired = 3,
    TimelockExpired = 4,
    InvalidVersion = 5,
    VersionIncompatible = 6,
    RollbackWindowClosed = 7,
    MigrationFailed = 8,
    NoRollbackAvailable = 9,
    UpgradeAlreadyPending = 10,
    SameWasmHash = 11,
}

// ───────────────────────── Storage Keys ─────────────────────────
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum DataKey {
    Admin,
    CurrentVersion,
    CurrentWasmHash,
    PreviousWasmHash,
    PreviousVersion,
    PendingUpgrade,
    LastUpgradeTime,
    MigrationExecuted,
}

// ───────────────────────── Data Types ─────────────────────────
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Version {
    pub major: u32,
    pub minor: u32,
    pub patch: u32,
}

impl Version {
    /// Returns true if `self` is strictly greater than `other`.
    pub fn is_greater_than(&self, other: &Version) -> bool {
        (self.major, self.minor, self.patch) > (other.major, other.minor, other.patch)
    }

    /// Returns true if this version is semver-compatible with `other`
    /// (same major version, and self >= other).
    pub fn is_compatible_with(&self, other: &Version) -> bool {
        self.major == other.major && self.is_greater_than(other)
    }
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PendingUpgrade {
    pub new_wasm_hash: BytesN<32>,
    pub new_version: Version,
    pub proposed_at: u64,
    pub execute_after: u64,
    pub proposer: Address,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct UpgradeRecord {
    pub old_wasm_hash: BytesN<32>,
    pub new_wasm_hash: BytesN<32>,
    pub old_version: Version,
    pub new_version: Version,
    pub executed_at: u64,
    pub rollback_deadline: u64,
}

// ───────────────────────── Events ─────────────────────────
#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct UpgradeProposed {
    #[topic]
    pub new_version: Version,
    pub new_wasm_hash: BytesN<32>,
    pub execute_after: u64,
    pub proposer: Address,
}

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct UpgradeExecuted {
    #[topic]
    pub new_version: Version,
    pub new_wasm_hash: BytesN<32>,
    pub executed_at: u64,
    pub rollback_deadline: u64,
}

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct UpgradeRolledBack {
    #[topic]
    pub restored_version: Version,
    pub restored_wasm_hash: BytesN<32>,
    pub rolled_back_at: u64,
}

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct MigrationCompleted {
    pub version: Version,
    pub completed_at: u64,
}

// ───────────────────────── Contract ─────────────────────────
#[contract]
pub struct UpgradeManager;

#[contractimpl]
impl UpgradeManager {
    /// Initialize the contract with an admin and initial version/wasm hash.
    pub fn initialize(
        env: Env,
        admin: Address,
        initial_version: Version,
        initial_wasm_hash: BytesN<32>,
    ) {
        if env.storage().instance().has(&DataKey::Admin) {
            panic!("already initialized");
        }
        admin.require_auth();
        env.storage().instance().set(&DataKey::Admin, &admin);
        env.storage()
            .instance()
            .set(&DataKey::CurrentVersion, &initial_version);
        env.storage()
            .instance()
            .set(&DataKey::CurrentWasmHash, &initial_wasm_hash);
    }

    /// Propose an upgrade. Only admin can call. Timelock starts now.
    pub fn propose_upgrade(
        env: Env,
        new_wasm_hash: BytesN<32>,
        new_version: Version,
    ) -> Result<(), UpgradeError> {
        let admin: Address = env
            .storage()
            .instance()
            .get(&DataKey::Admin)
            .ok_or(UpgradeError::NotAuthorized)?;
        admin.require_auth();

        // Block if an upgrade is already pending
        if env
            .storage()
            .instance()
            .has(&DataKey::PendingUpgrade)
        {
            return Err(UpgradeError::UpgradeAlreadyPending);
        }

        let current_version: Version = env
            .storage()
            .instance()
            .get(&DataKey::CurrentVersion)
            .unwrap();
        let current_wasm_hash: BytesN<32> = env
            .storage()
            .instance()
            .get(&DataKey::CurrentWasmHash)
            .unwrap();

        // No-op protection: same wasm hash
        if new_wasm_hash == current_wasm_hash {
            return Err(UpgradeError::SameWasmHash);
        }

        // Version compatibility: must be semver-greater, same major
        if !new_version.is_compatible_with(&current_version) {
            return Err(UpgradeError::VersionIncompatible);
        }

        let now = env.ledger().timestamp();
        let execute_after = now + TIMELOCK_SECONDS;

        let pending = PendingUpgrade {
            new_wasm_hash: new_wasm_hash.clone(),
            new_version: new_version.clone(),
            proposed_at: now,
            execute_after,
            proposer: admin.clone(),
        };

        env.storage()
            .instance()
            .set(&DataKey::PendingUpgrade, &pending);

        UpgradeProposed {
            new_version,
            new_wasm_hash,
            execute_after,
            proposer: admin,
        }
        .publish(&env);

        Ok(())
    }

    /// Execute a pending upgrade after the timelock has expired.
    /// Anyone can call this once the timelock is over.
    pub fn execute_upgrade(env: Env) -> Result<(), UpgradeError> {
        let pending: PendingUpgrade = env
            .storage()
            .instance()
            .get(&DataKey::PendingUpgrade)
            .ok_or(UpgradeError::NoPendingUpgrade)?;

        let now = env.ledger().timestamp();

        // Timelock must have expired
        if now < pending.execute_after {
            return Err(UpgradeError::TimelockNotExpired);
        }

        // Load current state for rollback record
        let current_wasm_hash: BytesN<32> = env
            .storage()
            .instance()
            .get(&DataKey::CurrentWasmHash)
            .unwrap();
        let current_version: Version = env
            .storage()
            .instance()
            .get(&DataKey::CurrentVersion)
            .unwrap();

        // Save previous state for rollback
        env.storage()
            .instance()
            .set(&DataKey::PreviousWasmHash, &current_wasm_hash);
        env.storage()
            .instance()
            .set(&DataKey::PreviousVersion, &current_version);

        // Perform the WASM upgrade
        env.deployer()
            .update_current_contract_wasm(pending.new_wasm_hash.clone());

        // Update current state
        env.storage().instance().set(
            &DataKey::CurrentWasmHash,
            &pending.new_wasm_hash,
        );
        env.storage()
            .instance()
            .set(&DataKey::CurrentVersion, &pending.new_version);

        let rollback_deadline = now + ROLLBACK_WINDOW_SECONDS;
        env.storage()
            .instance()
            .set(&DataKey::LastUpgradeTime, &now);
        env.storage()
            .instance()
            .set(&DataKey::MigrationExecuted, &false);

        // Clear pending
        env.storage().instance().remove(&DataKey::PendingUpgrade);

        UpgradeExecuted {
            new_version: pending.new_version,
            new_wasm_hash: pending.new_wasm_hash,
            executed_at: now,
            rollback_deadline,
        }
        .publish(&env);

        Ok(())
    }

    /// Post-upgrade migration hook. Called after execute_upgrade.
    /// Runs at most once per upgrade.
    pub fn migrate(env: Env) -> Result<(), UpgradeError> {
        let executed: bool = env
            .storage()
            .instance()
            .get(&DataKey::MigrationExecuted)
            .unwrap_or(true);

        if executed {
            return Err(UpgradeError::MigrationFailed);
        }

        // ─────────────────────────────────────────────
        // Add your storage migration logic here.
        // Example: rename keys, set defaults, restructure.
        // ─────────────────────────────────────────────

        let version: Version = env
            .storage()
            .instance()
            .get(&DataKey::CurrentVersion)
            .unwrap();
        let now = env.ledger().timestamp();

        env.storage()
            .instance()
            .set(&DataKey::MigrationExecuted, &true);

        MigrationCompleted {
            version,
            completed_at: now,
        }
        .publish(&env);

        Ok(())
    }

    /// Emergency rollback within 48 hours of the last upgrade.
    /// Restores the previous WASM bytecode and version.
    pub fn rollback(env: Env) -> Result<(), UpgradeError> {
        let admin: Address = env
            .storage()
            .instance()
            .get(&DataKey::Admin)
            .ok_or(UpgradeError::NotAuthorized)?;
        admin.require_auth();

        // Check rollback window
        let last_upgrade_time: u64 = env
            .storage()
            .instance()
            .get(&DataKey::LastUpgradeTime)
            .ok_or(UpgradeError::NoRollbackAvailable)?;

        let now = env.ledger().timestamp();
        if now > last_upgrade_time + ROLLBACK_WINDOW_SECONDS {
            return Err(UpgradeError::RollbackWindowClosed);
        }

        let previous_wasm_hash: BytesN<32> = env
            .storage()
            .instance()
            .get(&DataKey::PreviousWasmHash)
            .ok_or(UpgradeError::NoRollbackAvailable)?;
        let previous_version: Version = env
            .storage()
            .instance()
            .get(&DataKey::PreviousVersion)
            .ok_or(UpgradeError::NoRollbackAvailable)?;

        // Perform rollback upgrade
        env.deployer()
            .update_current_contract_wasm(previous_wasm_hash.clone());

        // Restore previous state
        env.storage()
            .instance()
            .set(&DataKey::CurrentWasmHash, &previous_wasm_hash);
        env.storage()
            .instance()
            .set(&DataKey::CurrentVersion, &previous_version);

        // Clear rollback data
        env.storage().instance().remove(&DataKey::PreviousWasmHash);
        env.storage().instance().remove(&DataKey::PreviousVersion);
        env.storage().instance().remove(&DataKey::LastUpgradeTime);

        UpgradeRolledBack {
            restored_version: previous_version,
            restored_wasm_hash: previous_wasm_hash,
            rolled_back_at: now,
        }
        .publish(&env);

        Ok(())
    }

    // ───────────────────────── Queries ─────────────────────────

    pub fn get_version(env: Env) -> Version {
        env.storage()
            .instance()
            .get(&DataKey::CurrentVersion)
            .unwrap()
    }

    pub fn get_admin(env: Env) -> Address {
        env.storage()
            .instance()
            .get(&DataKey::Admin)
            .unwrap()
    }

    pub fn get_pending_upgrade(env: Env) -> Option<PendingUpgrade> {
        env.storage()
            .instance()
            .get(&DataKey::PendingUpgrade)
    }

    pub fn is_rollback_available(env: Env) -> bool {
        let last: Option<u64> = env
            .storage()
            .instance()
            .get(&DataKey::LastUpgradeTime);
        match last {
            Some(t) => {
                let now = env.ledger().timestamp();
                now <= t + ROLLBACK_WINDOW_SECONDS
            }
            None => false,
        }
cat > src/lib.rs << 'EOF'
#![no_std]

use soroban_sdk::{
    contract, contracterror, contractevent, contractimpl, contracttype, Address, BytesN, Env,
    String, Symbol, Vec,
};

// ───────────────────────── Constants ─────────────────────────
/// 48 hours in seconds (48 * 60 * 60)
pub const TIMELOCK_SECONDS: u64 = 172_800;
/// 48 hours rollback window in seconds
pub const ROLLBACK_WINDOW_SECONDS: u64 = 172_800;
/// 1 hour in seconds — emergency rollback after this window closes
pub const EMERGENCY_ROLLBACK_WINDOW: u64 = 3_600;

// ───────────────────────── Errors ─────────────────────────
#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum UpgradeError {
    NotAuthorized = 1,
    NoPendingUpgrade = 2,
    TimelockNotExpired = 3,
    TimelockExpired = 4,
    InvalidVersion = 5,
    VersionIncompatible = 6,
    RollbackWindowClosed = 7,
    MigrationFailed = 8,
    NoRollbackAvailable = 9,
    UpgradeAlreadyPending = 10,
    SameWasmHash = 11,
}

// ───────────────────────── Storage Keys ─────────────────────────
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum DataKey {
    Admin,
    CurrentVersion,
    CurrentWasmHash,
    PreviousWasmHash,
    PreviousVersion,
    PendingUpgrade,
    LastUpgradeTime,
    MigrationExecuted,
}

// ───────────────────────── Data Types ─────────────────────────
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Version {
    pub major: u32,

