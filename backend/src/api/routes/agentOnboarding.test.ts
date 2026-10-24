import Database from "better-sqlite3";
import express from "express";
import request from "supertest";
import {
  createAgentDb,
  createAgentRegistrationDraftStore,
} from "../../db/agents";
import { createAgentOnboardingRouter } from "./agentOnboarding";

describe("agent onboarding flow", () => {
  it("persists each validated step and registers on final submit", async () => {
    const database = new Database(":memory:");
    const agentDb = createAgentDb(database);
    const draftStore = createAgentRegistrationDraftStore(database);
    const registerOnChain = jest.fn(async () => "stellar-tx-hash");
    const app = express();
    app.use(express.json());
    app.use("/api/agents/onboarding", createAgentOnboardingRouter({
      agentDb,
      draftStore,
      checkEndpoint: async () => true,
      registerOnChain,
    }));

    try {
      const started = await request(app)
        .post("/api/agents/onboarding/start")
        .send({ agentId: "agent-1", stellarPublicKey: `G${"A".repeat(55)}` })
        .expect(201);
      const draftId = started.body.draft_id;

      await request(app)
        .put(`/api/agents/onboarding/${draftId}/capabilities`)
        .send({ capabilities: ["research", "analysis"] })
        .expect(200);
      await request(app)
        .put(`/api/agents/onboarding/${draftId}/pricing`)
        .send({ pricingXLM: 2.5 })
        .expect(200);
      await request(app)
        .put(`/api/agents/onboarding/${draftId}/endpoint`)
        .send({ endpoint: "https://agent.example/api" })
        .expect(200);
      const preview = await request(app)
        .get(`/api/agents/onboarding/${draftId}`)
        .expect(200);
      expect(preview.body.preview).toMatchObject({
        id: "agent-1",
        capabilities: ["research", "analysis"],
        pricingXLM: 2.5,
        endpoint: "https://agent.example/api",
      });

      const submitted = await request(app)
        .post(`/api/agents/onboarding/${draftId}/submit`)
        .expect(201);
      expect(submitted.body.transactionHash).toBe("stellar-tx-hash");
      expect(agentDb.findById("agent-1")?.capabilities).toEqual(["research", "analysis"]);
      expect(draftStore.find(draftId)).toBeUndefined();
      expect(registerOnChain).toHaveBeenCalledTimes(1);
    } finally {
      database.close();
    }
  });

  it("removes drafts after their 24-hour expiry", () => {
    const database = new Database(":memory:");
    const draftStore = createAgentRegistrationDraftStore(database);
    const draft = {
      draftId: "draft-1",
      agentId: "agent-1",
      stellarPublicKey: `G${"A".repeat(55)}`,
      createdAt: "2026-01-01T00:00:00.000Z",
      lastActivityAt: "2026-01-01T00:00:00.000Z",
      expiresAt: "2026-01-02T00:00:00.000Z",
    };
    draftStore.create(draft);

    expect(draftStore.find(draft.draftId, "2026-01-02T00:00:00.000Z")).toBeUndefined();
    database.close();
  });
});