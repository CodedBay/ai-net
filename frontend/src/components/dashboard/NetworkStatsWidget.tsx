// src/components/dashboard/NetworkStatsWidget.tsx
import React, { useMemo } from "react";
import { useTranslation } from "react-i18next";
import {
  Users,
  Activity,
  Coins,
  CheckCircle2,
  TrendingUp,
  TrendingDown,
  Minus,
  AlertTriangle,
} from "lucide-react";
import { useNetworkStats } from "../../hooks/useNetworkStats";
import { useAnimatedCounter } from "../../hooks/useAnimatedCounter";
import { Skeleton } from "../common/Skeleton";
import styles from "./NetworkStatsWidget.module.css";

interface TrendInfo {
  direction: "up" | "down" | "neutral";
  percent: number;
}

function computeTrend(current: number, previous: number): TrendInfo {
  if (previous === 0) {
    if (current > 0) return { direction: "up", percent: 100 };
    return { direction: "neutral", percent: 0 };
  }
  const diff = current - previous;
  const pct = Math.abs(Math.round((diff / previous) * 100));
  if (diff > 0) return { direction: "up", percent: pct };
  if (diff < 0) return { direction: "down", percent: pct };
  return { direction: "neutral", percent: 0 };
}

interface StatCardProps {
  title: string;
  value: number;
  unit?: string;
  icon?: React.ReactNode;
  trend?: TrendInfo;
  decimals?: number;
}

export const StatCard: React.FC<StatCardProps> = ({
  title,
  value,
  unit,
  icon,
  trend,
  decimals = 0,
}) => {
  const animatedValue = useAnimatedCounter(value, { decimals });

  const formattedValue =
    decimals > 0
      ? animatedValue.toLocaleString(undefined, {
          minimumFractionDigits: decimals,
          maximumFractionDigits: decimals,
        })
      : animatedValue.toLocaleString();

  return (
    <div className={styles.card} role="region" aria-label={title}>
      <div className={styles.cardHeader}>
        <span className={styles.title}>{title}</span>
        {icon && <span className={styles.icon}>{icon}</span>}
      </div>
      <div className={styles.cardBody}>
        <div className={styles.value} aria-live="polite">
          {formattedValue}
          {unit && <span className={styles.unit}>{unit}</span>}
        </div>
        {trend && (
          <span
            className={`${styles.trend} ${
              trend.direction === "up"
                ? styles.trendUp
                : trend.direction === "down"
                  ? styles.trendDown
                  : styles.trendNeutral
            }`}
            aria-label={`${title} ${trend.direction === "neutral" ? "unchanged" : `${trend.direction} by ${trend.percent}%`} since last hour`}
          >
            {trend.direction === "up" && <TrendingUp size={12} />}
            {trend.direction === "down" && <TrendingDown size={12} />}
            {trend.direction === "neutral" && <Minus size={12} />}
            <span>
              {trend.direction === "up"
                ? `+${trend.percent}%`
                : trend.direction === "down"
                  ? `-${trend.percent}%`
                  : "0%"}
            </span>
          </span>
        )}
      </div>
    </div>
  );
};

export interface NetworkStatsWidgetProps {
  className?: string;
}

export const NetworkStatsWidget: React.FC<NetworkStatsWidgetProps> = ({
  className,
}) => {
  const { t } = useTranslation();
  const { data, loading, isStale } = useNetworkStats();

  const metrics = useMemo(() => {
    if (!data) {
      return {
        totalAgents: 0,
        activeTasks: 0,
        xlm24h: 0,
        tasksCompleted: 0,
        agentsTrend: { direction: "neutral" as const, percent: 0 },
        activeTasksTrend: { direction: "neutral" as const, percent: 0 },
        xlmTrend: { direction: "neutral" as const, percent: 0 },
        tasksTrend: { direction: "neutral" as const, percent: 0 },
      };
    }

    const tasks24h = data.tasksLast24h || [];
    const xlm24hSeries = data.xlmLast24h || [];

    const currentTaskHour =
      tasks24h.length > 0 ? tasks24h[tasks24h.length - 1].value : 0;
    const prevTaskHour =
      tasks24h.length > 1 ? tasks24h[tasks24h.length - 2].value : 0;

    const currentXlmHour =
      xlm24hSeries.length > 0 ? xlm24hSeries[xlm24hSeries.length - 1].value : 0;
    const prevXlmHour =
      xlm24hSeries.length > 1 ? xlm24hSeries[xlm24hSeries.length - 2].value : 0;

    const active =
      data.activeTasks !== undefined ? data.activeTasks : currentTaskHour;
    const xlmTotal24h =
      xlm24hSeries.length > 0
        ? xlm24hSeries.reduce((acc, p) => acc + p.value, 0)
        : data.totalXLMTransacted;

    return {
      totalAgents: data.totalAgents,
      activeTasks: active,
      xlm24h: Math.round(xlmTotal24h),
      tasksCompleted: data.totalTasks,
      agentsTrend: computeTrend(currentTaskHour, prevTaskHour),
      activeTasksTrend: computeTrend(currentTaskHour, prevTaskHour),
      xlmTrend: computeTrend(currentXlmHour, prevXlmHour),
      tasksTrend: computeTrend(currentTaskHour, prevTaskHour),
    };
  }, [data]);

  if (loading && !data) {
    return (
      <div
        className={`${styles.container} ${className || ""}`}
        data-testid="network-stats-skeleton"
        aria-busy="true"
      >
        <div className={styles.grid}>
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className={styles.skeletonCard}>
              <Skeleton width="50%" height="0.875rem" />
              <Skeleton width="75%" height="1.75rem" />
            </div>
          ))}
        </div>
      </div>
    );
  }

  return (
    <div
      className={`${styles.container} ${className || ""}`}
      data-testid="network-stats-widget"
    >
      {isStale && (
        <div className={styles.staleIndicator} role="status">
          <AlertTriangle size={14} />
          <span>
            {t(
              "page.dashboard.staleData",
              "Data may be out of date (polling every 60s)",
            )}
          </span>
        </div>
      )}
      <div className={styles.grid}>
        <StatCard
          title={t("page.dashboard.totalAgents", "Total Agents")}
          value={metrics.totalAgents}
          icon={<Users size={18} />}
          trend={metrics.agentsTrend}
        />
        <StatCard
          title={t("page.dashboard.activeTasks", "Active Tasks")}
          value={metrics.activeTasks}
          icon={<Activity size={18} />}
          trend={metrics.activeTasksTrend}
        />
        <StatCard
          title={t("page.dashboard.xlmTransacted24h", "XLM Transacted (24h)")}
          value={metrics.xlm24h}
          unit=" XLM"
          icon={<Coins size={18} />}
          trend={metrics.xlmTrend}
        />
        <StatCard
          title={t(
            "page.dashboard.tasksCompletedAllTime",
            "Tasks Completed (all time)",
          )}
          value={metrics.tasksCompleted}
          icon={<CheckCircle2 size={18} />}
          trend={metrics.tasksTrend}
        />
      </div>
    </div>
  );
};

export default NetworkStatsWidget;
