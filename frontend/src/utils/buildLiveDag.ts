import type {
  AgentPreference,
  DagEdge,
  DagNode,
} from "../services/taskService";
import type { DAGNode } from "../types/api";

export interface LiveDagNode extends DagNode {
  agentType?: string;
  prompt?: string;
  status?: string;
  result?: unknown;
  error?: string;
  dependsOn?: string[];
  duration?: string | number;
  cost?: string | number;
}

export interface LiveDagEdge extends DagEdge {
  id?: string;
  animated?: boolean;
}

export interface LiveDag {
  nodes: LiveDagNode[];
  edges: LiveDagEdge[];
}

function isDAGNode(item: unknown): item is DAGNode {
  return typeof item === "object" && item !== null && "nodeId" in item;
}

/**
 * Builds a DAG structure from an array of DAGNode records.
 */
export function buildDagFromTaskNodes(
  taskNodes: DAGNode[],
  labelOf?: (agentType: string) => string,
): LiveDag {
  const nodes: LiveDagNode[] = taskNodes.map((node) => ({
    id: node.nodeId,
    label: labelOf ? labelOf(node.agentType) : node.agentType || node.nodeId,
    agentType: node.agentType,
    prompt: node.prompt,
    status: node.status,
    result: node.result,
    error: node.error,
    dependsOn: node.dependsOn,
  }));

  const edges: LiveDagEdge[] = [];
  taskNodes.forEach((node) => {
    if (node.dependsOn && Array.isArray(node.dependsOn)) {
      node.dependsOn.forEach((depId) => {
        edges.push({
          id: `edge-${depId}-${node.nodeId}`,
          source: depId,
          target: node.nodeId,
          animated: node.status === "running",
        });
      });
    }
  });

  return { nodes, edges };
}

/**
 * Builds the execution DAG preview from either:
 * 1) Currently selected agent preferences (for wizard review step)
 * 2) Task DAG nodes (for live task graph visualization)
 *
 * Pure — never mutates its inputs — so it can be called on every render.
 */
export function buildLiveDag(
  preferences: AgentPreference[],
  labelOf: (preference: AgentPreference) => string,
): LiveDag;
export function buildLiveDag(
  taskNodes: DAGNode[],
  labelOf?: (preference: string) => string,
): LiveDag;
export function buildLiveDag(
  input: (AgentPreference | DAGNode)[],
  labelOf?: (preference: any) => string,
): LiveDag {
  if (!input || input.length === 0) {
    return { nodes: [], edges: [] };
  }

  if (isDAGNode(input[0])) {
    return buildDagFromTaskNodes(input as DAGNode[], labelOf);
  }

  const preferences = input as AgentPreference[];
  const nodes: LiveDagNode[] = preferences.map((preference) => ({
    id: preference,
    label: labelOf ? labelOf(preference) : preference,
  }));

  const edges: LiveDagEdge[] = [];
  for (let i = 0; i < preferences.length - 1; i += 1) {
    edges.push({
      id: `edge-${preferences[i]}-${preferences[i + 1]}`,
      source: preferences[i],
      target: preferences[i + 1],
    });
  }

  return { nodes, edges };
}
