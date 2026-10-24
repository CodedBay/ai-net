# Cross-Contract Event Emission Standards

This document specifies the unified event emission standards across all smart contracts in **ai-net**.

## Core Standards

1. **Topic Formatting**:
   - Primary topic is snake_case symbol representing the event type: e.g. `agent_registered`, `bid_submitted`, `task_assigned`, `price_updated`.
   - Contract-scoped topics follow `(contract_symbol, event_type)`.

2. **Standard Payload Structure**:
   All event payloads must include:
   - `version: u32`: Schema version (starting at `1`).
   - `ledger: u32`: Ledger sequence number when the event was emitted.
   - Specific domain fields.

3. **Public Emission Invariant**:
   - Events are only emitted from public contract functions after state validations and mutations succeed.
   - Internal helper functions do not emit side-effect events directly.

4. **Helper Macros**:
   - Defined in `smart-contracts/common/src/event_standards.rs` (`emit_event!` and `emit_contract_event!`).
