import { apiClient, ApiError } from './api';
import type {
  AgentPreference,
  TaskEstimate,
  TaskSubmissionPayload,
  TaskSubmitResponse,
  DagNode,
  DagEdge
} from '../types/api';

export type {
  AgentPreference,
  TaskEstimate,
  TaskSubmissionPayload,
  TaskSubmitResponse,
  DagNode,
  DagEdge,
};

export async function createTask(
  payload: TaskSubmissionPayload,
): Promise<TaskSubmitResponse> {
  try {
    return await apiClient.post<TaskSubmitResponse>('/api/tasks', payload);
  } catch (error: unknown) {
    if (error instanceof ApiError) {
      throw new Error(`Task submission failed: ${error.message}`);
    }
    throw error;
  }
}

/**
 * Fetch the server-side cost estimate for the selected agents.
 *
 * v1 returns the estimate directly while v2 wraps it in a `{ data }` envelope;
 * accept either so the wizard works regardless of the negotiated API version.
 */
export async function estimateTaskCost(
  agents: AgentPreference[],
  signal?: AbortSignal,
): Promise<TaskEstimate> {
  const params = new URLSearchParams({ agents: agents.join(',') });
  const response = await apiClient.get<TaskEstimate | { data: TaskEstimate }>(
    `/api/tasks/estimate?${params.toString()}`,
    signal ? { signal } : undefined,
  );

  if (response && typeof response === 'object' && 'data' in response) {
    return response.data;
  }
  return response as TaskEstimate;
}
