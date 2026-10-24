import {
  agentFactory,
  createOracleManagerSetEvent,
  createPipeline,
  createTaskCreatedEvent,
  createTaskFinalizedEvent,
  createTaskStoreUpgradedEvent,
  createTaskUpdatedEvent,
  eventRecordFactory,
  featureFlagFactory,
  paymentFactory,
  qualityScoreFactory,
  subTaskFactory,
  taskFactory,
  webhookDeliveryFactory,
} from "./index";

describe("test data factories", () => {
  it("creates defaults and merges overrides", () => {
    expect(agentFactory.create({ id: "agent_override" })).toMatchObject({
      id: "agent_override",
      capabilities: ["research"],
    });
    expect(taskFactory.create({ status: "running" }).status).toBe("running");
    expect(subTaskFactory.create().taskId).toBe("task_test_1");
    expect(paymentFactory.create().amountStroops).toBe(2_500_000n);
    expect(webhookDeliveryFactory.create().status).toBe("pending");
    expect(qualityScoreFactory.create().score).toBe(85);
    expect(featureFlagFactory.create({ enabled: true }).enabled).toBe(true);
    expect(eventRecordFactory.create().taskId).toBe("task_test_1");
  });

  it("builds a coordinator pipeline with five agents and assigned tasks by default", () => {
    const pipeline = createPipeline();

    expect(pipeline.coordinator.id).toBe("coordinator_test_1");
    expect(pipeline.agents).toHaveLength(5);
    expect(pipeline.tasks).toHaveLength(5);
    pipeline.tasks.forEach((task, index) => {
      expect(task.dag[0]?.type).toBe(pipeline.agents[index].capabilities[0]);
    });
  });

  it("creates fixtures for every task_store event topic", () => {
    expect(createTaskCreatedEvent().topics).toEqual(["task_meta", "created"]);
    expect(createTaskUpdatedEvent().topics).toEqual(["task_meta", "updated"]);
    expect(createTaskFinalizedEvent().topics).toEqual(["task_meta", "finalized"]);
    expect(createOracleManagerSetEvent().topics).toEqual(["task_str", "ora_set"]);
    expect(createTaskStoreUpgradedEvent().topics).toEqual(["task_str", "upgraded"]);
  });
});
