# Staking Guide for Node Operators

This guide describes the bond accounting currently implemented by ai-net's `agent_registry` contract. It covers the configured minimum, contract calls, SLA penalties, cooldown behavior, and planning examples.

> **Implementation limitation:** The repository does not contain a `capability_staking` contract or an XLM token transfer/escrow path for agent bonds. `agent_registry` records a `bond_amount` in stroops, can reduce that number, and emits a bond-return event; it does not custody, transfer, or return XLM. The CLI examples below invoke registry accounting only. Do not treat the recorded amount as a wallet balance or proof of collateral. There is no public backend HTTP endpoint for staking. Bond recommendations and economics here are illustrative and have not been reviewed by a protocol economist.

---

## Table of Contents

1. [What Is Staking and Why It Exists](#1-what-is-staking-and-why-it-exists)
2. [Minimum Stake Requirements](#2-minimum-stake-requirements)
3. [Staking via CLI and API](#3-staking-via-cli-and-api)
4. [Slashing Conditions and Thresholds](#4-slashing-conditions-and-thresholds)
5. [Bond Withdrawal and Cooldown Period](#5-bond-withdrawal-and-cooldown-period)
6. [Recommended Bond Sizes](#6-recommended-bond-sizes)
7. [Economics: Revenue vs Staking Cost](#7-economics-revenue-vs-staking-cost)
8. [Risk Table](#8-risk-table)
9. [Worked Examples](#9-worked-examples)

---

## 1. What Is Staking and Why It Exists

The registry requires each agent record to declare a bond amount in stroops. The default minimum is intended as an economic-accountability parameter, but the current contract stores the declared amount rather than locking XLM. SLA logic and admin slash calls can change this recorded amount; it is not a custody guarantee.

1. **Registration requirement:** The declared amount must meet the registry's current global minimum.
2. **SLA accounting:** A detected SLA violation reduces the recorded amount by the contract's penalty formula.
3. **Administrative adjustment:** The contract admin can reduce the recorded amount with `slash_bond`.

Registration does not lock XLM. Deregistration removes the agent record and starts a cooldown record; after the cooldown, a second call emits a bond-return event but does not transfer tokens.

### How Staking Relates to Reputation

The registry does not rank agents by bond amount. Its SLA code emits an event with a reputation boost after qualifying checks; it does not persist an on-chain reputation score.

- **Higher recorded amounts** do not affect discovery ranking in the current contract.
- **SLA violations** emit a violation event and reduce the recorded amount by 10% of its current value when the calculated penalty is nonzero.
- **SLA bonus events** report a 5-point reputation boost after at least 10 checks with no recorded violations; this is not a persisted reputation score.

---

## 2. Minimum Stake Requirements

The default minimum bond is **10 XLM** (`100,000,000` stroops), enforced by the `agent_registry` contract's `DEFAULT_MIN_BOND_STROOPS` constant. The contract admin can adjust this via the `set_min_bond` function.

### Per-Capability Minimums

The contract enforces one configurable global minimum and does not set capability-specific requirements. No per-capability amounts have been reviewed by a protocol economist.

| Capability | Contract Minimum | Reviewed recommendation |
|---|---|---|---|
| `research` | Current global minimum (default 10 XLM) | Not established |
| `risk` | Current global minimum (default 10 XLM) | Not established |
| `coding` | Current global minimum (default 10 XLM) | Not established |
| `design` | Current global minimum (default 10 XLM) | Not established |
| `report` | Current global minimum (default 10 XLM) | Not established |

> **Note**: The contract will reject any `register_agent` call with `bond_amount < min_bond` by returning `Error::InsufficientBond` (error code 10).

### Checking the Current Minimum

```bash
# Query the current minimum bond from the agent_registry contract
stellar contract invoke \
  --id <AGENT_REGISTRY_CONTRACT_ID> \
  --source <YOUR_KEY> \
  --network testnet \
  -- \
  get_min_bond
```

---

## 3. Staking via CLI and API

### Register an Agent with a Bond Amount

The registry checks `bond_amount` at registration. This records a number; it does not debit or escrow the caller's XLM.

```bash
# Register an agent with a 50 XLM bond (500,000,000 stroops)
stellar contract invoke \
  --id <AGENT_REGISTRY_CONTRACT_ID> \
  --source alice \
  --network testnet \
  -- \
  register_agent \
  --record '{"id": "agent_research_alpha", "capability": "research", "price_stroops": 5000000, "endpoint": "https://agent.example.com/api", "owner": "GALICE...", "metadata": {}, "bond_amount": 500000000}'
```

The contract emits a `(registry, bond_lck)` event for indexers. This is an accounting event, not evidence of a token transfer:

```json
{
  "agent_id": "agent_research_alpha",
  "owner": "GALICE...",
  "amount_stroops": 500000000
}
```

### Check the Recorded Bond Amount

```bash
# List records for a capability; inspect the matching id and its bond_amount
stellar contract invoke \
  --id <AGENT_REGISTRY_CONTRACT_ID> \
  --source alice \
  --network testnet \
  -- \
  lookup_agents \
  --capability research
```

The response includes matching agent records and their `bond_amount` in stroops. This is not a wallet balance. The contract has no `get_agent` entrypoint, independent bond-balance query, or public backend REST endpoint.

### Check Agent Health

```bash
# Query agent health status (existence, frozen state, error count)
stellar contract invoke \
  --id <AGENT_REGISTRY_CONTRACT_ID> \
  --source alice \
  --network testnet \
  -- \
  get_agent_health \
  --agent_id agent_research_alpha
```

### Deregister and Complete the Cooldown

Registry removal is a two-call process:

```bash
# First call: remove the agent record and start the cooldown
stellar contract invoke \
  --id <AGENT_REGISTRY_CONTRACT_ID> \
  --source alice \
  --network testnet \
  -- \
  deregister_agent \
  --agent_id agent_research_alpha
```

```bash
# Second call: after the cooldown, emit the bond-return event
stellar contract invoke \
  --id <AGENT_REGISTRY_CONTRACT_ID> \
  --source alice \
  --network testnet \
  -- \
  deregister_agent \
  --agent_id agent_research_alpha
```

The second call emits a `(registry, bond_ret)` event. The current implementation does not transfer XLM:

```json
{
  "agent_id": "agent_research_alpha",
  "owner": "GALICE...",
  "amount_stroops": 500000000
}
```

### API Availability

There is no staking endpoint in the backend and this repository does not provide a generated TypeScript client for these calls. Direct integrations can use the Stellar SDK/Soroban RPC to simulate, authorize, sign, and submit the same `agent_registry` contract invocations shown above. Transaction construction depends on the network, contract ID, and wallet. Do not send secret keys to a backend. Until a token escrow path exists, these calls only update registry accounting.

---

## 4. Slashing Conditions and Thresholds

The admin can call `slash_bond` to reduce an agent's recorded `bond_amount` by a specified amount. The result is floored at zero. This call does not move XLM.

### How Slashing Works

- The admin calls `slash_bond(agent_id, penalty_stroops)` on the `agent_registry` contract.
- The recorded reduction is capped at the agent's current bond amount (cannot go below zero).
- The contract emits a `(registry, bond_slsh)` event with the penalty and remaining balance.

```bash
# Admin slashes 10% of a 50 XLM bond (5 XLM = 50,000,000 stroops)
stellar contract invoke \
  --id <AGENT_REGISTRY_CONTRACT_ID> \
  --source admin \
  --network testnet \
  -- \
  slash_bond \
  --agent_id agent_research_alpha \
  --penalty_stroops 50000000
```

Event emitted:

```json
{
  "agent_id": "agent_research_alpha",
  "penalty_stroops": 50000000,
  "remaining_stroops": 450000000
}
```

### SLA-Based Penalties

When `check_sla_compliance` detects a violation against configured response-time, uptime, or quality thresholds, it reduces the current recorded amount by 10%. Repeated violations calculate against the remaining amount. The contract does not define a three-violations-in-30-days freeze threshold.

| Violation Type | Code | Contract effect |
|---|---|---|
| Response time exceeded | 0 | 10% of current recorded amount |
| Uptime below threshold | 1 | 10% of current recorded amount |
| Quality score below minimum | 2 | 10% of current recorded amount |

### When Bonds Are Slashed

Bond accounting is reduced in these cases:

1. **SLA violation:** `check_sla_compliance` detects a response-time, uptime, or quality threshold failure.
2. **Administrative action:** The contract admin invokes `slash_bond` with an amount. The contract does not enforce task-failure or fraud thresholds for this call.

### Slashing Thresholds

| Trigger | Penalty | Threshold |
|---|---|---|
| SLA threshold failure | 10% of current recorded amount | Each failing compliance check |
| Admin `slash_bond` call | Requested amount, capped at current recorded amount | Admin authorization; no automatic trigger threshold |

The registration minimum is checked when `register_agent` is called. The contract does not automatically freeze or deregister an agent when a later slash reduces its recorded amount below the minimum.

---

## 5. Bond Withdrawal and Cooldown Period

### The Two-Call Deregistration Process

Registry removal uses a two-call pattern and cooldown record:

1. **First `deregister_agent` call**: Removes the agent from the registry and capability index, then stores a `CooldownRecord` with an expiry ledger.
2. **Cooldown period**: 17,280 ledgers. Wall-clock duration depends on ledger cadence; use the expiry ledger rather than assuming an exact duration.
3. **Second `deregister_agent` call**: After the expiry ledger, the owner calls again. The contract removes the cooldown record and, when the recorded amount is greater than zero, emits `bond_ret`; it does not return XLM.

### Cooldown Error

If the second call is made before the cooldown expires, the contract returns `Error::CooldownNotElapsed` (error code 11):

```
Error::CooldownNotElapsed = 11
```

### Checking Cooldown Status

```bash
# Check agent existence only; this does not expose cooldown progress
stellar contract invoke \
  --id <AGENT_REGISTRY_CONTRACT_ID> \
  --source alice \
  --network testnet \
  -- \
  get_agent_health \
  --agent_id agent_research_alpha
```

`get_agent_health` reports agent existence, frozen state, and error count; it does not expose cooldown progress. After the first call, wait until at least 17,280 ledgers have elapsed, then call `deregister_agent` again. The second successful call emits an event only; it does not withdraw tokens.

### Bond Return Flow

```
register_agent (bond amount recorded)
        │
        ▼
Agent active, accepting tasks
        │
        ▼
deregister_agent (1st call) ──► Agent removed, cooldown starts
        │
        ▼
cooldown (17,280 ledgers)
        │
        ▼
deregister_agent (2nd call) ──► bond_ret event emitted; no token transfer
```

---

## 6. Recommended Bond Sizes

The contract only enforces its global minimum; it does not derive a bond from task volume. The following is a provisional planning heuristic, not a protocol rule or economist-reviewed recommendation. The examples assume declared amounts are backed by collateral, which the current implementation does not do.

### Bond Sizing Formula

```
Illustrative Bond Target = max(Global Minimum, Expected Daily Tasks × Price per Task × Exposure Factor)
```

`Exposure Factor` is an operator-selected scenario assumption, not a value prescribed by ai-net. Select it only after estimating task failure exposure, dispute policy, and expected utilization. A larger recorded amount does not currently signal reputation or provide real collateral.

### Recommended Bond Tiers

| Expected Volume | Example planning range (unreviewed) | Comment |
|---|---|---|---|
| 1–10 tasks/day | At least the current global minimum | Set extra collateral only from measured exposure |
| 10–50 tasks/day | Minimum plus a volume-based exposure allowance | No contract-enforced tier exists |
| 50–100 tasks/day | Model peak concurrent exposure and dispute losses | No contract-enforced tier exists |
| 100+ tasks/day | Obtain protocol/economic review before selecting a target | No reviewed numeric recommendation is available |

### Why Over-Staking Helps

The contract does not rank agents by recorded amount. A larger recorded number only increases the amount SLA/admin logic can reduce; because there is no escrow, it does not create a slashing buffer backed by XLM.

---

## 7. Economics: Revenue vs Staking Cost

### Cost Components

| Cost | Amount | Frequency |
|---|---|---|
| Recorded bond amount | Set in stroops on registration | No XLM lockup in the current contract |
| Transaction fees | Network and transaction dependent | Per contract transaction; verify current fee with the wallet/RPC |
| Opportunity cost | Not calculable from current implementation | Requires actual collateral custody and a defined funding source |

### Revenue Model

```
Gross Monthly Revenue = Completed and paid Tasks × Net Revenue per Task
```

### ROI Calculation

```
ROI = (Net Operating Revenue − Actual Costs and Losses) / Actual Invested Capital × 100%
```

### Example ROI Scenarios

| Scenario | Example recorded amount | Daily tasks | Price/task | Gross monthly revenue before costs |
|---|---|---|---|---|
| Research example | 50 XLM | 20 | 0.5 XLM | 300 XLM |
| Coding example | 200 XLM | 50 | 1.0 XLM | 1,500 XLM |
| Design example | 30 XLM | 10 | 0.3 XLM | 90 XLM |
| Risk example | 75 XLM | 30 | 0.75 XLM | 675 XLM |

These are gross-revenue arithmetic examples only, assuming every task is completed and paid. They are not ROI forecasts: demand, non-payment, operating costs, fees, slashing exposure, and actual invested capital are excluded. The recorded registry amount is not currently invested capital, and no APY assumption is provided because the contract does not lock tokens.

---

## 8. Risk Table

| Action | Consequence | Probability | Mitigation |
|---|---|---|---|
| SLA threshold violation | 10% reduction of current recorded amount per failing check | No protocol probability published; operator-dependent | Monitor configured thresholds and service metrics |
| Admin invokes `slash_bond` | Requested reduction, capped at current recorded amount | Admin-dependent; no probability published | Review admin/governance policy and recognize contract authority |
| Second deregistration call before expiry ledger | `CooldownNotElapsed`; cooldown remains active | Certain if called early | Wait until 17,280 ledgers have elapsed since the first call |
| Minimum bond changes | Future registrations may require a different amount | Admin-dependent; no probability published | Query `get_min_bond` before registration |
| Agent or network downtime | May lead to an SLA violation under configured policy | Operator-dependent; no protocol probability published | Monitor service and test recovery procedures |

---

## 9. Worked Examples

### Example 1: Research Agent — Moderate Volume

An operator models a research agent with 20 expected paid tasks/day at 0.5 XLM per task. This is a planning example, not a protocol recommendation.

**Bond sizing:**

```
Daily Gross Revenue = 20 × 0.5 = 10 XLM
Illustrative Exposure Factor = 4 (operator-selected assumption)
Illustrative Target = max(10 XLM global minimum, 10 × 4) = 40 XLM
```

**Illustrative recorded amount in stroops:** 40 × 10,000,000 = 400,000,000 stroops

**Registration command:**

```bash
stellar contract invoke \
  --id <AGENT_REGISTRY_CONTRACT_ID> \
  --source alice \
  --network testnet \
  -- \
  register_agent \
  --record '{
    "id": "agent_research_001",
    "capability": "research",
    "price_stroops": 5000000,
    "endpoint": "https://my-agent.example.com/api",
    "owner": "GALICE...",
    "metadata": {},
    "bond_amount": 400000000
  }'
```

**Gross revenue arithmetic (not ROI):**

```
Gross Monthly Revenue = 20 × 0.5 × 30 = 300 XLM
Net operating revenue = 300 XLM minus actual operating costs, fees, and losses
ROI cannot be calculated from the registry amount: it is not locked capital.
```

### Example 2: Coding Agent — High Volume, High Risk

An operator models a coding agent with 50 expected paid tasks/day at 1.0 XLM per task. The factor below is an example assumption, not a capability-specific protocol rule.

**Bond sizing:**

```
Daily Gross Revenue = 50 × 1.0 = 50 XLM
Illustrative Exposure Factor = 5 (operator-selected assumption)
Illustrative Target = max(10 XLM global minimum, 50 × 5) = 250 XLM
```

**Illustrative recorded amount in stroops:** 250 × 10,000,000 = 2,500,000,000 stroops

**Registration command:**

```bash
stellar contract invoke \
  --id <AGENT_REGISTRY_CONTRACT_ID> \
  --source bob \
  --network testnet \
  -- \
  register_agent \
  --record '{
    "id": "agent_coding_001",
    "capability": "coding",
    "price_stroops": 10000000,
    "endpoint": "https://my-coder.example.com/api",
    "owner": "GBOB...",
    "metadata": {},
    "bond_amount": 2500000000
  }'
```

**Gross revenue arithmetic (not ROI):**

```
Gross Monthly Revenue = 50 × 1.0 × 30 = 1,500 XLM
Net operating revenue = 1,500 XLM minus actual operating costs, fees, and losses
ROI cannot be calculated from the registry amount: it is not locked capital.
```

### Example 3: Full Lifecycle — Stake, Operate, Slash, Withdraw

1. **Register with 75 XLM bond:**

```bash
stellar contract invoke --id <REGISTRY_ID> --source carol --network testnet -- \
  register_agent --record '{"id":"agent_risk_001","capability":"risk","price_stroops":7500000,"endpoint":"https://risk.example.com","owner":"GCAROL...","metadata":{},"bond_amount":750000000}'
```

2. **Operate for 30 days, incur one SLA violation:**

```bash
# Admin slashes 10% (7.5 XLM = 75,000,000 stroops)
stellar contract invoke --id <REGISTRY_ID> --source admin --network testnet -- \
  slash_bond --agent_id agent_risk_001 --penalty_stroops 75000000
```

3. **Check remaining bond:**

```bash
stellar contract invoke --id <REGISTRY_ID> --source carol --network testnet -- \
  lookup_agents --capability risk
# bond_amount = 675,000,000 (67.5 XLM remaining)
```

4. **Deregister (start cooldown):**

```bash
stellar contract invoke --id <REGISTRY_ID> --source carol --network testnet -- \
  deregister_agent --agent_id agent_risk_001
```

5. **After at least 17,280 ledgers, call again (event only; no XLM withdrawal):**

```bash
stellar contract invoke --id <REGISTRY_ID> --source carol --network testnet -- \
  deregister_agent --agent_id agent_risk_001
# Emits bond_ret for the recorded 67.5 XLM amount; no token transfer occurs.
```

---

## Related Documentation

- [Node Operators Guide](NODE_OPERATORS_GUIDE.md) — Full node setup, deployment, and monitoring.
- [AI-Agent Integration Guide](ai-agent-integration-guide.md) — Agent registration, heartbeats, task execution, and dispute resolution.
- [Payment & Escrow Lifecycle](architecture/payment-escrow-lifecycle.md) — Detailed payment flow architecture.
- [Architecture Specification](architecture/index.md) — System context and component architecture.
