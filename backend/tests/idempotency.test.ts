import request from 'supertest';
import Database from 'better-sqlite3';
import { createIdempotencyStore, type IdempotencyStore } from '../src/services/idempotency';
import { createIdempotencyMiddleware } from '../src/api/middleware/idempotency';
import express, { Router, Request, Response } from 'express';

// ---------------------------------------------------------------------------
// Idempotency Store unit tests
// ---------------------------------------------------------------------------

describe('IdempotencyStore', () => {
  let store: IdempotencyStore;
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    store = createIdempotencyStore(db, { cleanupIntervalMs: 0 });
  });

  afterEach(() => {
    store.close();
  });

  describe('get / storeResponse', () => {
    it('returns undefined for a key that has never been stored', () => {
      expect(store.get('nonexistent')).toBeUndefined();
    });

    it('stores and retrieves a response', () => {
      const body = { taskId: 'task_abc', status: 'queued' };
      store.storeResponse('key-1', 201, body);

      const entry = store.get('key-1');
      expect(entry).toBeDefined();
      expect(entry!.key).toBe('key-1');
      expect(entry!.statusCode).toBe(201);
      expect(JSON.parse(entry!.responseBody)).toEqual(body);
    });

    it('does not overwrite an existing key (INSERT OR IGNORE)', () => {
      store.storeResponse('key-1', 201, { first: true });
      store.storeResponse('key-1', 200, { second: true });

      const entry = store.get('key-1');
      expect(entry).toBeDefined();
      expect(entry!.statusCode).toBe(201);
      expect(JSON.parse(entry!.responseBody)).toEqual({ first: true });
    });

    it('different keys store independently', () => {
      store.storeResponse('key-a', 201, { a: 1 });
      store.storeResponse('key-b', 200, { b: 2 });

      expect(store.get('key-a')!.statusCode).toBe(201);
      expect(store.get('key-b')!.statusCode).toBe(200);
    });

    it('scopes the same key to different wallets', () => {
      store.storeResponse('shared-key', 201, { wallet: 'a' }, 'wallet-a');
      store.storeResponse('shared-key', 201, { wallet: 'b' }, 'wallet-b');

      expect(JSON.parse(store.get('shared-key', 'wallet-a')!.responseBody)).toEqual({ wallet: 'a' });
      expect(JSON.parse(store.get('shared-key', 'wallet-b')!.responseBody)).toEqual({ wallet: 'b' });
    });

    it('stores and returns the request payload hash', () => {
      store.storeResponse('hashed-key', 201, { ok: true }, 'anonymous', 'sha256-abc');

      expect(store.get('hashed-key')!.requestHash).toBe('sha256-abc');
    });

    it('defaults requestHash to null when omitted', () => {
      store.storeResponse('legacy-key', 201, { ok: true });

      expect(store.get('legacy-key')!.requestHash).toBeNull();
    });
  });

  describe('TTL expiry', () => {
    it('returns undefined for an entry that has expired', () => {
      // Create a store with a 1ms TTL so it expires almost immediately.
      const shortStore = createIdempotencyStore(db, {
        ttlMs: 1,
        cleanupIntervalMs: 0,
      });

      shortStore.storeResponse('ephemeral', 200, { ok: true });

      // Wait just long enough for the TTL to expire.
      const start = Date.now();
      while (Date.now() - start < 5) {
        // busy wait
      }

      expect(shortStore.get('ephemeral')).toBeUndefined();
      shortStore.stopCleanup();
    });
  });

  describe('cleanup', () => {
    it('removes expired entries and returns the count', () => {
      // Use a 1ms TTL so entries expire immediately.
      const shortStore = createIdempotencyStore(db, {
        ttlMs: 1,
        cleanupIntervalMs: 0,
      });

      shortStore.storeResponse('exp-1', 200, {});
      shortStore.storeResponse('exp-2', 201, {});

      // Wait for expiry.
      const start = Date.now();
      while (Date.now() - start < 5) {
        // busy wait
      }

      const deleted = shortStore.cleanup();
      expect(deleted).toBe(2);

      expect(shortStore.get('exp-1')).toBeUndefined();
      expect(shortStore.get('exp-2')).toBeUndefined();
      shortStore.stopCleanup();
    });

    it('does not remove non-expired entries', () => {
      store.storeResponse('still-good', 200, {});
      const deleted = store.cleanup();
      expect(deleted).toBe(0);
      expect(store.get('still-good')).toBeDefined();
    });
  });

  describe('delete', () => {
    it('removes a single entry', () => {
      store.storeResponse('to-delete', 200, {});
      expect(store.get('to-delete')).toBeDefined();

      store.delete('to-delete');
      expect(store.get('to-delete')).toBeUndefined();
    });
  });

  describe('startCleanup / stopCleanup', () => {
    it('starts and stops without throwing', () => {
      store.startCleanup();
      store.startCleanup(); // idempotent
      store.stopCleanup();
      store.stopCleanup(); // idempotent
    });
  });
});

// ---------------------------------------------------------------------------
// Idempotency Middleware integration tests
// ---------------------------------------------------------------------------

describe('Idempotency Middleware', () => {
  let db: Database.Database;
  let store: IdempotencyStore;
  let app: express.Express;
  let handlerCallCount: number;

  beforeEach(() => {
    db = new Database(':memory:');
    store = createIdempotencyStore(db, { cleanupIntervalMs: 0 });
    handlerCallCount = 0;

    app = express();
    app.use(express.json());

    const testRouter = Router();
    testRouter.post(
      '/tasks',
      createIdempotencyMiddleware(store),
      (_req: Request, res: Response) => {
        handlerCallCount += 1;
        res.status(201).json({ taskId: `task_${handlerCallCount}`, status: 'queued' });
      },
    );

    app.use('/api', testRouter);
  });

  afterEach(() => {
    store.close();
  });

  it('passes through transparently when no Idempotency-Key header is present', async () => {
    const res = await request(app)
      .post('/api/tasks')
      .send({ prompt: 'hello' });

    expect(res.status).toBe(201);
    expect(res.body.taskId).toMatch(/^task_/);
    expect(handlerCallCount).toBe(1);
  });

  it('passes through on the first request with an Idempotency-Key', async () => {
    const res = await request(app)
      .post('/api/tasks')
      .set('Idempotency-Key', '11111111-1111-4111-8111-111111111111')
      .send({ prompt: 'hello' });

    expect(res.status).toBe(201);
    expect(res.body.taskId).toBe('task_1');
    expect(handlerCallCount).toBe(1);
  });

  it('replays the stored response on a duplicate Idempotency-Key', async () => {
    // First request — creates the task.
    const first = await request(app)
      .post('/api/tasks')
      .set('idempotency-key', '22222222-2222-4222-8222-222222222222')
      .send({ prompt: 'hello' });

    expect(first.status).toBe(201);
    expect(first.body.taskId).toBe('task_1');
    expect(handlerCallCount).toBe(1);

    // Second request with the same key — should replay, not create.
    const second = await request(app)
      .post('/api/tasks')
      .set('idempotency-key', '22222222-2222-4222-8222-222222222222')
      .send({ prompt: 'hello' });

    expect(second.status).toBe(201);
    expect(second.body.taskId).toBe('task_1'); // same as first
    expect(second.headers['x-idempotency-replay']).toBe('true');
    expect(handlerCallCount).toBe(1); // handler NOT called again
  });

  it('does not replay a key across different wallets', async () => {
    const key = '66666666-6666-4666-8666-666666666666';
    const first = await request(app)
      .post('/api/tasks')
      .set('Idempotency-Key', key)
      .send({ prompt: 'wallet A task', walletPublicKey: 'wallet-a' });
    const second = await request(app)
      .post('/api/tasks')
      .set('Idempotency-Key', key)
      .send({ prompt: 'wallet B task', walletPublicKey: 'wallet-b' });

    expect(first.body.taskId).toBe('task_1');
    expect(second.body.taskId).toBe('task_2');
    expect(handlerCallCount).toBe(2);
  });

  it('creates separate tasks for different idempotency keys', async () => {
    const first = await request(app)
      .post('/api/tasks')
      .set('idempotency-key', '33333333-3333-4333-8333-333333333333')
      .send({ prompt: 'task A' });

    const second = await request(app)
      .post('/api/tasks')
      .set('idempotency-key', '44444444-4444-4444-8444-444444444444')
      .send({ prompt: 'task B' });

    expect(first.body.taskId).toBe('task_1');
    expect(second.body.taskId).toBe('task_2');
    expect(handlerCallCount).toBe(2);
  });

  it('does not replay error responses (4xx/5xx)', async () => {
    // Create a route that returns a 400 error.
    const errorApp = express();
    errorApp.use(express.json());
    const errorRouter = Router();
    errorRouter.post(
      '/fail',
      createIdempotencyMiddleware(store),
      (_req: Request, res: Response) => {
        handlerCallCount += 1;
        res.status(400).json({ error: 'bad request' });
      },
    );
    errorApp.use('/api', errorRouter);

    const first = await request(errorApp)
      .post('/api/fail')
      .set('idempotency-key', '55555555-5555-4555-8555-555555555555')
      .send({});

    expect(first.status).toBe(400);
    expect(handlerCallCount).toBe(1);

    // Second request should NOT be replayed from cache — it should hit the handler again.
    const second = await request(errorApp)
      .post('/api/fail')
      .set('idempotency-key', '55555555-5555-4555-8555-555555555555')
      .send({});

    expect(second.status).toBe(400);
    expect(handlerCallCount).toBe(2); // handler called again
  });

  it('rejects malformed Idempotency-Key values with 422', async () => {
    const res = await request(app)
      .post('/api/tasks')
      .set('idempotency-key', 'not-a-uuid')
      .send({ prompt: 'hello' });

    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('INVALID_IDEMPOTENCY_KEY');
    expect(handlerCallCount).toBe(0);
  });

  it('rejects whitespace-only Idempotency-Key values with 422', async () => {
    const res = await request(app)
      .post('/api/tasks')
      .set('idempotency-key', '   ')
      .send({ prompt: 'hello' });

    expect(res.status).toBe(422);
    expect(handlerCallCount).toBe(0);
  });

  it('returns 409 when the same key is reused with a different payload', async () => {
    const key = '77777777-7777-4777-8777-777777777777';

    const first = await request(app)
      .post('/api/tasks')
      .set('Idempotency-Key', key)
      .send({ prompt: 'original payload' });

    expect(first.status).toBe(201);
    expect(handlerCallCount).toBe(1);

    const conflict = await request(app)
      .post('/api/tasks')
      .set('Idempotency-Key', key)
      .send({ prompt: 'tampered payload' });

    expect(conflict.status).toBe(409);
    expect(conflict.body.error.code).toBe('IDEMPOTENCY_PAYLOAD_MISMATCH');
    expect(handlerCallCount).toBe(1); // handler still NOT called
    expect(conflict.headers['x-idempotency-replay']).toBeUndefined();
  });

  it('replays identically-keyed requests that repeat the original payload', async () => {
    const key = '88888888-8888-4888-8888-888888888888';
    const payload = { prompt: 'stable payload', maxBudgetXLM: 1 };

    const first = await request(app)
      .post('/api/tasks')
      .set('Idempotency-Key', key)
      .send(payload);
    const second = await request(app)
      .post('/api/tasks')
      .set('Idempotency-Key', key)
      .send(payload);

    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(second.body.taskId).toBe(first.body.taskId);
    expect(second.headers['x-idempotency-replay']).toBe('true');
    expect(handlerCallCount).toBe(1);
  });

  it('replays entries stored without a payload hash (legacy back-compat)', async () => {
    const key = '99999999-9999-4999-8999-999999999999';
    // Simulate an entry persisted before request hashing existed.
    store.storeResponse(key, 201, { taskId: 'task_legacy', status: 'queued' });

    const res = await request(app)
      .post('/api/tasks')
      .set('Idempotency-Key', key)
      .send({ prompt: 'anything' });

    expect(res.status).toBe(201);
    expect(res.body.taskId).toBe('task_legacy');
    expect(res.headers['x-idempotency-replay']).toBe('true');
    expect(handlerCallCount).toBe(0);
  });
});
