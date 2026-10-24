/**
 * Unit tests for useAgentStatusSocket (#179)
 *
 * Tests cover:
 *  - Successful WebSocket connection and status updates
 *  - Disconnect + reconnect with exponential back-off
 *  - Fallback activation after max retries exhausted
 *  - Fallback activation when WebSocket is unsupported
 *  - Cleanup on unmount (no memory leaks)
 *  - agents:snapshot event hydration
 *  - Heartbeat ping/pong
 */

import { renderHook, act } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { useAgentStatusSocket } from './useAgentStatusSocket';

// ── MockWebSocket ────────────────────────────────────────────────────────────

class MockWebSocket {
  static lastInstance: MockWebSocket | null = null;
  static instances: MockWebSocket[] = [];

  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  readyState: number = 0; // WebSocket.CONNECTING

  readonly url: string;
  sent: string[] = [];
  closed = false;

  constructor(url: string) {
    this.url = url;
    MockWebSocket.lastInstance = this;
    MockWebSocket.instances.push(this);
  }

  send(data: string) {
    this.sent.push(data);
  }

  close() {
    this.closed = true;
    this.readyState = 3; // CLOSED
    this.onclose?.(new CloseEvent('close', { code: 1000 }));
  }

  // ── Test helpers ───────────────────────────────────────────────────────────
  open() {
    this.readyState = 1; // OPEN
    this.onopen?.(new Event('open'));
  }

  message(data: unknown) {
    this.onmessage?.(
      new MessageEvent('message', { data: JSON.stringify(data) }),
    );
  }

  error() {
    this.onerror?.(new Event('error'));
  }

  drop() {
    this.readyState = 3;
    this.onclose?.(new CloseEvent('close', { code: 1006 }));
  }
}

// ── Setup ────────────────────────────────────────────────────────────────────

const originalWebSocket = (global as Record<string, unknown>)['WebSocket'];

beforeEach(() => {
  vi.useFakeTimers();
  MockWebSocket.lastInstance = null;
  MockWebSocket.instances = [];
  (global as Record<string, unknown>)['WebSocket'] = MockWebSocket;
});

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllTimers();
  (global as Record<string, unknown>)['WebSocket'] = originalWebSocket;
});

// ── Tests ────────────────────────────────────────────────────────────────────

describe('useAgentStatusSocket — successful connection', () => {
  it('starts in "connecting" state and transitions to "connected" on open', async () => {
    const { result } = renderHook(() =>
      useAgentStatusSocket({ baseUrl: 'ws://localhost:3001' }),
    );

    expect(result.current.connectionState).toBe('connecting');

    act(() => {
      MockWebSocket.lastInstance?.open();
    });

    expect(result.current.connectionState).toBe('connected');
    expect(result.current.isFallback).toBe(false);
  });

  it('connects to ws://<baseUrl>/ws', () => {
    renderHook(() => useAgentStatusSocket({ baseUrl: 'ws://test:9000' }));
    expect(MockWebSocket.lastInstance?.url).toBe('ws://test:9000/ws');
  });

  it('updates agent status on agent:status event', async () => {
    const { result } = renderHook(() =>
      useAgentStatusSocket({ baseUrl: 'ws://localhost:3001' }),
    );

    act(() => { MockWebSocket.lastInstance?.open(); });

    act(() => {
      MockWebSocket.lastInstance?.message({
        event: 'agent:status',
        payload: {
          agentId: 'agent-1',
          name: 'research',
          capability: 'research',
          oldStatus: 'offline',
          newStatus: 'online',
          lastHeartbeat: '2026-10-20T10:00:00.000Z',
        },
        timestamp: '2026-10-20T10:00:05.000Z',
      });
    });

    const record = result.current.agentStatuses.get('agent-1');
    expect(record).toBeDefined();
    expect(record?.status).toBe('online');
    expect(record?.capability).toBe('research');
  });

  it('hydrates agent map from agents:snapshot on connect', () => {
    const { result } = renderHook(() =>
      useAgentStatusSocket({ baseUrl: 'ws://localhost:3001' }),
    );

    act(() => { MockWebSocket.lastInstance?.open(); });

    act(() => {
      MockWebSocket.lastInstance?.message({
        event: 'agents:snapshot',
        payload: {
          agents: [
            { id: 'agent-a', capabilities: ['research'], status: 'online', lastSeenAt: '2026-10-20T09:00:00.000Z' },
            { id: 'agent-b', capabilities: ['risk'], status: 'offline', lastSeenAt: '2026-10-19T09:00:00.000Z' },
          ],
        },
        timestamp: '2026-10-20T10:00:00.000Z',
      });
    });

    expect(result.current.agentStatuses.size).toBe(2);
    expect(result.current.agentStatuses.get('agent-a')?.status).toBe('online');
    expect(result.current.agentStatuses.get('agent-b')?.status).toBe('offline');
  });

  it('replies pong to a server ping', () => {
    renderHook(() => useAgentStatusSocket({ baseUrl: 'ws://localhost:3001' }));
    act(() => { MockWebSocket.lastInstance?.open(); });

    act(() => {
      MockWebSocket.lastInstance?.message({ type: 'ping' });
    });

    const ws = MockWebSocket.lastInstance;
    expect(ws?.sent).toContain(JSON.stringify({ type: 'pong' }));
  });
});

describe('useAgentStatusSocket — disconnect + reconnect', () => {
  it('schedules a reconnect after unexpected close (1 s first back-off)', async () => {
    const { result } = renderHook(() =>
      useAgentStatusSocket({ baseUrl: 'ws://localhost:3001', maxReconnectAttempts: 5 }),
    );
    act(() => { MockWebSocket.lastInstance?.open(); });

    act(() => { MockWebSocket.lastInstance?.drop(); });
    expect(result.current.connectionState).toBe('disconnected');

    // Advance past the 1 s first backoff.
    act(() => { vi.advanceTimersByTime(1100); });

    // A second WS instance should have been created.
    expect(MockWebSocket.instances.length).toBe(2);
  });

  it('uses exponential back-off (1 s, 2 s, 4 s …)', () => {
    renderHook(() =>
      useAgentStatusSocket({ baseUrl: 'ws://localhost:3001', maxReconnectAttempts: 5 }),
    );

    // Drop each attempt immediately and verify the back-off delay doubles.
    const expectedDelays = [1000, 2000, 4000];
    for (const delay of expectedDelays) {
      act(() => { MockWebSocket.lastInstance?.drop(); });
      expect(MockWebSocket.instances.length).toBe(
        expectedDelays.indexOf(delay) + 1,
      );
      act(() => { vi.advanceTimersByTime(delay + 50); });
    }

    // After 3 drops and advancing all delays, 4 instances total (original + 3 retries).
    expect(MockWebSocket.instances.length).toBe(4);
  });

  it('reconnect() resets the back-off counter', () => {
    const { result } = renderHook(() =>
      useAgentStatusSocket({ baseUrl: 'ws://localhost:3001', maxReconnectAttempts: 5 }),
    );
    act(() => { MockWebSocket.lastInstance?.open(); });

    // Exhaust 2 retries to advance the counter.
    act(() => { MockWebSocket.lastInstance?.drop(); });
    act(() => { vi.advanceTimersByTime(1100); });
    act(() => { MockWebSocket.lastInstance?.drop(); });
    act(() => { vi.advanceTimersByTime(2100); });

    // Manual reconnect should reset.
    act(() => { result.current.reconnect(); });
    expect(MockWebSocket.instances.length).toBeGreaterThanOrEqual(3);
    expect(result.current.connectionState).toBe('connecting');
  });
});

describe('useAgentStatusSocket — fallback activation', () => {
  it('activates polling fallback after maxReconnectAttempts retries', async () => {
    // Use a fetch mock so polls don't throw.
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ agents: [] }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const { result } = renderHook(() =>
      useAgentStatusSocket({
        baseUrl: 'ws://localhost:3001',
        maxReconnectAttempts: 2,
        pollIntervalMs: 500,
      }),
    );

    // Exhaust all retries.
    for (let i = 0; i < 3; i++) {
      act(() => { MockWebSocket.lastInstance?.drop(); });
      act(() => { vi.advanceTimersByTime(Math.pow(2, i) * 1000 + 100); });
    }

    expect(result.current.isFallback).toBe(true);
    expect(result.current.connectionState).toBe('fallback');

    vi.unstubAllGlobals();
  });

  it('activates fallback immediately when WebSocket is not supported', () => {
    (global as Record<string, unknown>)['WebSocket'] = undefined;

    const { result } = renderHook(() =>
      useAgentStatusSocket({ baseUrl: 'ws://localhost:3001' }),
    );

    expect(result.current.isFallback).toBe(true);
    expect(result.current.connectionState).toBe('fallback');
  });
});

describe('useAgentStatusSocket — cleanup on unmount', () => {
  it('closes the WebSocket and stops timers on unmount', () => {
    const { unmount } = renderHook(() =>
      useAgentStatusSocket({ baseUrl: 'ws://localhost:3001' }),
    );

    act(() => { MockWebSocket.lastInstance?.open(); });

    const ws = MockWebSocket.lastInstance;
    unmount();

    expect(ws?.closed).toBe(true);
  });

  it('does not attempt to reconnect after unmount', () => {
    const { unmount } = renderHook(() =>
      useAgentStatusSocket({ baseUrl: 'ws://localhost:3001', maxReconnectAttempts: 5 }),
    );

    act(() => { MockWebSocket.lastInstance?.open(); });
    const countBefore = MockWebSocket.instances.length;

    act(() => { MockWebSocket.lastInstance?.drop(); });
    unmount();

    // Advance timers — no new WS should be created after unmount.
    act(() => { vi.advanceTimersByTime(5000); });
    expect(MockWebSocket.instances.length).toBe(countBefore);
  });

  it('calls onStatusUpdate callback when agent status changes', () => {
    const onStatusUpdate = vi.fn();

    renderHook(() =>
      useAgentStatusSocket({
        baseUrl: 'ws://localhost:3001',
        onStatusUpdate,
      }),
    );

    act(() => { MockWebSocket.lastInstance?.open(); });

    act(() => {
      MockWebSocket.lastInstance?.message({
        event: 'agent:status',
        payload: {
          agentId: 'agent-x',
          name: 'coding',
          capability: 'coding',
          oldStatus: 'online',
          newStatus: 'offline',
          lastHeartbeat: '2026-10-20T12:00:00.000Z',
        },
        timestamp: '2026-10-20T12:00:00.000Z',
      });
    });

    expect(onStatusUpdate).toHaveBeenCalledWith(expect.any(Map));
    const map = onStatusUpdate.mock.calls[0][0] as Map<string, { status: string }>;
    expect(map.get('agent-x')?.status).toBe('offline');
  });
});
