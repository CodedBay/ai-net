/**
 * Unit tests for the test data factories in backend/tests/factories/index.ts.
 *
 * These tests verify that each factory:
 *  - Produces objects with correct shape and default values.
 *  - Returns unique IDs on successive calls (no collisions).
 *  - Respects Partial<T> overrides passed by the caller.
 *  - Never embeds real Stellar keys or credentials.
 */

import type { DAGNode } from "../src/types/task";
import {
  resetFactoryCounter,
  makeWallet,
  makeAgentRecord,
  makePaymentRecord,
  makeDAGNode,
  makeTask,
  makePipelineDAG,
  makePipelineTask,
} from "./factories/index";

beforeEach(() => {
  // Reset counter so test sequences are predictable and isolated.
  resetFactoryCounter();
});

// ─────────────────────────────────────────────────────────────────────────────
//  Wallet
// ─────────────────────────────────────────────────────────────────────────────

describe("makeWallet", () => {
  it("returns a publicKey that starts with G and is 56 chars", () => {
    const w = makeWallet();
    expect(w.publicKey).toMatch(/^G/);
    expect(w.publicKey).toHaveLength(56);
  });

  it("returns a secretKey that starts with S and is 56 chars", () => {
    const w = makeWallet();
    expect(w.secretKey).toMatch(/^S/);
    expect(w.secretKey).toHaveLength(56);
  });

  it("produces distinct keys for different counter values", () => {
    const w1 = makeWallet(1);
    const w2 = makeWallet(2);
    expect(w1.publicKey).not.toBe(w2.publicKey);
    expect(w1.secretKey).not.toBe(w2.secretKey);
  });

  it("keys contain only alphanumeric characters", () => {
    const w = makeWallet(42);
    expect(w.publicKey).toMatch(/^[A-Z0-9]{56}$/);
    expect(w.secretKey).toMatch(/^[A-Z0-9]{56}$/);
  });

  it("never produces a real Stellar key (placeholder only)", () => {
    // Placeholder keys contain the literal string TEST as a marker.
    const w = makeWallet();
    expect(w.publicKey).toContain("TEST");
    expect(w.secretKey).toContain("TEST");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
//  AgentRecord
// ─────────────────────────────────────────────────────────────────────────────

describe("makeAgentRecord", () => {
  it("returns an object with all required AgentRecord fields", () => {
    const agent = makeAgentRecord();
    expect(agent).toMatchObject({
      id: expect.any(String),
      capabilities: expect.any(Array),
      pricingXLM: expect.any(Number),
      endpoint: expect.any(String),
      stellarPublicKey: expect.any(String),
      reputationScore: expect.any(Number),
      lastSeenAt: expect.any(String),
      status: expect.stringMatching(/^(online|offline)$/),
    });
  });

  it("produces unique IDs on successive calls", () => {
    const a1 = makeAgentRecord();
    const a2 = makeAgentRecord();
    expect(a1.id).not.toBe(a2.id);
  });

  it("stellarPublicKey is a test-only placeholder (starts with G, length 56)", () => {
    const agent = makeAgentRecord();
    expect(agent.stellarPublicKey).toMatch(/^G/);
    expect(agent.stellarPublicKey).toHaveLength(56);
    expect(agent.stellarPublicKey).toContain("TEST");
  });

  it("applies overrides correctly", () => {
    const agent = makeAgentRecord({
      status: "offline",
      pricingXLM: 9.99,
      capabilities: ["coding", "design"],
    });
    expect(agent.status).toBe("offline");
    expect(agent.pricingXLM).toBe(9.99);
    expect(agent.capabilities).toEqual(["coding", "design"]);
  });

  it("default reputationScore is 2.5", () => {
    const agent = makeAgentRecord();
    expect(agent.reputationScore).toBe(2.5);
  });

  it("lastSeenAt is a valid ISO-8601 string", () => {
    const agent = makeAgentRecord();
    expect(() => new Date(agent.lastSeenAt)).not.toThrow();
    expect(new Date(agent.lastSeenAt).toISOString()).toBe(agent.lastSeenAt);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
//  PaymentRecord
// ─────────────────────────────────────────────────────────────────────────────

describe("makePaymentRecord", () => {
  it("returns an object with all required PaymentRecord fields", () => {
    const payment = makePaymentRecord();
    expect(payment).toMatchObject({
      taskId: expect.any(String),
      nodeId: expect.any(String),
      balanceId: expect.any(String),
      status: expect.stringMatching(/^(locked|released|refunded)$/),
      amountStroops: expect.anything(),
      txHash: null,
    });
  });

  it("amountStroops is a BigInt", () => {
    const payment = makePaymentRecord();
    expect(typeof payment.amountStroops).toBe("bigint");
  });

  it("produces unique taskId/nodeId on successive calls", () => {
    const p1 = makePaymentRecord();
    const p2 = makePaymentRecord();
    expect(p1.taskId).not.toBe(p2.taskId);
    expect(p1.nodeId).not.toBe(p2.nodeId);
  });

  it("default status is locked", () => {
    const payment = makePaymentRecord();
    expect(payment.status).toBe("locked");
  });

  it("applies overrides correctly", () => {
    const payment = makePaymentRecord({
      status: "released",
      amountStroops: 5_000_000n,
      txHash: "abc123txhash",
    });
    expect(payment.status).toBe("released");
    expect(payment.amountStroops).toBe(5_000_000n);
    expect(payment.txHash).toBe("abc123txhash");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
//  DAGNode
// ─────────────────────────────────────────────────────────────────────────────

describe("makeDAGNode", () => {
  it("returns an object with all required DAGNode fields", () => {
    const node = makeDAGNode();
    expect(node).toMatchObject({
      nodeId: expect.any(String),
      type: expect.any(String),
      dependencies: expect.any(Array),
      status: expect.stringMatching(/^(pending|running|completed|failed)$/),
    });
  });

  it("produces unique nodeIds on successive calls", () => {
    const n1 = makeDAGNode();
    const n2 = makeDAGNode();
    expect(n1.nodeId).not.toBe(n2.nodeId);
  });

  it("default status is pending with empty dependencies", () => {
    const node = makeDAGNode();
    expect(node.status).toBe("pending");
    expect(node.dependencies).toEqual([]);
  });

  it("applies overrides correctly", () => {
    const node = makeDAGNode({ type: "risk", status: "completed" });
    expect(node.type).toBe("risk");
    expect(node.status).toBe("completed");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
//  Task
// ─────────────────────────────────────────────────────────────────────────────

describe("makeTask", () => {
  it("returns an object with all required Task fields", () => {
    const task = makeTask();
    expect(task).toMatchObject({
      id: expect.any(String),
      prompt: expect.any(String),
      walletPublicKey: expect.any(String),
      status: expect.stringMatching(/^(queued|running|completed|cancelled|failed)$/),
      dag: expect.any(Array),
      createdAt: expect.any(String),
      updatedAt: expect.any(String),
    });
  });

  it("produces unique IDs on successive calls", () => {
    const t1 = makeTask();
    const t2 = makeTask();
    expect(t1.id).not.toBe(t2.id);
  });

  it("default status is queued with empty dag", () => {
    const task = makeTask();
    expect(task.status).toBe("queued");
    expect(task.dag).toEqual([]);
  });

  it("walletPublicKey is a test-only placeholder (starts with G, length 56)", () => {
    const task = makeTask();
    expect(task.walletPublicKey).toMatch(/^G/);
    expect(task.walletPublicKey).toHaveLength(56);
    expect(task.walletPublicKey).toContain("TEST");
  });

  it("createdAt and updatedAt are valid ISO-8601 strings", () => {
    const task = makeTask();
    expect(new Date(task.createdAt).toISOString()).toBe(task.createdAt);
    expect(new Date(task.updatedAt).toISOString()).toBe(task.updatedAt);
  });

  it("applies overrides correctly", () => {
    const task = makeTask({
      status: "running",
      prompt: "Custom prompt",
    });
    expect(task.status).toBe("running");
    expect(task.prompt).toBe("Custom prompt");
  });

  it("requestId and traceId are optional and undefined by default", () => {
    const task = makeTask();
    expect(task.requestId).toBeUndefined();
    expect(task.traceId).toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
//  Pipeline DAG factory
// ─────────────────────────────────────────────────────────────────────────────

describe("makePipelineDAG", () => {
  it("produces the requested number of nodes", () => {
    expect(makePipelineDAG(1)).toHaveLength(1);
    expect(makePipelineDAG(3)).toHaveLength(3);
    expect(makePipelineDAG(5)).toHaveLength(5);
  });

  it("first node has no dependencies", () => {
    const dag = makePipelineDAG(3);
    expect(dag[0].dependencies).toEqual([]);
  });

  it("each subsequent node depends on the previous node", () => {
    const dag = makePipelineDAG(4);
    for (let i = 1; i < dag.length; i++) {
      expect(dag[i].dependencies).toEqual([dag[i - 1].nodeId]);
    }
  });

  it("all nodes have unique nodeIds", () => {
    const dag = makePipelineDAG(5);
    const ids = dag.map((n: DAGNode) => n.nodeId);
    const uniqueIds = new Set(ids);
    expect(uniqueIds.size).toBe(ids.length);
  });

  it("all nodes default to pending status", () => {
    const dag = makePipelineDAG(3);
    dag.forEach((node: DAGNode) => expect(node.status).toBe("pending"));
  });

  it("throws a RangeError when n < 1", () => {
    expect(() => makePipelineDAG(0)).toThrow(RangeError);
    expect(() => makePipelineDAG(-1)).toThrow(RangeError);
  });

  it("applies nodeOverrides to every node", () => {
    const dag = makePipelineDAG(3, { status: "completed" });
    dag.forEach((node: DAGNode) => expect(node.status).toBe("completed"));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
//  Pipeline Task factory
// ─────────────────────────────────────────────────────────────────────────────

describe("makePipelineTask", () => {
  it("creates a Task whose dag has exactly n nodes", () => {
    const task = makePipelineTask(3);
    expect(task.dag).toHaveLength(3);
  });

  it("dag nodes are sequentially connected", () => {
    const task = makePipelineTask(4);
    const dag = task.dag;
    expect(dag[0].dependencies).toEqual([]);
    for (let i = 1; i < dag.length; i++) {
      expect(dag[i].dependencies).toEqual([dag[i - 1].nodeId]);
    }
  });

  it("applies task-level overrides", () => {
    const task = makePipelineTask(2, { status: "running" });
    expect(task.status).toBe("running");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
//  Uniqueness across factory types
// ─────────────────────────────────────────────────────────────────────────────

describe("global counter uniqueness", () => {
  it("IDs do not collide when mixing factory calls", () => {
    const agent = makeAgentRecord();
    const payment = makePaymentRecord();
    const task = makeTask();
    const node = makeDAGNode();

    const allIds = [agent.id, payment.taskId, payment.nodeId, task.id, node.nodeId];
    const uniqueIds = new Set(allIds);
    expect(uniqueIds.size).toBe(allIds.length);
  });
});
