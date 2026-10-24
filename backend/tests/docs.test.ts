import fs from "node:fs";
import path from "node:path";
import request from "supertest";
import YAML from "yaml";
import { createApp } from "../src/api/app";
import {
  openapiSpec,
  swaggerUiOptions,
  getOpenapiJson,
  getOpenapiYaml,
} from "../src/api/docs";

const ROUTE_MODULE_MOUNTS: Array<{ module: string; prefix: string }> = [
  { module: "admin.ts", prefix: "/api/admin" },
  { module: "admin.ts", prefix: "/api/admin/queue" },
  { module: "agents.ts", prefix: "/api/agents" },
  { module: "auth.ts", prefix: "/api/auth" },
  { module: "events.ts", prefix: "/api/events" },
  { module: "health.ts", prefix: "/health" },
  { module: "metrics.ts", prefix: "/metrics" },
  { module: "payments.ts", prefix: "/api/payments" },
  { module: "stats.ts", prefix: "/api/stats" },
  { module: "reconciliation.ts", prefix: "/api/reconciliation" },
  { module: "ratelimit.ts", prefix: "/api/ratelimit" },
  { module: "versions.ts", prefix: "/api/versions" },
  { module: "admin.ts", prefix: "/api/admin" },
  { module: "admin.ts", prefix: "/api/admin/queue" },
  { module: "versions.ts", prefix: "/api/versions" },
  { module: "v1/tasks.ts", prefix: "/api/tasks" },
  { module: "v2/tasks.ts", prefix: "/api/tasks" },
];

function collectImplementedOperations(): Set<string> {
  const operations = new Set<string>(["GET /tasks/{id}/stream"]);
  const routePattern = /\b(?:router|tasksRouter)\.(get|post|put|patch|delete)\s*\(\s*["']([^"']+)["']/g;

  for (const { module, prefix } of ROUTE_MODULE_MOUNTS) {
    const sourcePath = path.join(__dirname, "../src/api/routes", module);
    const source = fs.readFileSync(sourcePath, "utf8");
    for (const match of source.matchAll(routePattern)) {
      const routePath = match[2] === "/" ? "" : `/${match[2].replace(/^\//, "")}`;
      const fullPath = `${prefix}${routePath}`
        .replace(/\/{2,}/g, "/")
        .replace(/:([A-Za-z0-9_]+)/g, "{$1}");
      operations.add(`${match[1].toUpperCase()} ${fullPath}`);
    }
  }

  return operations;
}

const IMPLEMENTED_OPERATIONS = collectImplementedOperations();

describe("API Documentation & Swagger UI", () => {
  let app: ReturnType<typeof createApp>;

  beforeAll(() => {
    app = createApp({
      disableCompression: true,
      enableHeartbeatCleanup: false,
      enableQueueWorker: false,
    });
  });

  afterAll((done) => {
    app.close(done);
  });

  describe("OpenAPI Specification Structure", () => {
    it("should export a valid OpenAPI 3.1.0 document", () => {
      expect(openapiSpec).toBeDefined();
      expect(openapiSpec.openapi).toBe("3.1.0");
      expect(openapiSpec.info).toBeDefined();
      expect(openapiSpec.info.title).toBe("ai-net Backend API");
      expect(openapiSpec.info.version).toBe("0.1.0");
      expect(openapiSpec.info.description).toContain("Authentication");
      expect(openapiSpec.info.description).toContain("Rate Limiting");
      expect(openapiSpec.info.description).toContain("Live Task Stream (WebSocket)");
      expect(openapiSpec.info.description).toContain("Pagination & Filtering");
    });

    it("should define at least one described response for every documented endpoint", () => {
      for (const [routePath, pathItem] of Object.entries(openapiSpec.paths ?? {})) {
        for (const [method, operation] of Object.entries(pathItem as Record<string, any>)) {
          if (!["get", "post", "put", "patch", "delete"].includes(method)) continue;
          expect(Object.keys(operation.responses ?? {}).length).toBeGreaterThan(0);
          for (const [status, response] of Object.entries(operation.responses ?? {})) {
            expect(status).toMatch(/^(default|[1-5][0-9X]{2})$/);
            expect((response as { description?: string }).description).toEqual(expect.any(String));
          }
        }
      }
    });

    it("should map every documented method and path to an Express route", () => {
      const missing: string[] = [];
      for (const [routePath, pathItem] of Object.entries(openapiSpec.paths ?? {})) {
        for (const method of ["get", "post", "put", "patch", "delete"]) {
          if ((pathItem as Record<string, unknown>)[method] && !IMPLEMENTED_OPERATIONS.has(`${method.toUpperCase()} ${routePath}`)) {
            missing.push(`${method.toUpperCase()} ${routePath}`);
          }
        }
      }
      expect(missing).toEqual([]);
    });

    it("should declare WalletAuth, AgentSignatureAuth, and AgentChallengeAuth security schemes", () => {
      const securitySchemes = openapiSpec.components?.securitySchemes;
      expect(securitySchemes).toBeDefined();
      expect(securitySchemes?.WalletAuth).toBeDefined();
      expect(securitySchemes?.WalletAuth.name).toBe("walletpublickey");
      expect(securitySchemes?.AgentSignatureAuth).toBeDefined();
      expect(securitySchemes?.AgentSignatureAuth.name).toBe("x-signature");
      expect(securitySchemes?.AgentChallengeAuth).toBeDefined();
      expect(securitySchemes?.AgentChallengeAuth.name).toBe("x-challenge");
    });

    it("should define reusable rate limit and tracing headers", () => {
      const headers = openapiSpec.components?.headers;
      expect(headers).toBeDefined();
      expect(headers?.["X-RateLimit-Limit"]).toBeDefined();
      expect(headers?.["X-RateLimit-Remaining"]).toBeDefined();
      expect(headers?.["X-RateLimit-Reset"]).toBeDefined();
      expect(headers?.["X-Request-Id"]).toBeDefined();
      expect(headers?.["X-API-Version"]).toBeDefined();
    });

    it("should declare core schemas with examples", () => {
      const schemas = openapiSpec.components?.schemas;
      expect(schemas).toBeDefined();

      // Tasks
      expect(schemas?.Task).toBeDefined();
      expect(schemas?.CreateTaskRequest).toBeDefined();
      expect(schemas?.CreateTaskResponse).toBeDefined();
      expect(schemas?.TaskListItem).toBeDefined();
      expect(schemas?.TaskListResponse).toBeDefined();
      expect(schemas?.DAGNode).toBeDefined();
      expect(schemas?.TaskStatus).toBeDefined();

      // Agents
      expect(schemas?.Agent).toBeDefined();
      expect(schemas?.RegisterAgentRequest).toBeDefined();
      expect(schemas?.AgentHeartbeatResponse).toBeDefined();

      // Health & Stats
      expect(schemas?.HealthStatus).toBeDefined();
      expect(schemas?.DeepHealthStatus).toBeDefined();
      expect(schemas?.ReadinessStatus).toBeDefined();
      expect(schemas?.StatsResponse).toBeDefined();

      // Background Jobs & Admin
      expect(schemas?.QueueJob).toBeDefined();
      expect(schemas?.QueueStats).toBeDefined();
      expect(schemas?.QueueStatusResponse).toBeDefined();

      // WebSocket & Errors
      expect(schemas?.WebSocketStreamEvent).toBeDefined();
      expect(schemas?.ErrorResponse).toBeDefined();
      expect(schemas?.ValidationError).toBeDefined();
      expect(schemas?.NotFoundError).toBeDefined();
      expect(schemas?.RateLimitError).toBeDefined();
      expect(schemas?.InternalServerError).toBeDefined();
    });

    it("should include all primary REST and WebSocket endpoints in paths", () => {
      const paths = openapiSpec.paths;
      expect(paths).toBeDefined();

      // Tasks
      expect(paths?.["/api/tasks"]).toBeDefined();
      expect(paths?.["/api/tasks"]?.post).toBeDefined();
      expect(paths?.["/api/tasks"]?.get).toBeDefined();
      expect(paths?.["/api/tasks/{id}"]).toBeDefined();
      expect(paths?.["/api/tasks/{id}"]?.get).toBeDefined();
      expect(paths?.["/api/tasks/{id}"]?.delete).toBeDefined();

      // Agents
      expect(paths?.["/api/agents"]).toBeDefined();
      expect(paths?.["/api/agents"]?.get).toBeDefined();
      expect(paths?.["/api/agents/{id}"]).toBeDefined();
      expect(paths?.["/api/agents/{id}"]?.get).toBeDefined();
      expect(paths?.["/api/agents/{id}"]?.delete).toBeDefined();
      expect(paths?.["/api/agents/register"]).toBeDefined();
      expect(paths?.["/api/agents/register"]?.post).toBeDefined();
      expect(paths?.["/api/agents/{id}/heartbeat"]).toBeDefined();
      expect(paths?.["/api/agents/{id}/heartbeat"]?.post).toBeDefined();

      // Health
      expect(paths?.["/health"]).toBeDefined();
      expect(paths?.["/health"]?.get).toBeDefined();
      expect(paths?.["/health/deep"]).toBeDefined();
      expect(paths?.["/health/deep"]?.get).toBeDefined();
      expect(paths?.["/health/ready"]).toBeDefined();
      expect(paths?.["/health/ready"]?.get).toBeDefined();

      // Stats
      expect(paths?.["/api/stats"]).toBeDefined();
      expect(paths?.["/api/stats"]?.get).toBeDefined();

      // WebSocket
      expect(paths?.["/tasks/{id}/stream"]).toBeDefined();

      // Admin Queue
      expect(paths?.["/api/admin/queue/status"]).toBeDefined();
      expect(paths?.["/api/admin/queue/jobs"]).toBeDefined();
    });
  });

  describe("Interactive Swagger UI Options", () => {
    it("should configure tryItOutEnabled and displayRequestDuration", () => {
      expect(swaggerUiOptions.swaggerOptions.tryItOutEnabled).toBe(true);
      expect(swaggerUiOptions.swaggerOptions.displayRequestDuration).toBe(true);
      expect(swaggerUiOptions.swaggerOptions.persistAuthorization).toBe(true);
      expect(swaggerUiOptions.customSiteTitle).toBe("ai-net Backend API Documentation");
    });
  });

  describe("Spec Serialization Helpers", () => {
    it("getOpenapiJson() returns JSON-serializable spec", () => {
      const json = getOpenapiJson();
      expect(json).toBe(openapiSpec);
      expect(JSON.stringify(json)).toContain("ai-net Backend API");
    });

    it("getOpenapiYaml() returns valid YAML string parseable back to object", () => {
      const yamlStr = getOpenapiYaml();
      expect(typeof yamlStr).toBe("string");
      expect(yamlStr).toContain("openapi: 3.1.0");
      const parsed = YAML.parse(yamlStr);
      expect(parsed.info.title).toBe("ai-net Backend API");
    });
  });

  describe("HTTP Documentation Endpoints", () => {
    it("GET /docs/ returns Swagger UI HTML with 200", async () => {
      const res = await request(app.httpServer).get("/docs/");
      expect(res.status).toBe(200);
      expect(res.type).toContain("html");
      expect(res.text).toContain("swagger-ui");
      expect(res.text).toContain("ai-net Backend API Documentation");
    });

    it("GET /openapi.json returns valid JSON OpenAPI specification", async () => {
      const res = await request(app.httpServer).get("/openapi.json");
      expect(res.status).toBe(200);
      expect(res.type).toContain("json");
      expect(res.body.openapi).toBe("3.1.0");
      expect(res.body.info.title).toBe("ai-net Backend API");
      expect(res.body.paths["/api/tasks"]).toBeDefined();
    });

    it("GET /openapi.yaml returns YAML formatted specification", async () => {
      const res = await request(app.httpServer).get("/openapi.yaml");
      expect(res.status).toBe(200);
      expect(res.type).toMatch(/yaml/);
      expect(res.text).toContain("openapi: 3.1.0");
      const parsed = YAML.parse(res.text);
      expect(parsed.info.title).toBe("ai-net Backend API");
    });

    it("GET /docs/swagger.json returns JSON specification", async () => {
      const res = await request(app.httpServer).get("/docs/swagger.json");
      expect(res.status).toBe(200);
      expect(res.type).toContain("json");
      expect(res.body.info.title).toBe("ai-net Backend API");
    });

    it("GET /docs/swagger.yaml returns YAML specification", async () => {
      const res = await request(app.httpServer).get("/docs/swagger.yaml");
      expect(res.status).toBe(200);
      expect(res.type).toMatch(/yaml/);
      expect(res.text).toContain("openapi: 3.1.0");
      const parsed = YAML.parse(res.text);
      expect(parsed.info.title).toBe("ai-net Backend API");
    });
  });
});
