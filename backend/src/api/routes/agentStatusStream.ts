/**
 * Agent-status WebSocket broadcast endpoint — /ws
 *
 * Broadcasts `agent:status` events to all connected clients whenever an
 * agent's health status changes (online ↔ offline). The backend's
 * AgentMonitorService emits `AgentRecovered` and `AgentMarkedOffline` events
 * on the internal event bus under the `'system'` task channel; this module
 * subscribes to those events and fans them out over WebSocket.
 *
 * Wire format emitted to clients:
 * ```json
 * {
 *   "event": "agent:status",
 *   "payload": {
 *     "agentId": "agent_research_01",
 *     "name": "research",
 *     "capability": "research",
 *     "oldStatus": "online",
 *     "newStatus": "offline",
 *     "lastHeartbeat": "2026-10-20T10:00:00.000Z"
 *   },
 *   "timestamp": "2026-10-20T10:00:05.000Z"
 * }
 * ```
 *
 * Additionally, on first connect the server sends a synthetic `agents:snapshot`
 * event with the full current agent list so the client can hydrate immediately
 * without a separate REST call.
 *
 * Authentication: none required (read-only public status feed).
 * Heartbeat: server sends `{"type":"ping"}` every 30 s; client should respond
 *            with `{"type":"pong"}` to prevent inactivity-based disconnects.
 */

import type { Server as HttpServer } from 'http';
import type { IncomingMessage } from 'http';
import type { Socket } from 'net';
import { WebSocketServer, WebSocket } from 'ws';
import { randomUUID } from 'crypto';

import { eventBus as defaultEventBus } from '../../coordinator/eventBus';
import { getConfig } from '../../config';
import { createLogger } from '../../utils/logger';

const logger = createLogger({ module: 'ws-agent-status' });

const AGENT_STATUS_PATH = /^\/ws(?:\?.*)?$/;

const DEFAULT_HEARTBEAT_INTERVAL_MS = 30_000;
const DEFAULT_PONG_TIMEOUT_MS = 10_000;

export interface AgentStatusStreamOptions {
  heartbeatIntervalMs?: number;
  pongTimeoutMs?: number;
  /** Max concurrent connections per client IP (defaults to WS_MAX_CONNECTIONS_PER_CLIENT). */
  maxConnectionsPerClient?: number;
  eventBus?: typeof defaultEventBus;
  /** Injected for testing: returns a snapshot of current agents. */
  getAgentSnapshot?: () => Array<{
    id: string;
    capabilities?: string[];
    status: 'online' | 'offline';
    lastSeenAt?: string;
  }>;
}

const activeServers = new Set<WebSocketServer>();

export function getAgentStatusConnectionCount(): number {
  let total = 0;
  for (const server of activeServers) {
    total += server.clients.size;
  }
  return total;
}

/**
 * Attach the agent-status broadcast stream to an HTTP server.
 *
 * All clients connected to `ws://<host>/ws` receive agent status change
 * events in real time. On connect they immediately receive an
 * `agents:snapshot` event with the full current agent list.
 *
 * @returns A detach function that stops the stream and closes open sockets.
 */
export function attachAgentStatusStream(
  httpServer: HttpServer,
  options: AgentStatusStreamOptions = {},
): () => void {
  const {
    heartbeatIntervalMs = DEFAULT_HEARTBEAT_INTERVAL_MS,
    pongTimeoutMs = DEFAULT_PONG_TIMEOUT_MS,
    maxConnectionsPerClient = getConfig().WS_MAX_CONNECTIONS_PER_CLIENT,
    eventBus = defaultEventBus,
    getAgentSnapshot,
  } = options;

  /** Concurrent connections per client IP (bounded to protect the fan-out). */
  const clientConnections = new Map<string, number>();

  function getClientIp(req: IncomingMessage): string {
    const forwarded = req.headers['x-forwarded-for'];
    if (typeof forwarded === 'string') return forwarded.split(',')[0].trim();
    return req.socket.remoteAddress ?? 'unknown';
  }

  const wss = new WebSocketServer({ noServer: true });
  activeServers.add(wss);

  // ── Fan-out helper ─────────────────────────────────────────────────────────
  function broadcast(data: unknown): void {
    const msg = JSON.stringify(data);
    for (const client of wss.clients) {
      if (client.readyState === WebSocket.OPEN) {
        client.send(msg);
      }
    }
  }

  // ── Subscribe to system channel events ────────────────────────────────────
  const unsubSystem = eventBus.subscribe('system', (event) => {
    const { type, payload, timestamp } = event as {
      type: string;
      payload?: Record<string, unknown>;
      timestamp: string;
    };

    if (type === 'AgentRecovered' || type === 'AgentMarkedOffline') {
      const agentPayload = payload ?? {};
      broadcast({
        event: 'agent:status',
        payload: {
          agentId: agentPayload['agentId'] ?? '',
          name: agentPayload['agentId'] ?? '',
          capability: agentPayload['capability'] ?? agentPayload['agentId'] ?? '',
          oldStatus: type === 'AgentRecovered' ? 'offline' : 'online',
          newStatus: type === 'AgentRecovered' ? 'online' : 'offline',
          lastHeartbeat: timestamp,
        },
        timestamp: new Date().toISOString(),
        correlationId: (agentPayload['correlationId'] as string | undefined) ?? randomUUID(),
      });
    }
  });

  // ── Upgrade handler ────────────────────────────────────────────────────────
  const onUpgrade = (req: IncomingMessage, socket: Socket, head: Buffer): void => {
    if (!AGENT_STATUS_PATH.test(req.url ?? '')) {
      // Not our path — let other upgrade handlers deal with it.
      return;
    }

    const clientIp = getClientIp(req);
    const active = clientConnections.get(clientIp) ?? 0;
    if (active >= maxConnectionsPerClient) {
      logger.warn({ clientIp }, 'agent-status connection limit exceeded');
      socket.write(
        'HTTP/1.1 429 Too Many Requests\r\n' +
        'Connection: close\r\n\r\n' +
        'Too many concurrent WebSocket connections',
      );
      socket.destroy();
      return;
    }

    clientConnections.set(clientIp, active + 1);
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit('connection', ws, req, clientIp);
    });
  };

  httpServer.on('upgrade', onUpgrade);

  // ── Per-connection setup ───────────────────────────────────────────────────
  wss.on('connection', (ws: WebSocket, _req: IncomingMessage, clientIp: string) => {
    logger.debug('agent-status client connected');

    let heartbeat: NodeJS.Timeout | undefined;
    let pongTimer: NodeJS.Timeout | undefined;

    const send = (data: unknown): void => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(data));
      }
    };

    // Send a snapshot of current agents on connect so clients can hydrate
    // without a separate REST call.
    if (getAgentSnapshot) {
      try {
        const agents = getAgentSnapshot();
        send({
          event: 'agents:snapshot',
          payload: { agents },
          timestamp: new Date().toISOString(),
        });
      } catch (err) {
        logger.warn({ err }, 'failed to send agent snapshot');
      }
    }

    // Heartbeat
    heartbeat = setInterval(() => {
      if (ws.readyState !== WebSocket.OPEN) return;
      send({ type: 'ping' });
      pongTimer = setTimeout(() => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.terminate();
        }
      }, pongTimeoutMs);
    }, heartbeatIntervalMs);

    ws.on('message', (raw) => {
      try {
        const msg = JSON.parse(raw.toString()) as { type?: unknown };
        if (msg?.type === 'pong' && pongTimer) {
          clearTimeout(pongTimer);
          pongTimer = undefined;
        }
      } catch {
        // Ignore unparseable messages.
      }
    });

    const cleanup = (): void => {
      if (heartbeat) clearInterval(heartbeat);
      if (pongTimer) clearTimeout(pongTimer);
      const remaining = (clientConnections.get(clientIp) ?? 1) - 1;
      if (remaining > 0) clientConnections.set(clientIp, remaining);
      else clientConnections.delete(clientIp);
      logger.debug('agent-status client disconnected');
    };

    ws.on('close', cleanup);
    ws.on('error', cleanup);
  });

  // ── Detach ─────────────────────────────────────────────────────────────────
  return function detach(): void {
    unsubSystem();
    httpServer.off('upgrade', onUpgrade);
    activeServers.delete(wss);
    for (const client of wss.clients) {
      client.terminate();
    }
    wss.close();
  };
}
