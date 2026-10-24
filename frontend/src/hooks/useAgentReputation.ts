import { useState, useEffect } from 'react';
import { getAgentReputation, getAgentReputationHistory } from '../services/api';
import type { AgentReputation, ReputationHistory } from '../types/agent';

export function useAgentReputation(agentId: string) {
  const [data, setData] = useState<AgentReputation | null>(null);
  const [history, setHistory] = useState<ReputationHistory[]>([]);
  const [loading, setLoading] = useState(false);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fetchKey, setFetchKey] = useState(0);

  useEffect(() => {
    if (!agentId) return;

    let mounted = true;
    const fetchReputation = async () => {
      setLoading(true);
      setError(null);
      try {
        const result = await getAgentReputation(agentId);
        if (mounted) {
          setData(result);
        }
      } catch (err) {
        if (mounted) {
          setError(err instanceof Error ? err.message : 'Failed to fetch reputation data');
        }
      } finally {
        if (mounted) {
          setLoading(false);
        }
      }
    };

    const fetchHistory = async () => {
      setHistoryLoading(true);
      try {
        const result = await getAgentReputationHistory(agentId);
        if (mounted) setHistory(result);
      } catch {
        if (mounted) setHistory([]);
      } finally {
        if (mounted) setHistoryLoading(false);
      }
    };

    fetchReputation();
    fetchHistory();

    return () => {
      mounted = false;
    };
  }, [agentId, fetchKey]);

  return { data, history, loading, historyLoading, error, refetch: () => setFetchKey((key) => key + 1) };
}
