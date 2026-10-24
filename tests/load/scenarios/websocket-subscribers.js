/**
 * tests/load/scenarios/websocket-subscribers.js
 *
 * k6 WebSocket stress test for the ai-net real-time task streaming endpoint.
 *
 * Scenarios covered:
 *  1. sustained_load   — 500 concurrent WebSocket connections for 5 minutes
 *  2. message_ordering — sequence-number verification under concurrent updates
 *  3. reconnection     — clients reconnect within 10 s after server restart
 *  4. heartbeat        — keep-alive ping/pong verified every 15 s
 *
 * Acceptance thresholds (mirrors issue #460):
 *  - Connection success rate > 99.9%
 *  - Message latency p95 < 100 ms
 *  - Message ordering errors = 0
 *  - Reconnection within 10 s: 100% success
 *  - Heartbeat success rate > 99%
 *
 * Run all scenarios:
 *   k6 run tests/load/scenarios/websocket-subscribers.js
 *
 * Run a single scenario:
 *   k6 run -e SCENARIO=heartbeat tests/load/scenarios/websocket-subscribers.js
 *
 * Override target URL:
 *   k6 run -e WS_URL=ws://staging.ai-net.example/ws/tasks \
 *           tests/load/scenarios/websocket-subscribers.js
 */

import { check, sleep } from "k6";
import ws from "k6/ws";
import { Counter, Gauge, Rate, Trend } from "k6/metrics";
import { randomIntBetween } from "https://jslib.k6.io/k6-utils/1.4.0/index.js";

// ── Custom metrics ─────────────────────────────────────────────────────────────

const wsConnectSuccess    = new Rate("ws_connect_success");
const wsConnectFail       = new Counter("ws_connect_fail");
const wsMessageLatency    = new Trend("ws_message_latency_ms", true);
const wsMessagesReceived  = new Counter("ws_messages_received");
const wsOrderingErrors    = new Counter("ws_ordering_errors");
const wsReconnectSuccess  = new Rate("ws_reconnect_success");
const wsReconnectLatency  = new Trend("ws_reconnect_latency_ms", true);
const wsActiveSessions    = new Gauge("ws_active_sessions");
const wsHeartbeatSuccess  = new Rate("ws_heartbeat_success");

// ── Configuration ──────────────────────────────────────────────────────────────

const WS_URL             = __ENV.WS_URL             || "ws://localhost:3000/ws/tasks";
const HEARTBEAT_INTERVAL = parseInt(__ENV.HEARTBEAT_INTERVAL || "15"); // seconds
const MAX_RECONNECT_WAIT = parseInt(__ENV.MAX_RECONNECT_WAIT || "10"); // seconds

// ── Scenario options ───────────────────────────────────────────────────────────

export const options = {
  scenarios: {
    // Scenario 1: 500 concurrent connections held for 5 minutes
    sustained_load: {
      executor: "constant-vus",
      vus: 500,
      duration: "5m",
      tags: { scenario: "sustained_load" },
      env: { SCENARIO: "sustained_load" },
    },

    // Scenario 2: Message ordering verification under concurrent updates
    message_ordering: {
      executor: "constant-vus",
      vus: 50,
      duration: "2m",
      startTime: "30s",
      tags: { scenario: "message_ordering" },
      env: { SCENARIO: "message_ordering" },
    },

    // Scenario 3: Reconnection after simulated server drop
    reconnection: {
      executor: "constant-vus",
      vus: 20,
      duration: "90s",
      startTime: "5m30s",
      tags: { scenario: "reconnection" },
      env: { SCENARIO: "reconnection" },
    },

    // Scenario 4: Heartbeat keep-alive (ping/pong every 15 s)
    heartbeat: {
      executor: "constant-vus",
      vus: 10,
      duration: "3m",
      startTime: "15s",
      tags: { scenario: "heartbeat" },
      env: { SCENARIO: "heartbeat" },
    },
  },

  thresholds: {
    // Connection success rate must exceed 99.9%
    ws_connect_success:    ["rate>0.999"],
    // p95 message latency must be under 100 ms
    ws_message_latency_ms: ["p(95)<100"],
    // Zero message ordering violations allowed
    ws_ordering_errors:    ["count==0"],
    // Reconnection success rate must be 100%
    ws_reconnect_success:  ["rate==1"],
    // Heartbeat success rate must exceed 99%
    ws_heartbeat_success:  ["rate>0.99"],
  },
};

// ── Helpers ────────────────────────────────────────────────────────────────────

function buildWsUrl(taskId) {
  return `${WS_URL}?task=${taskId}&token=test-token-${taskId}`;
}

function taskId() {
  return `task-${__VU}-${Date.now()}`;
}

/**
 * Parse the sequence number from a task-update JSON message.
 * Expected format: { "type": "task_update", "seq": 42, ... }
 * Returns -1 when the message is not a sequenced update.
 */
function parseSeq(raw) {
  try {
    const msg = JSON.parse(raw);
    if (msg && typeof msg.seq === "number") return msg.seq;
  } catch (_) {}
  return -1;
}

// ── Scenario 1: Sustained load ─────────────────────────────────────────────────

function runSustainedLoad() {
  const url   = buildWsUrl(taskId());
  const start = Date.now();

  const res = ws.connect(url, {}, function (socket) {
    wsActiveSessions.add(1);
    wsConnectSuccess.add(true);

    socket.on("open", () => {
      socket.send(JSON.stringify({ type: "subscribe", filter: "all" }));
    });

    socket.on("message", () => {
      wsMessageLatency.add(Date.now() - start);
      wsMessagesReceived.add(1);
    });

    socket.on("error", () => {
      wsConnectFail.add(1);
      wsConnectSuccess.add(false);
    });

    socket.on("close", () => wsActiveSessions.add(-1));

    // Hold each connection for a realistic subscriber lifetime
    socket.setTimeout(() => socket.close(), randomIntBetween(15000, 45000));
  });

  if (!res || res.status !== 101) {
    wsConnectSuccess.add(false);
    wsConnectFail.add(1);
  }

  check(res, {
    "WS handshake 101": (r) => r && r.status === 101,
  });
}

// ── Scenario 2: Message ordering ───────────────────────────────────────────────

function runMessageOrdering() {
  const url    = buildWsUrl(taskId());
  const start  = Date.now();
  let lastSeq  = -1;

  const res = ws.connect(url, {}, function (socket) {
    wsConnectSuccess.add(true);
    wsActiveSessions.add(1);

    socket.on("open", () => {
      socket.send(JSON.stringify({ type: "subscribe", filter: "all" }));
    });

    socket.on("message", (data) => {
      wsMessageLatency.add(Date.now() - start);
      wsMessagesReceived.add(1);

      const seq = parseSeq(data);
      if (seq >= 0) {
        if (lastSeq >= 0 && seq !== lastSeq + 1) {
          wsOrderingErrors.add(1);
        }
        lastSeq = seq;
      }
    });

    socket.on("error", () => {
      wsConnectSuccess.add(false);
      wsConnectFail.add(1);
    });

    socket.on("close", () => wsActiveSessions.add(-1));
    socket.setTimeout(() => socket.close(), 60000);
  });

  check(res, {
    "ordering: connection OK":       (r) => r && r.status === 101,
    "ordering: no sequence gaps":    () => wsOrderingErrors.value === 0,
  });
}

// ── Scenario 3: Reconnection ────────────────────────────────────────────────────

function runReconnection() {
  const id  = taskId();
  const url = buildWsUrl(id);

  // First connection — drop it after 5 s to simulate an outage
  ws.connect(url, {}, function (socket) {
    wsConnectSuccess.add(true);
    wsActiveSessions.add(1);

    socket.on("open", () => {
      socket.send(JSON.stringify({ type: "subscribe", filter: "all" }));
    });

    socket.on("close", () => wsActiveSessions.add(-1));
    socket.on("error", () => {
      wsConnectSuccess.add(false);
      wsConnectFail.add(1);
    });

    socket.setTimeout(() => socket.close(), 5000);
  });

  // Reconnection attempts — must succeed within MAX_RECONNECT_WAIT seconds
  const reconnectStart = Date.now();
  let reconnected = false;

  for (let attempt = 0; attempt < 20; attempt++) {
    sleep(0.5);
    if ((Date.now() - reconnectStart) / 1000 > MAX_RECONNECT_WAIT) break;

    const res = ws.connect(url, {}, function (socket) {
      wsActiveSessions.add(1);
      socket.on("open", () => {
        reconnected = true;
        wsReconnectLatency.add(Date.now() - reconnectStart);
        socket.send(JSON.stringify({ type: "subscribe", filter: "all" }));
      });
      socket.on("close", () => wsActiveSessions.add(-1));
      socket.setTimeout(() => socket.close(), 10000);
    });

    if (res && res.status === 101) break;
  }

  wsReconnectSuccess.add(reconnected);
  check(reconnected, {
    [`reconnect within ${MAX_RECONNECT_WAIT}s`]: (v) => v === true,
  });
}

// ── Scenario 4: Heartbeat ──────────────────────────────────────────────────────

function runHeartbeat() {
  const url = buildWsUrl(taskId());

  ws.connect(url, {}, function (socket) {
    wsConnectSuccess.add(true);
    wsActiveSessions.add(1);

    socket.on("open", () => {
      socket.send(JSON.stringify({ type: "subscribe", filter: "all" }));
    });

    socket.on("pong", () => wsHeartbeatSuccess.add(true));

    socket.on("message", (data) => {
      wsMessagesReceived.add(1);
      try {
        const msg = JSON.parse(data);
        if (msg && (msg.type === "pong" || msg.type === "heartbeat")) {
          wsHeartbeatSuccess.add(true);
        }
      } catch (_) {}
    });

    socket.on("close", () => wsActiveSessions.add(-1));
    socket.on("error", () => {
      wsHeartbeatSuccess.add(false);
      wsConnectSuccess.add(false);
      wsConnectFail.add(1);
    });

    // Send 3 ping cycles then close
    let pingCount = 0;
    const interval = socket.setInterval(() => {
      socket.ping();
      pingCount++;
      if (pingCount >= 3) {
        socket.clearInterval(interval);
        socket.setTimeout(() => socket.close(), 2000);
      }
    }, HEARTBEAT_INTERVAL * 1000);
  });
}

// ── Default export — dispatch to scenario ──────────────────────────────────────

export default function () {
  const scenario = __ENV.SCENARIO || "sustained_load";

  switch (scenario) {
    case "message_ordering": runMessageOrdering(); break;
    case "reconnection":     runReconnection();    break;
    case "heartbeat":        runHeartbeat();       break;
    default:                 runSustainedLoad();   break;
  }

  sleep(randomIntBetween(1, 3));
}

// ── Lifecycle hooks ────────────────────────────────────────────────────────────

export function setup() {
  console.log(`WS stress test | URL: ${WS_URL}`);
  console.log(`Heartbeat: ${HEARTBEAT_INTERVAL}s | Max reconnect: ${MAX_RECONNECT_WAIT}s`);
}
