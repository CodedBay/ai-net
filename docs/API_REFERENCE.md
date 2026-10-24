# 🌐 AI-Net REST API Reference

Comprehensive reference for the **AI-Net Decentralized AI Agent Network API**.
Covers authentication, error taxonomy, rate limits, idempotency, versioning,
request/response schemas, and copy-paste `curl` examples for every endpoint.

For API versioning rules, historical changes, deprecations, and migration examples, see the [API Changelog](./API_CHANGELOG.md).

---

## Table of Contents

1. [Overview & Base URLs](#1-overview--base-urls)
2. [Authentication](#2-authentication)
3. [Request Headers](#3-request-headers)
4. [Response Headers](#4-response-headers)
5. [Error Taxonomy & Standard Envelope](#5-error-taxonomy--standard-envelope)
6. [Rate Limiting](#6-rate-limiting)
7. [Idempotency](#7-idempotency)
8. [API Versioning](#8-api-versioning)
9. [Endpoints Reference](#9-endpoints-reference)
   - [9.1 Health & Diagnostics](#91-health--diagnostics)
   - [9.2 Authentication (`/api/auth`)](#92-authentication-apiauth)
   - [9.3 Agent Management (`/api/agents`)](#93-agent-management-apiagents)
   - [9.4 Task Execution (`/api/tasks`)](#94-task-execution-apitasks)
   - [9.5 Network Stats (`/api/stats`)](#95-network-stats-apistats)
   - [9.6 Reconciliation (`/api/reconciliation`)](#96-reconciliation-apireconciliation)
   - [9.7 Admin (`/api/admin`)](#97-admin-apiadmin)
   - [9.8 Metrics (`/metrics`)](#98-metrics-metrics)
   - [9.9 API Versions (`/api/versions`)](#99-api-versions-apiversions)
10. [Common Schemas](#10-common-schemas)

---

## 1. Overview & Base URLs

| Environment | Base URL |
|---|---|
| **Local Development** | `http://localhost:3000` |
| **Stellar Testnet** | `https://api.testnet.ai-net.epta-node.io` |

All endpoints accept and return `application/json` unless otherwise stated.
Timestamps are ISO-8601 UTC strings (`2026-09-30T11:07:12.000Z`).

---

## 2. Authentication

The API uses two complementary authentication mechanisms.

### 2.1 JWT Bearer Token (user sessions)

Issue a session via `POST /api/auth/token`, then pass the returned
`accessToken` as a Bearer token:

```http
Authorization: Bearer <access_token>
```

Access tokens expire; use `POST /api/auth/refresh` to rotate them.

### 2.2 Wallet Public Key Header (task operations)

Task endpoints identify the caller by their Stellar wallet public key supplied
in a request header:

```http
walletpublickey: GBZXN7PIRZGNMHGA728XZVOG2GUFIDLAZ6AF2I2MD2OCYTAF2K1K4AAA
```

### 2.3 Admin API Key

Admin endpoints require an `X-Admin-API-Key` header or a Bearer token whose
subject matches the configured key (`ADMIN_API_KEY`):

```http
X-Admin-API-Key: <admin_api_key>
```

Missing, invalid, or unconfigured admin credentials always return
`403 Forbidden`. The server never reveals whether admin access is enabled.

### 2.4 Unauthenticated Endpoints

Health, stats, agent listing, and metrics endpoints are publicly accessible
without any authentication header.

---

## 3. Request Headers

| Header | Required | Description |
|---|---|---|
| `Content-Type` | Yes (mutations) | Must be `application/json` for all POST/PUT/PATCH requests |
| `Accept` | No | Use `application/json` (default) |
| `Authorization` | Conditional | `Bearer <jwt_token>` for session-authenticated endpoints |
| `walletpublickey` | Conditional | Stellar G-address for task endpoints |
| `X-Admin-API-Key` | Conditional | Admin operations |
| `Idempotency-Key` | Recommended | UUID v4 for safe mutation replay (see §7) |
| `X-Request-Id` | No | Client-supplied correlation ID (echoed back in response) |

---

## 4. Response Headers

| Header | Description |
|---|---|
| `X-Request-Id` | Unique request identifier (UUID). Use for support tickets and log correlation. |
| `X-RateLimit-Limit` | Maximum requests allowed in the current window |
| `X-RateLimit-Remaining` | Requests remaining in the current window |
| `X-RateLimit-Reset` | Unix timestamp when the rate-limit window resets |
| `Retry-After` | Seconds to wait before retrying (present on `429` responses) |
| `Deprecation` | `true` when the called API version is deprecated |
| `Sunset` | ISO-8601 date when the deprecated version will be removed |

---

## 5. Error Taxonomy & Standard Envelope

All error responses use a uniform JSON envelope:

```json
{
  "error": "Human-readable description",
  "code": "MACHINE_READABLE_CODE",
  "correlationId": "f47ac10b-58cc-4372-a567-0e02b2c3d479",
  "details": { }
}
```

| Field | Type | Description |
|---|---|---|
| `error` | `string` | Human-readable error description |
| `code` | `string` | Machine-readable error code (see table below) |
| `correlationId` | `string` | Request ID for log correlation (equals `X-Request-Id`) |
| `details` | `object` | Optional structured details (validation field errors, etc.) |

### 5.1 HTTP Status → Error Code Registry

| HTTP Status | Error Code | Cause | Resolution |
|---|---|---|---|
| `400 Bad Request` | `VALIDATION_ERROR` | Request body or query params fail schema validation | Inspect `details.issues` and correct the request |
| `401 Unauthorized` | `AUTHENTICATION_ERROR` | Missing, expired, or invalid JWT or API key | Re-issue token via `POST /api/auth/token` or supply valid credentials |
| `402 Payment Required` | `PAYMENT_REQUIRED` | Insufficient XLM balance or missing Soroban fee authorization | Fund the Stellar account or sign the payment transaction |
| `403 Forbidden` | `FORBIDDEN` | Authenticated but caller does not own the resource | Verify the `walletpublickey` header matches the resource owner |
| `404 Not Found` | `NOT_FOUND` | Resource does not exist | Verify the ID or address in the path |
| `409 Conflict` | `CONFLICT` | Duplicate idempotency key with a different payload | Reuse the same payload or supply a new `Idempotency-Key` |
| `429 Too Many Requests` | `RATE_LIMIT_EXCEEDED` | Rate limit or daily task quota exceeded | Respect `Retry-After` header before retrying |
| `500 Internal Server Error` | `INTERNAL_ERROR` | Unhandled backend exception | Report the `correlationId` to the support channel |
| `503 Service Unavailable` | `SERVICE_UNAVAILABLE` | Upstream dependency (Venice AI, Stellar Horizon) unreachable | Retry with exponential backoff |

### 5.2 Validation Error Detail

When `code` is `VALIDATION_ERROR`, the `details` object contains field-level issues:

```json
{
  "error": "Invalid request payload",
  "code": "VALIDATION_ERROR",
  "correlationId": "abc-123",
  "details": {
    "issues": [
      { "path": ["prompt"], "message": "Required" },
      { "path": ["maxBudgetXLM"], "message": "Number must be greater than or equal to 0.1" }
    ]
  }
}
```

---

## 6. Rate Limiting

Rate limits are enforced per IP address with separate tiers for public and
authenticated endpoints.

| Endpoint Group | Limit | Window |
|---|---|---|
| Public (health, agents, stats) | 100 req | 15 min |
| Authenticated (tasks) | 60 req | 15 min |
| Agent heartbeat | 1 req | 30 sec per agent |
| Admin | 30 req | 15 min |

When a limit is exceeded the server responds with `429 Too Many Requests` and
includes a `Retry-After` header indicating when the window resets.

Additionally, task creation enforces a **per-wallet daily quota** (default: 100
tasks per 24 h). Exceeding it returns:

```json
{
  "error": "Daily task limit reached (max 100 per 24 hours)",
  "code": "RATE_LIMIT_EXCEEDED"
}
```

---

## 7. Idempotency

Mutating endpoints (`POST /api/tasks`, `POST /api/agents/register`) support the
`Idempotency-Key` header. Supply a client-generated **UUID v4**:

```http
Idempotency-Key: 550e8400-e29b-41d4-a716-446655440000
```

| Scenario | Behaviour |
|---|---|
| First request | Processed normally; response cached for 24 h, scoped to the submitting wallet |
| Same key + same payload within 24 h | Original response replayed (HTTP `200` or `201`), `X-Idempotency-Replay: true` header set |
| Same key + **different payload** within 24 h | `409 Conflict` with code `IDEMPOTENCY_PAYLOAD_MISMATCH` |
| Key present but **not valid UUID v4** | `422 Unprocessable Entity` with code `INVALID_IDEMPOTENCY_KEY` |
| Key absent | No idempotency protection; safe to omit on reads |

Keys expire after **24 hours**. After expiry the same key value may be reused and will be treated as a new first request. Idempotency is scoped to the submitting wallet address — the same UUID supplied by two different wallets creates two independent entries.

---

## 8. API Versioning

The API supports multiple simultaneous versions. The default version is `1.0`
(deprecated). Clients should migrate to `2.0`.

Specify the target version via the `Accept-Version` header:

```http
Accept-Version: 2.0
```

Deprecated versions include `Deprecation: true` and `Sunset: <date>` response
headers. Check `GET /api/versions` for the full lifecycle manifest.

---

## 9. Endpoints Reference

---

### 9.1 Health & Diagnostics

#### `GET /health`

Basic liveness check. Returns process uptime and configured Stellar network.
No authentication required.

**Request**
```bash
curl -s http://localhost:3000/health
```

**Response `200 OK`**
```json
{
  "status": "ok",
  "uptime": 3600,
  "version": "0.1.0",
  "stellarNetwork": "testnet"
}
```

| Field | Type | Description |
|---|---|---|
| `status` | `string` | Always `"ok"` when the process is running |
| `uptime` | `number` | Process uptime in seconds |
| `version` | `string` | Deployed npm package version |
| `stellarNetwork` | `string` | Configured Stellar network (`"testnet"` or `"mainnet"`) |

---

#### `GET /health/live`

Alias for `GET /health`. Kubernetes liveness probe endpoint.

**Request**
```bash
curl -s http://localhost:3000/health/live
```

**Response `200 OK`** — same schema as `GET /health`.

---

#### `GET /health/ready`

Deep readiness probe. Checks SQLite databases (tasks, payments, jobs), Venice AI
reachability, and Stellar Horizon connectivity. Returns `500` when any required
dependency is degraded.

**Request**
```bash
curl -s http://localhost:3000/health/ready
```

**Response `200 OK`** (all checks pass)
```json
{
  "status": "ok",
  "checks": {
    "tasks": "ok",
    "payments": "ok",
    "queue": "ok",
    "venice": "ok",
    "horizon": "ok",
    "websocket": "ok"
  }
}
```

**Response `500 Internal Server Error`** (degraded)
```json
{
  "status": "error",
  "checks": {
    "tasks": "ok",
    "payments": "ok",
    "queue": "ok",
    "venice": "error",
    "horizon": "ok",
    "websocket": "unknown"
  }
}
```

| Check | Values | Description |
|---|---|---|
| `tasks` | `ok` / `error` | Tasks SQLite database connectivity |
| `payments` | `ok` / `error` | Payments SQLite database connectivity |
| `queue` | `ok` / `error` | Job queue SQLite database connectivity |
| `venice` | `ok` / `error` | Venice AI API reachability |
| `horizon` | `ok` / `error` | Stellar Horizon connectivity |
| `websocket` | `ok` / `error` / `unknown` | SSE/WebSocket stream layer status (`unknown` = not attached) |

---

#### `GET /health/deep`

Extended health check that performs live Venice AI and Horizon HTTP probes.
Responds `503` if any upstream is unreachable.

**Request**
```bash
curl -s http://localhost:3000/health/deep
```

**Response `200 OK`**
```json
{
  "status": "ok",
  "services": {
    "venice": "ok",
    "horizon": "ok"
  },
  "venice": "ok",
  "horizon": "ok"
}
```

**Response `503 Service Unavailable`**
```json
{
  "status": "degraded",
  "services": { "venice": "unreachable", "horizon": "ok" },
  "venice": "unreachable",
  "horizon": "ok"
}
```

---

#### `GET /health/dashboard`

Aggregated system metrics dashboard. **Requires admin authentication.**

**Request**
```bash
curl -s http://localhost:3000/health/dashboard \
  -H "X-Admin-API-Key: <admin_key>"
```

**Response `200 OK`** — Returns a rich metrics object including queue depth,
agent counts, task throughput, and WebSocket connection stats. Schema is
implementation-defined and may change between releases.

---

#### `GET /health/traces/:traceId`

Retrieve a distributed trace by its correlation ID.

| Path Parameter | Type | Description |
|---|---|---|
| `traceId` | `string` | Correlation ID (`X-Request-Id` from a previous response) |

**Request**
```bash
curl -s "http://localhost:3000/health/traces/f47ac10b-58cc-4372-a567-0e02b2c3d479"
```

**Response `200 OK`**
```json
{
  "correlationId": "f47ac10b-58cc-4372-a567-0e02b2c3d479",
  "spans": [
    { "name": "POST /api/tasks", "durationMs": 42, "status": "ok" }
  ],
  "startedAt": "2026-09-30T11:00:00.000Z",
  "endedAt": "2026-09-30T11:00:00.042Z",
  "totalDurationMs": 42
}
```

**Response `404 Not Found`**
```json
{ "error": "Trace not found", "traceId": "f47ac10b-..." }
```

---

### 9.2 Authentication (`/api/auth`)

#### `POST /api/auth/token`

Issues a new JWT access token and refresh token for a wallet/device pair.

**Request Body**

| Field | Type | Required | Description |
|---|---|---|---|
| `walletPublicKey` | `string` | Yes | Stellar G-address of the wallet |
| `deviceId` | `string` | Yes | Stable device identifier (UUID recommended) |
| `deviceName` | `string` | No | Human-readable device label |

**Request**
```bash
curl -s -X POST http://localhost:3000/api/auth/token \
  -H "Content-Type: application/json" \
  -d '{
    "walletPublicKey": "GBZXN7PIRZGNMHGA728XZVOG2GUFIDLAZ6AF2I2MD2OCYTAF2K1K4AAA",
    "deviceId": "device-uuid-1234",
    "deviceName": "My Laptop"
  }'
```

**Response `200 OK`**
```json
{
  "accessToken": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
  "refreshToken": "rt_abc123xyz456...",
  "expiresIn": 900,
  "sessionId": "sess_f47ac10b..."
}
```

| Field | Type | Description |
|---|---|---|
| `accessToken` | `string` | JWT access token (15-minute default lifetime) |
| `refreshToken` | `string` | Refresh token for rotation |
| `expiresIn` | `number` | Access token lifetime in seconds |
| `sessionId` | `string` | Session identifier |

**Response `400 Bad Request`**
```json
{
  "error": "Invalid request body",
  "code": "VALIDATION_ERROR",
  "details": { "issues": [{ "path": ["walletPublicKey"], "message": "Required" }] }
}
```

**Rate Limit**: 100 req / 15 min per IP.

---

#### `POST /api/auth/refresh`

Rotates the refresh token and issues a new access/refresh pair.
Replaying an already-consumed refresh token revokes the entire session family
(refresh token rotation security model).

**Request Body**

| Field | Type | Required | Description |
|---|---|---|---|
| `refreshToken` | `string` | Yes | Active refresh token to exchange |

**Request**
```bash
curl -s -X POST http://localhost:3000/api/auth/refresh \
  -H "Content-Type: application/json" \
  -d '{ "refreshToken": "rt_abc123xyz456..." }'
```

**Response `200 OK`** — same schema as `POST /api/auth/token`.

**Response `401 Unauthorized`**
```json
{ "error": "Invalid or expired refresh token", "code": "AUTHENTICATION_ERROR" }
```

---

#### `POST /api/auth/revoke`

Revokes the current session or a specific session by ID.
Requires a valid access token in the `Authorization` header.

**Request Body**

| Field | Type | Required | Description |
|---|---|---|---|
| `sessionId` | `string` | No | Session to revoke; defaults to the caller's current session |
| `reason` | `string` | No | Optional reason for audit log |

**Request**
```bash
curl -s -X POST http://localhost:3000/api/auth/revoke \
  -H "Authorization: Bearer <access_token>" \
  -H "Content-Type: application/json" \
  -d '{ "reason": "logout" }'
```

**Response `200 OK`**
```json
{ "revoked": true, "sessionId": "sess_f47ac10b..." }
```

---

#### `GET /api/auth/sessions`

Lists all active sessions for the authenticated wallet.
Requires a valid access token.

**Request**
```bash
curl -s http://localhost:3000/api/auth/sessions \
  -H "Authorization: Bearer <access_token>"
```

**Response `200 OK`**
```json
{
  "sessions": [
    {
      "sessionId": "sess_f47ac10b...",
      "deviceId": "device-uuid-1234",
      "deviceName": "My Laptop",
      "createdAt": "2026-09-30T10:00:00.000Z",
      "lastUsedAt": "2026-09-30T11:00:00.000Z",
      "ipAddress": "203.0.113.42"
    }
  ]
}
```

---

### 9.3 Agent Management (`/api/agents`)

#### `GET /api/agents`

Lists registered agents. Supports two modes:

- **Legacy mode** (no `cursor`/`limit` params): returns a flat JSON array.
- **Cursor-paginated mode** (with `cursor` or `limit`): returns a paginated envelope.

**Query Parameters**

| Parameter | Type | Default | Description |
|---|---|---|---|
| `cursor` | `string` | — | Opaque pagination cursor from `pagination.nextCursor` |
| `limit` | `number` | `20` | Page size (1–100); triggers cursor mode when present |
| `capability` | `string` | — | Filter by capability tag (e.g. `research`, `coding`) |
| `minReputation` | `number` | — | Filter agents with reputation ≥ this value |
| `maxPriceXLM` | `number` | — | Filter agents with price ≤ this value (in XLM) |
| `status` | `string` | — | `online` or `offline` |

**Request (legacy)**
```bash
curl -s "http://localhost:3000/api/agents?capability=research"
```

**Response `200 OK` (legacy — flat array)**
```json
[
  {
    "id": "agent_research_01",
    "capabilities": ["research"],
    "pricingXLM": 1.5,
    "endpoint": "https://research-agent.ai-net.io/v1/execute",
    "stellarPublicKey": "GBZXN7PIRZGNMHGA728XZVOG2GUFIDLAZ6AF2I2MD2OCYTAF2K1K4AAA",
    "reputationScore": 94.2,
    "status": "online",
    "lastSeenAt": "2026-09-30T11:00:00.000Z"
  }
]
```

**Request (cursor-paginated)**
```bash
curl -s "http://localhost:3000/api/agents?limit=10&capability=coding"
```

**Response `200 OK` (cursor-paginated)**
```json
{
  "data": {
    "items": [
      {
        "id": "agent_coding_01",
        "capabilities": ["coding"],
        "pricingXLM": 2.0,
        "endpoint": "https://coding-agent.ai-net.io/v1/execute",
        "stellarPublicKey": "GCEZWKCA5VLDNRLN3RPRJMRZOX3Z6G5CHCGWKX2ZWXK7GCQB4Q67WLM",
        "reputationScore": 87.5,
        "status": "online",
        "lastSeenAt": "2026-09-30T10:58:00.000Z"
      }
    ],
    "pagination": {
      "limit": 10,
      "nextCursor": "eyJpZCI6ImFnZW50X2NvZGluZ18wMSJ9",
      "hasNextPage": true
    }
  },
  "_links": {
    "self": "/api/agents",
    "next": "/api/agents?cursor=eyJpZCI6ImFnZW50X2NvZGluZ18wMSJ9&limit=10"
  }
}
```

**Agent Object Fields**

| Field | Type | Description |
|---|---|---|
| `id` | `string` | Unique agent identifier |
| `capabilities` | `string[]` | List of capability tags |
| `pricingXLM` | `number` | Service price in XLM |
| `endpoint` | `string` | Agent's HTTP execution endpoint |
| `stellarPublicKey` | `string` | Agent's Stellar G-address |
| `reputationScore` | `number` | Reputation score (0–100) |
| `status` | `string` | `online` or `offline` |
| `lastSeenAt` | `string` | ISO-8601 timestamp of last heartbeat |

**Rate Limit**: 100 req / 15 min per IP. Responses are cached server-side (TTL configurable).

---

#### `GET /api/agents/:id`

Returns the full profile for a single agent by its unique identifier.

**Path Parameters**

| Parameter | Type | Description |
|---|---|---|
| `id` | `string` | Unique agent identifier |

**Request**
```bash
curl -s http://localhost:3000/api/agents/agent_research_01
```

**Response `200 OK`** — same schema as a single item in `GET /api/agents`.

**Response `404 Not Found`**
```json
{ "error": "Agent not found" }
```

---

#### `GET /api/agents/:id/health`

Performs a live HTTP health check against the agent's registered endpoint.
Returns `healthy` or `unreachable` regardless of the agent's reachability
(i.e. this endpoint always returns `200`; the `status` field indicates health).

| Path Parameter | Type | Description |
|---|---|---|
| `id` | `string` | Agent identifier |

**Request**
```bash
curl -s http://localhost:3000/api/agents/agent_research_01/health
```

**Response `200 OK`**
```json
{
  "status": "healthy",
  "latencyMs": 34
}
```

| Field | Type | Description |
|---|---|---|
| `status` | `string` | `healthy` if endpoint responded OK; `unreachable` otherwise |
| `latencyMs` | `number` | Round-trip latency in milliseconds |

**Response `404 Not Found`**
```json
{ "error": "Agent not found" }
```

---

#### `POST /api/agents/register`

Registers a new agent on the network. The agent's Stellar account is verified
against Horizon unless `SKIP_STELLAR_ACCOUNT_VERIFY=true` is set.

**Request Headers**

| Header | Required | Description |
|---|---|---|
| `Content-Type` | Yes | `application/json` |
| `Idempotency-Key` | Recommended | UUID v4 for safe replay |

**Request Body**

| Field | Type | Required | Description |
|---|---|---|---|
| `agentId` | `string` | Yes | Unique agent identifier (non-empty string) |
| `capabilities` | `string[]` | Yes | Non-empty list of capability tags |
| `pricingXLM` | `number` | Yes | Service price in XLM (minimum `0.001`) |
| `endpoint` | `string` | Yes | Full HTTP URL for task execution |
| `stellarPublicKey` | `string` | Yes | Valid Stellar G-address (56-char base32) |

**Request**
```bash
curl -s -X POST http://localhost:3000/api/agents/register \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: 550e8400-e29b-41d4-a716-446655440000" \
  -d '{
    "agentId": "agent_research_01",
    "capabilities": ["research"],
    "pricingXLM": 1.5,
    "endpoint": "https://research-agent.ai-net.io/v1/execute",
    "stellarPublicKey": "GBZXN7PIRZGNMHGA728XZVOG2GUFIDLAZ6AF2I2MD2OCYTAF2K1K4AAA"
  }'
```

**Response `201 Created`**
```json
{
  "id": "agent_research_01",
  "capabilities": ["research"],
  "pricingXLM": 1.5,
  "endpoint": "https://research-agent.ai-net.io/v1/execute",
  "stellarPublicKey": "GBZXN7PIRZGNMHGA728XZVOG2GUFIDLAZ6AF2I2MD2OCYTAF2K1K4AAA",
  "reputationScore": 0,
  "status": "online",
  "lastSeenAt": "2026-09-30T11:07:12.000Z"
}
```

**Response `400 Bad Request`** (validation failure)
```json
{
  "error": "Invalid agent registration data",
  "code": "VALIDATION_ERROR",
  "details": {
    "issues": [
      { "path": ["stellarPublicKey"], "message": "Invalid Stellar public key format" }
    ]
  }
}
```

**Response `400 Bad Request`** (Stellar account not found on network)
```json
{
  "error": "Stellar account not found",
  "code": "StellarAccountNotFound"
}
```

**Response `429 Too Many Requests`**
```json
{ "error": "Too many requests", "code": "RATE_LIMIT_EXCEEDED" }
```

**Rate Limit**: 100 req / 15 min per IP.

---

#### `POST /api/agents/:id/heartbeat`

Updates the agent's `lastSeenAt` timestamp, keeping its `online` status active
in the registry. Must be called regularly (recommended: every 30–60 s).

| Path Parameter | Type | Description |
|---|---|---|
| `id` | `string` | Agent identifier |

**Request**
```bash
curl -s -X POST http://localhost:3000/api/agents/agent_research_01/heartbeat \
  -H "Content-Type: application/json"
```

**Response `200 OK`**
```json
{
  "status": "ok",
  "lastSeenAt": "2026-09-30T11:07:12.000Z"
}
```

**Response `404 Not Found`**
```json
{ "error": "Agent not found" }
```

**Response `429 Too Many Requests`**
```json
{ "error": "Too many requests", "code": "RATE_LIMIT_EXCEEDED" }
```

**Rate Limit**: 1 req / 30 s per agent ID.

---

### 9.4 Task Execution (`/api/tasks`)

Task endpoints identify the caller via the `walletpublickey` request header.
Omitting it results in the task being associated with `"anonymous"` (daily
limits still apply).

#### `POST /api/tasks`

Creates a new task. The server decomposes the natural-language `prompt` into an
execution DAG, persists the task record, and enqueues a background job.

**Request Headers**

| Header | Required | Description |
|---|---|---|
| `Content-Type` | Yes | `application/json` |
| `walletpublickey` | Recommended | Stellar G-address of the task owner |
| `Idempotency-Key` | Recommended | UUID v4 for deduplication |

**Request Body**

| Field | Type | Required | Description |
|---|---|---|---|
| `prompt` | `string` | Yes | Natural-language task description (max 100,000 chars) |
| `walletPublicKey` | `string` | No | Stellar wallet address of the task owner (overrides header) |
| `maxBudgetXLM` | `number` | No | Maximum XLM the task may spend (minimum `0.1` when provided) |
| `agentPreferences` | `string[]` | No | Preferred agent IDs to include in the DAG |
| `priority` | `string` | No | `"low"`, `"normal"` (default), or `"high"` |

**Request**
```bash
curl -s -X POST http://localhost:3000/api/tasks \
  -H "Content-Type: application/json" \
  -H "walletpublickey: GBZXN7PIRZGNMHGA728XZVOG2GUFIDLAZ6AF2I2MD2OCYTAF2K1K4AAA" \
  -H "Idempotency-Key: 550e8400-e29b-41d4-a716-446655440001" \
  -d '{
    "prompt": "Generate a market-entry report for solar energy in Southeast Asia",
    "maxBudgetXLM": 5.0,
    "priority": "normal"
  }'
```

**Response `201 Created`**
```json
{
  "taskId": "task_ab12cd34ef56",
  "status": "queued",
  "dagPreview": [
    {
      "nodeId": "node_research_1",
      "agentType": "research",
      "prompt": "Research solar energy market in Southeast Asia",
      "dependsOn": [],
      "status": "pending"
    },
    {
      "nodeId": "node_risk_1",
      "agentType": "risk",
      "prompt": "Analyze regulatory and financial risks for solar energy in SEA",
      "dependsOn": ["node_research_1"],
      "status": "pending"
    },
    {
      "nodeId": "node_report_1",
      "agentType": "report",
      "prompt": "Compile findings into a market-entry report",
      "dependsOn": ["node_research_1", "node_risk_1"],
      "status": "pending"
    }
  ]
}
```

| Field | Type | Description |
|---|---|---|
| `taskId` | `string` | Unique task identifier |
| `status` | `string` | Initial status — always `"queued"` |
| `dagPreview` | `array` | Decomposed DAG nodes (see DAG node schema below) |

**DAG Node Fields**

| Field | Type | Description |
|---|---|---|
| `nodeId` | `string` | Node identifier within the DAG |
| `agentType` | `string` | Agent capability required for this node |
| `prompt` | `string` | Node-specific prompt passed to the agent |
| `dependsOn` | `string[]` | Node IDs that must complete before this node runs |
| `status` | `string` | Node status: `pending`, `running`, `completed`, `failed` |
| `result` | `object\|null` | Agent output (populated when completed) |
| `error` | `string\|null` | Error message (populated on failure) |

**Response `400 Bad Request`**
```json
{
  "error": "Validation failed",
  "code": "VALIDATION_ERROR",
  "details": { "issues": [{ "path": ["prompt"], "message": "Required" }] }
}
```

**Response `429 Too Many Requests`** (rate limit)
```json
{
  "error": "Too many requests",
  "code": "RATE_LIMIT_EXCEEDED"
}
```

**Response `429 Too Many Requests`** (daily quota)
```json
{
  "error": "Daily task limit reached (max 100 per 24 hours)",
  "code": "RATE_LIMIT_EXCEEDED"
}
```

**Response `500 Internal Server Error`**
```json
{ "error": "Internal server error during task decomposition", "code": "INTERNAL_ERROR" }
```

**Rate Limit**: 60 req / 15 min per IP. Daily quota: 100 tasks per wallet per 24 h.

---

#### `GET /api/tasks`

Lists tasks owned by the wallet identified in the `walletpublickey` header.
Returns a paginated, filterable, sortable result set.

**Request Headers**

| Header | Required | Description |
|---|---|---|
| `walletpublickey` | Yes | Stellar G-address to list tasks for |

**Query Parameters**

| Parameter | Type | Default | Description |
|---|---|---|---|
| `page` | `number` | `1` | Page number (1-indexed) |
| `pageSize` | `number` | `10` | Items per page (1–100) |
| `status` | `string` | — | Filter by status: `queued`, `running`, `completed`, `failed` |
| `sort` | `string` | `createdAt:desc` | Sort order: `createdAt:desc` or `createdAt:asc` |
| `q` | `string` | — | Substring search in prompt text |

**Request**
```bash
curl -s "http://localhost:3000/api/tasks?page=1&pageSize=5&status=completed" \
  -H "walletpublickey: GBZXN7PIRZGNMHGA728XZVOG2GUFIDLAZ6AF2I2MD2OCYTAF2K1K4AAA"
```

**Response `200 OK`**
```json
{
  "tasks": [
    {
      "id": "task_ab12cd34ef56",
      "prompt": "Generate a market-entry report for solar energy in Southeast Asia",
      "walletPublicKey": "GBZXN7PIRZGNMHGA728XZVOG2GUFIDLAZ6AF2I2MD2OCYTAF2K1K4AAA",
      "status": "completed",
      "dagJson": "[{\"nodeId\":\"node_research_1\",\"status\":\"completed\"}]",
      "createdAt": "2026-09-30T11:00:00.000Z",
      "updatedAt": "2026-09-30T11:02:00.000Z"
    }
  ],
  "total": 1,
  "page": 1,
  "pageSize": 5
}
```

| Field | Type | Description |
|---|---|---|
| `tasks` | `array` | Task objects (see fields below) |
| `total` | `number` | Total matching tasks across all pages |
| `page` | `number` | Current page number |
| `pageSize` | `number` | Requested page size |

**Task List Item Fields**

| Field | Type | Description |
|---|---|---|
| `id` | `string` | Unique task ID |
| `prompt` | `string` | Original natural-language prompt |
| `walletPublicKey` | `string` | Owner wallet address |
| `status` | `string` | Current status |
| `dagJson` | `string` | JSON-encoded DAG node array |
| `createdAt` | `string` | ISO-8601 creation timestamp |
| `updatedAt` | `string` | ISO-8601 last-update timestamp |

**Response `400 Bad Request`**
```json
{ "error": "Invalid query parameters", "code": "VALIDATION_ERROR" }
```

---

#### `GET /api/tasks/estimate`

Returns a pre-submission cost estimate for one or more specialist agents. The
endpoint is available on both v1 and v2; v2 wraps the estimate in a `data`
envelope. Agent selections may be sent as a comma-separated `agents` value or
as repeated `agentHints` values.

**Query Parameters**

| Parameter | Type | Required | Description |
|---|---|---|---|
| `agents` | `string` | One of `agents` / `agentHints` | Comma-separated agents: `research`, `risk`, `coding`, `design`, `report` |
| `agentHints` | `string` | One of `agents` / `agentHints` | Repeatable agent selection, e.g. `?agentHints=research&agentHints=report` |

**Request**
```bash
curl -s "http://localhost:3000/api/tasks/estimate?agents=research,coding"
```

**Response `200 OK`**
```json
{
  "currency": "XLM",
  "breakdown": [
    { "agent": "research", "costXLM": 0.5 },
    { "agent": "coding", "costXLM": 0.8 }
  ],
  "subtotalXLM": 1.3,
  "platformFeeXLM": 0.065,
  "platformFeeRate": 0.05,
  "estimatedCostXLM": 1.365
}
```

An empty selection or an unknown agent name returns `400 Bad Request` with an
`INVALID_AGENTS` error code.

---

#### `GET /api/tasks/:id`

Returns full task details including the DAG, per-node results, and execution
status. The caller's `walletpublickey` header must match the task owner.

| Path Parameter | Type | Description |
|---|---|---|
| `id` | `string` | Unique task identifier |

**Request**
```bash
curl -s http://localhost:3000/api/tasks/task_ab12cd34ef56 \
  -H "walletpublickey: GBZXN7PIRZGNMHGA728XZVOG2GUFIDLAZ6AF2I2MD2OCYTAF2K1K4AAA"
```

**Response `200 OK`**
```json
{
  "id": "task_ab12cd34ef56",
  "taskId": "task_ab12cd34ef56",
  "prompt": "Generate a market-entry report for solar energy in Southeast Asia",
  "walletPublicKey": "GBZXN7PIRZGNMHGA728XZVOG2GUFIDLAZ6AF2I2MD2OCYTAF2K1K4AAA",
  "status": "completed",
  "dag": [
    {
      "nodeId": "node_research_1",
      "agentType": "research",
      "prompt": "Research solar energy market in SEA",
      "dependsOn": [],
      "status": "completed",
      "result": { "summary": "Market size $4.2B; CAGR 18%" },
      "error": null
    },
    {
      "nodeId": "node_report_1",
      "agentType": "report",
      "prompt": "Compile market-entry report",
      "dependsOn": ["node_research_1"],
      "status": "completed",
      "result": { "reportUrl": "https://reports.ai-net.io/task_ab12cd34ef56.pdf" },
      "error": null
    }
  ],
  "createdAt": "2026-09-30T11:00:00.000Z",
  "updatedAt": "2026-09-30T11:02:00.000Z"
}
```

**Response `403 Forbidden`**
```json
{ "error": "Access denied" }
```

**Response `404 Not Found`**
```json
{ "error": "Task not found" }
```

---

#### `GET /api/tasks/:id/stream`

Subscribes to real-time Server-Sent Events for a task's execution progress.
The connection remains open until the task reaches a terminal state
(`completed` or `failed`) or the client disconnects.

| Path Parameter | Type | Description |
|---|---|---|
| `id` | `string` | Task identifier to stream |

**Request**
```bash
curl -N -H "Accept: text/event-stream" \
  "http://localhost:3000/api/tasks/task_ab12cd34ef56/stream"
```

**Stream Response (`200 OK`, `text/event-stream`)**
```
event: progress
data: {"nodeId":"node_research_1","agentType":"research","status":"running","percentage":25}

event: progress
data: {"nodeId":"node_research_1","agentType":"research","status":"completed","percentage":50}

event: progress
data: {"nodeId":"node_report_1","agentType":"report","status":"running","percentage":75}

event: completed
data: {"taskId":"task_ab12cd34ef56","status":"completed","percentage":100}
```

**Event Types**

| Event | Description |
|---|---|
| `progress` | A DAG node changed status. `percentage` is approximate. |
| `completed` | Task finished successfully. |
| `failed` | Task ended with failure. Includes `error` field. |
| `heartbeat` | Keep-alive ping (no data payload) |

**Response `404 Not Found`** (if task does not exist, before SSE stream opens)
```json
{ "error": "Task not found" }
```

---

#### `WS /ws` (agent-status stream)

Upgrades to a WebSocket connection that broadcasts agent health changes in
real time. The connection is read-only and requires no authentication.

**Request**
```bash
websocat "ws://localhost:3001/ws"
```

**Server messages** share the standard envelope
(`{ event, payload, timestamp, correlationId? }`):

| Event | Description |
|---|---|
| `agents:snapshot` | Sent immediately on connect with `{ agents: [{ id, capabilities, status, lastSeenAt }] }` so the client can hydrate without a REST call. |
| `agent:status` | An agent's health changed. Payload: `{ agentId, name, capability, oldStatus, newStatus, lastHeartbeat }`. |
| `{"type":"ping"}` | Heartbeat every 30 s. Clients reply with `{"type":"pong"}` or the connection is closed after `WS_PONG_TIMEOUT_MS`. |

Concurrent connections are capped per client IP
(`WS_MAX_CONNECTIONS_PER_CLIENT`, default 5); excess upgrades are rejected
with HTTP `429`.

---

### 9.5 Network Stats (`/api/stats`)

#### `GET /api/stats`

Returns aggregated network performance metrics. Results are cached server-side
with a 60-second TTL.

No authentication required.

**Request**
```bash
curl -s http://localhost:3000/api/stats
```

**Response `200 OK`**
```json
{
  "totalAgents": 12,
  "totalTasks": 348,
  "uptimePercent": 99.98,
  "totalXLMTransacted": 1250.75,
  "tasksLast24h": [
    { "timestamp": "2026-09-30T10:00:00.000Z", "value": 45 },
    { "timestamp": "2026-09-30T11:00:00.000Z", "value": 52 }
  ],
  "xlmLast24h": [
    { "timestamp": "2026-09-30T10:00:00.000Z", "value": 120.5 },
    { "timestamp": "2026-09-30T11:00:00.000Z", "value": 135.0 }
  ]
}
```

| Field | Type | Description |
|---|---|---|
| `totalAgents` | `number` | Total registered agents |
| `totalTasks` | `number` | Total tasks completed |
| `uptimePercent` | `number` | Network uptime percentage (0–100) |
| `totalXLMTransacted` | `number` | Total XLM transacted through the network |
| `tasksLast24h` | `array` | Hourly task count time series for the last 24 h |
| `xlmLast24h` | `array` | Hourly XLM volume time series for the last 24 h |

**Response `500 Internal Server Error`**
```json
{ "error": "Unable to load stats", "code": "STATS_LOAD_ERROR" }
```

**Rate Limit**: 100 req / 15 min per IP.

---

### 9.6 Reconciliation (`/api/reconciliation`)

#### `POST /api/reconciliation/run`

Triggers a payment reconciliation check, comparing local payment records
against on-chain Soroban state and Horizon transactions.

**Request Body**

| Field | Type | Default | Description |
|---|---|---|---|
| `triggeredBy` | `string` | `"manual"` | Trigger source: `"manual"`, `"scheduled"`, or `"release"` |

**Request**
```bash
curl -s -X POST http://localhost:3000/api/reconciliation/run \
  -H "Content-Type: application/json" \
  -d '{ "triggeredBy": "manual" }'
```

**Response `200 OK`**
```json
{
  "id": "recon_20260930_110712",
  "triggeredBy": "manual",
  "startedAt": "2026-09-30T11:07:12.000Z",
  "completedAt": "2026-09-30T11:07:15.000Z",
  "durationMs": 3120,
  "summary": {
    "totalChecked": 128,
    "discrepancies": 0,
    "resolved": 0,
    "errors": 0
  }
}
```

| Field | Type | Description |
|---|---|---|
| `id` | `string` | Reconciliation run identifier |
| `triggeredBy` | `string` | How the run was initiated |
| `startedAt` | `string` | ISO-8601 start timestamp |
| `completedAt` | `string` | ISO-8601 completion timestamp |
| `durationMs` | `number` | Total run duration in milliseconds |
| `summary.totalChecked` | `number` | Payment records checked |
| `summary.discrepancies` | `number` | Mismatches found |
| `summary.resolved` | `number` | Automatically resolved discrepancies |
| `summary.errors` | `number` | Errors during the run |

**Response `500 Internal Server Error`**
```json
{ "error": "Reconciliation run failed", "code": "INTERNAL_ERROR" }
```

---

#### `GET /api/reconciliation/report`

Returns the latest completed reconciliation report.

**Request**
```bash
curl -s http://localhost:3000/api/reconciliation/report
```

**Response `200 OK`** — same schema as `POST /api/reconciliation/run`.

**Response `404 Not Found`**
```json
{ "error": "Reconciliation Report not found" }
```

---

### 9.7 Admin (`/api/admin`)

All admin endpoints require `X-Admin-API-Key` or
`Authorization: Bearer <admin_key>` unless otherwise noted. Missing, invalid,
or unconfigured keys return `403 Forbidden`.

---

#### `GET /api/admin/stats`

Platform-wide metrics used by the admin console.

**Request**
```bash
curl -s http://localhost:3000/api/admin/stats \
  -H "X-Admin-API-Key: <admin_key>"
```

**Response `200 OK`**
```json
{
  "generatedAt": "2026-10-20T12:00:00.000Z",
  "agents": { "total": 12, "online": 9, "offline": 3, "banned": 1 },
  "tasks": {
    "total": 348,
    "queued": 4,
    "running": 2,
    "completed": 320,
    "failed": 12,
    "cancelled": 10,
    "last24h": 45
  },
  "xlm": { "released": 1250.75, "locked": 25.5, "total": 1276.25 }
}
```

**Response `403 Forbidden`**
```json
{ "error": "Forbidden" }
```

---

#### `GET /api/admin/tasks`

Lists every task on the platform, newest first, with filters and pagination.

| Parameter | Type | Description |
|---|---|---|
| `status` | `string` | `queued`, `running`, `completed`, `failed`, or `cancelled` |
| `wallet` | `string` | Filter by `walletPublicKey` (alias: `walletAddress`) |
| `from` | ISO-8601 | Only tasks created at or after this timestamp |
| `to` | ISO-8601 | Only tasks created at or before this timestamp |
| `limit` | `integer` | Page size, 1–100 (default `20`) |
| `offset` | `integer` | Rows to skip (default `0`) |

**Request**
```bash
curl -s "http://localhost:3000/api/admin/tasks?status=failed&limit=25" \
  -H "X-Admin-API-Key: <admin_key>"
```

**Response `200 OK`**
```json
{
  "tasks": [
    {
      "id": "task_ab12cd34ef56",
      "prompt": "Research the XLM market",
      "walletPublicKey": "G...",
      "status": "failed",
      "createdAt": "2026-10-20T10:00:00.000Z",
      "updatedAt": "2026-10-20T10:01:00.000Z"
    }
  ],
  "total": 1,
  "limit": 25,
  "offset": 0
}
```

**Response `400 Bad Request`**
```json
{ "error": "INVALID_QUERY", "details": { "fieldErrors": { "status": ["..."] } } }
```

---

#### `DELETE /api/admin/tasks/:id`

Force-cancels any task regardless of wallet ownership. Cancels the queued job
and refunds locked payments where possible.

**Request**
```bash
curl -s -X DELETE http://localhost:3000/api/admin/tasks/task_ab12cd34ef56 \
  -H "X-Admin-API-Key: <admin_key>"
```

**Response `200 OK`**
```json
{
  "taskId": "task_ab12cd34ef56",
  "status": "cancelled",
  "refundTxHashes": ["a1b2c3..."],
  "task": { /* full task object */ }
}
```

**Response `409 Conflict`** — task already completed, failed, or cancelled.
**Response `404 Not Found`** — unknown task id.

---

#### `POST /api/admin/agents/:id/ban`

Bans an agent and marks it offline. Banned agents are excluded from all new
task assignments (including dispatch fallbacks) until unbanned.

**Request**
```bash
curl -s -X POST http://localhost:3000/api/admin/agents/agent_research_01/ban \
  -H "X-Admin-API-Key: <admin_key>" \
  -H "Content-Type: application/json" \
  -d '{ "reason": "Repeated invalid outputs" }'
```

The body is optional; when supplied, `reason` is limited to 500 characters.

**Response `200 OK`**
```json
{ "banned": true, "agent": { "id": "agent_research_01", "status": "offline", "bannedAt": "..." } }
```

**Response `404 Not Found`**
```json
{ "error": "AGENT_NOT_FOUND" }
```

#### `POST /api/admin/agents/:id/unban`

Lifts a ban (idempotent). The agent stays offline until its next heartbeat.

**Response `200 OK`**
```json
{ "banned": false, "agent": { "id": "agent_research_01", "bannedAt": null } }
```

---

#### `GET /api/admin/logs`

Returns the most recent `error`/`fatal` log entries from the in-memory ring
buffer (max 200), newest first.

| Parameter | Type | Description |
|---|---|---|
| `limit` | `integer` | 1–500 entries (default `100`) |
| `level` | `string` | Optional filter: `error` or `fatal` |

**Request**
```bash
curl -s "http://localhost:3000/api/admin/logs?limit=50&level=error" \
  -H "X-Admin-API-Key: <admin_key>"
```

**Response `200 OK`**
```json
{
  "entries": [
    {
      "level": "error",
      "message": "admin operation failed",
      "timestamp": "2026-10-20T12:00:00.000Z",
      "requestId": "req_123",
      "traceId": "trace_abc",
      "error": { "name": "Error", "message": "boom", "stack": "Error: boom..." }
    }
  ],
  "total": 1
}
```

---

#### `GET /api/admin/read-only`

Returns the current read-only mode state.

**Request**
```bash
curl -s http://localhost:3000/api/admin/read-only \
  -H "X-Admin-API-Key: <admin_key>"
```

**Response `200 OK`**
```json
{
  "enabled": false,
  "reason": null,
  "enabledAt": null,
  "enabledBy": null
}
```

---

#### `PUT /api/admin/read-only`

Enables or disables read-only mode globally. In read-only mode all mutation
endpoints return `503 Service Unavailable`.

**Request Body**

| Field | Type | Required | Description |
|---|---|---|---|
| `enabled` | `boolean` | Yes | `true` to enable read-only, `false` to disable |
| `reason` | `string` | No | Optional reason for the audit log (max 500 chars) |

**Request**
```bash
curl -s -X PUT http://localhost:3000/api/admin/read-only \
  -H "X-Admin-API-Key: <admin_key>" \
  -H "Content-Type: application/json" \
  -d '{ "enabled": true, "reason": "Scheduled maintenance" }'
```

**Response `200 OK`** — same schema as `GET /api/admin/read-only`.

---

#### `GET /api/admin/agents`

Lists all agents visible to the admin, with optional status filter.

**Query Parameters**

| Parameter | Type | Description |
|---|---|---|
| `status` | `string` | Filter by `online` or `offline` |

**Request**
```bash
curl -s "http://localhost:3000/api/admin/agents" \
  -H "X-Admin-API-Key: <admin_key>"
```

**Response `200 OK`**
```json
{ "agents": [ /* array of agent objects */ ] }
```

---

#### `POST /api/admin/agents/:id/enable`

Re-enables a previously disabled agent.

| Path Parameter | Type | Description |
|---|---|---|
| `id` | `string` | Agent identifier |

**Request**
```bash
curl -s -X POST http://localhost:3000/api/admin/agents/agent_research_01/enable \
  -H "X-Admin-API-Key: <admin_key>"
```

**Response `200 OK`**
```json
{ "enabled": true, "agent": { /* agent object */ } }
```

**Response `404 Not Found`**
```json
{ "error": "AGENT_NOT_FOUND" }
```

---

#### `POST /api/admin/agents/:id/disable`

Disables an agent, preventing it from receiving tasks.

| Path Parameter | Type | Description |
|---|---|---|
| `id` | `string` | Agent identifier |

**Request**
```bash
curl -s -X POST http://localhost:3000/api/admin/agents/agent_research_01/disable \
  -H "X-Admin-API-Key: <admin_key>"
```

**Response `200 OK`**
```json
{ "enabled": false, "agent": { /* agent object */ } }
```

---

#### `POST /api/admin/reconciliation/run`

Admin-privileged reconciliation trigger. Accepts the same body as
`POST /api/reconciliation/run` and returns the same report schema.

**Request**
```bash
curl -s -X POST http://localhost:3000/api/admin/reconciliation/run \
  -H "X-Admin-API-Key: <admin_key>" \
  -H "Content-Type: application/json" \
  -d '{ "triggeredBy": "manual" }'
```

---

#### `POST /api/admin/maintenance/vacuum`

Runs SQLite `VACUUM` on all databases to reclaim storage space.

**Request**
```bash
curl -s -X POST http://localhost:3000/api/admin/maintenance/vacuum \
  -H "X-Admin-API-Key: <admin_key>"
```

**Response `200 OK`**
```json
{
  "results": [
    { "db": "payments", "status": "ok" },
    { "db": "agents", "status": "ok" },
    { "db": "tasks", "status": "ok" }
  ]
}
```

---

#### `POST /api/admin/maintenance/backup`

Backs up all SQLite databases to a specified directory.

**Request Body**

| Field | Type | Required | Description |
|---|---|---|---|
| `directory` | `string` | No | Target backup directory path |

**Request**
```bash
curl -s -X POST http://localhost:3000/api/admin/maintenance/backup \
  -H "X-Admin-API-Key: <admin_key>" \
  -H "Content-Type: application/json" \
  -d '{ "directory": "/backups/2026-09-30" }'
```

**Response `200 OK`**
```json
{
  "results": [
    { "db": "payments", "path": "/backups/2026-09-30/payments.db", "status": "ok" },
    { "db": "agents", "path": "/backups/2026-09-30/agents.db", "status": "ok" },
    { "db": "tasks", "path": "/backups/2026-09-30/tasks.db", "status": "ok" }
  ]
}
```

---

#### `GET /api/admin/audit-log`

Returns the admin operation audit log with pagination and optional CSV export.

**Query Parameters**

| Parameter | Type | Default | Description |
|---|---|---|---|
| `limit` | `number` | `200` | Maximum entries to return (1–1000) |
| `offset` | `number` | `0` | Entries to skip (for pagination) |
| `format` | `string` | `json` | `json` or `csv` |

**Request**
```bash
curl -s "http://localhost:3000/api/admin/audit-log?limit=50&offset=0" \
  -H "X-Admin-API-Key: <admin_key>"
```

**Response `200 OK` (`json`)**
```json
{
  "entries": [
    {
      "at": "2026-09-30T11:07:12.000Z",
      "actor": "admin",
      "action": "PUT /api/admin/read-only",
      "target": null,
      "statusCode": 200,
      "requestId": "req_abc123"
    }
  ]
}
```

**Response `200 OK` (`csv`)**

Returns `text/csv; charset=utf-8` with columns: `at`, `actor`, `action`,
`target`, `statusCode`, `requestId`.

---

#### `GET /api/admin/traces/:id`

Retrieves a distributed trace by trace ID or request ID. Both identifiers
are accepted — request IDs are resolved to their correlation trace.

| Path Parameter | Type | Description |
|---|---|---|
| `id` | `string` | `traceId` (correlation ID) or `requestId` |

**Request**
```bash
curl -s "http://localhost:3000/api/admin/traces/f47ac10b-58cc-4372-a567-0e02b2c3d479" \
  -H "X-Admin-API-Key: <admin_key>"
```

**Response `200 OK`**
```json
{
  "correlationId": "f47ac10b-58cc-4372-a567-0e02b2c3d479",
  "requestedId": "f47ac10b-58cc-4372-a567-0e02b2c3d479",
  "spans": [ { "name": "POST /api/tasks", "durationMs": 42 } ],
  "startedAt": "2026-09-30T11:07:12.000Z",
  "endedAt": "2026-09-30T11:07:12.042Z",
  "totalDurationMs": 42
}
```

**Response `404 Not Found`**
```json
{ "error": "Trace not found", "id": "f47ac10b-..." }
```

**Response `503 Service Unavailable`**
```json
{ "error": "ADMIN_API_KEY is not configured" }
```

---

#### `GET /api/admin/queue/status`

Returns background job queue metrics and worker status.

**Request**
```bash
curl -s http://localhost:3000/api/admin/queue/status \
  -H "X-Admin-API-Key: <admin_key>"
```

**Response `200 OK`**
```json
{
  "status": "healthy",
  "stats": {
    "queued": 2,
    "active": 1,
    "completed": 140,
    "failed": 1,
    "deadLetter": 0
  },
  "worker": {
    "running": true,
    "activeWorkers": 1,
    "concurrency": 5,
    "pollIntervalMs": 1000
  },
  "activeJobs": [],
  "deadLetterJobs": []
}
```

| Field | Type | Description |
|---|---|---|
| `status` | `string` | `"healthy"` or `"degraded"` |
| `stats.queued` | `number` | Jobs waiting to run |
| `stats.active` | `number` | Jobs currently executing |
| `stats.completed` | `number` | Total jobs completed |
| `stats.failed` | `number` | Total jobs failed (before DLQ) |
| `stats.deadLetter` | `number` | Jobs in the dead-letter queue |
| `worker.running` | `boolean` | Whether the background worker is active |
| `worker.concurrency` | `number` | Maximum simultaneous workers |

---

#### `GET /api/admin/flags`

Lists all feature flags with their current state and source.

**Request**
```bash
curl -s http://localhost:3000/api/admin/flags \
  -H "X-Admin-API-Key: <admin_key>"
```

**Response `200 OK`**
```json
{
  "flags": {
    "ENABLE_STREAMING": { "enabled": true, "source": "env" },
    "ENABLE_RATE_LIMIT": { "enabled": true, "source": "default" }
  }
}
```

---

#### `PUT /api/admin/flags/:flag`

Sets a runtime override for a feature flag.

| Path Parameter | Type | Description |
|---|---|---|
| `flag` | `string` | Feature flag name |

**Request Body**

| Field | Type | Required | Description |
|---|---|---|---|
| `enabled` | `boolean` | Yes | New flag value |

**Request**
```bash
curl -s -X PUT http://localhost:3000/api/admin/flags/ENABLE_STREAMING \
  -H "X-Admin-API-Key: <admin_key>" \
  -H "Content-Type: application/json" \
  -d '{ "enabled": false }'
```

**Response `200 OK`**
```json
{ "flag": "ENABLE_STREAMING", "enabled": false, "source": "runtime" }
```

**Response `404 Not Found`**
```json
{ "error": "Feature flag 'UNKNOWN_FLAG' not found" }
```

---

#### `DELETE /api/admin/flags/:flag`

Clears the runtime override for a flag, restoring the env/default value.

**Request**
```bash
curl -s -X DELETE http://localhost:3000/api/admin/flags/ENABLE_STREAMING \
  -H "X-Admin-API-Key: <admin_key>"
```

**Response `200 OK`**
```json
{ "flag": "ENABLE_STREAMING", "enabled": true, "source": "env" }
```

---

### 9.8 Metrics (`/metrics`)

#### `GET /metrics`

Exposes Prometheus-compatible metrics in text exposition format.
Also accessible at `GET /api/metrics`.

No authentication required (restrict at network/ingress level in production).

**Request**
```bash
curl -s http://localhost:3000/metrics
```

**Response `200 OK` (`text/plain; version=0.0.4`)**
```
# HELP http_requests_total Total number of HTTP requests
# TYPE http_requests_total counter
http_requests_total{method="GET",route="/api/agents",status="200"} 1420

# HELP http_request_duration_seconds HTTP request latency histogram
# TYPE http_request_duration_seconds histogram
http_request_duration_seconds_bucket{le="0.05"} 1200
...
```

---

### 9.9 API Versions (`/api/versions`)

#### `GET /api/versions`

Returns the API versioning lifecycle manifest: all supported versions,
deprecation status, sunset dates, and breaking-change summaries.
Use this endpoint to detect when a version you depend on is nearing sunset.

No authentication required.

**Request**
```bash
curl -s http://localhost:3000/api/versions
```

**Response `200 OK`**
```json
{
  "latestVersion": "2.0",
  "defaultVersion": "1.0",
  "policy": {
    "deprecationNoticeMonths": 6,
    "sunsetGracePeriodMonths": 12,
    "policyUrl": "/docs#api-versioning"
  },
  "versions": [
    {
      "version": "1.0",
      "status": "deprecated",
      "deprecatedAt": "2026-01-01",
      "sunsetAt": "2027-01-01",
      "breakingChanges": [],
      "migratesTo": "2.0"
    },
    {
      "version": "1.1",
      "status": "deprecated",
      "deprecatedAt": "2026-06-01",
      "sunsetAt": "2027-01-01",
      "breakingChanges": [
        "Task response envelope changed: `result` moved to `data.result`."
      ],
      "migratesTo": "2.0"
    },
    {
      "version": "2.0",
      "status": "current",
      "breakingChanges": [
        "Error responses now include a machine-readable `code` field.",
        "Paginated list endpoints return `{ data, pagination }` instead of a bare array.",
        "Agent registration requires `capabilities` array (was optional in v1)."
      ]
    }
  ]
}
```

---

## 10. Common Schemas

### Task Status Values

| Value | Description |
|---|---|
| `queued` | Task accepted and waiting for a worker |
| `running` | At least one DAG node is currently executing |
| `completed` | All DAG nodes finished successfully |
| `failed` | One or more nodes failed; execution stopped |

### Agent Status Values

| Value | Description |
|---|---|
| `online` | Agent is active (recent heartbeat received) |
| `offline` | No heartbeat received within the configured timeout |

### Capability Tags

| Tag | Description |
|---|---|
| `research` | Web research and data gathering |
| `risk` | Risk analysis and regulatory review |
| `coding` | Code generation and smart contract development |
| `design` | UI/UX and visual design tasks |
| `report` | Report compilation and document generation |

### Stellar Address Format

All `stellarPublicKey` and `walletPublicKey` fields must be valid Stellar
G-addresses: a 56-character base32 string beginning with `G`.

```
GBZXN7PIRZGNMHGA728XZVOG2GUFIDLAZ6AF2I2MD2OCYTAF2K1K4AAA
```

### Pagination (cursor-based)

Cursor-paginated responses include:

```json
{
  "data": {
    "items": [ /* results */ ],
    "pagination": {
      "limit": 10,
      "nextCursor": "eyJpZCI6ImFnZW50XzAxIn0=",
      "hasNextPage": true
    }
  },
  "_links": {
    "self": "/api/agents",
    "next": "/api/agents?cursor=eyJpZCI6ImFnZW50XzAxIn0=&limit=10"
  }
}
```

Pass `nextCursor` as the `cursor` query parameter to fetch the next page.
When `hasNextPage` is `false` or `nextCursor` is `null`, you have reached the
last page.
