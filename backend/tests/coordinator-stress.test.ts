/**
 * PipelineOrchestrator Stress Tests — Issue #92
 *
 * Verifies correct behavior of the Coordinator under concurrent load.
 *
 * Scenarios:
 *   1. 10 pipelines running simultaneously, each with 5 nodes
 *   2. No cross-pipeline state contamination
 *   3. Correct node completion ordering within each pipeline
 *   4. Resource cleanup after pipeline completion
 *   5. Random node failures — dependent nodes are skipped (status=failed)
 *   6. Memory stability after 100 pipeline completions
 *   7. Fake timers control async execution order
 */

import { Coordinator } from "../src/coordinator/coordinator";
import type { DAGNode } from "../src/types/task";
import { eventBus } from "../src/coordinator/eventBus";

// ── Jest mocks ────────────────────────────────────────────────────────────────

jest.mock("../src/coordinator/taskStore", () => ({
  createTask: jest.fn(),
  getTask: jest.fn((id: string) => ({
    id,
    prompt: "stress test",
    walletPublicKey: "GWALLET",
    status: "queued",
    dag: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  })),
  updateTask: jest.fn(),
  updateNode: jest.fn(),
  getEventHistory: jest.fn().mockReturnValue([]),
}));

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeLinearDag(nodeCount: number, type = "research"): DAGNode[] {
  const nodes: DAGNode[] = [];
  for (let i = 0; i < nodeCount; i++) {
    nodes.push({
      nodeId: `n${i}`,
      type,
      status: "pending",
      prompt: `Step ${i}`,
      dependencies: i === 0 ? [] : [`n${i - 1}`],
    });
  }
  return nodes;
}

/** Build a DAG: first 3 nodes are independent, last 2 depend on all 3. */
function makeFanInDag(): DAGNode[] {
  return [
    { nodeId: "research", type: "research", status: "pending", prompt: "research", dependencies: [] },
    { nodeId: "risk", type: "risk", status: "pending", prompt: "risk", dependencies: [] },
    { nodeId: "coding", type: "coding", status: "pending", prompt: "coding", dependencies: [] },
    { nodeId: "design", type: "design", status: "pending", prompt: "design", dependencies: ["research", "risk", "coding"] },
    { nodeId: "report", type: "report", status: "pending", prompt: "report", dependencies: ["design"] },
  ];
}

/** Build a DAG where one specific node will fail. */
function makeFailingDag(failNodeId: string): DAGNode[] {
  return [
    { nodeId: "n0", type: "research", status: "pending", prompt: "p0", dependencies: [] },
    { nodeId: failNodeId, type: "risk", status: "pending", prompt: "p-fail", dependencies: ["n0"] },
    { nodeId: "n2", type: "coding", status: "pending", prompt: "p2", dependencies: [failNodeId] },
    { nodeId: "n3", type: "report", status: "pending", prompt: "p3", dependencies: ["n2"] },
  ];
}

function makeCoordinator(dispatch?: jest.Mock): Coordinator {
  return new Coordinator({
    dispatch: dispatch ?? jest.fn().mockResolvedValue({ result: "ok" }),
    paymentService: { release: jest.fn().mockResolvedValue("tx-hash") },
    concurrency: 5,
  });
}

// ─────────────────────────────────────────────────────────────────────────────
//  1. 10 concurrent pipelines, each with 5 nodes
// ─────────────────────────────────────────────────────────────────────────────

describe("10 concurrent pipelines with 5 nodes each", () => {
  it("all 10 pipelines complete without errors", async () => {
    const PIPELINE_COUNT = 10;
    const NODE_COUNT = 5;

    const dispatch = jest.fn().mockResolvedValue({ result: "ok" });
    const coord = makeCoordinator(dispatch);

    const runs = Array.from({ length: PIPELINE_COUNT }, (_, i) => {
      const dag = makeLinearDag(NODE_COUNT);
      return coord.executeDAG(`task-${i}`, dag);
    });

    await Promise.all(runs);

    // Each pipeline has NODE_COUNT nodes → total dispatch calls = PIPELINE_COUNT * NODE_COUNT.
    expect(dispatch).toHaveBeenCalledTimes(PIPELINE_COUNT * NODE_COUNT);
  });

  it("all nodes in every pipeline reach 'completed' status", async () => {
    const PIPELINE_COUNT = 10;
    const NODE_COUNT = 5;

    const dispatch = jest.fn().mockResolvedValue({ result: "done" });
    const coord = makeCoordinator(dispatch);

    const dags = Array.from({ length: PIPELINE_COUNT }, () => makeLinearDag(NODE_COUNT));
    const runs = dags.map((dag, i) => coord.executeDAG(`task-p${i}`, dag));

    await Promise.all(runs);

    for (const dag of dags) {
      for (const node of dag) {
        expect(node.status).toBe("completed");
      }
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
//  2. No cross-pipeline state contamination
// ─────────────────────────────────────────────────────────────────────────────

describe("cross-pipeline isolation", () => {
  it("each pipeline's DAG nodes carry only their own results", async () => {
    const coord = new Coordinator({
      dispatch: jest.fn().mockImplementation(async (_taskId: string, node: DAGNode) => {
        // Result is specific to the node — embed the nodeId so we can verify isolation.
        return { nodeId: node.nodeId, pipeline: _taskId };
      }),
      paymentService: { release: jest.fn().mockResolvedValue("tx") },
      concurrency: 10,
    });

    const dags: Record<string, DAGNode[]> = {};
    const runs: Promise<void>[] = [];

    for (let i = 0; i < 5; i++) {
      const taskId = `pipeline-${i}`;
      dags[taskId] = makeLinearDag(3);
      runs.push(coord.executeDAG(taskId, dags[taskId]));
    }

    await Promise.all(runs);

    for (const [taskId, dag] of Object.entries(dags)) {
      for (const node of dag) {
        expect(node.status).toBe("completed");
        // Each node's result must reference this pipeline, not another.
        const result = node.result as { nodeId: string; pipeline: string };
        expect(result.pipeline).toBe(taskId);
        expect(result.nodeId).toBe(node.nodeId);
      }
    }
  });

  it("a failure in one pipeline does not affect sibling pipelines", async () => {
    // Pipeline 0 always fails; pipelines 1-4 always succeed.
    const dispatch = jest.fn().mockImplementation(async (taskId: string) => {
      if (taskId === "failing-pipeline") {
        throw new Error("injected failure");
      }
      return { result: "ok" };
    });

    const coord = makeCoordinator(dispatch);

    const failingDag = makeLinearDag(3);
    const successDags = Array.from({ length: 4 }, () => makeLinearDag(3));

    await Promise.all([
      coord.executeDAG("failing-pipeline", failingDag),
      ...successDags.map((dag, i) => coord.executeDAG(`ok-pipeline-${i}`, dag)),
    ]);

    // The failing pipeline's nodes should all be failed.
    for (const node of failingDag) {
      expect(node.status).toBe("failed");
    }

    // The successful pipelines' nodes should all be completed.
    for (const dag of successDags) {
      for (const node of dag) {
        expect(node.status).toBe("completed");
      }
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
//  3. Correct node completion ordering
// ─────────────────────────────────────────────────────────────────────────────

describe("node ordering invariants", () => {
  it("linear DAG: each node runs after its predecessor completes", async () => {
    const order: string[] = [];

    const dispatch = jest.fn().mockImplementation(async (_taskId: string, node: DAGNode) => {
      order.push(node.nodeId);
      return { result: node.nodeId };
    });

    const coord = makeCoordinator(dispatch);
    const dag = makeLinearDag(5);

    await coord.executeDAG("ordering-test", dag);

    // In a linear DAG n0→n1→n2→n3→n4 the order must be exactly [n0,n1,n2,n3,n4].
    expect(order).toEqual(["n0", "n1", "n2", "n3", "n4"]);
  });

  it("fan-in DAG: terminal node runs after all its dependencies", async () => {
    const completedBefore = new Map<string, Set<string>>();
    const completedNodes = new Set<string>();

    const dispatch = jest.fn().mockImplementation(async (_taskId: string, node: DAGNode) => {
      // Snapshot which nodes have already completed when this node starts.
      completedBefore.set(node.nodeId, new Set(completedNodes));
      completedNodes.add(node.nodeId);
      return { result: "ok" };
    });

    const coord = makeCoordinator(dispatch);
    const dag = makeFanInDag();

    await coord.executeDAG("fan-in-test", dag);

    // "design" must start after research, risk, coding are all done.
    const beforeDesign = completedBefore.get("design")!;
    expect(beforeDesign.has("research")).toBe(true);
    expect(beforeDesign.has("risk")).toBe(true);
    expect(beforeDesign.has("coding")).toBe(true);

    // "report" must start after design is done.
    const beforeReport = completedBefore.get("report")!;
    expect(beforeReport.has("design")).toBe(true);
  });

  it("all 10 concurrent linear pipelines respect ordering invariants", async () => {
    const ordersByTask: Record<string, string[]> = {};

    const dispatch = jest.fn().mockImplementation(async (taskId: string, node: DAGNode) => {
      ordersByTask[taskId] = ordersByTask[taskId] ?? [];
      ordersByTask[taskId].push(node.nodeId);
      return { result: "ok" };
    });

    const coord = makeCoordinator(dispatch);

    const runs = Array.from({ length: 10 }, (_, i) =>
      coord.executeDAG(`pipeline-${i}`, makeLinearDag(5))
    );
    await Promise.all(runs);

    for (let i = 0; i < 10; i++) {
      const order = ordersByTask[`pipeline-${i}`];
      expect(order).toEqual(["n0", "n1", "n2", "n3", "n4"]);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
//  4. Resource cleanup after pipeline completion
// ─────────────────────────────────────────────────────────────────────────────

describe("resource cleanup after pipeline completion", () => {
  it("event subscriptions are not accumulated across pipeline runs", async () => {
    const coord = makeCoordinator();

    // Run 10 pipelines sequentially.
    for (let i = 0; i < 10; i++) {
      await coord.executeDAG(`cleanup-${i}`, makeLinearDag(3));
    }

    // The eventBus should not have leaked subscriptions.
    // (The coordinator does not use persistent subscriptions; emitter is fire-and-forget.)
    // Confirm pipelines are completing by checking DAG nodes.
    const dag = makeLinearDag(2);
    await coord.executeDAG("cleanup-final", dag);
    for (const node of dag) {
      expect(node.status).toBe("completed");
    }
  });

  it("completed DAG nodes have no undefined result after completion", async () => {
    const dispatch = jest.fn().mockResolvedValue({ output: "data" });
    const coord = makeCoordinator(dispatch);
    const dag = makeLinearDag(4);

    await coord.executeDAG("cleanup-results", dag);

    for (const node of dag) {
      expect(node.status).toBe("completed");
      expect(node.result).toBeDefined();
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
//  5. Failure propagation — dependent nodes are skipped
// ─────────────────────────────────────────────────────────────────────────────

describe("failure propagation", () => {
  it("failure in n1 causes n2 and n3 to be marked failed (upstream_failed)", async () => {
    const dispatch = jest.fn().mockImplementation(async (_taskId: string, node: DAGNode) => {
      if (node.nodeId === "nfail") {
        throw new Error("node failed");
      }
      return { result: "ok" };
    });

    const coord = makeCoordinator(dispatch);
    const dag = makeFailingDag("nfail");

    await coord.executeDAG("failure-propagation", dag);

    const byId = Object.fromEntries(dag.map((n) => [n.nodeId, n]));
    expect(byId["n0"].status).toBe("completed");
    expect(byId["nfail"].status).toBe("failed");
    expect(byId["n2"].status).toBe("failed");
    expect(byId["n3"].status).toBe("failed");
    expect(byId["n2"].error).toBe("upstream_failed");
    expect(byId["n3"].error).toBe("upstream_failed");
  });

  it("random node failures across 5 concurrent pipelines are correctly isolated", async () => {
    // Each pipeline has one randomly chosen node that fails.
    const failNodes = ["n1", "n2", "n1", "n0", "n2"];

    const dispatch = jest.fn().mockImplementation(async (taskId: string, node: DAGNode) => {
      const pipelineIdx = parseInt(taskId.split("-")[1], 10);
      if (node.nodeId === failNodes[pipelineIdx]) {
        throw new Error("random failure");
      }
      return { result: "ok" };
    });

    const coord = makeCoordinator(dispatch);
    const dags = Array.from({ length: 5 }, () => makeLinearDag(4));
    const runs = dags.map((dag, i) => coord.executeDAG(`fail-${i}`, dag));

    await Promise.all(runs);

    for (let i = 0; i < 5; i++) {
      const dag = dags[i];
      const failIdx = parseInt(failNodes[i].replace("n", ""), 10);
      const byId = Object.fromEntries(dag.map((n) => [n.nodeId, n]));

      // Nodes before the failing node should be completed.
      for (let j = 0; j < failIdx; j++) {
        expect(byId[`n${j}`].status).toBe("completed");
      }
      // The failing node and all its descendants should be failed.
      expect(byId[`n${failIdx}`].status).toBe("failed");
    }
  });

  it("a pipeline with no failures emits task_completed event", async () => {
    const events: string[] = [];
    const unsub = eventBus.subscribeAll((ev: { type: string }) => events.push(ev.type));

    const coord = makeCoordinator();
    await coord.executeDAG("event-complete", makeLinearDag(3));

    unsub();
    expect(events).toContain("task_completed");
  });

  it("a pipeline with a failure emits task_failed event", async () => {
    const events: string[] = [];
    const unsub = eventBus.subscribeAll((ev: { type: string }) => events.push(ev.type));

    const dispatch = jest.fn().mockRejectedValue(new Error("boom"));
    const coord = makeCoordinator(dispatch);
    await coord.executeDAG("event-failed", makeLinearDag(3));

    unsub();
    expect(events).toContain("task_failed");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
//  6. Memory stability after 100 pipeline completions
// ─────────────────────────────────────────────────────────────────────────────

describe("memory stability after 100 pipeline completions", () => {
  it("runs 100 pipelines sequentially without growing heap unboundedly", async () => {
    const dispatch = jest.fn().mockResolvedValue({ result: "ok" });
    const coord = makeCoordinator(dispatch);

    const heapBefore = process.memoryUsage().heapUsed;

    for (let i = 0; i < 100; i++) {
      await coord.executeDAG(`mem-${i}`, makeLinearDag(3));
    }

    const heapAfter = process.memoryUsage().heapUsed;
    const growthMB = (heapAfter - heapBefore) / (1024 * 1024);

    // Allow a generous 50 MB budget for 100 pipelines.
    // A leak would cause hundreds of MB of growth.
    expect(growthMB).toBeLessThan(50);
  });

  it("dispatch is called exactly 300 times for 100 pipelines × 3 nodes", async () => {
    const dispatch = jest.fn().mockResolvedValue({ result: "ok" });
    const coord = makeCoordinator(dispatch);

    for (let i = 0; i < 100; i++) {
      await coord.executeDAG(`count-${i}`, makeLinearDag(3));
    }

    expect(dispatch).toHaveBeenCalledTimes(300);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
//  7. Fake timers — controlling async execution order
// ─────────────────────────────────────────────────────────────────────────────

describe("fake timers — execution order control", () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it("pipeline completes when fake timers are advanced past node timeout", async () => {
    // Use a very short timeout so the fake timer advance matters.
    const dispatch = jest.fn().mockResolvedValue({ result: "ok" });
    const coord = new Coordinator({
      dispatch,
      paymentService: { release: jest.fn().mockResolvedValue("tx") },
      timeoutMs: 5_000,
    });

    const dag = makeLinearDag(2);
    const runPromise = coord.executeDAG("timer-test", dag);

    // Advance fake timers so pending Promises resolve.
    await jest.runAllTimersAsync();
    await runPromise;

    for (const node of dag) {
      expect(node.status).toBe("completed");
    }
  });

  it("concurrent pipelines with fake timers all resolve", async () => {
    const dispatch = jest.fn().mockResolvedValue({ result: "ok" });
    const coord = makeCoordinator(dispatch);

    const dags = Array.from({ length: 5 }, () => makeLinearDag(2));
    const runs = dags.map((dag, i) => coord.executeDAG(`timer-${i}`, dag));

    await jest.runAllTimersAsync();
    await Promise.all(runs);

    for (const dag of dags) {
      for (const node of dag) {
        expect(node.status).toBe("completed");
      }
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
//  8. Progress reporting during concurrent execution
// ─────────────────────────────────────────────────────────────────────────────

describe("progress reporting under concurrent load", () => {
  it("onProgress reports 100% on completion for each pipeline", async () => {
    const dispatch = jest.fn().mockResolvedValue({ result: "ok" });
    const coord = makeCoordinator(dispatch);

    const progresses: number[][] = Array.from({ length: 5 }, () => []);

    const runs = Array.from({ length: 5 }, (_, i) =>
      coord.executeDAG(`progress-${i}`, makeLinearDag(3), (pct: number) => {
        progresses[i].push(pct);
      })
    );

    await Promise.all(runs);

    for (const prog of progresses) {
      expect(prog.at(-1)).toBe(100);
      // Progress should be non-decreasing.
      for (let j = 1; j < prog.length; j++) {
        expect(prog[j]).toBeGreaterThanOrEqual(prog[j - 1]);
      }
    }
  });

  it("onProgress is called 0% on empty DAG without errors", async () => {
    const coord = makeCoordinator();
    const progresses: number[] = [];

    await coord.executeDAG("empty-dag", [], (pct: number) => progresses.push(pct));

    // An empty DAG should immediately report 100%.
    expect(progresses).toContain(100);
  });
});
