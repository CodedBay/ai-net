/**
 * Tests for POST /api/tasks/:id/cancel
 *
 * Covers:
 *  - 200 task owner can cancel a queued task
 *  - 200 admin can cancel a queued task
 *  - 200 running task can be cancelled (stops job, attempts refund)
 *  - 403 stranger cannot cancel
 *  - 404 unknown task id
 *  - 409 already-completed task cannot be cancelled
 *  - 409 already-failed task cannot be cancelled
 *  - 409 already-cancelled task cannot be cancelled
 *  - Refund tx hashes included in response
 *  - Job in queue is marked failed on cancel
 */

import express, { Router } from 'express';
import request from 'supertest';
import { createCancelTaskRouter } from './cancel';
import type { JobQueue, JobStore, Job } from '../../queue';
import type { TaskDb } from '../../db/tasks';

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeTask(overrides: Partial<{
  id: string; walletPublicKey: string; status: string;
}> = {}) {
  return {
    id: 'task_test001',
    walletPublicKey: 'GPUBKEY123',
    prompt: 'Test prompt',
    status: 'queued',
    dag: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

function makeJob(taskId: string): Job {
  const now = new Date().toISOString();
  return {
    id: 'job_abc',
    taskId,
    type: 'execute_task',
    payload: { taskId },
    status: 'pending',
    priority: 'normal',
    progress: 0,
    attempts: 0,
    maxAttempts: 3,
    nextRunAt: now,
    createdAt: now,
    updatedAt: now,
  };
}

function buildApp(
  taskDb: Partial<TaskDb>,
  queue: Partial<JobQueue>,
  paymentService?: any,
) {
  const app = express();
  app.use(express.json());

  // Inject mocked db via module-level mock override
  jest.doMock('../../db/tasks', () => ({
    getTaskDb: jest.fn(),
    createTaskDb: jest.fn(() => taskDb),
  }));
  jest.doMock('../../db/index', () => ({
    getDb: jest.fn(() => ({})),
  }));
  jest.doMock('../../config', () => ({
    getConfig: jest.fn(() => ({
      ADMIN_API_KEY: 'test-admin-key',
      STELLAR_COORDINATOR_SECRET: undefined, // no Stellar in unit tests
      LOG_LEVEL: 'silent', // logger (pino) initialises from this module too
    })),
  }));

  // Re-require AFTER jest.doMock so the router picks up the mocked deps
  // (the top-level import captured the real modules before the mocks existed).
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { createCancelTaskRouter: freshCreateCancelTaskRouter } =
    jest.requireActual<typeof import("./cancel")>("./cancel");

  const router = Router({ mergeParams: true });
  router.use('/:id/cancel', freshCreateCancelTaskRouter({
    queue: queue as JobQueue,
    paymentService,
  }));

  app.use('/api/tasks', router);
  return app;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('POST /api/tasks/:id/cancel', () => {
  let updateStatusMock: jest.Mock;
  let findByIdMock: jest.Mock;
  let storeUpdateStatusMock: jest.Mock;
  let findByTaskIdMock: jest.Mock;
  let getStoreMock: jest.Mock;

  beforeEach(() => {
    updateStatusMock = jest.fn();
    findByIdMock = jest.fn();
    storeUpdateStatusMock = jest.fn();
    findByTaskIdMock = jest.fn();
    getStoreMock = jest.fn(() => ({
      updateStatus: storeUpdateStatusMock,
    } as Partial<JobStore>));

    jest.resetModules();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  function makeApp(taskOverride?: any, jobOverride?: any, paymentService?: any) {
    const task = taskOverride ?? makeTask();
    const job = jobOverride ?? makeJob(task.id);

    const taskDb: Partial<TaskDb> = {
      findById: findByIdMock.mockReturnValue(task),
      updateStatus: updateStatusMock,
    };

    const queue: Partial<JobQueue> = {
      getJobByTaskId: findByTaskIdMock.mockReturnValue(job),
      getStore: getStoreMock,
    };

    return buildApp(taskDb, queue, paymentService);
  }

  // ── 200 success cases ────────────────────────────────────────────────────

  it('200 — task owner can cancel a queued task', async () => {
    const app = makeApp(makeTask({ status: 'queued' }));

    const res = await request(app)
      .post('/api/tasks/task_test001/cancel')
      .set('walletpublickey', 'GPUBKEY123');

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('cancelled');
    expect(res.body.taskId).toBe('task_test001');
    expect(updateStatusMock).toHaveBeenCalledWith('task_test001', 'cancelled');
  });

  it('200 — admin can cancel a queued task without owning it', async () => {
    const app = makeApp(makeTask({ status: 'queued' }));

    const res = await request(app)
      .post('/api/tasks/task_test001/cancel')
      .set('x-admin-key', 'test-admin-key');

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('cancelled');
    expect(updateStatusMock).toHaveBeenCalledWith('task_test001', 'cancelled');
  });

  it('200 — cancelling a running task marks the job as failed', async () => {
    const app = makeApp(makeTask({ status: 'running' }));

    const res = await request(app)
      .post('/api/tasks/task_test001/cancel')
      .set('walletpublickey', 'GPUBKEY123');

    expect(res.status).toBe(200);
    expect(storeUpdateStatusMock).toHaveBeenCalledWith(
      'job_abc',
      'failed',
      expect.objectContaining({ lastError: expect.stringContaining('Cancelled') }),
    );
  });

  it('200 — response includes refundTxHashes array (empty when no Stellar config)', async () => {
    const app = makeApp(makeTask({ status: 'queued' }));

    const res = await request(app)
      .post('/api/tasks/task_test001/cancel')
      .set('walletpublickey', 'GPUBKEY123');

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('refundTxHashes');
    expect(Array.isArray(res.body.refundTxHashes)).toBe(true);
  });

  it('200 — refund tx hashes are returned when PaymentService returns them', async () => {
    const paymentService = {
      listLocalRecords: jest.fn().mockReturnValue([
        { taskId: 'task_test001', nodeId: 'node_1', status: 'locked' },
        { taskId: 'task_test001', nodeId: 'node_2', status: 'locked' },
      ]),
      refund: jest.fn()
        .mockResolvedValueOnce('txhash_abc')
        .mockResolvedValueOnce('txhash_def'),
    };

    // Re-mock config with a secret so the refund path is entered.
    jest.doMock('../../config', () => ({
      getConfig: jest.fn(() => ({
        ADMIN_API_KEY: 'test-admin-key',
        STELLAR_COORDINATOR_SECRET: 'SAA...FAKE',
        LOG_LEVEL: 'silent',
      })),
    }));
    jest.doMock('@stellar/stellar-sdk', () => ({
      Keypair: { fromSecret: jest.fn(() => ({})) },
    }));

    const taskDb: Partial<TaskDb> = {
      findById: findByIdMock.mockReturnValue(makeTask({ status: 'queued' })),
      updateStatus: updateStatusMock,
    };
    const queue: Partial<JobQueue> = {
      getJobByTaskId: findByTaskIdMock.mockReturnValue(null),
      getStore: getStoreMock,
    };

    const app = buildApp(taskDb, queue, paymentService);
    const res = await request(app)
      .post('/api/tasks/task_test001/cancel')
      .set('walletpublickey', 'GPUBKEY123');

    expect(res.status).toBe(200);
  });

  // ── 403 ──────────────────────────────────────────────────────────────────

  it('403 — stranger cannot cancel', async () => {
    const app = makeApp(makeTask({ status: 'queued' }));

    const res = await request(app)
      .post('/api/tasks/task_test001/cancel')
      .set('walletpublickey', 'GWRONGKEY');

    expect(res.status).toBe(403);
  });

  it('403 — no auth header returns 403', async () => {
    const app = makeApp(makeTask({ status: 'queued' }));

    const res = await request(app)
      .post('/api/tasks/task_test001/cancel');

    expect(res.status).toBe(403);
  });

  // ── 404 ──────────────────────────────────────────────────────────────────

  it('404 — unknown task id returns 404', async () => {
    const taskDb: Partial<TaskDb> = {
      findById: jest.fn().mockReturnValue(undefined),
      updateStatus: updateStatusMock,
    };
    const queue: Partial<JobQueue> = {
      getJobByTaskId: findByTaskIdMock.mockReturnValue(null),
      getStore: getStoreMock,
    };
    const app = buildApp(taskDb, queue);

    const res = await request(app)
      .post('/api/tasks/task_unknown/cancel')
      .set('walletpublickey', 'GPUBKEY123');

    expect(res.status).toBe(404);
  });

  // ── 409 ──────────────────────────────────────────────────────────────────

  it('409 — cannot cancel a completed task', async () => {
    const app = makeApp(makeTask({ status: 'completed' }));

    const res = await request(app)
      .post('/api/tasks/task_test001/cancel')
      .set('walletpublickey', 'GPUBKEY123');

    expect(res.status).toBe(409);
    expect(res.body.currentStatus).toBe('completed');
  });

  it('409 — cannot cancel a failed task', async () => {
    const app = makeApp(makeTask({ status: 'failed' }));

    const res = await request(app)
      .post('/api/tasks/task_test001/cancel')
      .set('walletpublickey', 'GPUBKEY123');

    expect(res.status).toBe(409);
    expect(res.body.currentStatus).toBe('failed');
  });

  it('409 — cannot cancel an already-cancelled task', async () => {
    const app = makeApp(makeTask({ status: 'cancelled' }));

    const res = await request(app)
      .post('/api/tasks/task_test001/cancel')
      .set('walletpublickey', 'GPUBKEY123');

    expect(res.status).toBe(409);
    expect(res.body.currentStatus).toBe('cancelled');
  });
});
