//! Migration v1.2.0 — Versioned storage keys (dual-read pattern)
//!
//! Introduces V2 storage keys alongside the existing V1 keys to enable
//! a zero-downtime schema change without data loss.
//!
//! ## Storage changes
//! - New: `DataKey::AgentRecordV2(Symbol)` — V2 record format (written lazily)
//! - Deprecated (not removed): `DataKey::AgentRecordV1(Symbol)` — legacy reads

use soroban_sdk::Env;
use migration_runner::MigrationError;

/// Apply the v1.2.0 migration: activate the dual-read storage pattern.
///
/// The dual-read logic lives in the upgraded contract code. This migration
/// records the schema change; V2 records are written lazily on first use.
/// In dry-run mode the function returns `Ok(())` without side effects.
pub fn up(_env: &Env, _dry_run: bool) -> Result<(), MigrationError> {
    // Dual-read logic lives in the upgraded contract code. This migration
    // records the schema change; V2 records are written lazily on first use.
    Ok(())
}

/// Reverse the v1.2.0 migration.
///
/// V1 data was never removed, so rolling back to the pre-v1.2.0 contract Wasm
/// immediately restores V1-only reads. V2 keys written during the upgrade window
/// should be cleaned up via a separate `cleanup_v2_records` contract function.
pub fn down(_env: &Env, _dry_run: bool) -> Result<(), MigrationError> {
    // V1 records remain intact; the rollback simply re-pins the schema version.
    // Off-chain tooling should call `cleanup_v2_records` to remove orphaned V2 keys.
    Ok(())
}
