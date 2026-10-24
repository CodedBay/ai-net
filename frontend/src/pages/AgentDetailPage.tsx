/**
 * AgentDetailPage
 *
 * Full detail view for a single registered agent at route /agents/:id.
 *
 * Sections:
 *  - Header: avatar (from address hash), name, status badge, wallet address + copy
 *  - Capability tags: chips for each declared capability
 *  - Pricing card: per-task price in XLM
 *  - Reputation panel: score gauge (0–100), dimensions, history sparkline
 *  - Recent task history placeholder (paginated in future)
 *  - "Hire this agent" CTA that pre-fills the task submission form
 *
 * Issue #14 — Agent Registry Browser / Agent Detail Page
 */

import React, { useCallback } from 'react'
import { useParams, useNavigate, Link } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { Star, Zap, DollarSign, Activity, ExternalLink } from 'lucide-react'

import { useAgentDetail } from '../hooks/useAgentDetail'
import { useBreadcrumbLabel } from '../components/layout/Breadcrumb'
import { CopyButton } from '../components/common/CopyButton'
import { Skeleton, SkeletonText, SkeletonCard } from '../components/common/Skeleton'
import { EmptyState } from '../components/common/EmptyState'
import styles from './AgentDetailPage.module.css'

const STELLAR_EXPLORER = 'https://stellar.expert/explorer/testnet'

function idToHue(id: string): number {
  let hash = 0
  for (let i = 0; i < id.length; i++) {
    hash = ((hash << 5) - hash + id.charCodeAt(i)) | 0
  }
  return Math.abs(hash) % 360
}

function truncateAddress(address: string, head = 8, tail = 4): string {
  if (address.length <= head + tail + 3) return address
  return `${address.slice(0, head)}…${address.slice(-tail)}`
}

const CAPABILITY_COLORS: Record<string, string> = {
  research: '#3b82f6',
  risk: '#f59e0b',
  coding: '#10b981',
  design: '#8b5cf6',
  report: '#ef4444',
  audit: '#f97316',
}

function StatusBadge({ status }: { status: string }) {
  const isOnline = status === 'active'
  const cls = isOnline ? styles.statusOnline : styles.statusOffline
  return (
    <span
      className={`${styles.statusBadge} ${cls}`}
      role="status"
      aria-live="polite"
      data-testid="agent-status-badge"
    >
      <span className={styles.statusDot} aria-hidden="true" />
      <span>{isOnline ? 'Online' : 'Offline'}</span>
    </span>
  )
}

function ScoreGauge({ score }: { score: number }) {
  const clamped = Math.max(0, Math.min(100, score))
  const r = 36
  const circumference = 2 * Math.PI * r
  const offset = circumference - (clamped / 100) * circumference
  const color = clamped >= 80 ? '#10b981' : clamped >= 50 ? '#f59e0b' : '#ef4444'
  return (
    <div className={styles.gauge} aria-label={`Reputation score: ${clamped} out of 100`}>
      <svg viewBox="0 0 80 80" width={80} height={80} aria-hidden="true">
        <circle cx="40" cy="40" r={r} fill="none" stroke="var(--border-color,#334155)" strokeWidth="6" />
        <circle
          cx="40" cy="40" r={r} fill="none" stroke={color} strokeWidth="6"
          strokeDasharray={circumference} strokeDashoffset={offset}
          strokeLinecap="round" transform="rotate(-90 40 40)"
        />
      </svg>
      <span className={styles.gaugeLabel}>{clamped}</span>
    </div>
  )
}

function HeaderSkeleton() {
  return (
    <div className={styles.header} aria-hidden="true" data-testid="header-skeleton">
      <Skeleton variant="circular" width={64} height={64} />
      <div className={styles.headerInfo}>
        <Skeleton width="14rem" height="1.75rem" style={{ marginBottom: '0.5rem' }} />
        <Skeleton width="20rem" height="1rem" />
      </div>
      <Skeleton variant="pill" width="5.5rem" height="2rem" />
    </div>
  )
}

function CapabilitiesSkeleton() {
  return (
    <div className={styles.section} aria-hidden="true" data-testid="capabilities-skeleton">
      <Skeleton width="8rem" height="0.875rem" style={{ marginBottom: '0.75rem' }} />
      <div className={styles.capabilityRow}>
        {[5, 4, 6].map((w, i) => (
          <Skeleton key={i} variant="pill" width={`${w}rem`} height="1.75rem" />
        ))}
      </div>
    </div>
  )
}

function PricingSkeleton() {
  return (
    <SkeletonCard className={styles.pricingCard} data-testid="pricing-skeleton">
      <Skeleton width="6rem" height="0.875rem" style={{ marginBottom: '0.75rem' }} />
      <Skeleton width="8rem" height="2.5rem" style={{ marginBottom: '0.5rem' }} />
      <Skeleton width="10rem" height="0.75rem" />
    </SkeletonCard>
  )
}

function ReputationSkeleton() {
  return (
    <SkeletonCard className={styles.reputationCard} data-testid="reputation-skeleton">
      <Skeleton width="7rem" height="0.875rem" style={{ marginBottom: '0.75rem' }} />
      <Skeleton variant="circular" width={80} height={80} style={{ margin: '0 auto 1rem' }} />
      <SkeletonText lines={3} />
    </SkeletonCard>
  )
}

const AgentDetailPage: React.FC = () => {
  const { id } = useParams<{ id: string }>()
  const { t } = useTranslation()
  const navigate = useNavigate()
  const { agent, reputation, reputationHistory, reputationHistoryLoading, agentLoading, reputationLoading, error, notFound } =
    useAgentDetail(id ?? '')
  useBreadcrumbLabel(agent?.name ?? `Agent ${id ?? ''}`)

  const handleHire = useCallback(() => {
    if (!id) return
    navigate(`/tasks/new?agentHints=${encodeURIComponent(id)}`)
  }, [id, navigate])

  if (notFound) {
    return (
      <div className={styles.page} data-testid="agent-not-found">
        <EmptyState
          title={t('page.agentDetail.notFound', { defaultValue: 'Agent not found' })}
          description={t('page.agentDetail.notFoundDesc', {
            defaultValue: 'No agent with this ID exists in the registry.',
          })}
          primaryAction={{
            label: t('page.agentDetail.browseRegistry', { defaultValue: 'Browse Registry' }),
            to: '/agents',
          }}
        />
      </div>
    )
  }

  if (error && !agentLoading) {
    return (
      <div className={styles.page} data-testid="agent-error">
        <div className={styles.errorBox} role="alert">
          <p>{error}</p>
          <Link to="/agents" className={styles.backLink}>
            ← {t('page.agentDetail.browseRegistry', { defaultValue: 'Browse Registry' })}
          </Link>
        </div>
      </div>
    )
  }

  const hue = idToHue(id ?? 'unknown')

  return (
    <div className={styles.page} data-testid="agent-detail-page">
      {/* Header */}
      {agentLoading ? (
        <HeaderSkeleton />
      ) : agent ? (
        <div className={styles.header} data-testid="agent-header">
          <div
            className={styles.avatar}
            style={{ background: `hsl(${hue},65%,45%)` }}
            aria-hidden="true"
          >
            <Zap size={28} color="#fff" />
          </div>
          <div className={styles.headerInfo}>
            <h1 className={styles.agentName}>{agent.name}</h1>
            <div className={styles.addressRow}>
              <code className={styles.address} title={agent.id} data-testid="agent-address">
                {truncateAddress(agent.id)}
              </code>
              <CopyButton text={agent.id} label="Copy ID" copiedLabel="Copied!" iconSize={13} />
              {agent.registrationTxHash && (
                <a
                  href={`${STELLAR_EXPLORER}/tx/${agent.registrationTxHash}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className={styles.explorerLink}
                  aria-label="View on Stellar Explorer"
                >
                  <ExternalLink size={14} aria-hidden="true" />
                </a>
              )}
            </div>
          </div>
          <StatusBadge status={agent.status} />
        </div>
      ) : null}

      {/* Capability tags */}
      {agentLoading ? (
        <CapabilitiesSkeleton />
      ) : agent ? (
        <section
          className={styles.section}
          aria-labelledby="capabilities-heading"
          data-testid="capabilities-section"
        >
          <h2 id="capabilities-heading" className={styles.sectionHeading}>
            {t('common.capabilities', { defaultValue: 'Capabilities' })}
          </h2>
          <div className={styles.capabilityRow} role="list">
            {agent.capabilities.length === 0 ? (
              <span className={styles.emptyText}>{t('common.none', { defaultValue: 'None' })}</span>
            ) : (
              agent.capabilities.map((cap) => (
                <span
                  key={cap}
                  role="listitem"
                  className={styles.capabilityTag}
                  style={{
                    borderColor: CAPABILITY_COLORS[cap.toLowerCase()] ?? 'var(--border-color)',
                    color: CAPABILITY_COLORS[cap.toLowerCase()] ?? 'var(--text-secondary)',
                  }}
                  data-testid={`capability-${cap}`}
                >
                  {cap}
                </span>
              ))
            )}
          </div>
        </section>
      ) : null}

      {/* Pricing + Reputation two-column */}
      <div className={styles.twoCol}>
        {agentLoading ? (
          <PricingSkeleton />
        ) : agent ? (
          <section
            className={styles.pricingCard}
            aria-labelledby="pricing-heading"
            data-testid="pricing-section"
          >
            <h2 id="pricing-heading" className={styles.cardHeading}>
              <DollarSign size={16} aria-hidden="true" />
              {t('page.agentDetail.pricing', { defaultValue: 'Pricing' })}
            </h2>
            <div className={styles.priceMain}>
              <span className={styles.priceValue} data-testid="agent-price">
                {agent.price.toFixed(2)}
              </span>
              <span className={styles.priceUnit}>XLM</span>
              <span className={styles.priceLabel}>
                {t('page.agentDetail.perTask', { defaultValue: 'per task' })}
              </span>
            </div>
          </section>
        ) : null}

        {reputationLoading ? (
          <ReputationSkeleton />
        ) : (
          <section
            className={styles.reputationCard}
            aria-labelledby="reputation-heading"
            data-testid="reputation-section"
          >
            <h2 id="reputation-heading" className={styles.cardHeading}>
              <Star size={16} aria-hidden="true" />
              {t('common.reputation', { defaultValue: 'Reputation' })}
            </h2>
            <div className={styles.gaugeWrapper}>
              <ScoreGauge score={agent ? agent.reputation * 20 : 0} />
            </div>
            {reputation?.dimensions && (
              <dl className={styles.dimensionGrid}>
                {Object.entries(reputation.dimensions).map(([key, val]) => (
                  <div key={key} className={styles.dimension}>
                    <dt className={styles.dimensionLabel}>{key}</dt>
                    <dd className={styles.dimensionBar}>
                      <div
                        className={styles.dimensionFill}
                        style={{ width: `${Math.round((val as number) * 100)}%` }}
                        role="img"
                        aria-label={`${key}: ${Math.round((val as number) * 100)}%`}
                      />
                    </dd>
                  </div>
                ))}
              </dl>
            )}
            <ReputationChart
              history={reputationHistory ?? []}
              loading={reputationHistoryLoading}
            />
          </section>
        )}
      </div>

      {/* Task history */}
      <section
        className={styles.section}
        aria-labelledby="history-heading"
        data-testid="task-history-section"
      >
        <h2 id="history-heading" className={styles.sectionHeading}>
          <Activity size={16} aria-hidden="true" />
          {t('page.agentDetail.recentTasks', { defaultValue: 'Recent Task History' })}
        </h2>
        {agentLoading ? (
          <SkeletonText lines={5} />
        ) : (
          <p className={styles.emptyText} data-testid="task-history-placeholder">
            {t('page.agentDetail.historyComingSoon', {
              defaultValue:
                'Task history will appear here once this agent has completed tasks.',
            })}
          </p>
        )}
      </section>

      {/* Hire CTA */}
      {!agentLoading && agent && (
        <div className={styles.ctaRow} data-testid="hire-cta">
          <button
            type="button"
            className={styles.hireButton}
            onClick={handleHire}
            disabled={agent.status !== 'active'}
            aria-disabled={agent.status !== 'active'}
            data-testid="hire-agent-btn"
          >
            {agent.status === 'active'
              ? t('agent.hire', { defaultValue: 'Hire this Agent' })
              : t('agent.offline', { defaultValue: 'Agent Offline' })}
          </button>
          <Link to="/agents" className={styles.browseLink} data-testid="browse-registry-link">
            {t('page.agentDetail.browseRegistry', { defaultValue: 'Browse Registry' })}
          </Link>
        </div>
      )}
    </div>
  )
}

export default AgentDetailPage
