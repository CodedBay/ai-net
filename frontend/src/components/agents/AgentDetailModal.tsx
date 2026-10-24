import { useState, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { ExternalLink, X } from 'lucide-react'
import type { AgentRecord } from '../../types/api'
import { ReputationStars } from './ReputationStars'
import { useAgentReputation } from '../../hooks/useAgentReputation'
import { AgentReputationRadar } from './AgentReputationRadar'
import { AgentReputationTrend } from './AgentReputationTrend'
import { SkeletonText } from '../common/Skeleton'
import { ConfirmDialog } from '../common/ConfirmDialog'
import { useFocusTrap } from '../../hooks/useFocusTrap'
import styles from './AgentDetailModal.module.css'

const STELLAR_EXPLORER = 'https://stellar.expert/explorer/testnet'

interface AgentDetailModalProps {
  agent: AgentRecord | null
  onClose: () => void
  /** Optional: called after the user confirms deregistration */
  onDeregister?: (agentId: string) => void
}

export function AgentDetailModal({ agent, onClose, onDeregister }: AgentDetailModalProps) {
  const { t } = useTranslation()
  const [showDeregisterConfirm, setShowDeregisterConfirm] = useState(false)
  // Called unconditionally (hook rules) — it no-ops on an empty id, which is
  // what the closed-modal case passes.
  const { data: reputationData, loading: reputationLoading } = useAgentReputation(agent?.id ?? '')

  // Focus trap for accessibility (WCAG 2.1 — no keyboard trap, APG dialog pattern)
  const dialogRef = useFocusTrap<HTMLDivElement>(!!agent)

  // Escape key closes the modal (WCAG 2.1 AA — keyboard accessible)
  useEffect(() => {
    if (!agent) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [agent, onClose])

  const handleDeregisterConfirm = () => {
    setShowDeregisterConfirm(false)
    if (agent && onDeregister) onDeregister(agent.id)
    onClose()
  }

  if (!agent) return null

  const titleId = 'agent-detail-modal-title'

  return (
    /* Backdrop */
    <div
      className={styles.overlay}
      onClick={onClose}
      role="presentation"
    >
      {/* Dialog — stops click propagation to backdrop */}
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className={styles.dialog}
        data-testid="agent-detail-modal"
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Close button */}
        <button
          type="button"
          className={styles.closeButton}
          onClick={onClose}
          aria-label={t('common.close', { defaultValue: 'Close' })}
          data-testid="agent-detail-modal-close"
        >
          <X size={18} aria-hidden="true" />
        </button>

        <div className={styles.header}>
          <div>
            <h2 id={titleId} className={styles.title}>{agent.name}</h2>
            <code className={styles.id} title={agent.id}>
              {agent.id}
            </code>
          </div>
        </div>

        <dl className={styles.grid}>
          <div className={styles.field}>
            <dt>{t('common.status')}</dt>
            <dd>
              {/* Status badge: uses text + icon, not color alone (WCAG 1.4.1) */}
              <span
                className={`${styles.status} ${
                  agent.status === 'active' ? styles.statusActive : styles.statusInactive
                }`}
                role="status"
              >
                <span className={styles.statusDot} aria-hidden="true" />
                {t(`agent.status.${agent.status}`, { defaultValue: agent.status })}
              </span>
            </dd>
          </div>

          <div className={styles.field}>
            <dt>{t('common.price')}</dt>
            <dd className={styles.value}>{agent.price.toFixed(2)} XLM</dd>
          </div>

          <div className={styles.field}>
            <dt>{t('common.reputation')}</dt>
            <dd>
              <ReputationStars value={agent.reputation} />
            </dd>
          </div>

          <div className={styles.fieldWide}>
            <dt>{t('common.capabilities')}</dt>
            <dd className={styles.pills}>
              {agent.capabilities.length === 0 ? (
                <span className={styles.value}>—</span>
              ) : (
                agent.capabilities.map((cap) => (
                  <span key={cap} className={styles.pill}>
                    {cap}
                  </span>
                ))
              )}
            </dd>
          </div>

          {agent.endpoint && (
            <div className={styles.fieldWide}>
              <dt>{t('agent.modal.endpoint')}</dt>
              <dd className={styles.mono}>{agent.endpoint}</dd>
            </div>
          )}

          <div className={styles.fieldWide}>
            <dt>{t('agent.modal.registrationTx')}</dt>
            <dd>
              {agent.registrationTxHash ? (
                <a
                  className={styles.txLink}
                  href={`${STELLAR_EXPLORER}/tx/${agent.registrationTxHash}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  data-testid="registration-tx-link"
                >
                  <span className={styles.mono}>{agent.registrationTxHash}</span>
                  <ExternalLink size={14} aria-hidden="true" />
                </a>
              ) : (
                <span className={styles.value}>{t('common.notAvailable')}</span>
              )}
            </dd>
          </div>

          <div className={styles.fieldWide}>
            <dt>Reputation Details</dt>
            <dd>
              {reputationLoading ? (
                <SkeletonText lines={4} />
              ) : reputationData ? (
                <div className={styles.chartsContainer}>
                  <AgentReputationRadar dimensions={reputationData.dimensions} />
                  <AgentReputationTrend history={reputationData.history} />
                </div>
              ) : (
                <div>No detailed reputation data available</div>
              )}
            </dd>
          </div>
        </dl>

        {onDeregister && (
          <div className={styles.dangerZone}>
            <button
              type="button"
              className={styles.deregisterButton}
              onClick={() => setShowDeregisterConfirm(true)}
              data-testid="deregister-agent-btn"
            >
              {t('agent.modal.deregister', { defaultValue: 'Deregister Agent' })}
            </button>
          </div>
        )}

        <ConfirmDialog
          open={showDeregisterConfirm}
          title={t('agent.deregisterConfirm.title', { defaultValue: 'Deregister Agent?' })}
          description={t('agent.deregisterConfirm.description', { defaultValue: `You are about to permanently deregister "${agent.name}" from the network.` })}
          consequence={t('agent.deregisterConfirm.consequence', { defaultValue: 'This agent will be removed from the registry. All task history associations will be lost and cannot be recovered.' })}
          confirmLabel={t('agent.deregisterConfirm.confirm', { defaultValue: 'Deregister Agent' })}
          cancelLabel={t('common.cancel', { defaultValue: 'Cancel' })}
          onConfirm={handleDeregisterConfirm}
          onCancel={() => setShowDeregisterConfirm(false)}
        />
      </div>
    </div>
  )
}
