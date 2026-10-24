# AI-Net Architecture Specification

Top-level technical reference for the ai-net platform — a decentralized agent coordination network built on the Stellar blockchain and Soroban smart contracts.

---

## Table of Contents

1. [System Context Diagram (C4 Level 1)](#1-system-context-diagram-c4-level-1)
2. [Component Architecture](#2-component-architecture)
3. [Sequence Diagram: Full Task Execution Flow](#3-sequence-diagram-full-task-execution-flow)
4. [Sequence Diagram: Agent Registration](#4-sequence-diagram-agent-registration)
5. [Sequence Diagram: Bidding Workflow](#5-sequence-diagram-bidding-workflow)
6. [Sequence Diagram: Payment Escrow Lifecycle](#6-sequence-diagram-payment-escrow-lifecycle)
7. [Sequence Diagram: Dispute Resolution](#7-sequence-diagram-dispute-resolution)
8. [Sequence Diagram: Contract Upgrade Flow](#8-sequence-diagram-contract-upgrade-flow)
9. [Deployment Diagram (Docker Compose)](#9-deployment-diagram-docker-compose)
10. [Data Flow Diagram](#10-data-flow-diagram)
11. [Security Model](#11-security-model)
12. [Technology Decisions Rationale](#12-technology-decisions-rationale)

> **Detailed sequence diagrams** for all major system flows (task submission, agent registration, bidding, escrow lifecycle, dispute resolution, upgrade flow) are in the dedicated reference: **[Sequence Diagrams →](sequence-diagrams.md)**

---

## 1. System Context Diagram (C4 Level 1)

The following C4 context diagram shows all external actors and systems that interact with the ai-net platform boundary.

```mermaid
C4Context
  title System Context — ai-net Platform

  Person(user, "User / Operator", "Submits natural-language tasks via the web UI or SDK. Connects a Stellar wallet.")
  Person(agent_dev, "Agent Developer", "Registers third-party AI agents on the network via the registration API.")

  System_Boundary(ai_net, "ai-net Platform") {
    System(frontend, "Web Frontend", "React SPA. Task submission, DAG monitoring, wallet management, agent browser.")
    System(backend, "Backend API & Coordinator", "Node.js/Express REST + WebSocket server. Decomposes tasks, dispatches agents, tracks state.")
    System(contracts, "Soroban Smart Contracts", "On-chain agent registry and payment escrow written in Rust.")
  }

  System_Ext(venice, "Venice AI", "LLM inference provider. Powers agent reasoning (research, coding, risk, design, report).")
  System_Ext(stellar_rpc, "Stellar Soroban RPC", "Soroban contract invocation endpoint.")
  System_Ext(stellar_horizon, "Stellar Horizon", "REST API for account, transaction, and event queries.")
  System_Ext(freighter, "Freighter Wallet", "Browser extension for signing Stellar transactions.")

  Rel(user, frontend, "Uses", "HTTPS / WebSocket")
  Rel(agent_dev, backend, "Registers agents via", "REST API")
  Rel(frontend, backend, "Submits tasks, streams events", "REST / SSE")
  Rel(frontend, freighter, "Signs transactions via", "Wallet API")
  Rel(backend, venice, "Invokes inference for", "HTTPS")
  Rel(backend, stellar_rpc, "Invokes contracts", "JSON-RPC")
  Rel(backend, stellar_horizon, "Queries accounts & events", "REST")
  Rel(contracts, stellar_rpc, "Hosted on", "Soroban")
```

---

## 2. Component Architecture

### 2.1 Layer Overview

```mermaid
graph TB
  subgraph "Presentation Layer — frontend/"
    UI["React 18 + TypeScript\n(Vite)"]
    WC["Wallet Context\n(Freighter / Secret Key)"]
    SSE["SSE Client\n(Live DAG Streaming)"]
  end

  subgraph "Orchestration Layer — backend/"
    API["Express REST API\n:3000"]
    Coord["Coordinator Engine\n(DAG Decomposition)"]
    Queue["Job Queue\n(In-Process)"]
    DB_Agents["agents.db\n(SQLite)"]
    DB_Tasks["tasks.db\n(SQLite)"]
    DB_Payments["payments.db\n(SQLite)"]
    Cache["Registry Cache\n(In-Memory, 30s TTL)"]
  end

  subgraph "Agent Workers — backend/src/agents/"
    RA["Research Agent"]
    RiskA["Risk Agent"]
    CA["Coding Agent"]
    DA["Design Agent"]
    RepA["Report Agent"]
  end

  subgraph "Settlement Layer — smart-contracts/"
    Registry["agent_registry\n(Soroban)"]
    Escrow["payment_escrow\n(Soroban)"]
    Governance["agent_governance\n(Soroban)"]
    Bidding["agent_bidding\n(Soroban)"]
    Dispute["dispute_resolution\n(Soroban)"]
    UpgradeMgr["upgrade_manager\n(Soroban)"]
  end

  UI -->|REST / SSE| API
  WC -->|Tx Signing| UI
  SSE -->|WebSocket ws://:3001| API
  API -->|Enqueue task| Queue
  Queue -->|Dispatch subtask| Coord
  Coord -->|Execute| RA & RiskA & CA & DA & RepA
  RA & RiskA & CA & DA & RepA -->|Inference| Venice["Venice AI"]
  Coord -->|Read/Write| DB_Tasks
  API -->|Read/Write| DB_Agents
  API -->|Read/Write| DB_Payments
  API -->|Cache reads| Cache
  Cache -.->|Sync every 60s| Registry
  Coord -->|Lock/Release escrow| Escrow
  API -->|Verify registration| Registry
```

### 2.2 Soroban Contract Map

```mermaid
classDiagram
  class agent_registry {
    +register_agent(id, capabilities, pricing, endpoint)
    +lookup_agents(capability) AgentRecord[]
    +deregister_agent(id)
    +update_pricing(id, price)
    +get_reputation(id) f64
  }

  class payment_escrow {
    +lock_escrow(coordinator, agent, amount, task_id)
    +release_payment(coordinator, agent, task_id)
    +refund_escrow(coordinator, task_id)
    +get_escrow_balance(task_id) i128
  }

  class agent_governance {
    +propose(description, action)
    +vote(proposal_id, support)
    +execute(proposal_id)
  }

  class agent_bidding {
    +submit_bid(task_id, price, reputation_hash)
    +reveal_bid(task_id, price, salt)
    +select_winner(task_id)
  }

  class dispute_resolution {
    +file_dispute(task_id, evidence_hash)
    +vote(dispute_id, verdict)
    +resolve(dispute_id)
    +slash_bond(agent_id, amount)
  }

  class upgrade_manager {
    +propose_upgrade(version, wasm_hash, plan)
    +validate_proposal()
    +execute_upgrade()
    +rollback_upgrade()
    +can_rollback() bool
  }

  agent_registry --> upgrade_manager : managed by
  payment_escrow --> upgrade_manager : managed by
  dispute_resolution --> agent_registry : reads reputation
  agent_bidding --> agent_registry : reads reputation
```

---

## 3. Sequence Diagram: Full Task Execution Flow

The following sequence diagram covers the complete market-entry report demo: from user submission through DAG execution, agent coordination, Venice AI inference, and final on-chain payment settlement.

```mermaid
sequenceDiagram
  autonumber
  actor User as User (Browser)
  participant FE as Web Frontend
  participant Wallet as Freighter Wallet
  participant API as Backend API :3000
  participant Coord as Coordinator Engine
  participant Registry as agent_registry (Soroban)
  participant Escrow as payment_escrow (Soroban)
  participant Research as Research Agent
  participant Risk as Risk Agent
  participant Report as Report Agent
  participant Venice as Venice AI
  participant DB as tasks.db / payments.db

  Note over User,DB: Phase 1 — Task Submission & Escrow Lock

  User->>FE: Submit "Market-entry report for solar energy\nin Southeast Asia" + budget 10 XLM
  FE->>Wallet: Sign escrow lock transaction (10 XLM)
  Wallet-->>FE: Signed transaction
  FE->>Escrow: Broadcast escrow lock tx
  Escrow-->>FE: Tx confirmed — escrow_id returned
  FE->>API: POST /api/tasks { prompt, escrow_id, walletPublicKey }
  API->>DB: INSERT task (status: queued)
  API-->>FE: 201 { taskId, status: "queued" }
  FE->>API: WS connect /tasks/:id/stream
  API-->>FE: Stream: { type: "task_started" }

  Note over Coord,Venice: Phase 2 — DAG Decomposition

  API->>Coord: dispatch(taskId)
  Coord->>Venice: decompose("market-entry report for solar energy in SEA")
  Venice-->>Coord: DAG [ research → risk → report ]
  Coord->>DB: UPDATE task dagJson, status: running
  API-->>FE: Stream: { type: "dag_ready", nodes: [...] }

  Note over Coord,Escrow: Phase 3 — Agent Discovery & Assignment

  Coord->>Registry: lookup_agents("research")
  Registry-->>Coord: [ Research Agent (4.8★, 2.5 XLM) ]
  Coord->>Registry: lookup_agents("risk")
  Registry-->>Coord: [ Risk Agent (4.5★, 3.0 XLM) ]
  Coord->>Registry: lookup_agents("report")
  Registry-->>Coord: [ Report Agent (4.9★, 1.5 XLM) ]

  Note over Research,Venice: Phase 4 — Parallel Agent Execution

  Coord->>Research: execute({ subtask: "Gather SEA solar market data" })
  API-->>FE: Stream: { type: "node_started", nodeId: "research" }
  Research->>Venice: complete(prompt, model: "venice-xl")
  Venice-->>Research: Market data findings
  Research-->>Coord: { result: "...", sources: [...] }
  API-->>FE: Stream: { type: "node_completed", nodeId: "research" }

  Coord->>Risk: execute({ subtask: "Analyze regulatory & financial risks", context: research_result })
  API-->>FE: Stream: { type: "node_started", nodeId: "risk" }
  Risk->>Venice: complete(prompt + research context, model: "venice-xl")
  Venice-->>Risk: Risk assessment
  Risk-->>Coord: { result: "..." }
  API-->>FE: Stream: { type: "node_completed", nodeId: "risk" }

  Note over Report,Escrow: Phase 5 — Report & Payment Settlement

  Coord->>Report: execute({ subtask: "Compile market-entry report", context: [research, risk] })
  API-->>FE: Stream: { type: "node_started", nodeId: "report" }
  Report->>Venice: complete(combined context, model: "venice-xl")
  Venice-->>Report: Final formatted report
  Report-->>Coord: { result: "Final Report PDF" }
  API-->>FE: Stream: { type: "node_completed", nodeId: "report" }

  Coord->>Escrow: release_payment(coordinator, research_agent, 2.5 XLM, taskId)
  Escrow-->>Coord: Tx confirmed
  API-->>FE: Stream: { type: "payment_released", agent: "research", amount: "2.5 XLM" }

  Coord->>Escrow: release_payment(coordinator, risk_agent, 3.0 XLM, taskId)
  Escrow-->>Coord: Tx confirmed
  API-->>FE: Stream: { type: "payment_released", agent: "risk", amount: "3.0 XLM" }

  Coord->>Escrow: release_payment(coordinator, report_agent, 1.5 XLM, taskId)
  Escrow-->>Coord: Tx confirmed
  API-->>FE: Stream: { type: "payment_released", agent: "report", amount: "1.5 XLM" }

  Coord->>DB: UPDATE task status: completed, result: final_report
  API-->>FE: Stream: { type: "task_completed", result: "..." }
  FE-->>User: Display final report + on-chain payment receipts
```

---

## 4. Sequence Diagram: Agent Registration

This diagram covers the full agent registration flow: from the operator calling the REST API, through on-chain registry confirmation, to the backend cache being populated.

```mermaid
sequenceDiagram
  autonumber
  actor Operator as Agent Operator
  participant API as Backend API :3000
  participant AgentsDB as agents.db
  participant Horizon as Stellar Horizon
  participant SorobanRPC as Soroban RPC
  participant Registry as agent_registry (Soroban)
  participant Cache as Registry Cache (30s TTL)

  Note over Operator,Cache: Phase 1 — REST Registration

  Operator->>API: POST /api/v1/agents { name, capability, endpoint, contractAddress, supportedModels }
  API->>API: Validate payload (Zod schema)

  alt Validation fails
    API-->>Operator: 400 VALIDATION_ERROR
  else contractAddress already registered
    API->>AgentsDB: SELECT agent WHERE contractAddress = ?
    AgentsDB-->>API: Existing record found
    API-->>Operator: 409 CONFLICT
  else Valid new registration
    API->>AgentsDB: INSERT agent (status: registered)
    AgentsDB-->>API: agent-id assigned
    API-->>Operator: 201 { id: "agent-xyz", status: "registered" }
  end

  Note over API,Registry: Phase 2 — On-Chain Staking (Operator-Initiated)

  Operator->>SorobanRPC: invoke agent_registry.stake_bond(agentId, bondAmount)
  SorobanRPC->>Registry: stake_bond(agentId, 100_000_000 stroops)
  Registry->>Registry: require_auth(operator_keypair)
  Registry->>Registry: Lock XLM bond in contract storage

  alt Bond amount below minimum (10 XLM)
    Registry-->>SorobanRPC: Error: BOND_TOO_LOW
    SorobanRPC-->>Operator: Transaction failed
  else Bond accepted
    Registry-->>SorobanRPC: { txHash, bondAmount }
    SorobanRPC-->>Operator: Transaction confirmed
  end

  Note over API,Cache: Phase 3 — On-Chain Registration Sync

  Operator->>SorobanRPC: invoke agent_registry.register_agent(agentId, capabilities, pricing, endpoint)
  SorobanRPC->>Registry: register_agent(...)
  Registry->>Registry: require_auth(operator_keypair)
  Registry->>Registry: Store agent record in Persistent storage
  Registry-->>SorobanRPC: AgentRegistered event emitted
  SorobanRPC-->>Operator: Transaction confirmed (txHash)

  Operator->>API: POST /api/v1/reconciliation (optional — trigger immediate sync)
  API->>Horizon: Poll for AgentRegistered events
  Horizon-->>API: Event stream including new agent
  API->>AgentsDB: UPDATE agent status: active
  API->>Cache: Invalidate & repopulate registry cache
  Cache-->>API: Cache refreshed

  opt Periodic background sync (every 60 s)
    API->>Horizon: Poll contract events since last cursor
    Horizon-->>API: Any new events
    API->>Cache: Merge updates into cache
  end

  Operator->>API: GET /api/v1/agents/agent-xyz
  API-->>Operator: { id, status: "active", capability, endpoint }
```

---

## 5. Sequence Diagram: Bidding Workflow

This diagram covers the commit-reveal bidding flow: task creation, bid submission, bid reveal, winner selection, and task assignment.

```mermaid
sequenceDiagram
  autonumber
  actor Requester as Task Requester
  participant API as Backend API :3000
  participant TaskDB as tasks.db
  participant Bidding as agent_bidding (Soroban)
  participant Registry as agent_registry (Soroban)
  participant AgentA as Agent A
  participant AgentB as Agent B
  participant Coord as Coordinator Engine

  Note over Requester,Coord: Phase 1 — Task Creation & Bid Window Open

  Requester->>API: POST /api/v1/tasks { prompt, capability: "research", budgetXlm: "5.0" }
  API->>TaskDB: INSERT task (status: bidding_open)
  API->>Bidding: invoke open_bid_window(taskId, capability, budget, deadline)
  Bidding-->>API: BidWindowOpened event (taskId, deadline)
  API-->>Requester: 201 { taskId, status: "bidding_open", bidDeadline }

  Note over AgentA,Bidding: Phase 2 — Commit Phase (Sealed Bids)

  API->>AgentA: Notify: new task available (taskId, capability, budgetXlm)
  API->>AgentB: Notify: new task available (taskId, capability, budgetXlm)

  AgentA->>AgentA: Compute bid: price=3.5 XLM, salt=random_bytes
  AgentA->>AgentA: commitment = hash(price || salt)
  AgentA->>Bidding: invoke submit_bid(taskId, commitment, reputationHash)
  Bidding->>Registry: get_reputation(agentA)
  Registry-->>Bidding: reputation_score = 4.8
  Bidding-->>AgentA: Bid committed (bidId)

  AgentB->>AgentB: Compute bid: price=4.0 XLM, salt=random_bytes
  AgentB->>AgentB: commitment = hash(price || salt)
  AgentB->>Bidding: invoke submit_bid(taskId, commitment, reputationHash)
  Bidding->>Registry: get_reputation(agentB)
  Registry-->>Bidding: reputation_score = 4.5
  Bidding-->>AgentB: Bid committed (bidId)

  Note over AgentA,Bidding: Phase 3 — Reveal Phase

  Note right of Bidding: Commit deadline passes; reveal window opens

  AgentA->>Bidding: invoke reveal_bid(taskId, price=3.5 XLM, salt)
  Bidding->>Bidding: Verify hash(price || salt) == commitment
  alt Hash mismatch
    Bidding-->>AgentA: Error: COMMITMENT_MISMATCH — bid disqualified
  else Hash valid
    Bidding-->>AgentA: Bid revealed and recorded
  end

  AgentB->>Bidding: invoke reveal_bid(taskId, price=4.0 XLM, salt)
  Bidding-->>AgentB: Bid revealed and recorded

  Note over Bidding,Coord: Phase 4 — Winner Selection & Assignment

  Note right of Bidding: Reveal deadline passes

  API->>Bidding: invoke select_winner(taskId)
  Bidding->>Bidding: Score bids: weighted(price, reputation)
  Bidding->>Bidding: Agent A score = f(3.5 XLM, 4.8★) → winner
  Bidding-->>API: WinnerSelected { taskId, winner: agentA, price: 3.5 XLM }

  API->>TaskDB: UPDATE task status: assigned, assignedAgent: agentA
  API->>Coord: dispatch(taskId, agentA, price: 3.5 XLM)
  Coord->>AgentA: POST /v1/execute { taskId, input, paymentEscrowId }
  AgentA-->>Coord: 200 { accepted: true }

  opt Agent does not respond within timeout
    Coord->>Bidding: invoke select_winner(taskId, skipWinner: agentA)
    Bidding-->>Coord: Next best: agentB (4.0 XLM)
    Coord->>AgentB: POST /v1/execute { taskId, input, paymentEscrowId }
  end
```

---

## 6. Sequence Diagram: Payment Escrow Lifecycle

This diagram covers the escrow lifecycle from lock-in through task execution to settlement, including the refund and dispute paths.

```mermaid
sequenceDiagram
  autonumber
  actor Requester as Task Requester
  participant Wallet as Freighter Wallet
  participant API as Backend API :3000
  participant Coord as Coordinator Engine
  participant Escrow as payment_escrow (Soroban)
  participant Agent as Assigned Agent
  participant PayDB as payments.db

  Note over Requester,PayDB: Phase 1 — Escrow Lock

  Requester->>Wallet: Request signature for escrow lock (10 XLM, taskId)
  Wallet-->>Requester: Signed transaction
  Requester->>Escrow: invoke lock_escrow(coordinator, agent, amount=10 XLM, taskId)
  Escrow->>Escrow: require_auth(requester_keypair)
  Escrow->>Escrow: Transfer 10 XLM to contract-held escrow account
  Escrow->>Escrow: Record EscrowRecord { taskId, coordinator, agent, amount, status: locked }
  Escrow-->>Requester: EscrowLocked { escrowId, txHash }

  Requester->>API: POST /api/v1/tasks { prompt, escrowId }
  API->>PayDB: INSERT payment_record (escrowId, amount, status: locked)
  API-->>Requester: 201 { taskId, escrowId }

  Note over Coord,Agent: Phase 2 — Task Execution

  Coord->>Agent: POST /v1/execute { taskId, input, escrowId }
  Agent-->>Coord: 200 { accepted: true, taskId }

  alt Task completes successfully
    Agent->>API: POST /api/v1/tasks/:id/result { status: "completed", output }
    API->>Coord: Task result received
    Coord->>Coord: Validate output quality
    Coord->>Escrow: invoke release_payment(coordinator, agent, taskId)
    Escrow->>Escrow: require_auth(coordinator_keypair)
    Escrow->>Escrow: Transfer escrowed XLM to agent's Stellar address
    Escrow->>Escrow: Update EscrowRecord status: released
    Escrow-->>Coord: PaymentReleased { txHash, amount }
    Coord->>PayDB: UPDATE payment_record status: released, settlementTxHash
    Coord->>API: Notify task: completed, payment: released
    API-->>Requester: SSE { type: "payment_released", amount: "10 XLM", txHash }

  else Task fails or times out
    Agent->>API: POST /api/v1/tasks/:id/result { status: "failed", errorMessage }
    API->>Coord: Task failed
    Coord->>Escrow: invoke refund_escrow(coordinator, taskId)
    Escrow->>Escrow: require_auth(coordinator_keypair)
    Escrow->>Escrow: Return XLM to requester's Stellar address
    Escrow->>Escrow: Update EscrowRecord status: refunded
    Escrow-->>Coord: EscrowRefunded { txHash }
    Coord->>PayDB: UPDATE payment_record status: refunded
    API-->>Requester: SSE { type: "task_failed", refundTxHash }

  else Requester raises dispute (within 72 h of completion)
    Requester->>API: POST /api/v1/disputes { taskId, reason, evidenceHash }
    API->>Escrow: invoke freeze_escrow(taskId)
    Escrow->>Escrow: Update EscrowRecord status: disputed — funds frozen
    Escrow-->>API: EscrowFrozen
    Note right of Escrow: Escrow remains frozen until dispute resolution (see §7)
  end

  opt Query escrow balance
    API->>Escrow: invoke get_escrow_balance(taskId)
    Escrow-->>API: { balance: "10.0000000", status: "locked" }
  end
```

---

## 7. Sequence Diagram: Dispute Resolution

This diagram covers the full dispute lifecycle: raising a dispute, submitting evidence, arbitration voting, resolution, and payment or bond-slash outcome.

```mermaid
sequenceDiagram
  autonumber
  actor Requester as Task Requester
  actor Agent as Agent Operator
  participant API as Backend API :3000
  participant Dispute as dispute_resolution (Soroban)
  participant Escrow as payment_escrow (Soroban)
  participant Registry as agent_registry (Soroban)
  participant Juror1 as Juror Node 1
  participant Juror2 as Juror Node 2
  participant Juror3 as Juror Node 3
  participant PayDB as payments.db

  Note over Requester,PayDB: Phase 1 — Dispute Filing (within 72 h of task completion)

  Requester->>API: POST /api/v1/disputes { taskId, reason, evidenceHash: "Qm..." }
  API->>Dispute: invoke file_dispute(taskId, evidenceHash, requester)
  Dispute->>Dispute: require_auth(requester_keypair)
  Dispute->>Escrow: invoke freeze_escrow(taskId)
  Escrow-->>Dispute: EscrowFrozen
  Dispute->>Dispute: Record DisputeRecord { disputeId, taskId, status: open, deadline: now+72h }
  Dispute-->>API: DisputeOpened { disputeId }
  API->>PayDB: UPDATE payment_record status: disputed
  API-->>Requester: 201 { disputeId, status: "open", evidenceDeadline }

  Note over Agent,Dispute: Phase 2 — Evidence Submission

  API->>Agent: Notify: dispute opened (disputeId, evidenceDeadline)

  Agent->>Dispute: invoke submit_evidence(disputeId, agentEvidenceHash, agentId)
  Dispute->>Dispute: require_auth(agent_keypair)
  Dispute->>Dispute: Store evidence hash reference (raw content stays off-chain)
  Dispute-->>Agent: Evidence recorded

  opt Requester submits additional evidence
    Requester->>Dispute: invoke submit_evidence(disputeId, additionalEvidenceHash, requester)
    Dispute-->>Requester: Additional evidence recorded
  end

  Note over Juror1,Dispute: Phase 3 — Juror Arbitration (3-day voting window)

  Dispute->>Juror1: Notify: dispute ready for review (disputeId)
  Dispute->>Juror2: Notify: dispute ready for review (disputeId)
  Dispute->>Juror3: Notify: dispute ready for review (disputeId)

  Juror1->>Dispute: invoke vote(disputeId, verdict: "agent_cleared", rationale_hash)
  Dispute->>Dispute: require_auth(juror1_keypair)
  Dispute-->>Juror1: Vote recorded

  Juror2->>Dispute: invoke vote(disputeId, verdict: "agent_cleared", rationale_hash)
  Dispute-->>Juror2: Vote recorded

  Juror3->>Dispute: invoke vote(disputeId, verdict: "partial_fault", rationale_hash)
  Dispute-->>Juror3: Vote recorded

  Note over Dispute,PayDB: Phase 4 — Resolution

  Note right of Dispute: Voting deadline passes — resolve called

  API->>Dispute: invoke resolve(disputeId)
  Dispute->>Dispute: Tally votes: 2× agent_cleared, 1× partial_fault
  Dispute->>Dispute: Quorum reached (≥ 2/3); majority = agent_cleared

  alt Agent cleared
    Dispute->>Escrow: invoke release_payment(coordinator, agent, taskId)
    Escrow-->>Dispute: PaymentReleased { txHash }
    Dispute->>Registry: update_reputation(agentId, outcome: cleared)
    Dispute-->>API: DisputeResolved { verdict: "agent_cleared", paymentTxHash }
    API->>PayDB: UPDATE payment_record status: released
    API-->>Requester: Dispute closed — agent cleared; payment released to agent
    API-->>Agent: Dispute closed — cleared; payment received

  else Partial fault (agent at fault)
    Dispute->>Escrow: invoke refund_escrow(coordinator, taskId, partialAmount)
    Escrow-->>Dispute: PartialRefund { txHash }
    Dispute->>Dispute: invoke slash_bond(agentId, slashAmount)
    Dispute->>Registry: update_reputation(agentId, outcome: partial_fault)
    Dispute-->>API: DisputeResolved { verdict: "partial_fault", refundTxHash, slashTxHash }
    API->>PayDB: UPDATE payment_record status: partially_refunded
    API-->>Requester: Partial refund issued
    API-->>Agent: Bond partially slashed

  else Full fault (agent at fault)
    Dispute->>Escrow: invoke refund_escrow(coordinator, taskId, fullAmount)
    Escrow-->>Dispute: FullRefund { txHash }
    Dispute->>Dispute: invoke slash_bond(agentId, fullBondAmount)
    Dispute->>Registry: update_reputation(agentId, outcome: full_fault)
    Dispute-->>API: DisputeResolved { verdict: "full_fault", refundTxHash, slashTxHash }
    API-->>Requester: Full refund issued
    API-->>Agent: Bond fully slashed; agent suspended

  else No quorum (jurors failed to vote)
    Note right of Dispute: Voting window expired with < 2/3 participation
    Dispute->>Escrow: invoke release_payment(coordinator, agent, taskId)
    Dispute-->>API: DisputeResolved { verdict: "no_quorum", paymentReleased: true }
    API-->>Requester: No quorum — payment released to agent by default
  end
```

---

## 8. Sequence Diagram: Contract Upgrade Flow

This diagram covers the full smart-contract upgrade flow: governance proposal, timelock, upgrade execution, post-migration verification, and rollback path.

```mermaid
sequenceDiagram
  autonumber
  actor Proposer as Upgrade Proposer
  actor Voter1 as Governance Voter 1
  actor Voter2 as Governance Voter 2
  participant Governance as agent_governance (Soroban)
  participant Timelock as Timelock (48 h)
  participant UpgradeMgr as upgrade_manager (Soroban)
  participant TargetContract as Target Contract (e.g. agent_registry)
  participant API as Backend API :3000

  Note over Proposer,API: Phase 1 — Upgrade Proposal

  Proposer->>UpgradeMgr: invoke propose_upgrade(version, wasmHash, migrationPlan)
  UpgradeMgr->>UpgradeMgr: require_auth(proposer_keypair)
  UpgradeMgr->>UpgradeMgr: validate_proposal() — check wasm_hash exists on ledger
  alt Proposal invalid (wasm not found or version regression)
    UpgradeMgr-->>Proposer: Error: INVALID_PROPOSAL
  else Proposal valid
    UpgradeMgr->>Governance: invoke propose(description: "Upgrade to v1.2.0", action: upgrade_plan)
    Governance-->>UpgradeMgr: proposalId assigned
    UpgradeMgr-->>Proposer: { proposalId, status: "voting_open", voteDeadline }
  end

  Note over Voter1,Governance: Phase 2 — Governance Voting

  Voter1->>Governance: invoke vote(proposalId, support: true)
  Governance->>Governance: require_auth(voter1_keypair)
  Governance->>Governance: Record vote; check quorum
  Governance-->>Voter1: Vote recorded

  Voter2->>Governance: invoke vote(proposalId, support: true)
  Governance->>Governance: Record vote; quorum reached
  Governance-->>Voter2: Vote recorded; proposal approved

  alt Proposal rejected (insufficient votes)
    Governance-->>Proposer: ProposalRejected { proposalId }
    Note right of Governance: Upgrade cancelled; no further action
  else Proposal approved
    Governance-->>UpgradeMgr: ProposalPassed { proposalId }
    UpgradeMgr->>Timelock: Start 48-hour timelock
    UpgradeMgr-->>Proposer: { status: "timelock", executeAfter: now+48h }
  end

  Note over UpgradeMgr,TargetContract: Phase 3 — Timelock & Execution

  Note right of Timelock: 48 hours pass

  opt Emergency cancellation during timelock
    Proposer->>Governance: invoke veto(proposalId)
    Governance-->>UpgradeMgr: UpgradeCancelled
    Note right of UpgradeMgr: Upgrade aborted; contract unchanged
  end

  Proposer->>UpgradeMgr: invoke execute_upgrade(proposalId)
  UpgradeMgr->>UpgradeMgr: require_auth(deployer_keypair)
  UpgradeMgr->>UpgradeMgr: Verify timelock has elapsed

  API->>API: Set maintenance mode — reject new task submissions
  API-->>Proposer: Maintenance mode active

  UpgradeMgr->>TargetContract: Run pre_migration_hook()
  TargetContract-->>UpgradeMgr: Pre-migration complete (state snapshot taken)

  UpgradeMgr->>TargetContract: upgrade(newWasmHash)
  TargetContract-->>UpgradeMgr: Contract WASM replaced on ledger

  UpgradeMgr->>TargetContract: Run post_migration_hook()
  TargetContract-->>UpgradeMgr: Post-migration complete (indexes rebuilt)

  Note over UpgradeMgr,API: Phase 4 — Verification

  Proposer->>TargetContract: Invoke smoke-test function (e.g. get_version())
  TargetContract-->>Proposer: { version: "1.2.0" }

  Proposer->>API: POST /api/v1/health-check (backend reads new contract version)
  API->>TargetContract: Query version
  TargetContract-->>API: "1.2.0"
  API-->>Proposer: { contractVersion: "1.2.0", status: "healthy" }

  API->>API: Lift maintenance mode
  API-->>Proposer: Maintenance mode off — system live on v1.2.0

  Note over UpgradeMgr,TargetContract: Phase 5 — Rollback Path (within 48-hour window)

  alt Critical issue detected post-upgrade
    Proposer->>UpgradeMgr: invoke can_rollback(proposalId)
    UpgradeMgr-->>Proposer: { canRollback: true, rollbackDeadline }

    Proposer->>UpgradeMgr: invoke rollback_upgrade(proposalId)
    UpgradeMgr->>UpgradeMgr: require_auth(deployer_keypair)
    UpgradeMgr->>TargetContract: upgrade(previousWasmHash)
    TargetContract-->>UpgradeMgr: Contract reverted to previous WASM
    UpgradeMgr->>TargetContract: Run rollback_migration_hook()
    TargetContract-->>UpgradeMgr: State restored from pre-upgrade snapshot
    UpgradeMgr-->>Proposer: { status: "rolled_back", version: "1.1.0" }
    API-->>Proposer: System live on v1.1.0
  end
```

---

## 9. Deployment Diagram (Docker Compose)

The following diagram reflects the exact services and their relationships in `docker-compose.yml`.

```mermaid
graph TB
  subgraph "Host Machine"
    subgraph "Docker Compose Network"
      Stellar["stellar-standalone\nImage: stellar/quickstart:testing\nPorts: 8000, 11626\nMode: --standalone --enable-soroban-rpc\nHealthcheck: curl :8000 | grep Stellar"]

      Backend["backend\nBuild: backend/Dockerfile\nPort: 3000\nEnv: NODE_ENV=development\n     DATABASE_URL=sqlite:///app/data/ai_net.db\n     SOROBAN_RPC_URL=http://stellar-standalone:8000/soroban/rpc\n     STELLAR_HORIZON_URL=http://stellar-standalone:8000\nHealthcheck: wget :3000/health"]

      Frontend["frontend\nBuild: frontend/Dockerfile\nPort: 5173\nEnv: VITE_API_BASE_URL=http://localhost:3000\n     VITE_STELLAR_NETWORK=standalone\n     VITE_SOROBAN_RPC_URL=http://localhost:8000/soroban/rpc"]

      Volume[("sqlite_data\n(named volume)\n/app/data/")]
    end
  end

  Browser["Browser\n:5173"]
  API_Client["API Client\n:3000"]

  Stellar -->|"healthy (5s interval)"| Backend
  Backend -->|"healthy (5s interval)"| Frontend
  Backend --- Volume
  Browser --> Frontend
  API_Client --> Backend
  Backend -->|":8000/soroban/rpc"| Stellar
  Frontend -->|":3000 (REST/WS)"| Backend
  Frontend -->|":8000/soroban/rpc"| Stellar
```

**Service startup order:** `stellar-standalone` → `backend` (waits for stellar healthy) → `frontend` (waits for backend healthy)

**Quick start:**

```bash
docker compose up -d
# Frontend:  http://localhost:5173
# Backend:   http://localhost:3000
# Stellar:   http://localhost:8000/soroban/rpc
```

---

## 10. Data Flow Diagram

### 10.1 Where Data Lives

| Data Store       | File                    | Owner   | Contents                                      |
| ---------------- | ----------------------- | ------- | --------------------------------------------- |
| `agents.db`      | `<cwd>/agents.db`       | backend | Agent registrations, capabilities, reputation |
| `tasks.db`       | `<cwd>/tasks.db`        | backend | Tasks, DAG state, quality scores, task events |
| `payments.db`    | `<cwd>/payments.db`     | backend | Payment records and escrow status             |
| Docker volume    | `sqlite_data:/app/data` | compose | Persistent storage across container restarts  |
| On-chain storage | Stellar ledger          | Soroban | Agent registry entries, escrow balances       |
| Registry cache   | In-process memory       | backend | 30-second TTL cache of on-chain agent data    |

### 10.2 Data Flow

```mermaid
flowchart LR
  subgraph "Inputs"
    User_Input["User submits task\n(prompt + budget)"]
    Agent_Reg["Agent registers\n(via REST API)"]
    OnChain_Reg["On-chain agent event\n(Soroban contract)"]
  end

  subgraph "Backend Processing"
    API_Layer["Express API\n(validation, auth)"]
    Coord_Engine["Coordinator Engine\n(DAG execution)"]
    Registry_Cache["Registry Cache\n(30s TTL)"]
    Event_Bus["Event Bus\n(pub/sub)"]
  end

  subgraph "Storage"
    TasksDB[("tasks.db\n+ task_events\n+ quality_scores")]
    AgentsDB[("agents.db\n+ reputation")]
    PaymentsDB[("payments.db")]
  end

  subgraph "External"
    Venice_AI["Venice AI\n(LLM Inference)"]
    Soroban_RPC["Soroban RPC\n(contract calls)"]
    Horizon["Stellar Horizon\n(event polling)"]
  end

  subgraph "Outputs"
    FE_Stream["Frontend SSE stream\n(real-time events)"]
    OnChain_Payment["On-chain payment\n(XLM transfer)"]
    DB_Result["Persisted result\n(task artifacts)"]
  end

  User_Input --> API_Layer
  Agent_Reg --> API_Layer
  API_Layer --> TasksDB
  API_Layer --> AgentsDB
  API_Layer --> Coord_Engine
  Coord_Engine --> Venice_AI
  Venice_AI --> Coord_Engine
  Coord_Engine --> Event_Bus
  Event_Bus --> FE_Stream
  Coord_Engine --> Soroban_RPC
  Soroban_RPC --> OnChain_Payment
  Coord_Engine --> TasksDB
  Coord_Engine --> PaymentsDB
  OnChain_Reg --> Horizon
  Horizon -->|"60s sync"| Registry_Cache
  Registry_Cache --> AgentsDB
  Coord_Engine --> DB_Result
```

---

## 11. Security Model

### 11.1 Authentication

| Layer                  | Mechanism                                                                                                             |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------- |
| Frontend → Backend API | `X-Wallet-Public-Key` header (Stellar public key). Verified against task ownership before streaming.                  |
| Agent → Backend API    | `Authorization: Bearer <secret>` per agent registration. Secrets are stored as bcrypt hashes.                         |
| WebSocket connection   | First message must contain `{ walletPublicKey }` matching the task owner. Rejected with close frame `4403` otherwise. |
| Soroban contracts      | `require_auth()` on every mutating invocation. Only the deployer or upgrade manager can upgrade.                      |

### 11.2 Authorization

- **Task access:** Each task is associated with a `walletPublicKey`. The API rejects read/stream requests where the `X-Wallet-Public-Key` header does not match the task's recorded public key.
- **Agent registration:** Agents must provide a signed Stellar challenge to deregister or update pricing. The backend verifies the signature against the registered `stellarPublicKey`.
- **Contract admin operations:** All admin-level contract calls (upgrade, governance, slashing) require the deployer's Stellar keypair to sign the transaction. Multi-signature is recommended for mainnet.
- **Rate limiting:** 100 requests/min per IP via `express-rate-limit`. LLM calls are additionally capped by per-wallet daily quotas enforced before forwarding to Venice AI.

### 11.3 Key Management

| Key Type                        | Storage Recommendation                                                  |
| ------------------------------- | ----------------------------------------------------------------------- |
| `STELLAR_SECRET_KEY` (deployer) | GitHub Actions secrets for CI/CD. Hardware wallet (Ledger) for mainnet. |
| `VENICE_API_KEY`                | Environment variable. Never logged or returned in API responses.        |
| Agent `stellarPublicKey`        | Public — stored in `agents.db` and on-chain registry.                   |
| Agent secret                    | Stored as bcrypt hash in `agents.db`. Never stored in plaintext.        |
| Testnet keys                    | `.env` file (gitignored). Separate from mainnet keys.                   |

**Key rotation:** Rotate `STELLAR_SECRET_KEY` after each mainnet deployment. Rotating the Venice API key requires redeploying the backend with the new value.

### 11.4 On-Chain Security Invariants

All Soroban contracts enforce:

1. **`require_auth()`** on every state-mutating function — no anonymous writes.
2. **Bounded storage** — agent capability arrays are capped at 10 entries to prevent unbounded storage growth.
3. **Pagination cursors** on collections — avoids returning unbounded result sets.
4. **Escrow immutability** — locked escrow can only be released by the locking coordinator key, preventing unauthorized withdrawals.
5. **Dispute evidence hashing** — evidence submitted to `dispute_resolution` is stored as SHA-256 hashes; raw content stays off-chain.

### 11.5 Circuit Breakers and Resilience

- Venice AI calls are wrapped in a circuit breaker: opens after 3 consecutive failures, stays open for 60 seconds before attempting recovery.
- Stellar Horizon calls use exponential backoff (up to 5 retries) for `TIMEOUT` and `TOO_MANY_REQUESTS` errors.
- Database connections use a connection pool with a 5-second acquire timeout and automatic reconnection on failure.

### 11.6 Input Validation

- All REST request bodies are validated with **Zod** schemas at the API boundary before reaching business logic.
- Task prompts are capped at 1,000 characters before being forwarded to Venice AI.
- SQL queries use **parameterized statements** exclusively — no string interpolation anywhere in the database layer.

---

## 12. Technology Decisions Rationale

### Stellar / Soroban for Payments and Registry

Stellar is purpose-built for fast, low-cost asset transfers. XLM transaction fees are fractions of a cent, settlement is final in 3–5 seconds, and the Soroban smart contract platform provides an auditable, sandboxed execution environment for the agent registry and escrow logic. Alternative EVM chains were evaluated but rejected due to higher fees and longer finality times that would make micro-payment flows per-agent-subtask economically impractical.

### SQLite over PostgreSQL

The backend uses three SQLite databases (`agents.db`, `tasks.db`, `payments.db`) rather than a single PostgreSQL instance. This simplifies local development (no separate database service required), eliminates a network hop on every query, and aligns with the single-node deployment model of the initial release. Each database file is versioned by its own schema migration table and managed by the shared `migrator.ts` module. When horizontal scaling is needed, the SQLite files can be replaced with a PostgreSQL-backed implementation behind the same interface.

### Venice AI for LLM Inference

Venice AI offers privacy-preserving, uncensored model inference with an OpenAI-compatible API. Agent prompts never leave the Venice infrastructure to train third-party models. The model routing map (`research/risk/design/report → venice-xl`, `coding → venice-code`) was chosen to match capability requirements while minimizing token costs.

### Playwright (Chromium-only) for Visual Regression

Visual screenshots are pixel-tied to a single browser rendering engine and OS font stack. Running the visual suite on Chromium only (via a pinned `mcr.microsoft.com/playwright` Docker image) means baselines need to be maintained only once, and rendering drift from OS differences is eliminated. Firefox and WebKit functional tests still run in the separate e2e suite.

### Node.js + Express for the Backend

The coordinator's primary work is I/O-bound (Stellar RPC calls, Venice AI calls, SQLite reads). Node.js's event loop model handles high concurrency for these workloads without thread management overhead. The Express framework was chosen for its minimal surface area and compatibility with the existing team's TypeScript conventions.

### Vite + React 18 for the Frontend

Vite provides sub-second HMR and optimized production builds with ES module chunking. React 18's concurrent features (Suspense, transitions) support the skeleton loading states and real-time streaming UI required by the task monitoring dashboard. Server-Sent Events (SSE) were chosen over WebSockets for the task event stream because they are unidirectional, automatically reconnecting, and compatible with HTTP/2 multiplexing.

---

## Related Documents

- [Sequence Diagrams](sequence-diagrams.md) — all 6 major system flow sequence diagrams: task submission, agent registration, bidding, payment escrow lifecycle, dispute resolution, and upgrade flow
- [Payment Flows & Escrow Lifecycle](payment-escrow-lifecycle.md) — detailed payment state machine and reconciliation design
- [Governance Timelock](governance-timelock.md) — on-chain governance proposal and voting flow
- [Smart Contract Deployment Guide](../../smart-contracts/docs/DEPLOYMENT_GUIDE.md)
- [Database Schema](../DATABASE_SCHEMA.md)
- [Frontend Architecture](../FRONTEND_ARCHITECTURE.md)
- [API Reference](../API_REFERENCE.md)
