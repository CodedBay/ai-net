/**
 * Unit tests for PipelineOrchestrator.
 *
 * Scenarios covered:
 *  - Empty DAG
 *  - Single node execution
 *  - Independent nodes execute in parallel
 *  - Dependent nodes wait for predecessors
 *  - Failed node marks dependents as skipped
 *  - Nested failure propagation
 *  - Cycle detection
 *  - Unknown dependency reference
 *  - Node timeout
 *  - Input reference resolution
 *  - Progress events emitted at each state change
 *  - Concurrency limit respected
 */
import {
  PipelineOrchestrator,
  PipelineNode,
  PipelineEvent,
  PipelineResult,
  NodeExecutorFn,
  detectCycles,
} from "./pipelineOrchestrator";

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeNode(
  id: string,
  dependsOn: string[] = [],
  agentType = "research",
  inputs: Record<string, string> = {},
): PipelineNode {
  return { id, agentType, inputs, dependsOn };
}

function noopExecutor(): NodeExecutorFn {
  return async () => ({ done: true });
}

function capturingExecutor(
  results: Record<string, unknown> = {},
): NodeExecutorFn {
  return async (node) => {
    return results[node.id] ?? { nodeId: node.id };
  };
}

function failingExecutor(failIds: Set<string>): NodeExecutorFn {
  return async (node) => {
    if (failIds.has(node.id)) {
      throw new Error(`Node ${node.id} intentionally failed`);
    }
    return { nodeId: node.id };
  };
}

function collectEvents(orchestrator: PipelineOrchestrator): PipelineEvent[] {
  const events: PipelineEvent[] = [];
  orchestrator.on("event", (e) => events.push(e));
  return events;
}

// ─── detectCycles ─────────────────────────────────────────────────────────────

describe("detectCycles", () => {
  it("does not throw for a valid linear DAG", () => {
    expect(() =>
      detectCycles([
        makeNode("a"),
        makeNode("b", ["a"]),
        makeNode("c", ["b"]),
      ]),
    ).not.toThrow();
  });

  it("does not throw for a diamond DAG", () => {
    expect(() =>
      detectCycles([
        makeNode("a"),
        makeNode("b", ["a"]),
        makeNode("c", ["a"]),
        makeNode("d", ["b", "c"]),
      ]),
    ).not.toThrow();
  });

  it("throws for a direct self-loop", () => {
    expect(() => detectCycles([makeNode("a", ["a"])])).toThrow(/cycle/i);
  });

  it("throws for a two-node cycle", () => {
    expect(() =>
      detectCycles([makeNode("a", ["b"]), makeNode("b", ["a"])]),
    ).toThrow(/cycle/i);
  });

  it("throws for a three-node cycle", () => {
    expect(() =>
      detectCycles([
        makeNode("a", ["c"]),
        makeNode("b", ["a"]),
        makeNode("c", ["b"]),
      ]),
    ).toThrow(/cycle/i);
  });

  it("handles empty DAG without throwing", () => {
    expect(() => detectCycles([])).not.toThrow();
  });
});

// ─── PipelineOrchestrator ─────────────────────────────────────────────────────

describe("PipelineOrchestrator", () => {
  describe("empty DAG", () => {
    it("returns completed result with zero nodes", async () => {
      const orch = new PipelineOrchestrator(noopExecutor());
      const result = await orch.run("pipe-0", []);
      expect(result.status).toBe("completed");
      expect(result.nodes).toHaveLength(0);
    });

    it("emits pipeline_started and pipeline_completed events", async () => {
      const orch = new PipelineOrchestrator(noopExecutor());
      const events = collectEvents(orch);
      await orch.run("pipe-empty", []);
      expect(events.map((e) => e.type)).toContain("pipeline_started");
      expect(events.map((e) => e.type)).toContain("pipeline_completed");
    });
  });

  describe("single node", () => {
    it("runs the node and returns completed status", async () => {
      const orch = new PipelineOrchestrator(noopExecutor());
      const result = await orch.run("pipe-1", [makeNode("a")]);
      expect(result.status).toBe("completed");
      expect(result.nodes[0].status).toBe("completed");
    });

    it("emits node_started and node_completed events", async () => {
      const orch = new PipelineOrchestrator(noopExecutor());
      const events = collectEvents(orch);
      await orch.run("pipe-single", [makeNode("a")]);
      const types = events.map((e) => e.type);
      expect(types).toContain("node_started");
      expect(types).toContain("node_completed");
    });

    it("records durationMs on node result", async () => {
      const orch = new PipelineOrchestrator(noopExecutor());
      const result = await orch.run("pipe-dur", [makeNode("a")]);
      expect(typeof result.nodes[0].durationMs).toBe("number");
      expect(result.nodes[0].durationMs).toBeGreaterThanOrEqual(0);
    });
  });

  describe("parallel execution", () => {
    it("runs independent nodes without waiting for each other", async () => {
      const order: string[] = [];
      const executor: NodeExecutorFn = async (node) => {
        order.push(`start:${node.id}`);
        await new Promise((r) => setTimeout(r, 10));
        order.push(`end:${node.id}`);
        return {};
      };

      const orch = new PipelineOrchestrator(executor);
      await orch.run("pipe-par", [makeNode("a"), makeNode("b"), makeNode("c")]);

      // All three should start before any ends (overlapping execution)
      const startA = order.indexOf("start:a");
      const startB = order.indexOf("start:b");
      const startC = order.indexOf("start:c");
      const endA = order.indexOf("end:a");
      // All starts should precede the first end
      const firstEnd = Math.min(endA, order.indexOf("end:b"), order.indexOf("end:c"));
      expect(startA).toBeLessThan(firstEnd);
      expect(startB).toBeLessThan(firstEnd);
      expect(startC).toBeLessThan(firstEnd);
    });

    it("all nodes complete successfully", async () => {
      const orch = new PipelineOrchestrator(noopExecutor());
      const result = await orch.run("pipe-par-ok", [
        makeNode("a"),
        makeNode("b"),
        makeNode("c"),
      ]);
      expect(result.status).toBe("completed");
      expect(result.nodes.every((n) => n.status === "completed")).toBe(true);
    });
  });

  describe("dependent node execution order", () => {
    it("runs dependent node only after predecessor completes", async () => {
      const order: string[] = [];
      const executor: NodeExecutorFn = async (node) => {
        order.push(node.id);
        return {};
      };

      const orch = new PipelineOrchestrator(executor);
      await orch.run("pipe-dep", [
        makeNode("a"),
        makeNode("b", ["a"]),
        makeNode("c", ["b"]),
      ]);

      expect(order.indexOf("a")).toBeLessThan(order.indexOf("b"));
      expect(order.indexOf("b")).toBeLessThan(order.indexOf("c"));
    });

    it("runs diamond DAG correctly", async () => {
      const order: string[] = [];
      const executor: NodeExecutorFn = async (node) => {
        order.push(node.id);
        return {};
      };

      const orch = new PipelineOrchestrator(executor);
      await orch.run("pipe-diamond", [
        makeNode("root"),
        makeNode("left", ["root"]),
        makeNode("right", ["root"]),
        makeNode("merge", ["left", "right"]),
      ]);

      expect(order.indexOf("root")).toBeLessThan(order.indexOf("left"));
      expect(order.indexOf("root")).toBeLessThan(order.indexOf("right"));
      expect(order.indexOf("left")).toBeLessThan(order.indexOf("merge"));
      expect(order.indexOf("right")).toBeLessThan(order.indexOf("merge"));
    });
  });

  describe("failure propagation", () => {
    it("marks direct dependents as skipped when a node fails", async () => {
      const orch = new PipelineOrchestrator(failingExecutor(new Set(["a"])));
      const result = await orch.run("pipe-fail", [
        makeNode("a"),
        makeNode("b", ["a"]),
      ]);
      expect(result.status).toBe("failed");
      const nodeA = result.nodes.find((n) => n.nodeId === "a")!;
      const nodeB = result.nodes.find((n) => n.nodeId === "b")!;
      expect(nodeA.status).toBe("failed");
      expect(nodeB.status).toBe("skipped");
    });

    it("propagates skipped status transitively", async () => {
      const orch = new PipelineOrchestrator(failingExecutor(new Set(["a"])));
      const result = await orch.run("pipe-transitive", [
        makeNode("a"),
        makeNode("b", ["a"]),
        makeNode("c", ["b"]),
        makeNode("d", ["c"]),
      ]);
      expect(result.status).toBe("failed");
      expect(result.nodes.find((n) => n.nodeId === "a")!.status).toBe("failed");
      expect(result.nodes.find((n) => n.nodeId === "b")!.status).toBe("skipped");
      expect(result.nodes.find((n) => n.nodeId === "c")!.status).toBe("skipped");
      expect(result.nodes.find((n) => n.nodeId === "d")!.status).toBe("skipped");
    });

    it("does not skip nodes that depend on unaffected paths", async () => {
      const orch = new PipelineOrchestrator(failingExecutor(new Set(["fail"])));
      const result = await orch.run("pipe-partial-fail", [
        makeNode("fail"),
        makeNode("ok"),
        makeNode("after-ok", ["ok"]),
      ]);
      expect(result.nodes.find((n) => n.nodeId === "ok")!.status).toBe("completed");
      expect(result.nodes.find((n) => n.nodeId === "after-ok")!.status).toBe("completed");
      expect(result.nodes.find((n) => n.nodeId === "fail")!.status).toBe("failed");
    });

    it("emits node_failed and node_skipped events", async () => {
      const orch = new PipelineOrchestrator(failingExecutor(new Set(["a"])));
      const events = collectEvents(orch);
      await orch.run("pipe-events-fail", [makeNode("a"), makeNode("b", ["a"])]);
      const types = events.map((e) => e.type);
      expect(types).toContain("node_failed");
      expect(types).toContain("node_skipped");
    });

    it("records error message on failed node", async () => {
      const orch = new PipelineOrchestrator(failingExecutor(new Set(["a"])));
      const result = await orch.run("pipe-err-msg", [makeNode("a")]);
      const nodeA = result.nodes.find((n) => n.nodeId === "a")!;
      expect(nodeA.error).toMatch(/intentionally failed/i);
    });
  });

  describe("cycle detection", () => {
    it("throws before starting execution if DAG has a cycle", async () => {
      const orch = new PipelineOrchestrator(noopExecutor());
      await expect(
        orch.run("pipe-cycle", [makeNode("a", ["b"]), makeNode("b", ["a"])]),
      ).rejects.toThrow(/cycle/i);
    });

    it("throws for self-loop", async () => {
      const orch = new PipelineOrchestrator(noopExecutor());
      await expect(
        orch.run("pipe-self", [makeNode("a", ["a"])]),
      ).rejects.toThrow(/cycle/i);
    });
  });

  describe("unknown dependency", () => {
    it("throws if a node references an unknown dependency", async () => {
      const orch = new PipelineOrchestrator(noopExecutor());
      await expect(
        orch.run("pipe-unknown", [makeNode("a", ["nonexistent"])]),
      ).rejects.toThrow(/unknown node/i);
    });
  });

  describe("node timeout", () => {
    it("marks a node as failed when it exceeds the timeout", async () => {
      const slowExecutor: NodeExecutorFn = async () => {
        await new Promise((r) => setTimeout(r, 10_000));
        return {};
      };
      const orch = new PipelineOrchestrator(slowExecutor, { nodeTimeoutMs: 50 });
      const result = await orch.run("pipe-timeout", [makeNode("a")]);
      expect(result.nodes[0].status).toBe("failed");
      expect(result.nodes[0].error).toMatch(/timed out/i);
    });
  });

  describe("input reference resolution", () => {
    it("passes resolved inputs to executor", async () => {
      const receivedInputs: Record<string, Record<string, string>> = {};
      const executor: NodeExecutorFn = async (node, resolvedInputs) => {
        receivedInputs[node.id] = resolvedInputs;
        return { value: "hello" };
      };

      const orch = new PipelineOrchestrator(executor);
      await orch.run("pipe-ref", [
        makeNode("producer", [], "research", {}),
        makeNode("consumer", ["producer"], "report", {
          context: "$producer.value",
        }),
      ]);

      expect(receivedInputs["consumer"].context).toBe("hello");
    });

    it("passes literal inputs unchanged when no reference", async () => {
      const receivedInputs: Record<string, Record<string, string>> = {};
      const executor: NodeExecutorFn = async (node, resolvedInputs) => {
        receivedInputs[node.id] = resolvedInputs;
        return {};
      };

      const orch = new PipelineOrchestrator(executor);
      await orch.run("pipe-literal", [
        makeNode("a", [], "research", { prompt: "analyze solar energy" }),
      ]);

      expect(receivedInputs["a"].prompt).toBe("analyze solar energy");
    });
  });

  describe("concurrency limit", () => {
    it("never exceeds the configured concurrency", async () => {
      let running = 0;
      let maxConcurrent = 0;

      const executor: NodeExecutorFn = async () => {
        running += 1;
        maxConcurrent = Math.max(maxConcurrent, running);
        await new Promise((r) => setTimeout(r, 20));
        running -= 1;
        return {};
      };

      const orch = new PipelineOrchestrator(executor, { concurrency: 2 });
      const nodes = Array.from({ length: 6 }, (_, i) => makeNode(`n${i}`));
      await orch.run("pipe-concurrency", nodes);

      expect(maxConcurrent).toBeLessThanOrEqual(2);
    });
  });

  describe("event completeness", () => {
    it("emits start and end events for every node in a multi-node DAG", async () => {
      const orch = new PipelineOrchestrator(noopExecutor());
      const events = collectEvents(orch);
      const nodes = [
        makeNode("a"),
        makeNode("b", ["a"]),
        makeNode("c", ["a"]),
        makeNode("d", ["b", "c"]),
      ];
      await orch.run("pipe-all-events", nodes);

      const nodeIds = nodes.map((n) => n.id);
      for (const id of nodeIds) {
        expect(events.some((e) => e.type === "node_started" && e.nodeId === id)).toBe(true);
        expect(events.some((e) => e.type === "node_completed" && e.nodeId === id)).toBe(true);
      }
    });

    it("includes pipelineId in every event", async () => {
      const orch = new PipelineOrchestrator(noopExecutor());
      const events = collectEvents(orch);
      await orch.run("my-pipeline", [makeNode("a"), makeNode("b")]);
      for (const e of events) {
        expect(e.pipelineId).toBe("my-pipeline");
      }
    });

    it("includes timestamps in every event", async () => {
      const orch = new PipelineOrchestrator(noopExecutor());
      const events = collectEvents(orch);
      await orch.run("pipe-ts", [makeNode("a")]);
      for (const e of events) {
        expect(typeof e.timestamp).toBe("string");
        expect(e.timestamp.length).toBeGreaterThan(0);
      }
    });
  });

  describe("pipeline result", () => {
    it("includes pipelineId, startedAt, completedAt, durationMs", async () => {
      const orch = new PipelineOrchestrator(noopExecutor());
      const result = await orch.run("pipe-meta", [makeNode("a")]);
      expect(result.pipelineId).toBe("pipe-meta");
      expect(typeof result.startedAt).toBe("string");
      expect(typeof result.completedAt).toBe("string");
      expect(typeof result.durationMs).toBe("number");
    });

    it("has status failed when any node fails", async () => {
      const orch = new PipelineOrchestrator(failingExecutor(new Set(["a"])));
      const result = await orch.run("pipe-status-fail", [makeNode("a")]);
      expect(result.status).toBe("failed");
    });

    it("has status completed when all nodes succeed", async () => {
      const orch = new PipelineOrchestrator(noopExecutor());
      const result = await orch.run("pipe-status-ok", [makeNode("a"), makeNode("b")]);
      expect(result.status).toBe("completed");
    });
  });
});
