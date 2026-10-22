/**
 * AgentsPage
 *
 * Displays all registered agents from the backend registry.
 * Supports two views: card grid (default) and table.
 *
 * Card view shows: name, capabilities, XLM price, online/offline status,
 * reputation stars, and a "Hire" CTA button.
 *
 * Includes:
 *  - Skeleton loading states while data is fetching
 *  - Empty state when no agents are registered
 *  - Filter bar (capability, price range, status)
 *  - Auto-refresh every 30 seconds
 *  - URL state persistence for filters
 *
 * Issue #1 / #3: Implement agent registry browsing page
 */

import { useCallback, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useSearchParams, useNavigate } from 'react-router-dom'
import { LayoutGrid, List, Users, Plus } from 'lucide-react'

import { useAgentRegistry } from '../hooks/useAgentRegistry'
import { AgentTable } from '../components/agents/AgentTable'
import { AgentFilterBar } from '../components/agents/AgentFilterBar'
import { AgentDetailModal } from '../components/agents/AgentDetailModal'
import { AgentRegistryCard } from '../components/agents/AgentRegistryCard'
import { EmptyState } from '../components/common/EmptyState'
import { AgentsEmptyIllustration } from '../components/common/illustrations'
import { SearchEmptyIllustration } from '../components/common/illustrations'
import { Skeleton, SkeletonCard } from '../components/common/Skeleton'
import type { AgentRecord } from '../types/api'
import {
  allCapabilities,
  filterAndSortAgents,
  filtersFromSearchParams,
  filtersToSearchParams,
  priceDomain,
  type AgentFilters,
  type SortKey,
} from '../utils/agentRegistry'
import styles from './AgentsPage.module.css'
import cardStyles from './AgentsCardPage.module.css'

const TABLE_COLUMNS = 6
const SKELETON_ROWS = 5
const SKELETON_CARDS = 8

type ViewMode = 'card' | 'table'

// ── Skeleton components ───────────────────────────────────────────────────────

/**
 * Skeleton for a single agent card — mirrors the AgentRegistryCard layout.
 */
function AgentCardSkeleton() {
  return (
    <div
      className={cardStyles.cardSkeleton}
      aria-hidden="true"
      data-testid="agent-card-skeleton"
    >
      {/* Header */}
      <div className={cardStyles.cardSkeletonHeader}>
        <Skeleton variant="circular" width={40} height={40} />
        <div className={cardStyles.cardSkeletonName}>
          <Skeleton width="60%" height="1rem" style={{ marginBottom: 6 }} />
          <Skeleton width="40%" height="0.7rem" />
        </div>
        <Skeleton variant="pill" width="5rem" height="1.6rem" />
      </div>
      {/* Capability pills */}
      <div className={cardStyles.cardSkeletonPills}>
        <Skeleton variant="pill" width="4.5rem" height="1.4rem" />
        <Skeleton variant="pill" width="3.5rem" height="1.4rem" />
        <Skeleton variant="pill" width="5rem" height="1.4rem" />
      </div>
      {/* Metrics */}
      <div className={cardStyles.cardSkeletonMetrics}>
        <div className={cardStyles.cardSkeletonMetric}>
          <Skeleton width="2.5rem" height="0.7rem" />
          <Skeleton width="3.5rem" height="1rem" />
        </div>
        <div className={cardStyles.cardSkeletonMetric}>
          <Skeleton width="4.5rem" height="0.7rem" />
          <Skeleton width="5rem" height="1rem" />
        </div>
      </div>
      {/* CTA button */}
      <Skeleton variant="pill" width="100%" height="2.625rem" />
    </div>
  )
}

/**
 * Full-page skeleton that mirrors the filter bar + card grid layout.
 */
export function AgentsPageSkeleton() {
  const { t } = useTranslation()

  return (
    <div
      data-testid="agents-page-skeleton"
      aria-busy="true"
      aria-label={t('a11y.loadingAgentRegistry', { defaultValue: 'Loading agent registry' })}
    >
      {/* Filter bar skeleton */}
      <div className={styles.filterSkeleton}>
        <div className={styles.filterGroupSkeleton}>
          <Skeleton width="6rem" height="0.75rem" />
          <div className={styles.chipRow}>
            <Skeleton variant="pill" width="5rem" height="1.5rem" />
            <Skeleton variant="pill" width="5rem" height="1.5rem" />
            <Skeleton variant="pill" width="5rem" height="1.5rem" />
          </div>
        </div>
        <div className={styles.filterGroupSkeleton}>
          <Skeleton width="8rem" height="0.75rem" />
          <Skeleton width="10rem" height="0.4rem" />
        </div>
      </div>

      {/* Card grid skeleton */}
      <div className={cardStyles.cardGrid} aria-hidden="true">
        {Array.from({ length: SKELETON_CARDS }, (_, i) => (
          <AgentCardSkeleton key={i} />
        ))}
      </div>

      {/* Table skeleton (hidden visually when in card mode, but kept for table mode) */}
      <div className={styles.tableSkeleton} style={{ display: 'none' }}>
        <div className={styles.tableHeaderRow} aria-hidden="true">
          {Array.from({ length: TABLE_COLUMNS }, (_, i) => (
            <Skeleton key={i} height="1rem" />
          ))}
        </div>
        {Array.from({ length: SKELETON_ROWS }, (_, i) => (
          <SkeletonCard key={i}>
            <div style={{ display: 'grid', gridTemplateColumns: `repeat(${TABLE_COLUMNS}, 1fr)`, gap: '1rem' }}>
              {Array.from({ length: TABLE_COLUMNS }, (_, j) => (
                <Skeleton key={j} height="1rem" />
              ))}
            </div>
          </SkeletonCard>
        ))}
      </div>
    </div>
  )
}

// ── Main component ────────────────────────────────────────────────────────────

function AgentsPage() {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const { agents, loading, error, refetch } = useAgentRegistry()
  const [searchParams, setSearchParams] = useSearchParams()
  const [selected, setSelected] = useState<AgentRecord | null>(null)
  const [viewMode, setViewMode] = useState<ViewMode>('card')

  // Filter/sort state derived from URL
  const filters = useMemo(
    () => filtersFromSearchParams(searchParams),
    [searchParams]
  )

  const updateFilters = useCallback(
    (next: Partial<AgentFilters>) => {
      const merged = { ...filters, ...next }
      setSearchParams(filtersToSearchParams(merged), { replace: true })
    },
    [filters, setSearchParams]
  )

  const resetFilters = useCallback(() => {
    setSearchParams({}, { replace: true })
  }, [setSearchParams])

  const handleSort = useCallback(
    (key: SortKey) => {
      if (filters.sortKey !== key) {
        updateFilters({ sortKey: key, sortDir: key === 'price' ? 'asc' : 'desc' })
      } else {
        updateFilters({ sortDir: filters.sortDir === 'asc' ? 'desc' : 'asc' })
      }
    },
    [filters, updateFilters]
  )

  const capabilities = useMemo(() => allCapabilities(agents), [agents])
  const domain = useMemo(() => priceDomain(agents), [agents])
  const visibleAgents = useMemo(
    () => filterAndSortAgents(agents, filters),
    [agents, filters]
  )

  const handleHire = useCallback((agent: AgentRecord) => {
    // Navigate to task creation pre-filled with this agent
    navigate(`/tasks/new?agent=${encodeURIComponent(agent.id)}`)
  }, [navigate])

  return (
    <div className={styles.page}>
      <div className={styles.header}>
        <div>
          <h1 className={styles.title}>{t('nav.agentRegistry', { defaultValue: 'Agent Registry' })}</h1>
          <p className={styles.subtitle}>
            {loading
              ? t('page.agents.loading', { defaultValue: 'Loading agents…' })
              : `${visibleAgents.length} of ${agents.length} agent${
                  agents.length === 1 ? '' : 's'
                }`}
          </p>
        </div>

        {/* View mode toggle */}
        <div className={cardStyles.viewToggle} role="group" aria-label="View mode">
          <button
            type="button"
            className={`${cardStyles.viewToggleBtn} ${viewMode === 'card' ? cardStyles.viewToggleBtnActive : ''}`}
            onClick={() => setViewMode('card')}
            aria-pressed={viewMode === 'card'}
            aria-label="Card view"
            title="Card view"
          >
            <LayoutGrid size={16} aria-hidden="true" />
          </button>
          <button
            type="button"
            className={`${cardStyles.viewToggleBtn} ${viewMode === 'table' ? cardStyles.viewToggleBtnActive : ''}`}
            onClick={() => setViewMode('table')}
            aria-pressed={viewMode === 'table'}
            aria-label="Table view"
            title="Table view"
          >
            <List size={16} aria-hidden="true" />
          </button>
        </div>
      </div>

      {/* ── Error state ───────────────────────────────────────────────────── */}
      {error && !loading ? (
        <div className={styles.errorBox} id="registry-error" role="alert">
          <p>{t('page.agents.error', { error, defaultValue: `Failed to load agents: ${error}` })}</p>
          <button type="button" className={styles.retryButton} onClick={refetch}>
            {t('common.retry', { defaultValue: 'Retry' })}
          </button>
        </div>
      ) : loading && agents.length === 0 ? (
        /* ── Initial loading skeleton ─────────────────────────────────────── */
        <AgentsPageSkeleton />
      ) : (
        <div className="fade-in">
          {/* Filter bar */}
          <AgentFilterBar
            filters={filters}
            availableCapabilities={capabilities}
            priceDomain={domain}
            onChange={updateFilters}
            onReset={resetFilters}
            onRefresh={refetch}
          />

          {/* ── Card view ─────────────────────────────────────────────── */}
          {viewMode === 'card' && (
            <>
              {visibleAgents.length === 0 ? (
                <EmptyState
                  illustration={
                    agents.length === 0
                      ? <AgentsEmptyIllustration />
                      : <SearchEmptyIllustration />
                  }
                  title={t('agent.table.emptyTitle', { defaultValue: 'No agents found' })}
                  description={
                    agents.length === 0
                      ? t('agent.table.emptySubtext', { defaultValue: 'No agents are registered yet. Be the first to register your agent.' })
                      : t('page.agents.noMatchingAgents', { defaultValue: 'No agents match the current filters. Try adjusting or resetting them.' })
                  }
                  primaryAction={
                    agents.length === 0
                      ? {
                          label: t('landing.hero.startTask', { defaultValue: 'Submit a Task' }),
                          to: '/tasks/new',
                          icon: <Plus size={16} />,
                        }
                      : {
                          label: t('page.agents.resetFilters', { defaultValue: 'Reset Filters' }),
                          onClick: resetFilters,
                        }
                  }
                  data-testid="agents-empty"
                />
              ) : (
                <div
                  className={cardStyles.cardGrid}
                  role="list"
                  aria-label={t('nav.agentRegistry', { defaultValue: 'Agent Registry' })}
                >
                  {visibleAgents.map((agent) => (
                    <div
                      key={agent.id}
                      role="listitem"
                      data-testid={`agent-row-${agent.id}`}
                    >
                      <AgentRegistryCard
                        agent={agent}
                        onHire={handleHire}
                      />
                    </div>
                  ))}
                </div>
              )}
            </>
          )}

          {/* ── Table view ────────────────────────────────────────────── */}
          {viewMode === 'table' && (
            <AgentTable
              agents={visibleAgents}
              loading={loading}
              sortKey={filters.sortKey}
              sortDir={filters.sortDir}
              onSort={handleSort}
              onRowClick={setSelected}
            />
          )}
        </div>
      )}

      <AgentDetailModal agent={selected} onClose={() => setSelected(null)} />
    </div>
  )
}

export default AgentsPage
