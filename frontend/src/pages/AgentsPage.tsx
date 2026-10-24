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

import { useCallback, useEffect, useMemo, useRef, useState, type TouchEvent } from 'react'
import { useTranslation } from 'react-i18next'
import { useSearchParams, useNavigate } from 'react-router-dom'
import { LayoutGrid, List, Plus } from 'lucide-react'

import { useAgentRegistry } from '../hooks/useAgentRegistry'
import { AgentTable } from '../components/agents/AgentTable'
import { AgentFilterBar } from '../components/agents/AgentFilterBar'
import { AgentDetailModal } from '../components/agents/AgentDetailModal'
import { AgentRegistryCard } from '../components/agents/AgentRegistryCard'
import { SearchWithTypeahead } from '../components/agents/SearchWithTypeahead'
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
type MobileSheet = 'filters' | 'sort' | 'compare' | null

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
  const { agents, loading, error, refetch, getSuggestions } = useAgentRegistry()
  const [searchParams, setSearchParams] = useSearchParams()
  const [selected, setSelected] = useState<AgentRecord | null>(null)
  const [viewMode, setViewMode] = useState<ViewMode>('card')
  const [mobileSheet, setMobileSheet] = useState<MobileSheet>(null)
  const [sheetExpanded, setSheetExpanded] = useState(false)
  const [tabletFiltersOpen, setTabletFiltersOpen] = useState(false)
  const [compareAgents, setCompareAgents] = useState<AgentRecord[]>([])
  const touchStart = useRef<{ agentId: string; x: number } | null>(null)

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

  const toggleCompare = useCallback((agent: AgentRecord) => {
    setCompareAgents((current) => {
      if (current.some((item) => item.id === agent.id)) {
        return current.filter((item) => item.id !== agent.id)
      }
      return current.length < 2 ? [...current, agent] : [...current.slice(1), agent]
    })
  }, [])

  const handleCardTouchStart = (event: TouchEvent<HTMLDivElement>, agentId: string) => {
    const target = event.target
    if (target instanceof Element && target.closest('button, a, input, select')) {
      touchStart.current = null
      return
    }
    touchStart.current = { agentId, x: event.changedTouches[0].clientX }
  }

  const handleCardTouchEnd = (event: TouchEvent<HTMLDivElement>, agent: AgentRecord) => {
    const start = touchStart.current
    touchStart.current = null
    if (!start || start.agentId !== agent.id || !window.matchMedia('(max-width: 767px)').matches) return
    if (start.x - event.changedTouches[0].clientX > 64) toggleCompare(agent)
  }

  const chooseSort = (sortKey: SortKey | null, sortDir: 'asc' | 'desc') => {
    updateFilters({ sortKey, sortDir })
    setMobileSheet(null)
  }

  const desktopSortValue = filters.sortKey === 'price'
    ? `price-${filters.sortDir}`
    : filters.sortKey === 'reputation' ? 'reputation' : 'recommended'

  useEffect(() => {
    if (!mobileSheet) return
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setMobileSheet(null)
    }
    document.addEventListener('keydown', closeOnEscape)
    return () => document.removeEventListener('keydown', closeOnEscape)
  }, [mobileSheet])

  const activeFilterCount =
    filters.capabilities.length +
    Number(filters.priceMin != null || filters.priceMax != null) +
    Number(filters.status !== 'all')
  const sortLabel = filters.sortKey === 'price'
    ? filters.sortDir === 'asc' ? 'Price: low to high' : 'Price: high to low'
    : filters.sortKey === 'reputation' ? 'Reputation' : 'Recommended'
  const sheetTitle = mobileSheet === 'filters'
    ? 'Agent filters'
    : mobileSheet === 'sort' ? 'Sort agents' : 'Compare agents'

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
          {/* Search with typeahead */}
          <div className={styles.searchSection}>
            <SearchWithTypeahead
              value={filters.searchQuery ?? ''}
              onChange={(q) => updateFilters({ searchQuery: q })}
              onSelectSuggestion={(s) => {
                if (s.type === 'agent' && s.agent) {
                  setSelected(s.agent)
                } else if (s.type === 'capability') {
                  if (!filters.capabilities.includes(s.value)) {
                    updateFilters({ capabilities: [...filters.capabilities, s.value] })
                  }
                } else if (s.type === 'type') {
                  updateFilters({ searchQuery: s.value })
                }
              }}
              getSuggestions={getSuggestions}
            />
          </div>

          {/* Filter bar */}
          <AgentFilterBar
            filters={filters}
            availableCapabilities={capabilities}
            priceDomain={domain}
            onChange={updateFilters}
            onReset={resetFilters}
            onRefresh={refetch}
          />

            <main className={styles.marketplaceResults}>
              <div className={styles.resultsToolbar}>
                <button
                  type="button"
                  className={styles.tabletFilterButton}
                  onClick={() => setTabletFiltersOpen((open) => !open)}
                  aria-expanded={tabletFiltersOpen}
                >
                  <Filter size={17} aria-hidden="true" />
                  Filters{activeFilterCount > 0 ? ` (${activeFilterCount})` : ''}
                </button>
                <button
                  type="button"
                  className={styles.mobileSortButton}
                  onClick={() => { setSheetExpanded(false); setMobileSheet('sort') }}
                  aria-haspopup="dialog"
                >
                  <ArrowDownUp size={17} aria-hidden="true" />
                  {sortLabel}
                  <ChevronDown size={16} aria-hidden="true" />
                </button>
                <label className={styles.desktopSortControl}>
                  <span>Sort</span>
                  <select
                    value={desktopSortValue}
                    aria-label="Sort agents"
                    onChange={(event) => {
                      const value = event.target.value
                      if (value === 'price-asc') chooseSort('price', 'asc')
                      else if (value === 'price-desc') chooseSort('price', 'desc')
                      else if (value === 'reputation') chooseSort('reputation', 'desc')
                      else chooseSort(null, 'desc')
                    }}
                  >
                    <option value="recommended">Recommended</option>
                    <option value="price-asc">Price: low to high</option>
                    <option value="price-desc">Price: high to low</option>
                    <option value="reputation">Reputation</option>
                  </select>
                </label>
              </div>

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
                          onTouchStart={(event) => handleCardTouchStart(event, agent.id)}
                          onTouchEnd={(event) => handleCardTouchEnd(event, agent)}
                          onTouchCancel={() => { touchStart.current = null }}
                        >
                          <AgentRegistryCard
                            agent={agent}
                            onHire={handleHire}
                            onCompare={toggleCompare}
                            isSelectedForComparison={compareAgents.some((item) => item.id === agent.id)}
                          />
                        </div>
                      ))}
                    </div>
                  )}
                </>
              )}

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
            </main>
          </div>
        </div>
      )}

      <button
        type="button"
        className={styles.floatingFilterButton}
        onClick={() => { setSheetExpanded(false); setMobileSheet('filters') }}
        aria-haspopup="dialog"
        aria-label={`Open filters${activeFilterCount > 0 ? `, ${activeFilterCount} active` : ''}`}
      >
        <Filter size={19} aria-hidden="true" />
        Filters{activeFilterCount > 0 ? ` (${activeFilterCount})` : ''}
      </button>

      {compareAgents.length > 0 && (
        <div className={styles.compareTray} role="status" aria-live="polite">
          <span>{compareAgents.length} of 2 selected for comparison</span>
          <button type="button" onClick={() => setCompareAgents([])} aria-label="Clear comparison selection">
            <X size={16} aria-hidden="true" />
          </button>
          {compareAgents.length === 2 && (
            <button
              type="button"
              className={styles.compareAction}
              onClick={() => { setSheetExpanded(false); setMobileSheet('compare') }}
              aria-haspopup="dialog"
            >
              Compare
            </button>
          )}
        </div>
      )}

      {mobileSheet && (
        <>
          <button
            type="button"
            className={styles.sheetBackdrop}
            aria-label="Close panel"
            onClick={() => setMobileSheet(null)}
          />
          <section
            className={`${styles.mobileSheet} ${sheetExpanded ? styles.mobileSheetExpanded : ''}`}
            role="dialog"
            aria-modal="true"
            aria-labelledby="agent-sheet-title"
          >
            <button
              type="button"
              className={styles.sheetHandle}
              onClick={() => setSheetExpanded((expanded) => !expanded)}
              aria-label={sheetExpanded ? 'Snap sheet to half height' : 'Expand sheet to 90 percent height'}
              aria-expanded={sheetExpanded}
            >
              <span />
            </button>
            <div className={styles.sheetHeader}>
              <h2 id="agent-sheet-title">{sheetTitle}</h2>
              <button type="button" className={styles.sheetClose} onClick={() => setMobileSheet(null)} aria-label="Close panel">
                <X size={20} aria-hidden="true" />
              </button>
            </div>

            {mobileSheet === 'filters' && (
              <div className={styles.sheetContent}>
                <AgentFilterBar
                  variant="sheet"
                  filters={filters}
                  availableCapabilities={capabilities}
                  priceDomain={domain}
                  onChange={updateFilters}
                  onReset={resetFilters}
                  onRefresh={refetch}
                />
              </div>
            )}

            {mobileSheet === 'sort' && (
              <div className={styles.sheetContent} role="radiogroup" aria-label="Sort agents">
                {([
                  { key: null, direction: 'desc', label: 'Recommended' },
                  { key: 'price', direction: 'asc', label: 'Price: low to high' },
                  { key: 'price', direction: 'desc', label: 'Price: high to low' },
                  { key: 'reputation', direction: 'desc', label: 'Reputation' },
                ] as const).map((option) => {
                  const checked = filters.sortKey === option.key && (!option.key || filters.sortDir === option.direction)
                  return (
                    <button
                      key={option.label}
                      type="button"
                      className={styles.sortOption}
                      role="radio"
                      aria-checked={checked}
                      onClick={() => chooseSort(option.key, option.direction)}
                    >
                      <span>{option.label}</span>
                      {checked && <Check size={18} aria-hidden="true" />}
                    </button>
                  )
                })}
              </div>
            )}

            {mobileSheet === 'compare' && compareAgents.length === 2 && (
              <div className={`${styles.sheetContent} ${styles.compareContent}`} role="table" aria-label="Agent comparison">
                <div role="row" className={styles.compareRow}>
                  <span role="columnheader">Agent</span>
                  {compareAgents.map((agent) => <strong role="columnheader" key={agent.id}>{agent.name}</strong>)}
                </div>
                <div role="row" className={styles.compareRow}>
                  <span role="rowheader">Price</span>
                  {compareAgents.map((agent) => <span role="cell" key={agent.id}>{agent.price.toFixed(2)} XLM</span>)}
                </div>
                <div role="row" className={styles.compareRow}>
                  <span role="rowheader">Reputation</span>
                  {compareAgents.map((agent) => <span role="cell" key={agent.id}>{agent.reputation.toFixed(1)} / 5</span>)}
                </div>
                <div role="row" className={styles.compareRow}>
                  <span role="rowheader">Capabilities</span>
                  {compareAgents.map((agent) => <span role="cell" key={agent.id}>{agent.capabilities.join(', ') || 'None'}</span>)}
                </div>
                <div role="row" className={styles.compareRow}>
                  <span role="rowheader">Status</span>
                  {compareAgents.map((agent) => <span role="cell" key={agent.id}>{agent.status}</span>)}
                </div>
              </div>
            )}
          </section>
        </>
      )}

      <AgentDetailModal agent={selected} onClose={() => setSelected(null)} />
    </div>
  )
}

export default AgentsPage
