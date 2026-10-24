//! # Event Standards for ai-net Smart Contracts
//!
//! Provides standardized schemas and macros for event emission across all contracts.
//! Every standardized event adheres to:
//! - Snake_case event type naming (e.g. `agent_registered`, `price_updated`, `task_assigned`).
//! - Top-level `version: u32` field (defaults to 1).
//! - Top-level `ledger: u32` sequence stamp.
//! - Direct emission from public contract functions.

#[macro_export]
macro_rules! emit_event {
    ($env:expr, $event_type:expr, $payload:expr) => {{
        $env.events().publish(
            (soroban_sdk::Symbol::new($env, $event_type),),
            $payload,
        );
    }};
}

#[macro_export]
macro_rules! emit_contract_event {
    ($env:expr, $contract:expr, $event_type:expr, $payload:expr) => {{
        $env.events().publish(
            (
                soroban_sdk::Symbol::new($env, $contract),
                soroban_sdk::Symbol::new($env, $event_type),
            ),
            $payload,
        );
    }};
}
