import { useState, useCallback, useMemo } from "react";
import type { DAGNode, DAGEvent, NodeStatus } from "../types/api";

export interface ExtendedDAGNode extends DAGNode {
  startTime?: string;
  endTime?: string;
  duration?: string;
  cost?: string;
}

export const useNodeState = (_taskId: string) => {
  const [nodes, setNodes] = useState<DAGNode[]>([]);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);

  const updateNodeFromEvent = useCallback((event: DAGEvent) => {
    if (!event.nodeId) return;

    setNodes((prev) => {
      switch (event.type) {
        case "node_started":
          return prev.map((n) =>
            n.nodeId === event.nodeId
              ? {
                  ...n,
                  status: "running" as NodeStatus,
                  startTime: event.timestamp,
                }
              : n,
          );

        case "node_completed": {
          const payload = event.payload as any;
          return prev.map((n) => {
            if (n.nodeId !== event.nodeId) return n;

            let duration = (n as ExtendedDAGNode).duration;
            if (payload?.duration) {
              duration =
                typeof payload.duration === "number"
                  ? `${(payload.duration / 1000).toFixed(2)}s`
                  : String(payload.duration);
            } else if (payload?.executionTimeMs) {
              duration = `${(payload.executionTimeMs / 1000).toFixed(2)}s`;
            } else if ((n as ExtendedDAGNode).startTime) {
              const start = new Date(
                (n as ExtendedDAGNode).startTime!,
              ).getTime();
              const end = new Date(event.timestamp).getTime();
              if (end >= start) {
                duration = `${((end - start) / 1000).toFixed(2)}s`;
              }
            }

            const cost = payload?.cost || (n as ExtendedDAGNode).cost;

            return {
              ...n,
              status: "completed" as NodeStatus,
              result: payload,
              endTime: event.timestamp,
              duration,
              cost,
            };
          });
        }

        case "node_failed": {
          const payload = event.payload as any;
          const errMessage = payload?.error || "Node execution failed";
          return prev.map((n) =>
            n.nodeId === event.nodeId
              ? {
                  ...n,
                  status: "failed" as NodeStatus,
                  error: errMessage,
                  endTime: event.timestamp,
                }
              : n,
          );
        }

        default:
          return prev;
      }
    });
  }, []);

  const getNodeStatus = useCallback(
    (nodeId: string): NodeStatus | undefined => {
      const node = nodes.find((n) => n.nodeId === nodeId);
      return node?.status;
    },
    [nodes],
  );

  const getCompletedNodes = useCallback((): DAGNode[] => {
    return nodes.filter((n) => n.status === "completed");
  }, [nodes]);

  const getRunningNodes = useCallback((): DAGNode[] => {
    return nodes.filter((n) => n.status === "running");
  }, [nodes]);

  const getFailedNodes = useCallback((): DAGNode[] => {
    return nodes.filter((n) => n.status === "failed");
  }, [nodes]);

  const initializeNodes = useCallback((initialNodes: DAGNode[]) => {
    setNodes(initialNodes);
  }, []);

  const getNodeById = useCallback(
    (nodeId: string): DAGNode | undefined => {
      return nodes.find((n) => n.nodeId === nodeId);
    },
    [nodes],
  );

  const selectedNode = useMemo(() => {
    if (!selectedNodeId) return undefined;
    return nodes.find((n) => n.nodeId === selectedNodeId);
  }, [nodes, selectedNodeId]);

  return {
    nodes,
    selectedNodeId,
    setSelectedNodeId,
    selectedNode,
    updateNodeFromEvent,
    getNodeStatus,
    getCompletedNodes,
    getRunningNodes,
    getFailedNodes,
    getNodeById,
    initializeNodes,
  };
};
