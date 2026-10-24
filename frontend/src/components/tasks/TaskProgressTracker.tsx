/**
 * TaskProgressTracker — Live progress tracker for a running pipeline task.
 *
 * Features:
 *  - Polls /api/tasks/:id every 3 seconds while task is active
 *  - Step-by-step timeline with status icons per sub-agent step
 *  - Switches to WebSocket events when available (via useTaskWebSocket)
 *  - Cancel button with confirmation modal
 *  - Displays final result and total cost on completion
 *  - Shows refund amount on cancellation
 */

import React, { useState, useEffect, useCallback, useRef } from 'react';
import {
  CheckCircle2,
  XCircle,
  Clock,
  Loader2,
  AlertCircle,
  Ban,
  RefreshCw,
  DollarSign,
  Wifi,
  WifiOff,
} from 'lucide-react';
import type { TaskResponse, DAGNode, DAGEvent } from '../../types/api';
import { apiClient } from '../../services/api';
import { useTaskWebSocket } from '../../hooks/useTaskWebSocket';
import styles from './TaskProgressTracker.module.css';

// ─── Types ────────────────────────────────────────────────────────────────────

type NodeStatus = 'pending' | 'running' | 'completed' | 'failed' | 'skipped';

interface StepState {
  nodeId: string;
  agentType: string;
  status: NodeStatus;
  startedAt?: string;
  completedAt?: string;
  durationMs?: number;
  error?: string;
  output?: unknown;
}

const AGENT_LABELS: Record<string, string> = {
  research: 'Research',
  risk: 'Risk Analysis',
  coding: 'Coding',
  design: 'Design',
  report: 'Report',
};

const AGENT_COSTS: Record<string, number> = {
  research: 0.5,
  risk: 0.3,
  coding: 1.2,
  design: 0.6,
  report: 0.4,
};

// ─── Helpers ─────────────────────────────────────────────────────────────────

function getAgentLabel(type: string): string {
  return AGENT_LABELS[type.toLowerCase()] ?? type.charAt(0).toUpperCase() + type.slice(1);
}

function getCostForType(type: string): number {
  return AGENT_COSTS[type.toLowerCase()] ?? 0.5;
}

function formatDurationMs(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60_000)}m ${Math.floor((ms % 60_000) / 1000)}s`;
}

function isTerminal(status: TaskResponse['status']): boolean {
  return status === 'completed' || status === 'failed';
}

function computeTotalCost(steps: StepState[]): number {
  return steps
    .filter((s) => s.status === 'completed')
    .reduce((sum, s) => sum + getCostForType(s.agentType), 0);
}

// ─── Status icon ─────────────────────────────────────────────────────────────

interface StatusIconProps {
  status: NodeStatus;
  size?: number;
}

const StatusIcon: React.FC<StatusIconProps> = ({ status, size = 18 }) => {
  switch (status) {
    case 'completed':
      return <CheckCircle2 size={size} className={styles.iconCompleted} aria-hidden="true" />;
    case 'failed':
      return <XCircle size={size} className={styles.iconFailed} aria-hidden="true" />;
    case 'running':
      return <Loader2 size={size} className={`${styles.iconRunning} ${styles.spin}`} aria-hidden="true" />;
    case 'skipped':
      return <Ban size={size} className={styles.iconSkipped} aria-hidden="true" />;
    default:
      return <Clock size={size} className={styles.iconPending} aria-hidden="true" />;
  }
};

// ─── Step row ─────────────────────────────────────────────────────────────────

interface StepRowProps {
  step: StepState;
  isLast: boolean;
}

const StepRow: React.FC<StepRowProps> = ({ step, isLast }) => {
  const label = getAgentLabel(step.agentType);
  const cost = getCostForType(step.agentType);

  return (
    <li
      className={`${styles.step} ${styles[`step_${step.status}`]}`}
      aria-label={`${label}: ${step.status}`}
    >
      {/* Connector line */}
      <div className={styles.connector} aria-hidden="true">
        <div className={styles.iconWrap}>
          <StatusIcon status={step.status} />
        </div>
        {!isLast && <div className={styles.line} />}
      </div>

      {/* Content */}
      <div className={styles.stepContent}>
        <div className={styles.stepHeader}>
          <span className={styles.stepLabel}>{label}</span>
          <span className={`${styles.stepBadge} ${styles[`badge_${step.status}`]}`}>
            {step.status.charAt(0).toUpperCase() + step.status.slice(1)}
          </span>
        </div>

        <div className={styles.stepMeta}>
          {step.status === 'completed' && (
            <>
              {step.durationMs !== undefined && (
                <span className={styles.metaChip}>
                  {formatDurationMs(step.durationMs)}
                </span>
              )}
              <span className={styles.metaChip}>
                <DollarSign size={11} aria-hidden="true" />
                {cost.toFixed(2)} XLM
              </span>
            </>
          )}
          {step.status === 'failed' && step.error && (
            <span className={styles.metaError}>
              <AlertCircle size={12} aria-hidden="true" />
              {step.error}
            </span>
          )}
          {step.status === 'running' && (
            <span className={styles.metaChip}>Running…</span>
          )}
          {step.status === 'pending' && (
            <span className={styles.metaChip}>Waiting</span>
          )}
          {step.status === 'skipped' && (
            <span className={styles.metaChip}>Skipped due to upstream failure</span>
          )}
        </div>
      </div>
    </li>
  );
};

// ─── Cancel modal ─────────────────────────────────────────────────────────────

interface CancelModalProps {
  onConfirm: () => void;
  onClose: () => void;
  isLoading: boolean;
  refundAmount?: number;
}

const CancelModal: React.FC<CancelModalProps> = ({
  onConfirm,
  onClose,
  isLoading,
  refundAmount,
}) => {
  // Trap focus in modal
  const confirmRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    confirmRef.current?.focus();
  }, []);

  return (
    <div
      className={styles.modalOverlay}
      role="dialog"
      aria-modal="true"
      aria-labelledby="cancel-modal-title"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className={styles.modal}>
        <h2 id="cancel-modal-title" className={styles.modalTitle}>
          Cancel this task?
        </h2>
        <p className={styles.modalBody}>
          This will stop execution of all remaining sub-agents. Any completed
          steps will not be refunded.
          {refundAmount !== undefined && refundAmount > 0 && (
            <>
              {' '}
              Estimated refund:{' '}
              <strong>{refundAmount.toFixed(2)} XLM</strong>.
            </>
          )}
        </p>
        <div className={styles.modalActions}>
          <button
            className={styles.btnSecondary}
            onClick={onClose}
            disabled={isLoading}
          >
            Keep running
          </button>
          <button
            ref={confirmRef}
            className={styles.btnDanger}
            onClick={onConfirm}
            disabled={isLoading}
            aria-busy={isLoading}
          >
            {isLoading ? (
              <>
                <Loader2 size={14} className={styles.spin} aria-hidden="true" />
                Cancelling…
              </>
            ) : (
              'Yes, cancel task'
            )}
          </button>
        </div>
      </div>
    </div>
  );
};

// ─── Props ────────────────────────────────────────────────────────────────────

export interface TaskProgressTrackerProps {
  /** The task ID to track. */
  taskId: string;
  /** Called when the user cancels the task successfully. */
  onCancelled?: () => void;
  /** Called when the task completes (success or failure). */
  onCompleted?: (task: TaskResponse) => void;
  /** Polling interval in ms. Defaults to 3000. */
  pollIntervalMs?: number;
}

// ─── Main component ───────────────────────────────────────────────────────────

export const TaskProgressTracker: React.FC<TaskProgressTrackerProps> = ({
  taskId,
  onCancelled,
  onCompleted,
  pollIntervalMs = 3000,
}) => {
  const [task, setTask] = useState<TaskResponse | null>(null);
  const [steps, setSteps] = useState<StepState[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showCancelModal, setShowCancelModal] = useState(false);
  const [isCancelling, setIsCancelling] = useState(false);
  const [cancelledRefund, setCancelledRefund] = useState<number | undefined>(undefined);

  // Track whether we're using WebSocket events (to suppress polling)
  const wsActiveRef = useRef(false);
  const pollingRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const onCompletedRef = useRef(onCompleted);
  useEffect(() => { onCompletedRef.current = onCompleted; }, [onCompleted]);

  // ─── Step init ─────────────────────────────────────────────────────────────

  const initSteps = useCallback((dag: DAGNode[]): StepState[] => {
    return dag.map((node) => ({
      nodeId: node.nodeId,
      agentType: node.agentType || node.nodeId,
      status: (node.status ?? 'pending') as NodeStatus,
    }));
  }, []);

  const mergeStepsFromDag = useCallback(
    (dag: DAGNode[], prev: StepState[]): StepState[] => {
      const byId = new Map(prev.map((s) => [s.nodeId, s]));
      return dag.map((node) => {
        const existing = byId.get(node.nodeId);
        return {
          nodeId: node.nodeId,
          agentType: node.agentType || node.nodeId,
          status: (node.status ?? existing?.status ?? 'pending') as NodeStatus,
          startedAt: existing?.startedAt,
          completedAt: existing?.completedAt,
          durationMs: existing?.durationMs,
          error: node.error ?? existing?.error,
          output: node.result ?? existing?.output,
        };
      });
    },
    [],
  );

  // ─── Fetch task ────────────────────────────────────────────────────────────

  const fetchTask = useCallback(async () => {
    try {
      const data = await apiClient.get<TaskResponse>(`/api/tasks/${taskId}`);
      setTask(data);
      setSteps((prev) =>
        prev.length === 0
          ? initSteps(data.dag ?? [])
          : mergeStepsFromDag(data.dag ?? [], prev),
      );
      setError(null);

      if (isTerminal(data.status)) {
        onCompletedRef.current?.(data);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to fetch task');
    } finally {
      setLoading(false);
    }
  }, [taskId, initSteps, mergeStepsFromDag]);

  // ─── Polling ──────────────────────────────────────────────────────────────

  const scheduleNextPoll = useCallback(() => {
    if (pollingRef.current) clearTimeout(pollingRef.current);
    pollingRef.current = setTimeout(() => {
      if (!wsActiveRef.current) {
        fetchTask().then(() => {
          // Continue polling if task is not terminal
          setTask((current) => {
            if (current && !isTerminal(current.status)) {
              scheduleNextPoll();
            }
            return current;
          });
        });
      }
    }, pollIntervalMs);
  }, [fetchTask, pollIntervalMs]);

  // ─── Initial load + polling ───────────────────────────────────────────────

  useEffect(() => {
    let cancelled = false;

    const load = async () => {
      try {
        const data = await apiClient.get<TaskResponse>(`/api/tasks/${taskId}`);
        if (cancelled) return;
        setTask(data);
        setSteps(initSteps(data.dag ?? []));
        setError(null);
        setLoading(false);

        if (isTerminal(data.status)) {
          onCompletedRef.current?.(data);
        } else if (!wsActiveRef.current) {
          scheduleNextPoll();
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'Failed to fetch task');
          setLoading(false);
        }
      }
    };

    load();

    return () => {
      cancelled = true;
      if (pollingRef.current) clearTimeout(pollingRef.current);
    };
  }, [taskId, initSteps, scheduleNextPoll]);

  // ─── WebSocket events ─────────────────────────────────────────────────────

  const handleWsMessage = useCallback((event: DAGEvent) => {
    wsActiveRef.current = true;
    if (pollingRef.current) clearTimeout(pollingRef.current);

    const nodeId = event.nodeId;

    setSteps((prev) => {
      if (!nodeId) return prev;
      return prev.map((s) => {
        if (s.nodeId !== nodeId) return s;
        const now = new Date().toISOString();

        switch (event.type) {
          case 'node_started':
            return { ...s, status: 'running', startedAt: event.timestamp ?? now };

          case 'node_completed': {
            const startMs = s.startedAt ? new Date(s.startedAt).getTime() : null;
            const endMs = event.timestamp ? new Date(event.timestamp).getTime() : Date.now();
            return {
              ...s,
              status: 'completed',
              completedAt: event.timestamp ?? now,
              durationMs: startMs !== null ? endMs - startMs : undefined,
              output: event.payload,
            };
          }

          case 'node_failed':
            return {
              ...s,
              status: 'failed',
              completedAt: event.timestamp ?? now,
              error:
                typeof event.payload === 'object' && event.payload !== null
                  ? String((event.payload as Record<string, unknown>).error ?? 'Unknown error')
                  : 'Unknown error',
            };

          default:
            return s;
        }
      });
    });

    if (event.type === 'task_completed' || event.type === 'task_failed') {
      setTask((prev) => {
        if (!prev) return prev;
        const updated: TaskResponse = {
          ...prev,
          status: event.type === 'task_completed' ? 'completed' : 'failed',
        };
        onCompletedRef.current?.(updated);
        return updated;
      });
    }
  }, []);

  const { isConnected: wsConnected } = useTaskWebSocket({
    taskId,
    onMessage: handleWsMessage,
  });

  // ─── Cancel ───────────────────────────────────────────────────────────────

  const handleCancelConfirm = useCallback(async () => {
    setIsCancelling(true);
    try {
      await apiClient.delete(`/api/tasks/${taskId}`);
      setTask((prev) => (prev ? { ...prev, status: 'failed' } : prev));
      // We don't know the original budget here; show completed cost as spent
      setCancelledRefund(0); // placeholder — backend determines actual refund
      setShowCancelModal(false);
      onCancelled?.();
    } catch (err) {
      // Show error in modal
      setIsCancelling(false);
    }
  }, [taskId, onCancelled]);

  // ─── Derived state ────────────────────────────────────────────────────────

  const totalCost = computeTotalCost(steps);
  const completedCount = steps.filter((s) => s.status === 'completed').length;
  const progressPct =
    steps.length > 0 ? Math.round((completedCount / steps.length) * 100) : 0;
  const isTaskTerminal = task ? isTerminal(task.status) : false;
  const canCancel = task?.status === 'queued' || task?.status === 'running';

  // Potential refund = cost of non-started nodes
  const potentialRefund = steps
    .filter((s) => s.status === 'pending')
    .reduce((sum, s) => sum + getCostForType(s.agentType), 0);

  // ─── Loading skeleton ─────────────────────────────────────────────────────

  if (loading) {
    return (
      <div className={styles.container} aria-busy="true" aria-label="Loading task progress">
        <div className={styles.header}>
          <div className={`${styles.skeleton} ${styles.skeletonTitle}`} />
          <div className={`${styles.skeleton} ${styles.skeletonBadge}`} />
        </div>
        <div className={styles.progressBar} aria-hidden="true">
          <div className={styles.progressFill} style={{ width: '0%' }} />
        </div>
        <ul className={styles.stepList}>
          {Array.from({ length: 3 }).map((_, i) => (
            <li key={i} className={styles.step}>
              <div className={styles.connector}>
                <div className={`${styles.iconWrap} ${styles.skeleton}`} />
                {i < 2 && <div className={styles.line} />}
              </div>
              <div className={styles.stepContent}>
                <div className={`${styles.skeleton} ${styles.skeletonLine}`} />
              </div>
            </li>
          ))}
        </ul>
      </div>
    );
  }

  // ─── Error state ──────────────────────────────────────────────────────────

  if (error && !task) {
    return (
      <div className={styles.container} role="alert">
        <div className={styles.errorState}>
          <AlertCircle size={24} aria-hidden="true" />
          <p>{error}</p>
          <button
            className={styles.btnSecondary}
            onClick={() => { setLoading(true); setError(null); fetchTask(); }}
          >
            <RefreshCw size={14} aria-hidden="true" />
            Retry
          </button>
        </div>
      </div>
    );
  }

  // ─── Render ───────────────────────────────────────────────────────────────

  return (
    <div className={styles.container}>
      {/* Header */}
      <div className={styles.header}>
        <div className={styles.headerLeft}>
          <h2 className={styles.title}>Task Progress</h2>
          <span className={styles.taskId} title={taskId}>
            #{taskId.slice(-8)}
          </span>
        </div>
        <div className={styles.headerRight}>
          {/* WebSocket connectivity indicator */}
          {wsConnected ? (
            <span className={styles.wsIndicator} title="Live updates active">
              <Wifi size={13} aria-hidden="true" />
              Live
            </span>
          ) : (
            <span className={`${styles.wsIndicator} ${styles.wsIndicatorOff}`} title="Polling for updates">
              <WifiOff size={13} aria-hidden="true" />
              Polling
            </span>
          )}

          {/* Task status badge */}
          {task && (
            <span className={`${styles.statusBadge} ${styles[`badge_${task.status}`]}`}>
              {task.status.charAt(0).toUpperCase() + task.status.slice(1)}
            </span>
          )}
        </div>
      </div>

      {/* Progress bar */}
      <div
        className={styles.progressBar}
        role="progressbar"
        aria-valuenow={progressPct}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label={`${progressPct}% complete`}
      >
        <div
          className={`${styles.progressFill} ${isTaskTerminal && task?.status !== 'completed' ? styles.progressFillFailed : ''}`}
          style={{ width: `${progressPct}%` }}
        />
      </div>
      <p className={styles.progressLabel}>
        {completedCount} / {steps.length} steps completed ({progressPct}%)
      </p>

      {/* Steps timeline */}
      <ul className={styles.stepList} aria-label="Pipeline steps">
        {steps.map((step, i) => (
          <StepRow key={step.nodeId} step={step} isLast={i === steps.length - 1} />
        ))}
      </ul>

      {/* Final result */}
      {task?.status === 'completed' && (
        <div className={styles.resultPanel} aria-live="polite">
          <div className={styles.resultHeader}>
            <CheckCircle2 size={18} className={styles.iconCompleted} aria-hidden="true" />
            <span>Task completed</span>
          </div>
          <div className={styles.costSummary}>
            <DollarSign size={15} aria-hidden="true" />
            Total cost:{' '}
            <strong>{totalCost.toFixed(2)} XLM</strong>
          </div>
          {/* Display output from last completed step */}
          {steps.at(-1)?.output != null && (
            <div className={styles.outputPanel}>
              <h3 className={styles.outputTitle}>Result</h3>
              <pre className={styles.outputContent}>
                {typeof steps.at(-1)!.output === 'string'
                  ? steps.at(-1)!.output as string
                  : JSON.stringify(steps.at(-1)!.output, null, 2)}
              </pre>
            </div>
          )}
        </div>
      )}

      {/* Failed / cancelled */}
      {task?.status === 'failed' && (
        <div className={styles.failedPanel} aria-live="polite" role="alert">
          <XCircle size={18} className={styles.iconFailed} aria-hidden="true" />
          <span>
            Task failed.
            {cancelledRefund !== undefined
              ? ` Estimated refund: ${cancelledRefund.toFixed(2)} XLM.`
              : ''}
          </span>
        </div>
      )}

      {/* Actions */}
      {canCancel && (
        <div className={styles.actions}>
          <button
            className={styles.btnDanger}
            onClick={() => setShowCancelModal(true)}
            aria-label="Cancel this task"
          >
            <Ban size={14} aria-hidden="true" />
            Cancel Task
          </button>
        </div>
      )}

      {/* Cancel confirmation modal */}
      {showCancelModal && (
        <CancelModal
          onConfirm={handleCancelConfirm}
          onClose={() => setShowCancelModal(false)}
          isLoading={isCancelling}
          refundAmount={potentialRefund}
        />
      )}
    </div>
  );
};

export default TaskProgressTracker;
