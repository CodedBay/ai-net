import React, { useMemo } from "react";
import { useTranslation, Trans } from "react-i18next";
import { useParams } from "react-router-dom";

import { useTaskMonitor } from "../hooks/useTaskMonitor";
import { DAGVisualization } from "../components/tasks/DAGVisualization";
import { TaskDetailTimeline } from "../components/dashboard/TaskDetailTimeline";
import { PaymentTimeline } from "../components/dashboard/PaymentTimeline";
import { Skeleton, SkeletonText } from "../components/common/Skeleton";
import { EmptyState } from "../components/common/EmptyState";
import { TaskFailedIllustration } from "../components/common/illustrations";
import { AlertCircle, CheckCircle2, Play, RefreshCw } from "lucide-react";

/**
 * Context-aware skeleton that mirrors the task detail layout (header, DAG
 * panel, output/payment panels) so there is no layout shift on load.
 */
export const TaskDetailSkeleton: React.FC = () => {
  const { t } = useTranslation();

  return (
    <div
      className="space-y-6"
      data-testid="task-detail-skeleton"
      aria-busy="true"
      aria-label={t("a11y.loadingTaskDetails")}
    >
      {/* Details Header */}
      <div className="glass-panel flex flex-col md:flex-row justify-between items-start md:items-center gap-4">
        <div className="w-full md:w-2/3">
          <div className="flex items-center gap-3">
            <Skeleton width="12rem" height="1.75rem" />
            <Skeleton variant="pill" width="6rem" height="1.25rem" />
          </div>
          <Skeleton width="16rem" height="0.75rem" className="mt-2" />
          <Skeleton width="80%" height="1rem" className="mt-3" />
        </div>
        <div className="flex items-center gap-3">
          <Skeleton width="6rem" height="2.5rem" />
          <Skeleton width="4rem" height="2.5rem" />
        </div>
      </div>

      {/* Timeline & DAG Skeleton Panel */}
      <div className="glass-panel relative flex flex-col">
        <Skeleton width="12rem" height="1.5rem" className="mb-4" />
        <div className="space-y-4">
          <Skeleton height="80px" />
          <Skeleton height="80px" />
          <Skeleton height="80px" />
        </div>
        <div
          className="w-full bg-slate-950/40 rounded-xl border border-[var(--panel-border)] overflow-hidden flex items-center gap-8 px-8 mt-4"
          style={{ height: "280px" }}
        >
          {Array.from({ length: 3 }, (_, index) => (
            <Skeleton
              key={index}
              variant="rect"
              width="160px"
              height="92px"
              className="shrink-0 rounded-xl"
            />
          ))}
        </div>
      </div>

      {/* Combined Panels */}
      <div className="grid grid-cols-1 lg:grid-cols-5 gap-6">
        <div className="glass-panel lg:col-span-3">
          <SkeletonText lines={6} />
        </div>
        <div className="glass-panel lg:col-span-2">
          <SkeletonText lines={4} />
        </div>
      </div>
    </div>
  );
};

const TaskDetailPage: React.FC = () => {
  const { t } = useTranslation();
  const { id } = useParams<{ id: string }>();
  const { task, loading, error, wsStatus, nodes, payments, outputs, refetch } =
    useTaskMonitor(id);

  // Check if any node is failed
  const failedNode = useMemo(() => {
    return nodes.find((n) => n.status === "failed");
  }, [nodes]);

  if (loading && !nodes.length) {
    return <TaskDetailSkeleton />;
  }

  if (error) {
    return (
      <div className="glass-panel border-rose-500/30">
        <EmptyState
          illustration={<TaskFailedIllustration />}
          title={t("page.task.errorTitle")}
          description={error.message}
          primaryAction={{
            label: t("common.retry"),
            onClick: refetch,
            icon: <RefreshCw size={16} />,
          }}
          secondaryAction={{
            label: "Contact Support",
            to: "mailto:support@ai-net.io",
          }}
          variant="card"
        />
      </div>
    );
  }

  // Get current WS status color/label
  const getWsStatusBadge = () => {
    switch (wsStatus) {
      case "connected":
        return {
          bg: "var(--status-success-surface)",
          border: "var(--status-success-border)",
          color: "var(--status-success-text)",
          label: t("page.task.ws.connected"),
        };
      case "connecting":
        return {
          bg: "var(--status-warning-surface)",
          border: "var(--status-warning-border)",
          color: "var(--status-warning-text)",
          label: t("page.task.ws.connecting"),
        };
      case "error":
      case "disconnected":
      default:
        return {
          bg: "var(--status-danger-surface)",
          border: "var(--status-danger-border)",
          color: "var(--status-danger-text)",
          label: t("page.task.ws.disconnected"),
        };
    }
  };

  const wsBadge = getWsStatusBadge();

  return (
    <div className="space-y-6 fade-in">
      {/* Task failed banner */}
      {failedNode && (
        <div
          className="p-4 bg-rose-950/60 border border-rose-500/50 rounded-xl flex items-start gap-3 text-rose-200 animate-fadeIn"
          role="alert"
        >
          <AlertCircle className="text-rose-400 mt-0.5 shrink-0" size={20} />
          <div>
            <h4 className="font-bold text-sm">{t("page.task.failedTitle")}</h4>
            <p className="text-xs text-[var(--status-danger-text)] mt-0.5">
              <Trans
                i18nKey="page.task.failedBody"
                values={{
                  node: failedNode.nodeId
                    .replace("node_", "")
                    .replace("node-", ""),
                  error: failedNode.error || t("page.task.unknownError"),
                }}
                components={[
                  <span
                    key="node"
                    className="font-mono font-bold capitalize"
                  />,
                ]}
              />
            </p>
          </div>
        </div>
      )}

      {/* Task completed banner */}
      {task?.status === "completed" && !failedNode && (
        <div
          className="p-4 bg-emerald-950/60 border border-emerald-500/50 rounded-xl flex items-start gap-3 text-emerald-200 animate-fadeIn"
          role="alert"
        >
          <CheckCircle2
            className="text-emerald-400 mt-0.5 shrink-0"
            size={20}
          />
          <div>
            <h4 className="font-bold text-sm">
              {t("page.task.completedTitle")}
            </h4>
            <p className="text-xs text-[var(--status-success-text)] mt-0.5">
              {t("page.task.completedBody")}
            </p>
          </div>
        </div>
      )}

      {/* Details Header */}
      <div className="glass-panel flex flex-col md:flex-row justify-between items-start md:items-center gap-4">
        <div>
          <div className="flex items-center gap-3">
            <h1 className="text-xl md:text-2xl font-bold tracking-tight">
              {t("nav.taskMonitoring")}
            </h1>
            <span
              id="ws-status"
              data-ws-state={wsStatus}
              className="chip text-[10px] tracking-wider uppercase"
              style={{
                background: wsBadge.bg,
                borderColor: wsBadge.border,
                color: wsBadge.color,
              }}
            >
              {t("page.task.wsStatus", { status: wsBadge.label })}
            </span>
          </div>
          <p className="text-xs text-[var(--text-secondary)] font-mono mt-1">
            {t("page.task.taskId", { id })}
          </p>
          {task?.prompt && (
            <p className="text-sm text-[var(--text-muted)] mt-3 italic border-l-2 border-[var(--accent-secondary)] pl-3">
              "{task.prompt}"
            </p>
          )}
        </div>

        <div className="flex items-center gap-3 self-stretch md:self-auto justify-between">
          <div className="text-right hidden sm:block">
            <div className="text-[10px] uppercase font-bold text-[var(--text-secondary)]">
              {t("common.status")}
            </div>
            <div
              className={`text-xs font-extrabold capitalize mt-0.5 ${
                task?.status === "completed"
                  ? "text-[var(--status-success)]"
                  : task?.status === "failed"
                    ? "text-[var(--status-danger)]"
                    : "text-[var(--accent-secondary)]"
              }`}
            >
              {task?.status || "queued"}
            </div>
          </div>
          <button
            onClick={refetch}
            className="flex items-center gap-1.5 px-3 py-1.5 text-xs rounded-lg bg-[var(--surface-elevated)] hover:bg-[var(--surface-muted)] border border-[var(--border-strong)] transition"
          >
            <RefreshCw size={12} />
            <span>{t("page.task.sync")}</span>
          </button>
        </div>
      </div>

      {/* Interactive DAG Graph Panel */}
      <div className="glass-panel relative flex flex-col">
        <div className="flex items-center gap-2 mb-3">
          <Play size={16} className="text-[var(--accent-secondary)]" />
          <h3 className="text-md font-semibold text-[var(--text-primary)]">
            {t("page.task.dagTitle")}
          </h3>
          <span className="text-[10px] text-[var(--text-muted)] ml-auto">
            {t("page.task.dagHint")}
          </span>
        </div>

        <DAGVisualization
          nodes={nodes}
          outputs={outputs}
          payments={payments}
          taskId={id}
        />
      </div>

      {/* Combined Panels */}
      <div className="grid grid-cols-1 lg:grid-cols-5 gap-6">
        <div className="lg:col-span-3">
          <TaskDetailTimeline nodes={nodes} outputs={outputs} />
        </div>
        <div className="lg:col-span-2">
          <PaymentTimeline payments={payments} />
        </div>
      </div>
    </div>
  );
};

export default TaskDetailPage;
