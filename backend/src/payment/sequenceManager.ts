import { randomUUID } from "crypto";

export const SEQUENCE_LOCK_TTL_MS = 10_000;

export interface RedisSequenceLockClient {
  set(key: string, value: string, expiry: "PX", ttlMs: number, condition: "NX"): Promise<string | null>;
  eval(script: string, numberOfKeys: number, key: string, value: string): Promise<unknown>;
}

const RELEASE_LOCK_SCRIPT = `
  if redis.call("get", KEYS[1]) == ARGV[1] then
    return redis.call("del", KEYS[1])
  end
  return 0
`;

function createRedisClient(): RedisSequenceLockClient | undefined {
  if (process.env.NODE_ENV === "test") return undefined;
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const Redis = require("ioredis") as new (url: string, options: Record<string, unknown>) => RedisSequenceLockClient;
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { getConfig } = require("../config") as typeof import("../config");
  return new Redis(getConfig().REDIS_URL, {
    lazyConnect: true,
    maxRetriesPerRequest: 1,
    enableOfflineQueue: false,
  });
}

/** Serializes Stellar submissions per account, with a Redis lease across processes. */
export class SequenceNumberManager {
  private readonly locks = new Map<string, Promise<void>>();
  private readonly redis: RedisSequenceLockClient | undefined;

  constructor(redisClient?: RedisSequenceLockClient | null) {
    this.redis = redisClient === null ? undefined : redisClient ?? createRedisClient();
  }

  async withAccount<T>(publicKey: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(publicKey) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.locks.set(publicKey, current);

    await previous;
    try {
      return this.redis
        ? await this.withRedisLock(publicKey, fn)
        : await fn();
    } finally {
      release();
      if (this.locks.get(publicKey) === current) this.locks.delete(publicKey);
    }
  }

  private async withRedisLock<T>(publicKey: string, fn: () => Promise<T>): Promise<T> {
    const key = `stellar:sequence:${publicKey}`;
    const token = randomUUID();
    const deadline = Date.now() + SEQUENCE_LOCK_TTL_MS;

    while (Date.now() < deadline) {
      const acquired = await this.redis!.set(key, token, "PX", SEQUENCE_LOCK_TTL_MS, "NX");
      if (acquired === "OK") {
        try {
          return await fn();
        } finally {
          await this.redis!.eval(RELEASE_LOCK_SCRIPT, 1, key, token).catch(() => undefined);
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }

    throw new Error(`Timed out acquiring Stellar sequence lock for ${publicKey}`);
  }
}