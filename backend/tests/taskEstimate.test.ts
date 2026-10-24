import express from "express";
import request from "supertest";
import { createV1TasksRouter } from "../src/api/routes/v1/tasks";
import { createV2TasksRouter } from "../src/api/routes/v2/tasks";
import { errorHandler } from "../src/api/middleware/errorHandler";
import {
  AGENT_BASE_COSTS_XLM,
  PLATFORM_FEE_RATE,
  computeTaskEstimate,
  parseEstimateAgentsQuery,
} from "../src/services/taskEstimate";
import type { DispatchFn, PaymentReleaseFn } from "../src/coordinator/coordinator";

const noopDispatch = jest.fn() as unknown as DispatchFn;
const noopRelease = jest.fn() as unknown as PaymentReleaseFn;

function buildApp(router: express.Router) {
  const app = express();
  app.use(express.json());
  app.use("/api/tasks", router);
  app.use(errorHandler);
  return app;
}

const v1App = buildApp(createV1TasksRouter(noopDispatch, noopRelease));
const v2App = buildApp(createV2TasksRouter(noopDispatch, noopRelease));

describe("task estimate service", () => {
  it("sums base costs and applies the 5% platform fee", () => {
    const estimate = computeTaskEstimate(["research", "coding"]);

    expect(estimate).toEqual({
      currency: "XLM",
      breakdown: [
        { agent: "research", costXLM: AGENT_BASE_COSTS_XLM.research },
        { agent: "coding", costXLM: AGENT_BASE_COSTS_XLM.coding },
      ],
      subtotalXLM: 1.3,
      platformFeeXLM: 0.065,
      platformFeeRate: PLATFORM_FEE_RATE,
      estimatedCostXLM: 1.365,
    });
  });

  it("deduplicates repeated agents", () => {
    const estimate = computeTaskEstimate(["report", "report"]);
    expect(estimate.breakdown).toHaveLength(1);
    expect(estimate.estimatedCostXLM).toBe(0.315);
  });

  it("parses comma-separated and repeated query values", () => {
    const parsed = parseEstimateAgentsQuery({
      agents: "research,coding",
      agentHints: ["design", "report"],
    });

    expect(parsed).toEqual({
      ok: true,
      agents: ["research", "coding", "design", "report"],
    });
  });
});

describe("GET /api/tasks/estimate (v1)", () => {
  it("returns the breakdown for comma-separated agents", async () => {
    const res = await request(v1App).get("/api/tasks/estimate?agents=research,coding");

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      currency: "XLM",
      subtotalXLM: 1.3,
      platformFeeXLM: 0.065,
      platformFeeRate: 0.05,
      estimatedCostXLM: 1.365,
    });
    expect(res.body.breakdown).toEqual([
      { agent: "research", costXLM: 0.5 },
      { agent: "coding", costXLM: 0.8 },
    ]);
  });

  it("accepts repeated agentHints query values", async () => {
    const res = await request(v1App).get(
      "/api/tasks/estimate?agentHints=research&agentHints=report",
    );

    expect(res.status).toBe(200);
    expect(res.body.breakdown.map((item: { agent: string }) => item.agent)).toEqual([
      "research",
      "report",
    ]);
    expect(res.body.estimatedCostXLM).toBe(0.84);
  });

  it("returns 400 for an unknown agent", async () => {
    const res = await request(v1App).get("/api/tasks/estimate?agents=research,wizard");

    expect(res.status).toBe(400);
    expect(res.body.error).toMatchObject({ code: "INVALID_AGENTS" });
    expect(res.body.error.message).toContain("wizard");
  });

  it("returns 400 when no agents are supplied", async () => {
    const res = await request(v1App).get("/api/tasks/estimate");

    expect(res.status).toBe(400);
    expect(res.body.error).toMatchObject({ code: "INVALID_AGENTS" });
  });
});

describe("GET /api/tasks/estimate (v2)", () => {
  it("wraps the estimate in the v2 data envelope", async () => {
    const res = await request(v2App).get("/api/tasks/estimate?agents=design");

    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
      currency: "XLM",
      estimatedCostXLM: 0.63,
    });
    expect(res.body._meta).toMatchObject({ version: "2.0" });
  });

  it("includes _meta on validation errors", async () => {
    const res = await request(v2App).get("/api/tasks/estimate?agents=");

    expect(res.status).toBe(400);
    expect(res.body.error).toMatchObject({ code: "INVALID_AGENTS" });
    expect(res.body._meta).toMatchObject({ version: "2.0" });
  });
});
