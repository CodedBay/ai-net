// src/components/tasks/DAGVisualization.tsx
import React, { useMemo, useState, useCallback } from "react";
import ReactFlow, {
  Background,
  Controls,
  MiniMap,
  Handle,
  Position,
  MarkerType,
  Node,
  Edge,
  NodeProps,
} from "reactflow";
import "reactflow/dist/style.css";
import { useTranslation } from "react-i18next";
import { X, Clock, DollarSign, Bot, Activity } from "lucide-react";
import type { DAGNode, PaymentEvent } from "../../types/api";
import { getAmountForAgent } from "../../hooks/useTaskMonitor";
import styles from "./DAGVisualization.module.css";

export interface DAGVisualizationProps {
  nodes: DAGNode[];
  outputs?: Record<string, unknown>;
  payments?: PaymentEvent[];
  taskId?: string;
  className?: string;
}

interface CustomNodeData {
  id: string;
  label: string;
  agentType: string;
  status: string;
  prompt?: string;
  isSelected: boolean;
  onSelect: (id: string) => void;
}

const CustomDagNode: React.FC<NodeProps<CustomNodeData>> = ({ data }) => {
  const { id, label, agentType, status, isSelected, onSelect } = data;

  const statusClass =
    status === "completed"
      ? styles.completed
      : status === "running"
        ? styles.running
        : status === "failed"
          ? styles.failed
          : styles.queued;

  const handleClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    onSelect(id);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      onSelect(id);
    }
  };

  const accessibleLabel = `Task node: ${label}, Agent: ${agentType || "Unknown"}, Status: ${status}`;

  return (
    <div
      className={`${styles.nodeWrapper} ${statusClass} ${isSelected ? styles.selected : ""}`}
      onClick={handleClick}
      onKeyDown={handleKeyDown}
      role="button"
      tabIndex={0}
      aria-label={accessibleLabel}
      aria-pressed={isSelected}
    >
      <Handle
        type="target"
        position={Position.Left}
        style={{
          background: "var(--text-muted, #94a3b8)",
          width: 8,
          height: 8,
        }}
      />
      <div>
        <div className={styles.nodeCategory}>{agentType || "Agent"}</div>
        <div className={styles.nodeLabel} title={label}>
          {label}
        </div>
      </div>
      <div className={styles.nodeBadge}>
        {status === "running" && (
          <Activity size={10} className="animate-spin mr-1" />
        )}
        {status}
      </div>
      <Handle
        type="source"
        position={Position.Right}
        style={{
          background: "var(--text-muted, #94a3b8)",
          width: 8,
          height: 8,
        }}
      />
    </div>
  );
};

const nodeTypes = {
  customDag: CustomDagNode,
};

export const DAGVisualization: React.FC<DAGVisualizationProps> = ({
  nodes,
  outputs = {},
  payments = [],
  className,
}) => {
  const { t } = useTranslation();
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);

  const selectedNode = useMemo(() => {
    if (!selectedNodeId) return null;
    return nodes.find((n) => n.nodeId === selectedNodeId) || null;
  }, [nodes, selectedNodeId]);

  const handleSelectNode = useCallback((id: string) => {
    setSelectedNodeId((prev) => (prev === id ? null : id));
  }, []);

  // Compute node hierarchy/levels for horizontal layout
  const { flowNodes, flowEdges } = useMemo(() => {
    if (!nodes || nodes.length === 0) {
      return { flowNodes: [], flowEdges: [] };
    }

    // Map dependency depth
    const depthMap = new Map<string, number>();
    const nodeMap = new Map<string, DAGNode>();
    nodes.forEach((n) => nodeMap.set(n.nodeId, n));

    const getDepth = (nodeId: string, visited = new Set<string>()): number => {
      if (depthMap.has(nodeId)) return depthMap.get(nodeId)!;
      if (visited.has(nodeId)) return 0; // prevent cycles
      visited.add(nodeId);

      const node = nodeMap.get(nodeId);
      if (!node || !node.dependsOn || node.dependsOn.length === 0) {
        depthMap.set(nodeId, 0);
        return 0;
      }

      let maxParentDepth = -1;
      node.dependsOn.forEach((dep) => {
        maxParentDepth = Math.max(
          maxParentDepth,
          getDepth(dep, new Set(visited)),
        );
      });

      const currentDepth = maxParentDepth + 1;
      depthMap.set(nodeId, currentDepth);
      return currentDepth;
    };

    nodes.forEach((n) => getDepth(n.nodeId));

    // Group nodes by depth for y-positioning
    const depthGroups = new Map<number, string[]>();
    nodes.forEach((n) => {
      const d = depthMap.get(n.nodeId) || 0;
      const group = depthGroups.get(d) || [];
      group.push(n.nodeId);
      depthGroups.set(d, group);
    });

    const fNodes: Node<CustomNodeData>[] = nodes.map((node) => {
      const depth = depthMap.get(node.nodeId) || 0;
      const nodesAtDepth = depthGroups.get(depth) || [node.nodeId];
      const rowIndex = nodesAtDepth.indexOf(node.nodeId);

      const x = depth * 260 + 60;
      const y = rowIndex * 120 + 70;

      const cleanLabel = (node.agentType || node.nodeId).replace(
        /^node[-_]/,
        "",
      );

      return {
        id: node.nodeId,
        type: "customDag",
        position: { x, y },
        data: {
          id: node.nodeId,
          label: cleanLabel,
          agentType: node.agentType || "coordinator",
          status: node.status,
          prompt: node.prompt,
          isSelected: selectedNodeId === node.nodeId,
          onSelect: handleSelectNode,
        },
      };
    });

    const fEdges: Edge[] = [];
    nodes.forEach((node) => {
      if (node.dependsOn && node.dependsOn.length > 0) {
        node.dependsOn.forEach((depId) => {
          let strokeColor = "var(--text-muted, #64748b)";
          let animated = false;

          if (node.status === "completed") {
            strokeColor = "var(--status-success, #10b981)";
          } else if (node.status === "running") {
            strokeColor = "var(--accent, #6366f1)";
            animated = true;
          } else if (node.status === "failed") {
            strokeColor = "var(--status-danger, #ef4444)";
          }

          fEdges.push({
            id: `edge-${depId}-${node.nodeId}`,
            source: depId,
            target: node.nodeId,
            animated,
            style: {
              stroke: strokeColor,
              strokeWidth: 2,
            },
            markerEnd: {
              type: MarkerType.ArrowClosed,
              color: strokeColor,
            },
          });
        });
      }
    });

    return { flowNodes: fNodes, flowEdges: fEdges };
  }, [nodes, selectedNodeId, handleSelectNode]);

  // Extract selected node details
  const nodeOutput = useMemo(() => {
    if (!selectedNode) return null;
    const directOutput = outputs[selectedNode.nodeId];
    if (directOutput !== undefined) return directOutput;
    if (selectedNode.result !== undefined) return selectedNode.result;
    return null;
  }, [selectedNode, outputs]);

  const nodeDuration = useMemo(() => {
    if (!selectedNode) return "—";
    const extended = selectedNode as any;
    if (extended.duration) return extended.duration;
    if (extended.result?.executionTimeMs) {
      return `${(extended.result.executionTimeMs / 1000).toFixed(2)}s`;
    }
    if (selectedNode.status === "running") return "Running…";
    if (selectedNode.status === "completed") return "Completed";
    return "—";
  }, [selectedNode]);

  const nodeCost = useMemo(() => {
    if (!selectedNode) return "—";
    const extended = selectedNode as any;
    if (extended.cost) return `${extended.cost} XLM`;
    if (payments && payments.length > 0) {
      const match = payments.find(
        (p) =>
          p.memo?.includes(selectedNode.nodeId) ||
          p.counterparty?.includes(selectedNode.agentType),
      );
      if (match) return `${match.amount} XLM`;
    }
    const defaultAmount = getAmountForAgent(selectedNode.agentType);
    return `${defaultAmount} XLM`;
  }, [selectedNode, payments]);

  return (
    <div
      className={`${styles.wrapper} ${className || ""}`}
      data-testid="dag-visualization"
      aria-label="Task Execution DAG"
    >
      <div className={styles.graphContainer}>
        {flowNodes.length > 0 ? (
          <ReactFlow
            nodes={flowNodes}
            edges={flowEdges}
            nodeTypes={nodeTypes}
            onNodeClick={(_event, node) => handleSelectNode(node.id)}
            onPaneClick={() => setSelectedNodeId(null)}
            fitView
            fitViewOptions={{ padding: 0.25 }}
            nodesConnectable={false}
            nodesDraggable={false}
            zoomOnScroll={true}
            zoomOnPinch={true}
            panOnDrag={true}
            preventScrolling={false}
          >
            <Background
              color="var(--border-subtle, rgba(255, 255, 255, 0.08))"
              gap={16}
              size={1}
            />
            <Controls showInteractive={false} position="bottom-left" />
            <MiniMap
              className={styles.minimap}
              nodeStrokeWidth={3}
              nodeColor={(n) => {
                const s = n.data?.status;
                if (s === "completed") return "#10b981";
                if (s === "running") return "#6366f1";
                if (s === "failed") return "#ef4444";
                return "#64748b";
              }}
              position="bottom-right"
            />
          </ReactFlow>
        ) : (
          <div className={styles.emptyState}>
            {t("page.task.dagEmpty", "No DAG nodes available for this task.")}
          </div>
        )}
      </div>

      {/* Expanded Side Panel */}
      {selectedNode && (
        <aside
          className={styles.sidePanel}
          data-testid="node-detail-panel"
          role="complementary"
          aria-label={`Details for node ${selectedNode.nodeId}`}
        >
          <div className={styles.panelHeader}>
            <div>
              <div className={styles.sectionLabel}>
                {t("page.task.sidePanel.title", "Node Details")}
              </div>
              <h4 className={styles.panelTitle}>
                {selectedNode.agentType || selectedNode.nodeId}
              </h4>
            </div>
            <button
              onClick={() => setSelectedNodeId(null)}
              className={styles.closeButton}
              aria-label={t("page.task.sidePanel.close", "Close details")}
            >
              <X size={18} />
            </button>
          </div>

          <div className={styles.section}>
            <span className={styles.sectionLabel}>
              {t("page.task.sidePanel.agent", "Assigned Agent")}
            </span>
            <div className="flex items-center gap-1.5 text-sm font-semibold text-[var(--accent-secondary)]">
              <Bot size={16} />
              <span className="capitalize">
                {selectedNode.agentType || "General Agent"}
              </span>
            </div>
          </div>

          <div className={styles.metaRow}>
            <div className={styles.metaCard}>
              <span className={styles.sectionLabel}>
                {t("page.task.sidePanel.duration", "Duration")}
              </span>
              <div className="flex items-center gap-1 text-xs font-mono font-bold mt-1">
                <Clock size={12} className="text-slate-400" />
                <span>{nodeDuration}</span>
              </div>
            </div>
            <div className={styles.metaCard}>
              <span className={styles.sectionLabel}>
                {t("page.task.sidePanel.cost", "Cost")}
              </span>
              <div className="flex items-center gap-1 text-xs font-mono font-bold mt-1 text-emerald-400">
                <DollarSign size={12} />
                <span>{nodeCost}</span>
              </div>
            </div>
          </div>

          <div className={styles.section}>
            <span className={styles.sectionLabel}>
              {t("page.task.sidePanel.input", "Input Prompt")}
            </span>
            <p className={styles.sectionValue}>
              {selectedNode.prompt ||
                t("page.task.sidePanel.noPrompt", "No prompt supplied")}
            </p>
          </div>

          <div className={styles.section}>
            <span className={styles.sectionLabel}>
              {t("page.task.sidePanel.output", "Execution Output")}
            </span>
            {selectedNode.status === "failed" ? (
              <div
                className={`${styles.codeBlock} text-rose-300 border-rose-500/30`}
              >
                {selectedNode.error || "Execution failed"}
              </div>
            ) : nodeOutput ? (
              <pre className={styles.codeBlock}>
                {typeof nodeOutput === "string"
                  ? nodeOutput
                  : JSON.stringify(nodeOutput, null, 2)}
              </pre>
            ) : (
              <div className="text-xs text-[var(--text-muted)] italic">
                {selectedNode.status === "running"
                  ? t("page.task.sidePanel.executing", "Node is executing…")
                  : t(
                      "page.task.sidePanel.noOutput",
                      "No output recorded yet.",
                    )}
              </div>
            )}
          </div>
        </aside>
      )}
    </div>
  );
};

export default DAGVisualization;
