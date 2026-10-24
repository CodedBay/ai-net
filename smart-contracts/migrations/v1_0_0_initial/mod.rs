//! Migration v1.0.0 — Initial schema
//!
//! Establishes the base storage layout. This migration marks the
//! transition from the un-versioned (v0) state to a versioned schema.
//!
//! **Storage changes:** none (additive — the schema version key itself is
//! written by the migration runner, not by this migration's `up` function).

use soroban_sdk::Env;
use migration_runner::MigrationError;

/// Apply the v1.0.0 initial schema migration.
///
/// In dry-run mode the function returns `Ok(())` without writing any state —
/// schema version tracking is handled by the caller via `apply_migration`.
pub fn up(_env: &Env, _dry_run: bool) -> Result<(), MigrationError> {
    // Initial schema: no data transformations required.
    // New storage keys are created on first use by the contract.
    Ok(())
}

/// Reverse the v1.0.0 initial schema migration.
///
/// Removes any storage keys that were introduced in this version.
/// For the initial migration there is nothing to remove.
pub fn down(_env: &Env, _dry_run: bool) -> Result<(), MigrationError> {
    // Nothing to undo for the initial migration.
    Ok(())
}
