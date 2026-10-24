import { useCallback, useState } from 'react';
import { createTask, TaskSubmissionPayload, TaskSubmitResponse } from '../services/taskService';

/** Lifecycle state for a task submission request. */
export type TaskSubmitStatus = 'idle' | 'loading' | 'success' | 'error';

/**
 * Manages the lifecycle of a single task submission to `POST /api/tasks`.
 *
 * Exposes a `submitTask` callback that sets `status` to `'loading'` while the
 * request is in flight, then transitions to `'success'` or `'error'` based on
 * the outcome. The hook is designed to be used once per form submission — the
 * state is reset at the start of each call so it is safe to call `submitTask`
 * multiple times.
 *
 * @returns An object containing:
 *   - `submitTask` — async function that submits the task payload.
 *   - `status` — current submission lifecycle state.
 *   - `error` — human-readable error message, or `null` when there is no error.
 *   - `data` — the server response on success, or `null` otherwise.
 */
export function useTaskSubmit() {
  const [status, setStatus] = useState<TaskSubmitStatus>('idle');
  const [error, setError] = useState<string | null>(null);
  const [data, setData] = useState<TaskSubmitResponse | null>(null);

  const submitTask = useCallback(async (payload: TaskSubmissionPayload) => {
    /**
     * Submits a task to the backend and updates state throughout the lifecycle.
     *
     * @param payload - Task description and optional agent preferences.
     * @returns The server response containing the new task ID and DAG preview.
     * @throws Re-throws the underlying error after setting `status` to `'error'`.
     */
    setStatus('loading');
    setError(null);
    setData(null);

    try {
      const response = await createTask(payload);
      setData(response);
      setStatus('success');
      return response;
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Network error';
      setError(message);
      setData(null);
      setStatus('error');
      throw err;
    }
  }, []);

  return {
    submitTask,
    status,
    error,
    data,
  };
}
