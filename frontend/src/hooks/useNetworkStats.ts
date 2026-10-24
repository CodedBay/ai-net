// src/hooks/useNetworkStats.ts
import { useEffect, useState, useCallback, useRef } from "react";
import { getStats } from "../services/api";
import type { TimePoint } from "../types/api";

export interface NetworkStats {
  totalAgents: number;
  totalTasks: number;
  totalXLMTransacted: number;
  uptimePercent: number;
  tasksLast24h?: TimePoint[];
  xlmLast24h?: TimePoint[];
  tasksLast7d?: TimePoint[];
  xlmLast7d?: TimePoint[];
  activeTasks?: number;
}

export interface UseNetworkStatsReturn {
  data: NetworkStats | null;
  loading: boolean;
  error: Error | null;
  isStale: boolean;
  lastUpdated: Date | null;
  refetch: () => Promise<void>;
}

const POLL_INTERVAL_MS = 60_000;
const STALE_THRESHOLD_MS = 65_000;

export const useNetworkStats = (): UseNetworkStatsReturn => {
  const [data, setData] = useState<NetworkStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);
  const [isStale, setIsStale] = useState(false);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
  const lastSuccessRef = useRef<number>(0);

  const fetchStats = useCallback(async (isBackground = false) => {
    if (!isBackground) {
      setLoading(true);
    }
    try {
      const res = await getStats();
      setData(res);
      setError(null);
      setIsStale(false);
      const now = Date.now();
      lastSuccessRef.current = now;
      setLastUpdated(new Date(now));
    } catch (e) {
      const err = e as Error;
      setError(err);
      if (lastSuccessRef.current > 0) {
        // We have older data, so mark it as stale rather than blowing away previous stats
        setIsStale(true);
      }
    } finally {
      if (!isBackground) {
        setLoading(false);
      }
    }
  }, []);

  const refetch = useCallback(async () => {
    await fetchStats(false);
  }, [fetchStats]);

  useEffect(() => {
    fetchStats(false);

    // 60-second polling interval
    const intervalId = window.setInterval(() => {
      fetchStats(true);
    }, POLL_INTERVAL_MS);

    // Stale check timer
    const staleCheckId = window.setInterval(() => {
      if (
        lastSuccessRef.current > 0 &&
        Date.now() - lastSuccessRef.current > STALE_THRESHOLD_MS
      ) {
        setIsStale(true);
      }
    }, 10_000);

    const onFocus = () => {
      if (Date.now() - lastSuccessRef.current >= POLL_INTERVAL_MS) {
        fetchStats(true);
      }
    };
    window.addEventListener("focus", onFocus);

    return () => {
      window.clearInterval(intervalId);
      window.clearInterval(staleCheckId);
      window.removeEventListener("focus", onFocus);
    };
  }, [fetchStats]);

  return { data, loading, error, isStale, lastUpdated, refetch };
};
