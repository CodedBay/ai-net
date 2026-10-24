import http from 'http';
import type { AddressInfo } from 'net';
import { WebSocket } from 'ws';

import { attachAgentStatusStream } from '../src/api/routes/agentStatusStream';
import { eventBus } from '../src/coordinator/eventBus';

interface TestServer {
  server: http.Server;
  url: string;
  detach: () => void;
}

function startServer(
  options: Parameters<typeof attachAgentStatusStream>[1] = {},
): Promise<TestServer> {
  return new Promise((resolve) => {
    const server = http.createServer();
    const detach = attachAgentStatusStream(server, {
      eventBus,
      heartbeatIntervalMs: 60_000,
      pongTimeoutMs: 5_000,
      ...options,
    });
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      resolve({ server, url: `ws://127.0.0.1:${port}/ws`, detach });
    });
  });
}

function stopServer(ctx: TestServer): Promise<void> {
  return new Promise((resolve) => {
    ctx.detach();
    ctx.server.close(() => resolve());
  });
}

interface SocketHandle {
  ws: WebSocket;
  /** Resolves with the next buffered/received message. */
  next: (timeoutMs?: number) => Promise<Record<string, unknown>>;
}

function openSocket(url: string): Promise<SocketHandle> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const buffered: Record<string, unknown>[] = [];
    const waiters: Array<(message: Record<string, unknown>) => void> = [];

    ws.on('message', (raw) => {
      const message = JSON.parse(raw.toString()) as Record<string, unknown>;
      const waiter = waiters.shift();
      if (waiter) waiter(message);
      else buffered.push(message);
    });

    const next = (timeoutMs = 2_000): Promise<Record<string, unknown>> => {
      const bufferedMessage = buffered.shift();
      if (bufferedMessage) return Promise.resolve(bufferedMessage);
      return new Promise((resolveNext, rejectNext) => {
        const timer = setTimeout(() => {
          const index = waiters.indexOf(onMessage);
          if (index >= 0) waiters.splice(index, 1);
          rejectNext(new Error('Timed out waiting for WebSocket message'));
        }, timeoutMs);
        const onMessage = (message: Record<string, unknown>): void => {
          clearTimeout(timer);
          resolveNext(message);
        };
        waiters.push(onMessage);
      });
    };

    ws.once('open', () => resolve({ ws, next }));
    ws.once('error', reject);
  });
}

const SNAPSHOT = [
  {
    id: 'agent_research_01',
    capabilities: ['research'],
    status: 'online' as const,
    lastSeenAt: '2026-10-20T10:00:00.000Z',
  },
];

describe('agent-status WebSocket stream', () => {
  it('sends an agents:snapshot event on connect', async () => {
    const ctx = await startServer({ getAgentSnapshot: () => SNAPSHOT });
    try {
      const { ws, next } = await openSocket(ctx.url);
      const message = await next();
      expect(message['event']).toBe('agents:snapshot');
      expect(message['payload']).toEqual({ agents: SNAPSHOT });
      ws.close();
    } finally {
      await stopServer(ctx);
    }
  });

  it('broadcasts agent:status when an agent recovers', async () => {
    const ctx = await startServer({ getAgentSnapshot: () => [] });
    try {
      const { ws, next } = await openSocket(ctx.url);
      await next(); // snapshot

      const pending = next();
      eventBus.emit('system', {
        type: 'AgentRecovered',
        taskId: 'system',
        timestamp: '2026-10-20T10:00:05.000Z',
        payload: { agentId: 'agent_research_01', status: 'online' },
      });

      const message = await pending;
      expect(message['event']).toBe('agent:status');
      expect(message['payload']).toMatchObject({
        agentId: 'agent_research_01',
        oldStatus: 'offline',
        newStatus: 'online',
        lastHeartbeat: '2026-10-20T10:00:05.000Z',
      });
      ws.close();
    } finally {
      await stopServer(ctx);
    }
  });

  it('broadcasts agent:status when an agent is marked offline', async () => {
    const ctx = await startServer({ getAgentSnapshot: () => [] });
    try {
      const { ws, next } = await openSocket(ctx.url);
      await next(); // snapshot

      const pending = next();
      eventBus.emit('system', {
        type: 'AgentMarkedOffline',
        taskId: 'system',
        timestamp: '2026-10-20T10:00:10.000Z',
        payload: {
          agentId: 'agent_risk_01',
          capability: 'risk',
          consecutiveFailures: 3,
          status: 'offline',
        },
      });

      const message = await pending;
      expect(message['event']).toBe('agent:status');
      expect(message['payload']).toMatchObject({
        agentId: 'agent_risk_01',
        capability: 'risk',
        oldStatus: 'online',
        newStatus: 'offline',
      });
      ws.close();
    } finally {
      await stopServer(ctx);
    }
  });

  it('rejects connections beyond maxConnectionsPerClient', async () => {
    const ctx = await startServer({
      maxConnectionsPerClient: 1,
      getAgentSnapshot: () => [],
    });
    try {
      const first = await openSocket(ctx.url);
      await first.next(); // snapshot

      const second = new WebSocket(ctx.url);
      const outcome = await new Promise<string>((resolve) => {
        second.once('open', () => resolve('open'));
        second.once('error', () => resolve('rejected'));
      });
      expect(outcome).toBe('rejected');
      first.ws.close();
    } finally {
      await stopServer(ctx);
    }
  });

  it('closes open sockets on detach', async () => {
    const ctx = await startServer({ getAgentSnapshot: () => [] });
    const { ws, next } = await openSocket(ctx.url);
    await next(); // snapshot

    const closed = new Promise<void>((resolve) => ws.once('close', () => resolve()));
    ctx.detach();
    await closed;
    await new Promise<void>((resolve) => ctx.server.close(() => resolve()));
    expect(ws.readyState).toBe(WebSocket.CLOSED);
  });
});
