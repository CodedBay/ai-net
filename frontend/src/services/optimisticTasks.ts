import type { TaskResponse } from '../types/api';

/**
 * Short-lived optimistic task records.
 *
 * After a successful submission we navigate straight to the task detail page;
 * the history list can lag behind by a few seconds. Persisting the new task in
 * `sessionStorage` for a minute lets the history page show a pending card
 * immediately without masking the real API response for long.
 */

export const PENDING_TASKS_STORAGE_KEY = 'ai-net:pending-tasks:v1';
export const PENDING_TASK_TTL_MS = 60_000;

interface StoredPendingTask {
  task: TaskResponse;
  expiresAt: number;
}

const hasStorage = (): boolean =>
  typeof window !== 'undefined' && typeof window.sessionStorage !== 'undefined';

function taskKey(task: TaskResponse): string {
  return task.taskId || task.id || '';
}

function readStore(): StoredPendingTask[] {
  if (!hasStorage()) return [];
  try {
    const raw = window.sessionStorage.getItem(PENDING_TASKS_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];

    return parsed.filter((entry): entry is StoredPendingTask => {
      if (!entry || typeof entry !== 'object') return false;
      const candidate = entry as Partial<StoredPendingTask>;
      return (
        typeof candidate.expiresAt === 'number' &&
        !!candidate.task &&
        typeof candidate.task === 'object' &&
        typeof candidate.task.taskId === 'string'
      );
    });
  } catch {
    return [];
  }
}

function writeStore(entries: StoredPendingTask[]): void {
  if (!hasStorage()) return;
  try {
    window.sessionStorage.setItem(PENDING_TASKS_STORAGE_KEY, JSON.stringify(entries));
  } catch {
    // Ignore write failures (sandboxed iframe, quota exceeded, etc.).
  }
}

/** Store a task as pending until it is cleared or its TTL expires. */
export function addPendingTask(task: TaskResponse): void {
  const now = Date.now();
  const existing = readStore().filter((entry) => entry.expiresAt > now);
  const key = taskKey(task);
  const withoutDuplicate = existing.filter((entry) => taskKey(entry.task) !== key);
  writeStore([...withoutDuplicate, { task, expiresAt: now + PENDING_TASK_TTL_MS }]);
}

/** Read non-expired pending tasks. Corrupt or expired entries are ignored. */
export function readPendingTasks(now: number = Date.now()): TaskResponse[] {
  return readStore()
    .filter((entry) => entry.expiresAt > now)
    .map((entry) => entry.task);
}

/** Remove a pending task, e.g. once the server list includes it. */
export function clearPendingTask(taskId: string): void {
  const remaining = readStore().filter((entry) => taskKey(entry.task) !== taskId);
  writeStore(remaining);
}

/**
 * Prepend pending tasks to a server-fetched list.
 *
 * Tasks already present in the server response win, so a pending card never
 * duplicates the authoritative record; pending entries also dedupe against
 * each other by `taskId`.
 */
export function mergePendingTasks(
  tasks: TaskResponse[],
  pending: TaskResponse[] = readPendingTasks(),
): TaskResponse[] {
  const seen = new Set(tasks.map(taskKey).filter((key) => key.length > 0));
  const prepended: TaskResponse[] = [];

  for (const task of pending) {
    const key = taskKey(task);
    if (key.length === 0 || seen.has(key)) continue;
    seen.add(key);
    prepended.push(task);
  }

  return [...prepended, ...tasks];
}
