/**
 * useAgentStatusSocket — real-time agent status updates via WebSocket.
 *
 * Connects to `ws://<baseUrl>/ws` and consumes `agent:status` and
 * `agents:snapshot` events. Falls back to 10-second HTTP polling when the
 * browser does not support WebSocket or when the WebSocket fails to connect
 * after the maximum number of retries.
 *
 * ## Reconnection strategy
 * Exponential back-off: 1 s, 2 s, 4 s, 8 s, 16 s before giving up (5 retries).
 * After exhausting retries the fallback polling activates automatically.
 *
 * ## Memory safety
 * All WebSocket handlers, timers, and poll intervals are cleaned up on
 * component unmount (when the caller invokes the returned `disconnect` fn or
 * the effect teardown fires).
 *
 * ## Event wire format (backend docs/EVENTS.md §4.1)
 * ```ts
 * { event: "agent:status", payload: AgentStatusPayload, timestamp: string }
 * { event: "agents:snapshot", payload: { agents: AgentRecord[] }, timestamp: string }
 * { type: "ping" }  // heartbeat from server — reply with { type: "pong" }
 * ```
 */

import { useState, useEffect, useRef, useCallback } from 'react';

// ── Types ──────────────────────────────────────────────────────────────────

/** Agent status values as returned by the backend. */
export type AgentStatusValue = 'online' | 'offline' | 'busy' | 'error';

/** Payload of an `agent:status` WebSocket event (mirrors backend EVENTS.md §4.1). */
export interface AgentStatusPayload {
  agentId: string;
  name: string;
  capability: string;
  oldStatus: AgentStatusValue;
  newStatus: AgentStatusValue;
  lastHeartbeat: string; // ISO-8601
}

/** Slim record of a single agent's status, as held in local state. */
export interface AgentStatusRecord {
  agentId: string;
  name: string;
  capability: string;
  status: AgentStatusValue;
  lastHeartbeat: string;
}

/** Connection state visible to the UI. */
export type WsConnectionState =
  | 'connecting'
  | 'connected'
  | 'reconnecting'
  | 'disconnected'
  | 'error'
  | 'fallback';

export interface UseAgentStatusSocketOptions {
  /**
   * WebSocket base URL (e.g. `ws://localhost:3001`).
   * Defaults to the same host as the current page using the appropriate WS protocol.
   */
  baseUrl?: string;
  /** Maximum reconnect attempts before falling back to polling. Default: 5. */
  maxReconnectAttempts?: number;
  /** Polling interval (ms) used when WebSocket is unavailable. Default: 10 000. */
  pollIntervalMs?: number;
  /** Called with the current agent status map whenever it changes. */
  onStatusUpdate?: (agents: Map<string, AgentStatusRecord>) => void;
  /** REST endpoint to poll as a fallback. Default: `/api/agents`. */
  pollEndpoint?: string;
}

export interface UseAgentStatusSocketResult {
  /** Current WebSocket / polling connection state. */
  connectionState: WsConnectionState;
  /** Map from agentId → latest known status record. */
  agentStatuses: Map<string, AgentStatusRecord>;
  /** True when the fallback REST polling is active. */
  isFallback: boolean;
  /** Manually trigger a reconnect attempt (resets the back-off counter). */
  reconnect: () => void;
  /** Cleanly close the socket and stop polling. */
  disconnect: () => void;
}

// ── Helpers ────────────────────────────────────────────────────────────────

function deriveBaseUrl(): string {
  if (typeof window === 'undefined') return 'ws://localhost:3001';
  const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${window.location.host}`;
}

/** Runtime check — tests may stub WebSocket after this module is loaded. */
function isWebSocketSupported(): boolean {
  return typeof WebSocket !== 'undefined';
}

// ── Hook ───────────────────────────────────────────────────────────────────

export function useAgentStatusSocket(
  options: UseAgentStatusSocketOptions = {},
): UseAgentStatusSocketResult {
  const {
    baseUrl,
    maxReconnectAttempts = 5,
    pollIntervalMs = 10_000,
    onStatusUpdate,
    pollEndpoint = '/api/agents',
  } = options;

  const resolvedBaseUrl = baseUrl ?? deriveBaseUrl();

  const [connectionState, setConnectionState] = useState<WsConnectionState>(
    () => (isWebSocketSupported() ? 'connecting' : 'fallback'),
  );
  const [agentStatuses, setAgentStatuses] = useState<Map<string, AgentStatusRecord>>(
    () => new Map(),
  );
  const [isFallback, setIsFallback] = useState(() => !isWebSocketSupported());

  // Refs — stable across renders
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectAttemptRef = useRef(0);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pollTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const manualCloseRef = useRef(false);
  const onStatusUpdateRef = useRef(onStatusUpdate);
  onStatusUpdateRef.current = onStatusUpdate;

  // Stable agent state writer — merges an update into the existing map.
  const upsertAgent = useCallback((record: AgentStatusRecord) => {
    setAgentStatuses((prev) => {
      const next = new Map(prev);
      next.set(record.agentId, record);
      onStatusUpdateRef.current?.(next);
      return next;
    });
  }, []);

  const setAgents = useCallback((records: AgentStatusRecord[]) => {
    setAgentStatuses(() => {
      const next = new Map<string, AgentStatusRecord>();
      for (const r of records) next.set(r.agentId, r);
      onStatusUpdateRef.current?.(next);
      return next;
    });
  }, []);

  // ── Fallback polling ─────────────────────────────────────────────────────
  const startPolling = useCallback(() => {
    if (pollTimerRef.current) return; // already running
    setConnectionState('fallback');
    setIsFallback(true);

    const poll = async () => {
      try {
        const res = await fetch(pollEndpoint);
        if (res.ok) {
          type PollAgent = { id: string; capabilities?: string[]; status?: string; lastSeenAt?: string };
          const raw = (await res.json()) as unknown;
          const agents: PollAgent[] = Array.isArray(raw)
            ? (raw as PollAgent[])
            : ((raw as { agents?: PollAgent[] }).agents ?? []);
          if (agents.length > 0) {
            setAgents(
              agents.map((a) => ({
                agentId: a.id,
                name: a.id,
                capability: Array.isArray(a.capabilities) ? (a.capabilities[0] ?? '') : '',
                status: (a.status as AgentStatusValue) ?? 'offline',
                lastHeartbeat: a.lastSeenAt ?? new Date().toISOString(),
              })),
            );
          }
        }
      } catch {
        // network error during poll — keep trying
      }
    };

    void poll(); // immediate first poll
    pollTimerRef.current = setInterval(() => { void poll(); }, pollIntervalMs);
  }, [pollEndpoint, pollIntervalMs, setAgents]);

  const stopPolling = useCallback(() => {
    if (pollTimerRef.current) {
      clearInterval(pollTimerRef.current);
      pollTimerRef.current = null;
    }
  }, []);

  // ── WebSocket connection ──────────────────────────────────────────────────
  const connectWebSocket = useCallback(() => {
    if (!isWebSocketSupported()) {
      startPolling();
      return;
    }

    if (wsRef.current) {
      const prev = wsRef.current;
      prev.onopen = null;
      prev.onmessage = null;
      prev.onerror = null;
      prev.onclose = null;
      prev.close();
    }

    manualCloseRef.current = false;
    const isRetry = reconnectAttemptRef.current > 0;
    setConnectionState(isRetry ? 'reconnecting' : 'connecting');

    const ws = new WebSocket(`${resolvedBaseUrl}/ws`);
    wsRef.current = ws;

    ws.onopen = () => {
      reconnectAttemptRef.current = 0;
      stopPolling();
      setIsFallback(false);
      setConnectionState('connected');
    };

    ws.onmessage = (event) => {
      let data: unknown;
      try {
        data = JSON.parse(event.data as string);
      } catch {
        return;
      }

      const msg = data as {
        type?: string;
        event?: string;
        payload?: unknown;
      };

      // Server heartbeat
      if (msg.type === 'ping') {
        ws.send(JSON.stringify({ type: 'pong' }));
        return;
      }

      if (msg.event === 'agent:status') {
        const p = msg.payload as AgentStatusPayload;
        upsertAgent({
          agentId: p.agentId,
          name: p.name,
          capability: p.capability,
          status: p.newStatus,
          lastHeartbeat: p.lastHeartbeat,
        });
        return;
      }

      if (msg.event === 'agents:snapshot') {
        const p = msg.payload as {
          agents: Array<{
            id: string;
            capabilities?: string[];
            status?: string;
            lastSeenAt?: string;
          }>;
        };
        setAgents(
          (p.agents ?? []).map((a) => ({
            agentId: a.id,
            name: a.id,
            capability: Array.isArray(a.capabilities) ? (a.capabilities[0] ?? '') : '',
            status: (a.status as AgentStatusValue) ?? 'offline',
            lastHeartbeat: a.lastSeenAt ?? new Date().toISOString(),
          })),
        );
      }
    };

    ws.onerror = () => {
      setConnectionState('error');
    };

    ws.onclose = () => {
      setConnectionState('disconnected');

      if (manualCloseRef.current) return;

      if (reconnectAttemptRef.current < maxReconnectAttempts) {
        const delay = 1_000 * Math.pow(2, reconnectAttemptRef.current);
        reconnectAttemptRef.current += 1;
        if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current);
        reconnectTimerRef.current = setTimeout(() => {
          reconnectTimerRef.current = null;
          connectWebSocket();
        }, delay);
      } else {
        // All retries exhausted — activate fallback polling.
        startPolling();
      }
    };
  }, [resolvedBaseUrl, maxReconnectAttempts, startPolling, stopPolling, upsertAgent, setAgents]);

  // ── Public controls ───────────────────────────────────────────────────────
  const disconnect = useCallback(() => {
    manualCloseRef.current = true;
    if (reconnectTimerRef.current) {
      clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }
    stopPolling();
    if (wsRef.current) {
      wsRef.current.close();
      wsRef.current = null;
    }
    setConnectionState('disconnected');
  }, [stopPolling]);

  const reconnect = useCallback(() => {
    manualCloseRef.current = false;
    reconnectAttemptRef.current = 0;
    stopPolling();
    setIsFallback(false);
    connectWebSocket();
  }, [connectWebSocket, stopPolling]);

  // ── Mount / unmount ───────────────────────────────────────────────────────
  useEffect(() => {
    connectWebSocket();
    return () => {
      manualCloseRef.current = true;
      if (reconnectTimerRef.current) {
        clearTimeout(reconnectTimerRef.current);
        reconnectTimerRef.current = null;
      }
      stopPolling();
      if (wsRef.current) {
        const ws = wsRef.current;
        ws.onopen = null;
        ws.onmessage = null;
        ws.onerror = null;
        ws.onclose = null;
        ws.close();
        wsRef.current = null;
      }
    };
  // connectWebSocket is stable; running the effect only on mount is correct.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return {
    connectionState,
    agentStatuses,
    isFallback,
    reconnect,
    disconnect,
  };
}
