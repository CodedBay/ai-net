/**
 * PipelineStepIndicator
 *
 * Horizontal step indicator for multi-agent task pipelines shown on
 * TaskDetailPage. Each agent is rendered as a 32-px circle with a status
 * icon and a connector line between steps. Clicking a completed step opens
 * an inline output panel with the agent's result.
 *
 * Props
 * ─────
 *   nodes        – ordered list of DAGNode items from useNodeState
 *   pipelineStart – ISO timestamp when the first node started (for elapsed)
 *
 * Step states
 * ───────────
 *   pending  → gray circle
 *   running  → pulsing blue circle  (CSS animation)
 *   completed→ green circle with checkmark; connector line turns green
 *   failed   → red circle with X
 *
 * Accessibility
 * ─────────────
 *   - Each step button has aria-label describing agent name and status.
 *   - Output panel is announced via aria-live="polite".
 *   - Reduced-motion users get no animation (CSS media query).
 */

import React, { useState, useEffect, useRef } from 'react';
import { CheckCircle2, XCircle, Loader2, Clock, X, ChevronRight } from 'lucide-react';
import type { DAGNode } from '../../types/api';
import styles from './PipelineStepIndicator.module.css';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface PipelineStepIndicatorProps {
  /** Ordered array of DAG nodes representing the pipeline stages. */
  nodes: DAGNode[];
  /** ISO timestamp of when the first node started (for total elapsed). */
  pipelineStart?: string;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Format elapsed milliseconds as "Xm Ys" (e.g. "1m 32s") or "Xs" for < 60 s.
 * Returns an empty string when ms is undefined / NaN.
 */
function formatElapsed(ms: number | undefined): string {
  if (ms === undefined || isNaN(ms) || ms < 0) return '';
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return `${m}m ${s % 60}s`;
}

/**
 * Derive the per-step elapsed from node metadata.  The coordinator attaches
 * `startedAt` / `completedAt` ISO timestamps to each node's `result` payload
 * when available. Falls back to an empty string when absent.
 */
function nodeElapsed(node: DAGNode): string {
  const r = node.result as Record<string, unknown> | undefined;
  if (!r) return '';
  const start = r['startedAt'] as string | undefined;
  const end = r['completedAt'] as string | undefined;
  if (start && end) {
    return formatElapsed(new Date(end).getTime() - new Date(start).getTime());
  }
  return '';
}

/**
 * Determine how many nodes have completed for the compact-bar percentage.
 */
function completionPercent(nodes: DAGNode[]): number {
  if (!nodes.length) return 0;
  const done = nodes.filter(n => n.status === 'completed' || n.status === 'failed').length;
  return Math.round((done / nodes.length) * 100);
}

/** Returns a user-friendly label by stripping "node_" / "node-" prefixes. */
function cleanLabel(nodeId: string, agentType?: string): string {
  if (agentType) return agentType;
  return nodeId.replace(/^node[_-]/, '');
}

// ── Status icon ───────────────────────────────────────────────────────────────

const StatusIcon: React.FC<{ status: DAGNode['status'] }> = ({ status }) => {
  switch (status) {
    case 'completed':
      return <CheckCircle2 size={14} aria-hidden="true" />;
    case 'failed':
      return <XCircle size={14} aria-hidden="true" />;
    case 'running':
      return <Loader2 size={14} className="animate-spin" aria-hidden="true" />;
    default:
      return null;
  }
};

// ── Output panel ──────────────────────────────────────────────────────────────

interface OutputPanelProps {
  node: DAGNode;
  onClose: () => void;
}

const OutputPanel: React.FC<OutputPanelProps> = ({ node, onClose }) => {
  const label = cleanLabel(node.nodeId, node.agentType);
  const elapsed = nodeElapsed(node);

  // Pretty-print the result if it's an object; otherwise show as string.
  let content: string;
  try {
    content =
      typeof node.result === 'object' && node.result !== null
        ? JSON.stringify(node.result, null, 2)
        : String(node.result ?? '—');
  } catch {
    content = String(node.result ?? '—');
  }

  return (
    <div
      className={styles.outputPanel}
      role="region"
      aria-label={`${label} agent output`}
      aria-live="polite"
    >
      <div className={styles.outputPanelHeader}>
        <span className={styles.outputPanelTitle}>
          <ChevronRight size={12} style={{ display: 'inline', verticalAlign: 'middle' }} />
          {' '}{label}
          {elapsed && (
            <span className={styles.elapsed} style={{ marginLeft: '0.4rem' }}>
              ({elapsed})
            </span>
          )}
        </span>
        <button
          className={styles.closeButton}
          onClick={onClose}
          aria-label="Close output panel"
        >
          <X size={12} />
        </button>
      </div>
      <pre>{content}</pre>
    </div>
  );
};

// ── Main component ────────────────────────────────────────────────────────────

export const PipelineStepIndicator: React.FC<PipelineStepIndicatorProps> = ({
  nodes,
  pipelineStart,
}) => {
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [totalElapsed, setTotalElapsed] = useState<string>('');
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Tick total elapsed when the pipeline is running
  useEffect(() => {
    if (!pipelineStart) {
      setTotalElapsed('');
      return;
    }

    const update = () => {
      const ms = Date.now() - new Date(pipelineStart).getTime();
      setTotalElapsed(formatElapsed(ms));
    };

    update();
    intervalRef.current = setInterval(update, 1000);

    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, [pipelineStart]);

  // Close output panel when the selected node's ID leaves the list
  useEffect(() => {
    if (selectedNodeId && !nodes.find(n => n.nodeId === selectedNodeId)) {
      setSelectedNodeId(null);
    }
  }, [nodes, selectedNodeId]);

  if (!nodes.length) return null;

  const pct = completionPercent(nodes);
  const overallFailed = nodes.some(n => n.status === 'failed');
  const overallComplete = nodes.every(n => n.status === 'completed');

  const selectedNode = nodes.find(n => n.nodeId === selectedNodeId) ?? null;

  return (
    <div className={styles.container} data-testid="pipeline-step-indicator">
      {/* Header row */}
      <div className={styles.header}>
        <span className={styles.title}>
          <Clock size={13} aria-hidden="true" />
          Pipeline Progress
        </span>
        {totalElapsed && (
          <span className={styles.elapsed} aria-label={`Total elapsed: ${totalElapsed}`}>
            {totalElapsed}
          </span>
        )}
      </div>

      {/* ── Desktop: full step track ── */}
      <div
        className={styles.track}
        role="list"
        aria-label="Pipeline steps"
      >
        {nodes.map((node, index) => {
          const label = cleanLabel(node.nodeId, node.agentType);
          const stepElapsed = node.status === 'completed' ? nodeElapsed(node) : '';
          const isClickable = node.status === 'completed';
          const isSelected = selectedNodeId === node.nodeId;

          const iconClass = [
            styles.icon,
            styles[`icon--${node.status === 'running' ? 'active' : node.status === 'completed' ? 'complete' : node.status === 'failed' ? 'failed' : 'pending'}`],
          ].join(' ');

          const stepClass = [
            styles.step,
            styles[`step--${node.status === 'running' ? 'active' : node.status === 'completed' ? 'complete' : node.status === 'failed' ? 'failed' : 'pending'}`],
            isClickable ? styles['step--clickable'] : '',
          ].filter(Boolean).join(' ');

          const isConnectorComplete = index < nodes.length - 1 &&
            (nodes[index + 1].status === 'completed' || nodes[index + 1].status === 'running');

          return (
            <React.Fragment key={node.nodeId}>
              <div
                role="listitem"
                aria-label={`${label}: ${node.status}`}
                className={stepClass}
                onClick={isClickable ? () => setSelectedNodeId(isSelected ? null : node.nodeId) : undefined}
                onKeyDown={isClickable ? (e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    setSelectedNodeId(isSelected ? null : node.nodeId);
                  }
                } : undefined}
                tabIndex={isClickable ? 0 : undefined}
                aria-expanded={isClickable ? isSelected : undefined}
              >
                <div className={iconClass}>
                  <StatusIcon status={node.status} />
                  {node.status === 'pending' && (
                    <span aria-hidden="true">{index + 1}</span>
                  )}
                </div>
                <span
                  className={styles.label}
                  title={label}
                  aria-hidden="true"
                >
                  {label}
                </span>
                {stepElapsed && (
                  <span className={styles.stepElapsed} aria-hidden="true">
                    {stepElapsed}
                  </span>
                )}
              </div>

              {/* Connector line (not after last step) */}
              {index < nodes.length - 1 && (
                <div
                  className={[
                    styles.connector,
                    isConnectorComplete ? styles['connector--complete'] : '',
                  ].filter(Boolean).join(' ')}
                  aria-hidden="true"
                />
              )}
            </React.Fragment>
          );
        })}
      </div>

      {/* ── Mobile: compact progress bar ── */}
      <div className={styles.compactBar} aria-hidden="true">
        <div className={styles.compactBarLabel}>
          <span>
            {nodes.filter(n => n.status === 'completed').length}/{nodes.length} steps
          </span>
          <span>{pct}%</span>
        </div>
        <div className={styles.compactBarTrack}>
          <div
            className={[
              styles.compactBarFill,
              overallComplete ? styles['compactBarFill--complete'] : '',
              overallFailed ? styles['compactBarFill--failed'] : '',
            ].filter(Boolean).join(' ')}
            style={{ width: `${pct}%` }}
          />
        </div>
      </div>

      {/* ── Output side panel ── */}
      {selectedNode && selectedNode.status === 'completed' && (
        <OutputPanel
          node={selectedNode}
          onClose={() => setSelectedNodeId(null)}
        />
      )}
    </div>
  );
};

export default PipelineStepIndicator;
