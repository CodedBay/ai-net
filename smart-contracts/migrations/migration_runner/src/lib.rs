#![no_std]

//! # Migration Runner
//!
//! Versioned on-chain storage migration utilities for ai-net Soroban contracts.
//!
//! ## Design
//!
//! - Each migration is a version number, a name, an `up` closure, and a `down` closure.
//! - The current schema version is stored in contract Instance storage under
//!   [`MigrationDataKey::SchemaVersion`].
//! - A full history of applied migrations is stored under
//!   [`MigrationDataKey::MigrationHistory`].
//! - Dry-run mode executes the migration logic but writes **nothing** to storage,
//!   making it safe to simulate what would happen without side effects.
//!
//! ## Usage
//!
//! ```rust,ignore
//! use migration_runner::{apply_migration, get_schema_version, get_migration_history};
//! use soroban_sdk::{Env, String};
//!
//! // In your contract's migrate() function:
//! pub fn migrate(env: Env, dry_run: bool) -> Result<(), MigrationError> {
//!     let current = get_schema_version(&env);
//!     if current < 1 {
//!         apply_migration(&env, 1, String::from_str(&env, "v1_initial"),
//!             |_env, _dry_run| Ok(()), dry_run)?;
//!     }
//!     if current < 2 {
//!         apply_migration(&env, 2, String::from_str(&env, "v1_1_add_stats"),
//!             |_env, _dry_run| Ok(()), dry_run)?;
//!     }
//!     Ok(())
//! }
//! ```

use soroban_sdk::{contracttype, Env, String, Vec};

// ─── Storage Keys ─────────────────────────────────────────────────────────────

/// Storage keys used by the migration runner in a contract's Instance storage.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum MigrationDataKey {
    /// The current schema version (`u32`). `0` means no migrations have run.
    SchemaVersion,
    /// Complete history of applied (and rolled-back) migrations.
    MigrationHistory,
}

// ─── Types ────────────────────────────────────────────────────────────────────

/// One entry in the on-chain migration history.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct MigrationRecord {
    /// Monotonically increasing version this migration brings the contract to.
    pub version: u32,
    /// Human-readable migration name (e.g. `"v1_1_add_agent_stats"`).
    pub name: String,
    /// Ledger timestamp when this migration was recorded.
    pub applied_at: u64,
    /// `true` if this was a dry-run (state was NOT modified).
    pub dry_run: bool,
    /// `true` = forward migration; `false` = rollback.
    pub is_up: bool,
}

/// The full migration history stored in Instance storage.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct MigrationHistory {
    /// Ordered list of migration events (up and down).
    pub records: Vec<MigrationRecord>,
    /// The schema version at the time this snapshot was saved.
    pub current_version: u32,
}

/// Errors that can occur during migration operations.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
#[repr(u32)]
pub enum MigrationError {
    /// This migration has already been applied.
    AlreadyApplied = 1,
    /// The migration version was not found.
    NotFound = 2,
    /// Invalid version sequence (e.g., trying to apply v3 before v2).
    InvalidVersion = 3,
    /// A storage access error occurred.
    StorageError = 4,
    /// Dry-run completed successfully — no state was written.
    DryRunOnly = 5,
    /// There are no pending migrations to apply.
    NothingToDo = 6,
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/// Returns the current schema version from Instance storage.
///
/// Returns `0` if no migration has ever been applied.
pub fn get_schema_version(env: &Env) -> u32 {
    env.storage()
        .instance()
        .get(&MigrationDataKey::SchemaVersion)
        .unwrap_or(0)
}

/// Reads the full migration history from Instance storage.
///
/// Returns an empty history if none has been recorded yet.
pub fn get_migration_history(env: &Env) -> MigrationHistory {
    env.storage()
        .instance()
        .get(&MigrationDataKey::MigrationHistory)
        .unwrap_or(MigrationHistory {
            records: Vec::new(env),
            current_version: 0,
        })
}

/// Writes a new schema version to Instance storage.
pub fn set_schema_version(env: &Env, version: u32) {
    env.storage()
        .instance()
        .set(&MigrationDataKey::SchemaVersion, &version);
}

/// Returns the versions of all migrations that have not yet been applied,
/// given an ordered list of `(version, name)` pairs.
///
/// A migration is pending when its `version` is greater than the current
/// schema version stored on-chain.
pub fn detect_pending_migrations(env: &Env, migrations: &[(u32, &str)]) -> Vec<u32> {
    let current = get_schema_version(env);
    let mut pending = Vec::new(env);
    for (version, _name) in migrations {
        if *version > current {
            pending.push_back(*version);
        }
    }
    pending
}

fn append_migration_record(env: &Env, record: MigrationRecord) {
    let mut history = get_migration_history(env);
    history.records.push_back(record);
    history.current_version = get_schema_version(env);
    env.storage()
        .instance()
        .set(&MigrationDataKey::MigrationHistory, &history);
}

// ─── Public API ───────────────────────────────────────────────────────────────

/// Apply a single forward migration step.
///
/// # Parameters
/// - `env`: the Soroban environment
/// - `version`: the schema version this migration brings the contract **to**
/// - `name`: human-readable description, stored in history
/// - `migrate_fn`: the migration logic; receives `(env, dry_run)` and may
///   read/write persistent storage
/// - `dry_run`: when `true`, the migration logic runs but the schema version
///   and history are **not** updated — simulates the migration safely
///
/// # Errors
/// - [`MigrationError::AlreadyApplied`] if `current_version >= version`
pub fn apply_migration<F>(
    env: &Env,
    version: u32,
    name: String,
    migrate_fn: F,
    dry_run: bool,
) -> Result<(), MigrationError>
where
    F: FnOnce(&Env, bool) -> Result<(), MigrationError>,
{
    let current = get_schema_version(env);
    if current >= version {
        return Err(MigrationError::AlreadyApplied);
    }

    // Execute the caller-supplied migration logic.
    migrate_fn(env, dry_run)?;

    if !dry_run {
        set_schema_version(env, version);
        append_migration_record(
            env,
            MigrationRecord {
                version,
                name,
                applied_at: env.ledger().timestamp(),
                dry_run: false,
                is_up: true,
            },
        );
    }

    Ok(())
}

/// Roll back a single migration step.
///
/// # Parameters
/// - `version`: the schema version to roll back **from** (must be the current version)
/// - `name`: human-readable description, stored in history
/// - `rollback_fn`: the rollback logic; receives `(env, dry_run)`
/// - `dry_run`: when `true`, rollback logic runs but no state is written
///
/// # Errors
/// - [`MigrationError::NotFound`] if `current_version < version`
pub fn rollback_migration<F>(
    env: &Env,
    version: u32,
    name: String,
    rollback_fn: F,
    dry_run: bool,
) -> Result<(), MigrationError>
where
    F: FnOnce(&Env, bool) -> Result<(), MigrationError>,
{
    let current = get_schema_version(env);
    if current < version {
        return Err(MigrationError::NotFound);
    }

    rollback_fn(env, dry_run)?;

    if !dry_run {
        let prev = if version > 0 { version - 1 } else { 0 };
        set_schema_version(env, prev);
        append_migration_record(
            env,
            MigrationRecord {
                version,
                name,
                applied_at: env.ledger().timestamp(),
                dry_run: false,
                is_up: false,
            },
        );
    }

    Ok(())
}

// ─── Tests ────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use soroban_sdk::{Env, String};

    #[test]
    fn test_initial_version_is_zero() {
        let env = Env::default();
        assert_eq!(get_schema_version(&env), 0);
    }

    #[test]
    fn test_apply_migration_updates_version() {
        let env = Env::default();
        let name = String::from_str(&env, "v1_initial");
        apply_migration(&env, 1, name, |_env, _dry_run| Ok(()), false).unwrap();
        assert_eq!(get_schema_version(&env), 1);
    }

    #[test]
    fn test_dry_run_does_not_write_version() {
        let env = Env::default();
        let name = String::from_str(&env, "v1_initial");
        // dry_run=true: migration logic runs, but schema version must NOT change
        apply_migration(&env, 1, name, |_env, _dry_run| Ok(()), true).unwrap();
        assert_eq!(get_schema_version(&env), 0, "dry-run must not update schema version");
    }

    #[test]
    fn test_dry_run_does_not_write_history() {
        let env = Env::default();
        let name = String::from_str(&env, "v1_initial");
        apply_migration(&env, 1, name, |_env, _dry_run| Ok(()), true).unwrap();
        let history = get_migration_history(&env);
        assert_eq!(history.records.len(), 0, "dry-run must not write history");
    }

    #[test]
    fn test_already_applied_error() {
        let env = Env::default();
        let name1 = String::from_str(&env, "v1");
        let name2 = String::from_str(&env, "v1_again");
        apply_migration(&env, 1, name1, |_env, _dry_run| Ok(()), false).unwrap();
        let result = apply_migration(&env, 1, name2, |_env, _dry_run| Ok(()), false);
        assert_eq!(result, Err(MigrationError::AlreadyApplied));
    }

    #[test]
    fn test_multi_version_chain() {
        let env = Env::default();
        // Apply v1 -> v2 -> v3 in order
        apply_migration(&env, 1, String::from_str(&env, "v1"), |_e, _d| Ok(()), false).unwrap();
        apply_migration(&env, 2, String::from_str(&env, "v2"), |_e, _d| Ok(()), false).unwrap();
        apply_migration(&env, 3, String::from_str(&env, "v3"), |_e, _d| Ok(()), false).unwrap();
        assert_eq!(get_schema_version(&env), 3);
        let history = get_migration_history(&env);
        assert_eq!(history.records.len(), 3);
        assert_eq!(history.current_version, 3);
    }

    #[test]
    fn test_rollback_decrements_version() {
        let env = Env::default();
        apply_migration(&env, 1, String::from_str(&env, "v1"), |_e, _d| Ok(()), false).unwrap();
        rollback_migration(&env, 1, String::from_str(&env, "v1_down"), |_e, _d| Ok(()), false)
            .unwrap();
        assert_eq!(get_schema_version(&env), 0);
    }

    #[test]
    fn test_rollback_not_found() {
        let env = Env::default();
        // Cannot roll back a migration that was never applied
        let result = rollback_migration(
            &env,
            1,
            String::from_str(&env, "v1_down"),
            |_e, _d| Ok(()),
            false,
        );
        assert_eq!(result, Err(MigrationError::NotFound));
    }

    #[test]
    fn test_rollback_dry_run_does_not_write() {
        let env = Env::default();
        apply_migration(&env, 1, String::from_str(&env, "v1"), |_e, _d| Ok(()), false).unwrap();
        rollback_migration(&env, 1, String::from_str(&env, "v1_down"), |_e, _d| Ok(()), true)
            .unwrap();
        // Version must still be 1 after a dry-run rollback
        assert_eq!(get_schema_version(&env), 1);
    }

    #[test]
    fn test_detect_pending_migrations() {
        let env = Env::default();
        apply_migration(&env, 1, String::from_str(&env, "v1"), |_e, _d| Ok(()), false).unwrap();
        let migrations = [(1u32, "v1"), (2u32, "v2"), (3u32, "v3")];
        let pending = detect_pending_migrations(&env, &migrations);
        assert_eq!(pending.len(), 2); // v2 and v3 are pending
        assert_eq!(pending.get(0).unwrap(), 2);
        assert_eq!(pending.get(1).unwrap(), 3);
    }

    #[test]
    fn test_migration_history_records_up_flag() {
        let env = Env::default();
        apply_migration(&env, 1, String::from_str(&env, "v1"), |_e, _d| Ok(()), false).unwrap();
        let history = get_migration_history(&env);
        assert_eq!(history.records.get(0).unwrap().is_up, true);
    }

    #[test]
    fn test_migration_history_records_rollback_flag() {
        let env = Env::default();
        apply_migration(&env, 1, String::from_str(&env, "v1"), |_e, _d| Ok(()), false).unwrap();
        rollback_migration(&env, 1, String::from_str(&env, "v1_down"), |_e, _d| Ok(()), false)
            .unwrap();
        let history = get_migration_history(&env);
        // index 0 = up, index 1 = down
        assert_eq!(history.records.get(1).unwrap().is_up, false);
    }
}
