# Storage Migrations

This directory contains versioned storage migration scripts for ai-net Soroban contracts.

## Overview

Each migration represents a schema version change in a contract's on-chain storage layout.
Migrations are applied in sequential order and tracked in the contract's Instance storage.

## Structure

```
migrations/
├── README.md                          # This file
├── migration_runner/                  # Core MigrationRunner library crate
│   ├── Cargo.toml
│   └── src/lib.rs
├── v1_0_0_initial/
│   └── mod.rs                         # v1.0.0: Initial schema
├── v1_1_0_add_agent_stats/
│   └── mod.rs                         # v1.1.0: Add AgentStats storage
└── v1_2_0_versioned_storage/
    └── mod.rs                         # v1.2.0: Versioned storage keys
```

## Migration Versioning

Migrations are versioned using a monotonically increasing integer:
- `1` = v1.0.0 initial schema
- `2` = v1.1.0 add agent stats
- `3` = v1.2.0 versioned storage keys

## Usage

### Applying migrations from a contract

```rust
use migration_runner::{apply_migration, get_schema_version, MigrationError};
use soroban_sdk::{Env, String};

// In your contract's upgrade/migrate function:
pub fn migrate(env: Env, target_version: u32, dry_run: bool) -> Result<(), MigrationError> {
    let current = get_schema_version(&env);

    if current < 1 {
        apply_migration(
            &env,
            1,
            String::from_str(&env, "v1_initial"),
            v1_0_0_initial::up,
            dry_run,
        )?;
    }
    if current < 2 {
        apply_migration(
            &env,
            2,
            String::from_str(&env, "v1_1_add_stats"),
            v1_1_0_add_agent_stats::up,
            dry_run,
        )?;
    }
    if current < 3 {
        apply_migration(
            &env,
            3,
            String::from_str(&env, "v1_2_versioned"),
            v1_2_0_versioned_storage::up,
            dry_run,
        )?;
    }
    Ok(())
}
```

### Dry-run mode

Pass `dry_run: true` to simulate migrations without writing on-chain state:

```rust
// Simulate without side effects
migrate(env, 3, true)?; // runs logic but does not update schema version
```

### Rolling back

```rust
use migration_runner::rollback_migration;

rollback_migration(
    &env,
    3,
    String::from_str(&env, "v1_2_rollback"),
    v1_2_0_versioned_storage::down,
    false,
)?;
```

## On-Chain History

The migration history is stored in contract Instance storage under `MigrationDataKey::MigrationHistory`.
Query it with:

```rust
use migration_runner::get_migration_history;
let history = get_migration_history(&env);
// history.current_version, history.records
```

## Adding a New Migration

1. Create a new directory `v<MAJOR>_<MINOR>_<PATCH>_<description>/` containing `mod.rs`
2. Implement `up(env: &Env, dry_run: bool) -> MigrationResult` and `down(env: &Env, dry_run: bool) -> MigrationResult`
3. Call `apply_migration(...)` in your contract's `migrate()` function with the next sequential version integer
4. Update this README with the new migration entry
5. Document storage changes in `smart-contracts/docs/STORAGE_MIGRATION.md`

## Version Integer Mapping

| Integer | Semver  | Description               |
|---------|---------|---------------------------|
| 1       | v1.0.0  | Initial schema            |
| 2       | v1.1.0  | Add AgentStats storage    |
| 3       | v1.2.0  | Versioned storage keys    |
