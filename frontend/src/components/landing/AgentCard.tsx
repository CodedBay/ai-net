import React from 'react'
import { useTranslation } from 'react-i18next'
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion'
import { formatNumber } from '../../utils/format'
import { agentCardPress, cardEntrance, selectionBadge } from '../../utils/animationPresets'
import { Check, Star } from 'lucide-react'

export interface AgentData {
  id: string
  name: string
  type: string
  description: string
  icon: React.ReactNode
  tasksCompleted: number
  successRate: number
  capabilities?: string[]
  isOnline?: boolean
  lastHeartbeat?: number
  reputation?: number
}

interface AgentCardProps {
  agent: AgentData
  index: number
  selected?: boolean
  onSelect?: (agent: AgentData) => void
}

function formatHeartbeatAge(lastHeartbeat?: number): string {
  if (!lastHeartbeat) return ''
  const now = Date.now()
  const diffMs = now - lastHeartbeat
  const seconds = Math.floor(diffMs / 1000)
  if (seconds < 60) return `${seconds}s ago`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  return `${hours}h ago`
}

const capabilityTokens: Record<string, { color: string; surface: string; border: string }> = {
  research: {
    color: 'var(--agent-research)',
    surface: 'var(--agent-research-surface)',
    border: 'var(--agent-research-border)',
  },
  risk: {
    color: 'var(--agent-risk)',
    surface: 'var(--agent-risk-surface)',
    border: 'var(--agent-risk-border)',
  },
  coding: {
    color: 'var(--agent-coding)',
    surface: 'var(--agent-coding-surface)',
    border: 'var(--agent-coding-border)',
  },
  design: {
    color: 'var(--agent-design)',
    surface: 'var(--agent-design-surface)',
    border: 'var(--agent-design-border)',
  },
  report: {
    color: 'var(--agent-report)',
    surface: 'var(--agent-report-surface)',
    border: 'var(--agent-report-border)',
  },
}

function CapabilityBadges({ capabilities }: { capabilities: string[] }) {
  return (
    <div className="flex flex-wrap gap-1.5 mb-3">
      {capabilities.map((cap) => {
        const tokens = capabilityTokens[cap]
        const badgeStyle: React.CSSProperties = tokens
          ? {
              color: tokens.color,
              backgroundColor: tokens.surface,
              borderColor: tokens.border,
            }
          : {
              color: 'var(--text-secondary)',
              backgroundColor: 'var(--agent-default-surface)',
              borderColor: 'var(--agent-default-border)',
            }
        return (
          <span
            key={cap}
            className="text-[9px] font-bold uppercase tracking-wider px-2 py-0.5 rounded-full border"
            style={badgeStyle}
            title={cap}
          >
            {cap}
          </span>
        )
      })}
    </div>
  )
}

function ReputationStars({ rating }: { rating: number }) {
  const stars = Math.round((rating / 100) * 5)
  return (
    <div className="flex items-center gap-0.5" title={`Reputation: ${rating}/100`}>
      {Array.from({ length: 5 }, (_, i) => (
        <Star
          key={i}
          size={10}
          className={i < stars ? 'text-warning fill-warning' : 'text-text-secondary/30'}
        />
      ))}
    </div>
  )
}

const AgentCard: React.FC<AgentCardProps> = ({ agent, index, selected = false, onSelect }) => {
  const { t, i18n } = useTranslation()
  const prefersReducedMotion = useReducedMotion()
  const isOnline = agent.isOnline ?? true
  const capabilities = agent.capabilities ?? []

  return (
    <motion.div
      className={`agent-card-interactive bg-background-surface border border-border-subtle rounded-2xl p-5 flex flex-col group relative overflow-hidden ${onSelect ? 'cursor-pointer' : ''} ${selected ? 'agent-card-selected' : ''}`}
      variants={prefersReducedMotion ? undefined : cardEntrance(index)}
      initial={prefersReducedMotion ? false : 'hidden'}
      whileInView={prefersReducedMotion ? undefined : 'visible'}
      viewport={{ once: true, margin: '-30px' }}
      whileHover={prefersReducedMotion ? undefined : { y: -2, transition: { duration: 0.15, ease: 'easeOut' } }}
      whileTap={onSelect && !prefersReducedMotion ? agentCardPress : undefined}
      role={onSelect ? 'button' : undefined}
      tabIndex={onSelect ? 0 : undefined}
      aria-pressed={onSelect ? selected : undefined}
      onClick={onSelect ? () => onSelect(agent) : undefined}
      onKeyDown={onSelect ? (event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault()
          onSelect(agent)
        }
      } : undefined}
    >
      <AnimatePresence>
        {selected && (
          <motion.span
            className="agent-card-selection-badge"
            variants={prefersReducedMotion ? undefined : selectionBadge}
            initial={prefersReducedMotion ? false : 'hidden'}
            animate="visible"
            exit={prefersReducedMotion ? undefined : 'exit'}
            aria-label="Selected for comparison"
          >
            <Check size={14} aria-hidden="true" />
          </motion.span>
        )}
      </AnimatePresence>
      <div className="absolute inset-0 bg-gradient-primary opacity-0 group-hover:opacity-[0.03] transition-opacity duration-500" />
      <div className="absolute -inset-px rounded-2xl border border-accent-cyan/0 group-hover:border-accent-cyan/30 transition-all duration-500 pointer-events-none" />

      <div className="flex items-start justify-between mb-3 relative">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-background-surface-alt border border-border-subtle flex items-center justify-center group-hover:border-accent-cyan/30 group-hover:shadow-info-glow transition-all duration-300">
            {agent.icon}
          </div>
          <div className="flex flex-col">
            <h3 className="text-base font-bold text-text-primary group-hover:text-accent-cyan transition-colors duration-300">
              {agent.name}
            </h3>
            <span className="text-[10px] font-bold text-accent-purple uppercase tracking-wider mt-0.5">
              {agent.type}
            </span>
          </div>
        </div>

        <div className="flex items-center gap-2">
          <div className="flex flex-col items-end">
            <span className="text-[9px] text-text-secondary uppercase tracking-wider font-bold">
              {isOnline ? 'Online' : 'Offline'}
            </span>
            {agent.lastHeartbeat && (
              <span className="text-[8px] text-text-secondary/60">
                {formatHeartbeatAge(agent.lastHeartbeat)}
              </span>
            )}
          </div>
          <div
            className={`w-2.5 h-2.5 rounded-full relative ${
              isOnline
                ? 'bg-accent-green shadow-success-glow'
                : 'bg-text-secondary/40'
            }`}
          >
            {isOnline && (
              <span className="absolute inset-0 rounded-full bg-accent-green animate-ping opacity-75" />
            )}
          </div>
        </div>
      </div>

      {capabilities.length > 0 && <CapabilityBadges capabilities={capabilities} />}

      <p className="text-sm text-text-secondary mb-4 flex-grow line-clamp-3 relative leading-relaxed">
        {agent.description}
      </p>

      <div className="flex items-center justify-between pt-3 border-t border-border-subtle/50 relative">
        <div className="flex flex-col gap-0.5">
          <span className="text-[10px] text-text-secondary uppercase tracking-wider font-bold">{t('agent.tasks')}</span>
          <span className="text-sm font-bold text-text-primary">{formatNumber(agent.tasksCompleted, i18n.language)}</span>
        </div>
        <div className="flex flex-col items-center gap-0.5">
          <span className="text-[10px] text-text-secondary uppercase tracking-wider font-bold">{t('agent.success')}</span>
          <span className="text-sm font-bold text-accent-green">{agent.successRate}%</span>
        </div>
        <div className="flex flex-col items-end gap-0.5">
          <span className="text-[10px] text-text-secondary uppercase tracking-wider font-bold">Rating</span>
          {agent.reputation !== undefined ? (
            <ReputationStars rating={agent.reputation} />
          ) : (
            <span className="text-sm font-bold text-text-secondary">—</span>
          )}
        </div>
      </div>
    </motion.div>
  )
}

export default AgentCard
