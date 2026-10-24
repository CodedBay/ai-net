import { Writable } from "stream";
import { createLogger } from "../src/utils/logger";
import { loadConfig, resetConfigForTests } from "../src/config";

function collectStream(): { stream: Writable; lines: Buffer[] } {
  const lines: Buffer[] = [];
  const stream = new Writable({
    write(chunk: Buffer, _enc, callback) {
      lines.push(chunk);
      callback();
    },
  });
  return { stream, lines };
}

describe("structured log redaction", () => {
  beforeEach(() => {
    resetConfigForTests();
    loadConfig({
      ...process.env,
      NODE_ENV: "test",
      LOG_LEVEL: "info",
      VENICE_API_KEY: "venice-live-secret",
      DATABASE_URL: ":memory:",
    });
  });

  afterEach(() => {
    resetConfigForTests();
  });

  it("emits request and trace fields without leaking secrets or addresses", () => {
    const { stream, lines } = collectStream();
    const walletAddress = `G${"A".repeat(55)}`;
    const stellarSecret = `S${"B".repeat(55)}`;

    const logger = createLogger(
      {
        requestId: "req-test-1",
        traceId: "trace-test-1",
        userId: "usr_test",
        taskId: "task_abc123",
        route: "/api/tasks",
      },
      { destination: stream },
    );

    logger.info(
      {
        payload: {
          veniceApiKey: "venice-live-secret",
          walletPublicKey: walletAddress,
          nested: {
            authorization: `Bearer ${stellarSecret}`,
          },
        },
      },
      `creating task for ${walletAddress} token=${stellarSecret}`,
    );

    expect(lines.length).toBeGreaterThanOrEqual(1);

    const raw = lines.map((line) => line.toString()).join("");
    const entry = JSON.parse(lines[0]!.toString()) as Record<string, unknown>;

    expect(entry.requestId).toBe("req-test-1");
    expect(entry.traceId).toBe("trace-test-1");
    expect(entry.userId).toBe("usr_test");
    expect(entry.taskId).toBe("task_abc123");
    expect(entry.route).toBe("/api/tasks");
    expect(raw).not.toContain("venice-live-secret");
    expect(raw).not.toContain(walletAddress);
    expect(raw).not.toContain(stellarSecret);
    expect(raw).toContain("[REDACTED]");
  });

  it("writes the standard NDJSON fields and applies configured redaction paths", () => {
    const { stream, lines } = collectStream();
    const logger = createLogger(
      { traceId: "trace-structured", spanId: "span-structured" },
      { destination: stream, redactPaths: ["payload.privateNote"] },
    );

    logger.info({ payload: { privateNote: "internal detail", status: "queued" } }, "task accepted");

    const entry = JSON.parse(lines[0]!.toString()) as Record<string, unknown>;
    const context = entry.context as Record<string, unknown>;
    const payload = context.payload as Record<string, unknown>;
    expect(entry.timestamp).toEqual(expect.any(String));
    expect(entry.level).toBe("info");
    expect(entry.traceId).toBe("trace-structured");
    expect(entry.spanId).toBe("span-structured");
    expect(entry.service).toBe("ai-net-backend");
    expect(entry.message).toBe("task accepted");
    expect(payload.privateNote).toBe("[REDACTED]");
    expect(payload.status).toBe("queued");
  });
});
