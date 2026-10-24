//! Migration v1.1.0 — Add AgentStats storage key
//!
//! Extends the schema to include per-agent performance statistics.
//!
//! **Safety:** This is an additive-only change. A new `DataKey::AgentStats`
//! variant is introduced and old data is untouched. No existing records need
//! to be transformed.
//!
//! **Storage changes:**
//! - New: `DataKey::AgentStats(Symbol)` — populated lazily on first write
//!   by the upgraded contract code; no backfill required.

use soroban_sdk::Env;
use migration_runner::MigrationError;

/// Apply the v1.1.0 migration: enable AgentStats storage layout.
///
/// Because this is a purely additive change the migration itself performs no
/// writes. The upgraded contract code writes to the new key on first use.
/// In dry-run mode the function returns `Ok(())` without side effects.
pub fn up(_env: &Env, _dry_run: bool) -> Result<(), MigrationError> {
    // Additive migration: no data transformation needed.
    // New `AgentStats` keys are created on first write by the upgraded contract.
    Ok(())
}

/// Reverse the v1.1.0 migration.
///
/// In a full production rollback, off-chain tooling should supply all agent
/// IDs so that their `AgentStats` keys can be deleted. Soroban has no storage
/// iterator, so this function accepts the responsibility of cleanup being
/// handled externally via a separate contract call.
pub fn down(_env: &Env, _dry_run: bool) -> Result<(), MigrationError> {
    // Cannot enumerate all AgentStats keys without an iterator.
    // Callers must supply the list of agent IDs to clean up via a separate
    // `cleanup_agent_stats(agent_ids: Vec<Symbol>)` contract function.
    Ok(())
}
