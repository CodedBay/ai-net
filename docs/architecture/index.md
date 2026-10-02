# 🏛️ AI-Net Architecture Specification

This document is the **authoritative technical reference** for the AI-Net platform — a decentralized marketplace and multi-agent coordination protocol built on the **Stellar Network and Soroban Smart Contracts**.

---

## Table of Contents

1. [C4 Level 1 — System Context](#1-c4-level-1--system-context)
2. [C4 Level 2 — Container Diagram](#2-c4-level-2--container-diagram)
3. [C4 Level 3 — Backend Component Diagram](#3-c4-level-3--backend-component-diagram)
4. [Sequence Diagrams](#4-sequence-diagrams)
   - [4.1 Task Submission to Completion (Happy Path with Escrow)](#41-task-submission-to-completion-happy-path-with-escrow)
   - [4.2 Agent Registration + Heartbeat Lifecycle](#42-agent-registration--heartbeat-lifecycle)
   - [4.3 Governance Proposal + Timelock Execution](#43-governance-proposal--timelock-execution)
5. [Layer Responsibilities](#5-layer-responsibilities)
6. [Security Model](#6-security-model)
7. [Related Documents](#7-related-documents)

---

## 1. C4 Level 1 — System Context

The system context diagram shows ai-net as a single system, the external actors that interact with it, and the external systems it depends on.

```mermaid
C4Context
    title System Context — AI-Net

    Person(user, "User / dApp", "Submits natural-language tasks and reviews results via the web UI or SDK")
    Person(operator, "Node Operator", "Provisions and operates an ai-net node on testnet or mainnet")
    Person(agent_dev, "Agent Developer", "Registers a third-party AI agent on the network")

    System(ainet, "AI-Net", "Decentralized AI agent coordination and payment network. Decomposes tasks, discovers specialized agents, executes work, and settles payments on-chain.")

    System_Ext(stellar, "Stellar Blockchain", "Provides trustless payment settlement, on-chain agent registry, and governance via Soroban smart contracts")
    System_Ext(venice, "Venice AI", "Provides LLM inference for coordinator and specialized agent reasoning (private, uncensored models)")
    System_Ext(horizon, "Stellar Horizon", "HTTP API for Stellar network access — account queries, transaction submission, and event indexing")

    Rel(user, ainet, "Submits tasks, monitors progress", "HTTPS / WebSocket")
    Rel(operator, ainet, "Operates node, monitors health", "CLI / Prometheus")
    Rel(agent_dev, ainet, "Registers agent, sends heartbeats", "REST API")
    Rel(ainet, stellar, "Locks/releases escrow, registers agents, reads reputation", "Soroban SDK / RPC")
    Rel(ainet, venice, "Invokes LLM inference for task reasoning", "HTTPS REST")
    Rel(ainet, horizon, "Submits transactions, queries account state, indexes events", "HTTPS REST")
```

---

## 2. C4 Level 2 — Container Diagram

The container diagram shows the major deployable units inside AI-Net and their data flows.

```mermaid
C4Container
    title Container Diagram — AI-Net

    Person(user, "User / dApp")
    Person(agent_dev, "Agent Developer")

    System_Boundary(ainet, "AI-Net") {
        Container(frontend, "Web Frontend", "Next.js 14, TypeScript, Tailwind CSS", "Browser-based dashboard for task submission, agent discovery, and real-time monitoring. Connects Freighter wallet for transaction signing.")

        Container(api, "Backend API", "Node.js, Express, TypeScript", "REST + WebSocket + SSE server. Handles authentication, rate limiting, task submission, agent registry, and event streaming.")

        Container(coordinator, "Coordinator Engine", "TypeScript, Node.js", "Decomposes natural-language prompts into DAG sub-tasks, matches agents by capability and reputation, and orchestrates execution order.")

        Container(agents, "Specialized Agent Workers", "TypeScript, Node.js", "Five built-in agent types: Research, Risk, Coding, Design, Report. Each wraps Venice AI inference with domain-specific prompting.")

        Container(queue, "Job Queue", "In-process priority queue (JobQueue)", "Buffers task execution jobs. Assigns priority (low/normal/high) and dispatches to coordinator.")

        ContainerDb(tasks_db, "tasks.db", "SQLite", "Task records, DAG execution state, event log, cursor-pagination state.")
        ContainerDb(agents_db, "agents.db", "SQLite", "Agent registrations, heartbeat timestamps, reputation scores.")
        ContainerDb(payments_db, "payments.db", "SQLite", "Payment ledger, escrow correlation IDs, reconciliation audit log.")
    }

    System_Boundary(contracts, "Soroban Smart Contracts") {
        Container(agent_registry, "agent_registry", "Rust / Soroban", "On-chain verified agent identities, capabilities, pricing, and reputation scores. Emits registry/* events.")
        Container(payment_escrow, "payment_escrow", "Rust / Soroban", "Trustless token locking in Soroban contract storage. Emits escrow/* events.")
        Container(task_store, "task_store", "Rust / Soroban", "On-chain task lifecycle anchoring. Emits task_meta/* events.")
        Container(agent_governance, "agent_governance", "Rust / Soroban", "Governance parameter changes with mandatory timelock. Emits governance/* events.")
        Container(upgrade_manager, "upgrade_manager", "Rust / Soroban", "Safe contract upgrade orchestration with 48-hour rollback window.")
        Container(dispute, "dispute_resolution", "Rust / Soroban", "Multi-step jury voting with bond slashing and IPFS evidence anchoring.")
    }

    System_Ext(venice, "Venice AI")
    System_Ext(horizon, "Stellar Horizon")

    Rel(user, frontend, "Uses", "HTTPS")
    Rel(agent_dev, api, "Registers agent, sends heartbeats", "HTTPS REST")
    Rel(frontend, api, "REST + SSE + WebSocket", "HTTPS / WSS")
    Rel(api, coordinator, "Dispatches tasks via", "In-process queue")
    Rel(coordinator, agents, "Assigns sub-tasks to", "In-process call")
    Rel(agents, venice, "LLM inference", "HTTPS REST")
    Rel(api, tasks_db, "Reads/writes task state", "SQLite")
    Rel(api, agents_db, "Reads/writes agent registry", "SQLite")
    Rel(api, payments_db, "Reads/writes payment ledger", "SQLite")
    Rel(coordinator, task_store, "Anchors task lifecycle", "Soroban SDK")
    Rel(coordinator, payment_escrow, "Locks/releases escrow", "Soroban SDK")
    Rel(api, agent_registry, "Verifies agent registration", "Soroban SDK")
    Rel(agent_registry, horizon, "RPC queries", "HTTPS")
    Rel(payment_escrow, horizon, "RPC queries", "HTTPS")
    Rel(task_store, horizon, "RPC queries", "HTTPS")
    Rel(api, queue, "Enqueues jobs", "In-process")
    Rel(queue, coordinator, "Dispatches jobs", "In-process")
```

---

## 3. C4 Level 3 — Backend Component Diagram

The component diagram shows the major modules inside the Backend API container.

```mermaid
C4Component
    title Component Diagram — Backend API

    Container_Boundary(api, "Backend API") {
        Component(router, "Express Router", "Express.js", "Routes HTTP requests to domain handlers. Mounts v1 and v2 route trees. Applies global middleware (CORS, compression, request ID).")

        Component(auth_mw, "Auth Middleware", "TypeScript", "Validates JWT Bearer tokens and X-API-Key headers. Enforces wallet-based session authentication.")
        Component(rate_limit_mw, "Rate Limit Middleware", "TypeScript", "Enforces per-wallet, per-agent, and per-route request quotas. Returns X-RateLimit-* headers.")
        Component(validate_mw, "Validation Middleware", "Zod", "Validates request bodies and query params against Zod schemas. Returns 400 VALIDATION_ERROR on failure.")

        Component(agents_handler, "Agents Handler", "TypeScript", "Handles agent CRUD, heartbeat, and reputation endpoints. Reads/writes agents.db.")
        Component(tasks_handler, "Tasks Handler", "TypeScript", "Handles task create, list, get, cancel, estimate, and stream endpoints. Reads/writes tasks.db.")
        Component(stats_handler, "Stats Handler", "TypeScript", "Aggregates network metrics from all three SQLite databases. TTL-cached for 60 s.")
        Component(events_handler, "Events Handler", "TypeScript", "Handles event replay requests. Reads task_events table from tasks.db.")
        Component(auth_handler, "Auth Handler", "TypeScript", "Issues, refreshes, and revokes session tokens tied to Stellar wallet public keys.")
        Component(admin_handler, "Admin Handler", "TypeScript", "Protected admin operations: read-only mode, backup, vacuum, circuit breaker reset, audit log.")
        Component(health_handler, "Health Handler", "TypeScript", "Liveness, readiness, and deep dependency probes.")

        Component(coordinator_svc, "Coordinator Service", "TypeScript", "Decomposes prompts into DAG execution plans. Orchestrates agent dispatch and result aggregation.")
        Component(agent_workers, "Agent Workers", "TypeScript", "Research, Risk, Coding, Design, Report — each wraps Venice AI inference.")
        Component(payment_svc, "Payment Service", "TypeScript", "Soroban SDK integration for escrow lock/release. Reconciles on-chain vs local payment state.")
        Component(registry_svc, "Registry Service", "TypeScript", "Soroban SDK integration for agent_registry contract read/write operations.")
        Component(event_bus, "Event Bus", "TypeScript", "In-process event sourcing. Persists events to task_events table. Publishes to WebSocket server.")
        Component(ws_server, "WebSocket Server", "ws / TypeScript", "Manages connected clients. Broadcasts agent:status, task:update, payment:confirmed, heartbeat:missed events.")
        Component(heartbeat_monitor, "Heartbeat Monitor", "TypeScript", "Background loop that checks agents.db for stale agents and marks them offline.")
        Component(circuit_breaker, "Circuit Breaker", "TypeScript", "Wraps Venice AI calls. Opens after N consecutive failures; auto-closes after reset timeout.")
        Component(reconciliation_svc, "Reconciliation Service", "TypeScript", "Compares payments.db ledger with on-chain Stellar state. Resolves discrepancies.")

        ContainerDb(tasks_db, "tasks.db", "SQLite")
        ContainerDb(agents_db, "agents.db", "SQLite")
        ContainerDb(payments_db, "payments.db", "SQLite")
    }

    Container_Ext(venice, "Venice AI")
    Container_Ext(soroban, "Soroban Contracts")

    Rel(router, auth_mw, "Applied to protected routes")
    Rel(router, rate_limit_mw, "Applied to all routes")
    Rel(router, validate_mw, "Applied to mutation routes")
    Rel(router, agents_handler, "Routes /api/v*/agents")
    Rel(router, tasks_handler, "Routes /api/v*/tasks")
    Rel(router, stats_handler, "Routes /api/v1/stats")
    Rel(router, events_handler, "Routes /api/v1/events")
    Rel(router, auth_handler, "Routes /api/v1/auth")
    Rel(router, admin_handler, "Routes /api/v1/admin")
    Rel(router, health_handler, "Routes /health")
    Rel(tasks_handler, coordinator_svc, "Dispatches via job queue")
    Rel(coordinator_svc, agent_workers, "Assigns sub-tasks")
    Rel(agent_workers, circuit_breaker, "All Venice AI calls")
    Rel(circuit_breaker, venice, "HTTPS inference requests")
    Rel(coordinator_svc, payment_svc, "Lock/release escrow")
    Rel(payment_svc, soroban, "Soroban SDK")
    Rel(agents_handler, registry_svc, "On-chain registration")
    Rel(registry_svc, soroban, "Soroban SDK")
    Rel(coordinator_svc, event_bus, "Emits events")
    Rel(event_bus, tasks_db, "Persists events")
    Rel(event_bus, ws_server, "Broadcasts updates")
    Rel(agents_handler, agents_db, "CRUD")
    Rel(tasks_handler, tasks_db, "CRUD")
    Rel(payment_svc, payments_db, "Ledger writes")
    Rel(reconciliation_svc, payments_db, "Reads payment state")
    Rel(reconciliation_svc, soroban, "Queries on-chain state")
    Rel(heartbeat_monitor, agents_db, "Reads heartbeat timestamps")
    Rel(heartbeat_monitor, ws_server, "Pushes heartbeat:missed")
    Rel(stats_handler, tasks_db, "Aggregates metrics")
    Rel(stats_handler, agents_db, "Aggregates metrics")
    Rel(stats_handler, payments_db, "Aggregates metrics")
```

---

## 4. Sequence Diagrams

### 4.1 Task Submission to Completion (Happy Path with Escrow)

The full lifecycle from user submission through coordinator orchestration, multi-agent execution, and on-chain escrow settlement.

```mermaid
sequenceDiagram
    autonumber
    actor User as User / Frontend
    participant FE as Web Frontend
    participant API as Backend API
    participant Queue as Job Queue
    participant Coord as Coordinator Engine
    participant Escrow as payment_escrow Contract
    participant TaskStore as task_store Contract
    participant Agent as Specialized Agent Worker
    participant Venice as Venice AI
    participant WS as WebSocket Server

    User->>FE: Submit task prompt + budget
    FE->>Escrow: lock_escrow(task_id, amount_stroops)
    Escrow-->>FE: EscrowCreatedEvent (balance_id, tx_hash)
    Note over FE: Escrow lock confirmed

    FE->>API: POST /api/v1/tasks { prompt, walletPublicKey }
    API->>API: Validate (Zod) + rate-limit check
    API->>Queue: enqueue(execute_task, priority=normal)
    API-->>FE: 201 { taskId, status: "queued" }
    API->>WS: push task:update { newStatus: "queued" }
    WS-->>FE: task:update → task card appears

    Queue->>Coord: dispatch task
    Coord->>Coord: decompose(prompt) → DAG
    Coord->>TaskStore: store_task_metadata(task_id, assigned_agents)
    TaskStore-->>API: on-chain event: task_meta/created
    API->>WS: push task:update { newStatus: "running" }
    WS-->>FE: task card → Running

    loop For each DAG node (in dependency order)
        Coord->>Agent: execute_subtask(nodeId, agentType, context)
        Agent->>Venice: inference(prompt, model)
        Venice-->>Agent: LLM response
        Agent-->>Coord: subtask result
        Coord->>TaskStore: update_task_status(Pending → Running)
        TaskStore-->>API: on-chain event: task_meta/updated
        API->>WS: push task:update { progressPercent }
        WS-->>FE: progress bar updates
    end

    Coord->>TaskStore: update_task_status(Running → Completed)
    TaskStore-->>API: on-chain event: task_meta/finalized
    API->>WS: push task:update { newStatus: "completed" }
    WS-->>FE: status chip → Completed (green)

    Coord->>Escrow: release_escrow(balance_id, agent_address)
    Escrow-->>API: on-chain event: escrow/released (tx_hash)
    API->>WS: push payment:confirmed { txHash, amountXlm }
    WS-->>FE: Payment badge → Settled ✓

    Note over FE,Venice: Error path (dashed): if any agent fails after 3 retries,<br/>Coord emits TaskFailed, escrow/expired triggers refund to payer
```

### 4.2 Agent Registration + Heartbeat Lifecycle

```mermaid
sequenceDiagram
    autonumber
    participant Agent as Third-Party Agent
    participant API as Backend API
    participant Registry as agent_registry Contract
    participant HBMon as Heartbeat Monitor
    participant WS as WebSocket Server
    participant FE as Web Frontend

    Agent->>API: POST /api/v1/agents { agentId, capabilities, pricingXLM, endpoint, stellarPublicKey }
    API->>API: Validate schema (Zod)
    API->>Registry: register_agent(agent_id, capability, owner, endpoint)
    Registry-->>API: on-chain event: registry/registered
    API-->>Agent: 201 { id, status: "online" }
    API->>WS: push agent:status { newStatus: "online" }
    WS-->>FE: Agent appears in directory

    loop Every HEARTBEAT_INTERVAL_MS (default: 5 min)
        Agent->>API: POST /api/v1/agents/:id/heartbeat { status, activeJobs }
        API->>API: Update last_heartbeat_at in agents.db
        API-->>Agent: 200 { acknowledged: true }
    end

    Note over Agent,API: Agent worker crashes or network interruption

    Note over HBMon: Background loop checks:<br/>last_heartbeat_at < now - HEARTBEAT_STALE_THRESHOLD_MINUTES

    HBMon->>API: Mark agent offline in agents.db
    API->>WS: push heartbeat:missed { agentId, autoDeregistered: false }
    WS-->>FE: Agent dot → Offline (grey)

    Note over HBMon: AGENT_OFFLINE_DELETE_HOURS elapsed

    HBMon->>Registry: remove_agent(agent_id)
    Registry-->>API: on-chain event: registry/removed
    API->>WS: push agent:status { newStatus: "offline", autoDeregistered: true }
    WS-->>FE: Agent removed from directory

    Note over Agent: Agent restarts and re-registers
    Agent->>API: POST /api/v1/agents (re-register)
    API->>Registry: register_agent(...)
    API-->>Agent: 201 { id, status: "online" }
    API->>WS: push agent:status { newStatus: "online" }
    WS-->>FE: Agent reappears in directory
```

### 4.3 Governance Proposal + Timelock Execution

```mermaid
sequenceDiagram
    autonumber
    actor Admin as Contract Admin
    participant Governance as agent_governance Contract
    participant API as Backend API
    participant WS as WebSocket Server
    participant FE as Web Frontend

    Admin->>Governance: propose_change(parameter, current_value, proposed_value)
    Note over Governance: Records proposal + timelock_expires<br/>(e.g. 17,280 ledgers ≈ 24h)
    Governance-->>API: on-chain event: governance/proposed (proposal_id, timelock_expires)
    API->>WS: push governance:proposed { proposalId, parameter, timelockExpires }
    WS-->>FE: Governance panel shows pending proposal with countdown timer

    Note over Governance: Community review window (timelock duration)

    alt Timelock expires without objection
        Admin->>Governance: execute_change(proposal_id)
        Governance-->>API: on-chain event: governance/executed (proposal_id, new_value)
        API->>WS: push governance:executed { proposalId, parameter, newValue }
        WS-->>FE: Proposal status → Executed. Parameter display updates.
    else Emergency: Admin cancels proposal
        Admin->>Governance: cancel_proposal(proposal_id)
        Governance-->>API: on-chain event: governance/cancelled
        API->>WS: push governance:cancelled { proposalId }
        WS-->>FE: Proposal status → Cancelled
    end
```

---

## 5. Layer Responsibilities

AI-Net is partitioned into three decoupled layers:

### Presentation Layer (`frontend/`)

- Next.js 14 App Router, TypeScript, Tailwind CSS, Lucide icons.
- Stellar wallet integration (Freighter) for transaction signing and identity.
- Real-time task execution telemetry via Server-Sent Events (SSE) and WebSocket.
- Skeleton loading states and error boundaries for all async operations.

### Orchestration & Coordination Layer (`backend/`)

- Node.js 20, Express, TypeScript — REST API, WebSocket server, SSE streaming.
- **Coordinator Engine**: Decomposes natural-language prompts into DAGs of sub-tasks using Venice AI.
- **Specialized Workers**: Research, Risk, Coding, Design, Report — each wraps Venice AI with domain prompting.
- **Event Sourcing**: All task state changes are persisted as append-only events in `tasks.db`.
- **Persistence**: Three SQLite databases (`tasks.db`, `agents.db`, `payments.db`) with schema-versioned migrations.
- **Circuit Breakers**: Wrap Venice AI and Horizon calls with fail-fast protection and exponential backoff.

### Decentralized Settlement Layer (`smart-contracts/`)

Written in Rust for the Soroban Smart Contract platform on Stellar.

| Contract | Responsibility |
|---|---|
| `agent_registry` | On-chain agent identities, capabilities, pricing, and reputation scores |
| `payment_escrow` | Trustless XLM locking with time-locked refund safety nets |
| `task_store` | On-chain task lifecycle anchoring (created / updated / finalized) |
| `agent_governance` | Governance parameter changes with mandatory timelock |
| `agent_bidding` | Sealed-bid auction (`0.60 × Price + 0.40 × Reputation` composite score) |
| `dispute_resolution` | Multi-step jury voting with bond slashing and IPFS evidence |
| `upgrade_manager` | Safe contract upgrades with 48-hour rollback window |
| `error_registry` | On-chain error code registry for consistent error reporting |

---

## 6. Security Model

### Contract Invariants

- Every on-chain mutation performs strict authorization (`require_auth()`).
- State is stored in `Instance` storage for singletons; `Persistent`/`Temporary` for TTL-managed entities.
- No unbounded vectors in contract storage — collections enforce pagination cursors.

### Backend Security

- Wallet-based authentication: challenge → Freighter sign → JWT session.
- All mutations enforce idempotency keys to prevent double-submission.
- Rate limiting applied per wallet, per agent, and per route tier.
- Input validation via Zod on every request — max prompt length enforced to prevent token-cost abuse.
- Circuit breakers prevent Venice AI timeout storms from cascading into task failures.

### Testing Architecture

```mermaid
graph LR
    T1["Unit Tests (Jest / ts-jest)"]
    T2["Integration Tests (Supertest)"]
    T3["Contract Tests (Rust Cargo Test)"]
    T4["E2E Tests (Docker Compose + Testnet)"]
    T1 --> T2
    T2 --> T3
    T3 --> T4
```

---

## 7. Related Documents

- [Payment Flows & Escrow Lifecycle](payment-escrow-lifecycle.md) — Detailed escrow state machine, dispute flows, and reconciliation
- [Governance Timelock](governance-timelock.md) — Governance proposal and execution flow
- [REST API Reference](../API_REFERENCE.md) — All endpoint documentation with curl examples
- [Events Reference](../EVENTS.md) — On-chain and WebSocket event schemas with full cross-stack flow diagrams
- [Node Operators Guide](../NODE_OPERATORS_GUIDE.md) — Node provisioning, configuration, and monitoring
- [Operational Runbooks](../operations/RUNBOOKS.md) — Incident response procedures
- [Testnet Upgrade Runbook](../../smart-contracts/docs/TESTNET_UPGRADE_RUNBOOK.md) — Contract upgrade and rollback procedures
