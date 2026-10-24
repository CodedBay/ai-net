import { ArrowDown, ArrowUp, Minus } from 'lucide-react'
import { CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import type { ReputationHistory } from '../../types/agent'
import { AccessibleChart } from '../common/AccessibleChart'
import styles from './ReputationChart.module.css'

interface ReputationChartProps {
  history: ReputationHistory[]
  loading?: boolean
}

interface TooltipProps {
  active?: boolean
  payload?: Array<{ payload: ReputationHistory }>
}

function HistoryTooltip({ active, payload }: TooltipProps) {
  const item = payload?.[0]?.payload
  if (!active || !item) return null

  return (
    <div className={styles.tooltip}>
      <time dateTime={item.date}>{new Date(item.date).toLocaleString()}</time>
      <strong>Score: {item.score.toFixed(2)} / 5</strong>
      <span>Task: {item.taskId ?? 'Task completion'}</span>
    </div>
  )
}

export function ReputationChart({ history, loading = false }: ReputationChartProps) {
  const points = history.map((item) => ({
    ...item,
    label: new Date(item.date).toLocaleString(),
    value: `${item.score.toFixed(2)} / 5`,
    detail: `Task ${item.taskId ?? 'completion'}`,
  }))
  const change = history.length > 1 ? history[history.length - 1].score - history[0].score : 0
  const trend = change > 0.01 ? 'improving' : change < -0.01 ? 'declining' : 'stable'
  const TrendIcon = trend === 'improving' ? ArrowUp : trend === 'declining' ? ArrowDown : Minus
  const trendLabel = trend === 'improving' ? 'Improving' : trend === 'declining' ? 'Declining' : 'Stable'

  return (
    <section className={styles.section} aria-label="Reputation history for the last 30 days">
      <div className={styles.headingRow}>
        <h3 className={styles.heading}>30-day trend</h3>
        <span className={`${styles.trend} ${styles[trend]}`} aria-label={`Trend: ${trendLabel}`}>
          <TrendIcon size={14} aria-hidden="true" />
          {trendLabel}
        </span>
      </div>
      {loading ? (
        <div className={styles.skeleton} role="status" aria-label="Loading reputation history" />
      ) : history.length === 0 ? (
        <p className={styles.empty}>No reputation events in the last 30 days.</p>
      ) : (
        <div className={styles.chart}>
          <AccessibleChart
            label="Agent reputation history, with task completion events over the last 30 days"
            points={points}
          >
            <ResponsiveContainer width="100%" height={120}>
              <LineChart data={history} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
                <CartesianGrid stroke="var(--border-color, #334155)" strokeDasharray="3 4" vertical={false} />
                <XAxis
                  dataKey="date"
                  tickFormatter={(value: string) => new Date(value).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}
                  tick={{ fill: 'var(--text-secondary, #94a3b8)', fontSize: 11 }}
                  axisLine={false}
                  tickLine={false}
                  minTickGap={24}
                />
                <YAxis
                  domain={[0, 5]}
                  width={28}
                  tick={{ fill: 'var(--text-secondary, #94a3b8)', fontSize: 11 }}
                  axisLine={false}
                  tickLine={false}
                  tickCount={3}
                />
                <Tooltip content={<HistoryTooltip />} />
                <Line
                  type="monotone"
                  dataKey="score"
                  stroke="var(--accent-info, #38bdf8)"
                  strokeWidth={2}
                  dot={{ r: 3, fill: 'var(--accent-info, #38bdf8)' }}
                  activeDot={{ r: 5 }}
                  isAnimationActive={false}
                />
              </LineChart>
            </ResponsiveContainer>
          </AccessibleChart>
        </div>
      )}
    </section>
  )
}
