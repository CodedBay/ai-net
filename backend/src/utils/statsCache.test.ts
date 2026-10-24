import { StatsCache } from './statsCache';
import type { StatsResponse } from '../types/stats';

describe('StatsCache', () => {
  it('caches the first result for the TTL and avoids duplicate computation', async () => {
    let calls = 0;
    const cache = new StatsCache({
      ttlMs: 60_000,
      now: () => 1_000,
      computeStats: async (): Promise<StatsResponse> => {
        calls += 1;
        return {
          totalAgents: 1,
          totalTasks: 1,
          totalXLMTransacted: 0,
          uptimePercent: 100,
          tasksLast24h: [],
          xlmLast24h: [],
          tasksLast7d: [],
          xlmLast7d: []
        };
      }
    });

    const first = await cache.get();
    const second = await cache.get();

    expect(calls).toBe(1);
    expect(first).toEqual(second);
  });

  it('invalidates after TTL and recomputes on the next request', async () => {
    let calls = 0;
    let now = 1_000;
    const cache = new StatsCache({
      ttlMs: 60_000,
      now: () => now,
      computeStats: async (): Promise<StatsResponse> => {
        calls += 1;
        return {
          totalAgents: 1,
          totalTasks: 1,
          totalXLMTransacted: 0,
          uptimePercent: 100,
          tasksLast24h: [],
          xlmLast24h: [],
          tasksLast7d: [],
          xlmLast7d: []
        };
      }
    });

    await cache.get();
    now += 70_000;
    await cache.get();

    expect(calls).toBe(2);
  });
});
