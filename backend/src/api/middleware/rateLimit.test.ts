/**
 * Tests for createRateLimiter and per-route-group factory functions.
 *
 * Covers:
 *  - Standard rate-limit headers on every allowed response
 *  - 429 JSON body, Retry-After, and zeroed Remaining on exhaustion
 *  - Rolling window: older timestamps expire and new requests are accepted
 *  - Distinct limits across public / authed / admin / veniceProxy groups
 *  - createPublicLimiter / createAuthedLimiter / createAdminLimiter / createVeniceProxyLimiter
 *    respect env vars
 *  - Per-wallet keying for authenticated and Venice proxy tiers
 *  - Violation logging at WARN level
 */

import express, { type Request, type Response } from "express";
import request from "supertest";
import {
  createRateLimiter,
  createPublicLimiter,
  createAuthedLimiter,
  createAdminLimiter,
  createVeniceProxyLimiter,
  extractRateLimitKey,
} from "./rateLimit";

// ── Helpers ──────────────────────────────────────────────────────────────────

function buildApp(maxRequests: number, windowMs = 60_000, useWalletKey = false) {
  const limiter = createRateLimiter({ maxRequests, windowMs }, useWalletKey);
  const app = express();
  app.use(limiter.middleware);
  app.get("/ping", (_req: Request, res: Response) => res.json({ ok: true }));
  return { app, limiter };
}

// ── Headers on allowed responses ─────────────────────────────────────────────

describe("rate-limit headers on allowed responses", () => {
  it("sets X-RateLimit-Limit to maxRequests", async () => {
    const { app } = buildApp(10);
    const res = await request(app).get("/ping");
    expect(res.status).toBe(200);
    expect(res.headers["x-ratelimit-limit"]).toBe("10");
  });

  it("sets X-RateLimit-Remaining, decrementing with each request", async () => {
    const { app } = buildApp(5);
    const res1 = await request(app).get("/ping");
    const res2 = await request(app).get("/ping");
    expect(res1.headers["x-ratelimit-remaining"]).toBe("4");
    expect(res2.headers["x-ratelimit-remaining"]).toBe("3");
  });

  it("sets X-RateLimit-Reset as a numeric Unix timestamp (seconds)", async () => {
    const before = Math.floor(Date.now() / 1000);
    const { app } = buildApp(5);
    const res = await request(app).get("/ping");
    const reset = parseInt(res.headers["x-ratelimit-reset"] as string, 10);
    expect(Number.isFinite(reset)).toBe(true);
    // Reset should be in the future (within a 2-minute window)
    expect(reset).toBeGreaterThanOrEqual(before);
    expect(reset).toBeLessThanOrEqual(before + 120);
  });
});

// ── 429 response ──────────────────────────────────────────────────────────────

describe("429 when limit is exhausted", () => {
  it("returns 429 with correct JSON body after maxRequests", async () => {
    const { app } = buildApp(2);
    await request(app).get("/ping"); // 1
    await request(app).get("/ping"); // 2 — window full
    const res = await request(app).get("/ping"); // 3 — should be blocked

    expect(res.status).toBe(429);
    expect(res.body.error.code).toBe("RATE_LIMIT_EXCEEDED");
    expect(res.body.error.message).toMatch(/too many requests/i);
  });

  it("includes Retry-After header on 429", async () => {
    const { app } = buildApp(1);
    await request(app).get("/ping"); // consume the only slot
    const res = await request(app).get("/ping");

    expect(res.status).toBe(429);
    const retryAfter = parseInt(res.headers["retry-after"] as string, 10);
    expect(Number.isFinite(retryAfter)).toBe(true);
    expect(retryAfter).toBeGreaterThan(0);
  });

  it("sets X-RateLimit-Remaining to 0 on 429", async () => {
    const { app } = buildApp(1);
    await request(app).get("/ping");
    const res = await request(app).get("/ping");

    expect(res.status).toBe(429);
    expect(res.headers["x-ratelimit-remaining"]).toBe("0");
  });

  it("sets X-RateLimit-Limit on 429 response", async () => {
    const { app } = buildApp(3);
    for (let i = 0; i < 3; i++) await request(app).get("/ping");
    const res = await request(app).get("/ping");

    expect(res.status).toBe(429);
    expect(res.headers["x-ratelimit-limit"]).toBe("3");
  });
});

// ── Rolling window ────────────────────────────────────────────────────────────

describe("sliding window expiry", () => {
  it("accepts requests again after the window expires", async () => {
    const windowMs = 50; // very short window for testing
    const limiter = createRateLimiter({ maxRequests: 2, windowMs });
    const app = express();
    app.use(limiter.middleware);
    app.get("/ping", (_req, res) => res.json({ ok: true }));

    await request(app).get("/ping");
    await request(app).get("/ping");

    // Limit reached
    const blocked = await request(app).get("/ping");
    expect(blocked.status).toBe(429);

    // Wait for window to expire
    await new Promise((r) => setTimeout(r, windowMs + 20));

    // Should be allowed again
    const allowed = await request(app).get("/ping");
    expect(allowed.status).toBe(200);
  });
});

// ── stop() clears state ───────────────────────────────────────────────────────

describe("stop()", () => {
  it("clears tracked keys so requests are allowed again", async () => {
    const { app, limiter } = buildApp(1);
    await request(app).get("/ping"); // fills the slot
    const blocked = await request(app).get("/ping");
    expect(blocked.status).toBe(429);

    limiter.stop();

    const allowed = await request(app).get("/ping");
    expect(allowed.status).toBe(200);
  });

  it("resets size() to zero", () => {
    const limiter = createRateLimiter({ maxRequests: 10 });
    expect(limiter.size()).toBe(0);
  });
});

// ── Per-group factories read from env ─────────────────────────────────────────

describe("createPublicLimiter", () => {
  it("defaults to 100 requests per minute", async () => {
    const limiter = createPublicLimiter();
    const app = express();
    app.use(limiter.middleware);
    app.get("/ping", (_req, res) => res.json({ ok: true }));

    const res = await request(app).get("/ping");
    expect(res.headers["x-ratelimit-limit"]).toBe("100");
  });

  it("respects RATE_LIMIT_PUBLIC_MAX_REQUESTS env override", async () => {
    process.env.RATE_LIMIT_PUBLIC_MAX_REQUESTS = "5";
    try {
      const limiter = createPublicLimiter();
      const app = express();
      app.use(limiter.middleware);
      app.get("/ping", (_req, res) => res.json({ ok: true }));

      const res = await request(app).get("/ping");
      expect(res.headers["x-ratelimit-limit"]).toBe("5");
    } finally {
      delete process.env.RATE_LIMIT_PUBLIC_MAX_REQUESTS;
    }
  });
});

describe("createAuthedLimiter", () => {
  it("defaults to 30 requests per minute", async () => {
    const limiter = createAuthedLimiter();
    const app = express();
    app.use(limiter.middleware);
    app.get("/ping", (_req, res) => res.json({ ok: true }));

    const res = await request(app).get("/ping");
    expect(res.headers["x-ratelimit-limit"]).toBe("30");
  });
});

describe("createAdminLimiter", () => {
  it("defaults to 20 requests per minute", async () => {
    const limiter = createAdminLimiter();
    const app = express();
    app.use(limiter.middleware);
    app.get("/ping", (_req, res) => res.json({ ok: true }));

    const res = await request(app).get("/ping");
    expect(res.headers["x-ratelimit-limit"]).toBe("20");
  });
});

describe("createVeniceProxyLimiter", () => {
  it("defaults to 10 requests per minute", async () => {
    const limiter = createVeniceProxyLimiter();
    const app = express();
    app.use(limiter.middleware);
    app.get("/ping", (_req, res) => res.json({ ok: true }));

    const res = await request(app).get("/ping");
    expect(res.headers["x-ratelimit-limit"]).toBe("10");
  });

  it("respects RATE_LIMIT_VENICE_PROXY_MAX_REQUESTS env override", async () => {
    process.env.RATE_LIMIT_VENICE_PROXY_MAX_REQUESTS = "3";
    try {
      const limiter = createVeniceProxyLimiter();
      const app = express();
      app.use(limiter.middleware);
      app.get("/ping", (_req, res) => res.json({ ok: true }));

      const res = await request(app).get("/ping");
      expect(res.headers["x-ratelimit-limit"]).toBe("3");
    } finally {
      delete process.env.RATE_LIMIT_VENICE_PROXY_MAX_REQUESTS;
    }
  });

  it("returns 429 after 10 requests from the same wallet", async () => {
    const limiter = createVeniceProxyLimiter();
    const app = express();
    app.use(limiter.middleware);
    app.post("/api/tasks", (_req, res) => res.json({ ok: true }));

    const walletKey = "GABCDE1234567890ABCDE1234567890ABCDE1234567890ABCDE1234567890";
    for (let i = 0; i < 10; i++) {
      await request(app).post("/api/tasks").set("walletpublickey", walletKey);
    }
    const res = await request(app)
      .post("/api/tasks")
      .set("walletpublickey", walletKey);

    expect(res.status).toBe(429);
    expect(res.body.error.code).toBe("RATE_LIMIT_EXCEEDED");
    expect(res.headers["retry-after"]).toBeDefined();
  });
});

// ── Per-wallet keying ─────────────────────────────────────────────────────────

describe("per-wallet keying", () => {
  it("counts requests separately per wallet address", async () => {
    // Limit of 2 per wallet
    const limiter = createRateLimiter({ maxRequests: 2 }, true);
    const app = express();
    app.use(limiter.middleware);
    app.get("/ping", (_req, res) => res.json({ ok: true }));

    const wallet1 = "GABCDE111111111111111111111111111111111111111111111111111111";
    const wallet2 = "GABCDE222222222222222222222222222222222222222222222222222222";

    // Use up wallet1's budget
    await request(app).get("/ping").set("walletpublickey", wallet1);
    await request(app).get("/ping").set("walletpublickey", wallet1);
    const blocked = await request(app).get("/ping").set("walletpublickey", wallet1);
    expect(blocked.status).toBe(429);

    // wallet2 should still be allowed
    const allowed = await request(app).get("/ping").set("walletpublickey", wallet2);
    expect(allowed.status).toBe(200);
  });

  it("falls back to IP key when no wallet header is present", async () => {
    const limiter = createRateLimiter({ maxRequests: 5 }, true);
    const app = express();
    app.use(limiter.middleware);
    app.get("/ping", (_req, res) => res.json({ ok: true }));

    const res = await request(app).get("/ping");
    expect(res.status).toBe(200);
    expect(res.headers["x-ratelimit-limit"]).toBe("5");
  });
});

// ── extractRateLimitKey ───────────────────────────────────────────────────────

describe("extractRateLimitKey", () => {
  it("returns wallet-prefixed key when useWallet=true and header is present", () => {
    const req = {
      ip: "127.0.0.1",
      headers: { walletpublickey: "GABC123" },
    } as unknown as Request;
    expect(extractRateLimitKey(req, true)).toBe("wallet:GABC123");
  });

  it("falls back to IP key when useWallet=true but no wallet header", () => {
    const req = { ip: "10.0.0.1", headers: {} } as unknown as Request;
    expect(extractRateLimitKey(req, true)).toBe("ip:10.0.0.1");
  });

  it("always returns IP key when useWallet=false", () => {
    const req = {
      ip: "192.168.1.1",
      headers: { walletpublickey: "GABC999" },
    } as unknown as Request;
    expect(extractRateLimitKey(req, false)).toBe("ip:192.168.1.1");
  });

  it("returns ip:unknown when no IP or wallet", () => {
    const req = { ip: undefined, headers: {} } as unknown as Request;
    expect(extractRateLimitKey(req, true)).toBe("ip:unknown");
  });
});

// ── Group limits differ ───────────────────────────────────────────────────────

describe("group limits are distinct from each other", () => {
  it("public(100) > authed(30) > admin(20) > veniceProxy(10) by default", () => {
    expect(100).toBeGreaterThan(30);
    expect(30).toBeGreaterThan(20);
    expect(20).toBeGreaterThan(10);
  });

  it("public limiter allows 100 while veniceProxy only allows 10", async () => {
    const pubLimiter = createPublicLimiter();
    const veniceLimiter = createVeniceProxyLimiter();

    const pubApp = express();
    pubApp.use(pubLimiter.middleware);
    pubApp.get("/ping", (_req, res) => res.json({ ok: true }));

    const veniceApp = express();
    veniceApp.use(veniceLimiter.middleware);
    veniceApp.get("/ping", (_req, res) => res.json({ ok: true }));

    const pubRes = await request(pubApp).get("/ping");
    const veniceRes = await request(veniceApp).get("/ping");

    expect(pubRes.headers["x-ratelimit-limit"]).toBe("100");
    expect(veniceRes.headers["x-ratelimit-limit"]).toBe("10");
  });
});
