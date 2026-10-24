import { beforeEach, describe, expect, it } from 'vitest';
import type { TaskResponse } from '../types/api';
import {
  PENDING_TASK_TTL_MS,
  PENDING_TASKS_STORAGE_KEY,
  addPendingTask,
  clearPendingTask,
  mergePendingTasks,
  readPendingTasks,
} from './optimisticTasks';

function makeTask(overrides: Partial<TaskResponse> = {}): TaskResponse {
  const now = new Date().toISOString();
  return {
    taskId: 'task_pending',
    prompt: 'Build a report',
    walletPublicKey: 'GTESTWALLET',
    status: 'queued',
    dag: [],
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

describe('optimistic task store', () => {
  beforeEach(() => {
    window.sessionStorage.clear();
  });

  it('round-trips a pending task through sessionStorage', () => {
    const task = makeTask();
    addPendingTask(task);

    expect(readPendingTasks()).toEqual([task]);
    expect(window.sessionStorage.getItem(PENDING_TASKS_STORAGE_KEY)).not.toBeNull();
  });

  it('replaces an existing pending task with the same id', () => {
    addPendingTask(makeTask({ prompt: 'first' }));
    addPendingTask(makeTask({ prompt: 'second' }));

    const pending = readPendingTasks();
    expect(pending).toHaveLength(1);
    expect(pending[0].prompt).toBe('second');
  });

  it('drops entries after the TTL expires', () => {
    addPendingTask(makeTask());

    expect(readPendingTasks(Date.now() + PENDING_TASK_TTL_MS + 1)).toEqual([]);
  });

  it('clears a single pending task', () => {
    addPendingTask(makeTask({ taskId: 'task_a' }));
    addPendingTask(makeTask({ taskId: 'task_b' }));

    clearPendingTask('task_a');

    expect(readPendingTasks().map((task) => task.taskId)).toEqual(['task_b']);
  });

  it('ignores corrupt stored data', () => {
    window.sessionStorage.setItem(PENDING_TASKS_STORAGE_KEY, '{not json');
    expect(readPendingTasks()).toEqual([]);
  });
});

describe('mergePendingTasks', () => {
  it('prepends pending tasks that are not in the server list', () => {
    const serverTask = makeTask({ taskId: 'task_server', status: 'running' });
    const pendingTask = makeTask({ taskId: 'task_pending' });

    expect(mergePendingTasks([serverTask], [pendingTask])).toEqual([
      pendingTask,
      serverTask,
    ]);
  });

  it('dedupes by taskId, letting the server record win', () => {
    const serverTask = makeTask({ taskId: 'task_same', status: 'completed' });
    const optimistic = makeTask({ taskId: 'task_same', status: 'queued' });

    const merged = mergePendingTasks([serverTask], [optimistic]);

    expect(merged).toEqual([serverTask]);
  });

  it('dedupes repeated pending entries', () => {
    const pending = makeTask({ taskId: 'task_pending' });
    const merged = mergePendingTasks([], [pending, { ...pending }]);

    expect(merged).toHaveLength(1);
    expect(merged[0]).toEqual(pending);
  });
});
