import { useCallback, useEffect, useRef, useState } from 'react'
import { getAgents } from '../services/api'
import type { AgentRecord } from '../types/api'
import { normalizeAgent, allCapabilities } from '@utils/agentRegistry'
import { fuzzyMatch, fuzzyMatchFields, type WeightedField } from '../utils/fuzzy'

const REFRESH_INTERVAL = 30_000

export type SuggestionType = 'agent' | 'capability' | 'type'

export interface TypeaheadSuggestion {
  id: string
  label: string
  type: SuggestionType
  score: number
  indices: number[]
  agent?: AgentRecord
  value: string
}

export interface AgentRegistryOptions {
  refreshInterval?: number
}

export interface AgentRegistryResult {
  agents: AgentRecord[]
  loading: boolean
  error: string | null
  refetch: () => void
  searchAgents: (query: string) => AgentRecord[]
  getSuggestions: (query: string) => TypeaheadSuggestion[]
}

/**
 * Fetches the agent registry from `GET /api/agents` and keeps it fresh with a
 * background poll and window focus listener. `loading` is only true on the first
 * load — subsequent refreshes (auto or manual) update `agents` in place so the
 * table never remounts and the skeleton never flashes.
 *
 * @param options - Optional configuration for the hook.
 * @param options.refreshInterval - Milliseconds between background polls (default 30 000 ms).
 * @returns An object containing:
 *   - `agents` — normalized array of {@link AgentRecord} from the registry.
 *   - `loading` — `true` only on the initial load.
 *   - `error` — error message, or `null` when no error has occurred.
 *   - `refetch` — imperative callback to trigger an immediate refresh.
 */
export function useAgentRegistry(options: AgentRegistryOptions = {}): AgentRegistryResult {
  const refreshInterval = options.refreshInterval ?? REFRESH_INTERVAL
  const [agents, setAgents] = useState<AgentRecord[]>([])
  const [loading, setLoading] = useState<boolean>(true)
  const [error, setError] = useState<string | null>(null)

  const isFirstLoad = useRef(true)
  const fetchingRef = useRef(false)
  const mountedRef = useRef(true)

  const fetchAgents = useCallback(async () => {
    if (fetchingRef.current) return
    fetchingRef.current = true

    if (isFirstLoad.current) setLoading(true)

    try {
      const data = await getAgents()
      if (!mountedRef.current) return
      setAgents(Array.isArray(data) ? data.map(normalizeAgent) : [])
      setError(null)
    } catch (err) {
      if (!mountedRef.current) return
      setError(err instanceof Error ? err.message : 'Failed to load agents')
    } finally {
      if (mountedRef.current) {
        setLoading(false)
      }
      isFirstLoad.current = false
      fetchingRef.current = false
    }
  }, [])

  useEffect(() => {
    mountedRef.current = true
    fetchAgents()

    const interval = setInterval(fetchAgents, refreshInterval)
    const handleFocus = () => fetchAgents()
    if (typeof window !== 'undefined') {
      window.addEventListener('focus', handleFocus)
    }

    return () => {
      mountedRef.current = false
      clearInterval(interval)
      if (typeof window !== 'undefined') {
        window.removeEventListener('focus', handleFocus)
      }
    }
  }, [fetchAgents, refreshInterval])


  const refetch = useCallback(() => {
    fetchAgents()
  }, [fetchAgents])

  const searchAgents = useCallback((query: string): AgentRecord[] => {
    const q = query.trim()
    if (!q) return agents

    const scored: { agent: AgentRecord; score: number }[] = []

    for (const agent of agents) {
      const fields: WeightedField[] = [
        { text: agent.name, weight: 3 },
        ...agent.capabilities.map((c) => ({ text: c, weight: 2 })),
        { text: agent.id, weight: 1.5 },
      ]
      const match = fuzzyMatchFields(q, fields)
      if (match) {
        scored.push({ agent, score: match.score })
      }
    }

    scored.sort((a, b) => b.score - a.score)
    return scored.map((s) => s.agent)
  }, [agents])

  const getSuggestions = useCallback((query: string): TypeaheadSuggestion[] => {
    const q = query.trim()
    if (!q) return []

    const suggestions: TypeaheadSuggestion[] = []

    // 1. Agent names
    for (const agent of agents) {
      const match = fuzzyMatch(q, agent.name)
      if (match) {
        suggestions.push({
          id: `agent-${agent.id}`,
          label: agent.name,
          type: 'agent',
          score: match.score + 10,
          indices: match.indices,
          agent,
          value: agent.name,
        })
      }
    }

    // 2. Capability tags
    const capabilities = allCapabilities(agents)
    for (const cap of capabilities) {
      const match = fuzzyMatch(q, cap)
      if (match) {
        suggestions.push({
          id: `cap-${cap}`,
          label: cap,
          type: 'capability',
          score: match.score,
          indices: match.indices,
          value: cap,
        })
      }
    }

    // 3. Agent types
    const knownTypes = ['research', 'risk', 'coding', 'design', 'report']
    for (const agentType of knownTypes) {
      const match = fuzzyMatch(q, agentType)
      if (match) {
        suggestions.push({
          id: `type-${agentType}`,
          label: `${agentType.charAt(0).toUpperCase() + agentType.slice(1)} Agent`,
          type: 'type',
          score: match.score - 2,
          indices: match.indices,
          value: agentType,
        })
      }
    }

    suggestions.sort((a, b) => b.score - a.score)
    return suggestions.slice(0, 10)
  }, [agents])

  return { agents, loading, error, refetch, searchAgents, getSuggestions }
}
