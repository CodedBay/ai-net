import { createHmac, randomUUID, timingSafeEqual } from "crypto";
import { gzip, gunzip } from "zlib";
import { promisify } from "util";
import { mkdir, readFile, rm, writeFile } from "fs/promises";
import path from "path";
import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import type { TaskDb } from "../db/tasks";
import { createLogger } from "../utils/logger";
import { metricsService } from "./metrics";

const MAX_INLINE_BYTES = 1024 * 1024;
const COMPRESSION_THRESHOLD_BYTES = 1024;
const ARCHIVE_AFTER_MS = 30 * 24 * 60 * 60 * 1000;
const RESULT_TTL_MS = 365 * 24 * 60 * 60 * 1000;
const DOWNLOAD_TTL_SECONDS = 5 * 60;
const CLEANUP_INTERVAL_MS = 24 * 60 * 60 * 1000;
const gzipAsync = promisify(gzip);
const gunzipAsync = promisify(gunzip);
const logger = createLogger({ component: "task-results" });

export interface TaskResultArchiveStore {
  put(key: string, body: Buffer): Promise<void>;
  get(key: string): Promise<Buffer>;
  delete(key: string): Promise<void>;
}

export class S3TaskResultArchiveStore implements TaskResultArchiveStore {
  private readonly client: S3Client;

  constructor(private readonly bucket: string, client?: S3Client) {
    this.client = client ?? new S3Client({ region: process.env.AWS_REGION ?? "us-east-1" });
  }

  async put(key: string, body: Buffer): Promise<void> {
    await this.client.send(new PutObjectCommand({
      Bucket: this.bucket,
      Key: key,
      Body: body,
      ContentType: "application/json",
    }));
  }

  async get(key: string): Promise<Buffer> {
    const response = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
    if (!response.Body) throw new Error(`Archived task result ${key} has no body`);
    return Buffer.from(await response.Body.transformToByteArray());
  }

  async delete(key: string): Promise<void> {
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
  }
}

export class TaskResultStorageService {
  private cleanupTimer: NodeJS.Timeout | null = null;
  private readonly directory: string;
  private readonly signingSecret: string;
  private readonly archiveStore?: TaskResultArchiveStore;

  constructor(
    private readonly db: TaskDb,
    options: {
      directory?: string;
      signingSecret?: string;
      archiveStore?: TaskResultArchiveStore;
      s3Bucket?: string;
      s3Client?: S3Client;
    } = {},
  ) {
    this.directory = options.directory ?? process.env.TASK_RESULT_DIRECTORY ?? path.join(process.cwd(), "data", "task-results");
    this.signingSecret = options.signingSecret ?? process.env.TASK_RESULT_SIGNING_SECRET ?? process.env.AUTH_JWT_SECRET ?? "ai-net-task-result-local-key";
    const bucket = options.s3Bucket ?? process.env.TASK_RESULT_S3_BUCKET;
    this.archiveStore = options.archiveStore ?? (bucket ? new S3TaskResultArchiveStore(bucket, options.s3Client) : undefined);
  }

  async persist(taskId: string, result: unknown): Promise<void> {
    const serialized = JSON.stringify(result) ?? "null";
    const now = Date.now();
    const expiresAt = new Date(now + RESULT_TTL_MS).toISOString();
    const archiveAt = new Date(now + ARCHIVE_AFTER_MS).toISOString();
    const original = Buffer.from(serialized, "utf8");
    const compressed = original.byteLength > COMPRESSION_THRESHOLD_BYTES;
    const stored = compressed ? await gzipAsync(original) : original;
    if (compressed) metricsService.recordTaskResultCompressionRatio(stored.byteLength / original.byteLength);
    const content = compressed ? stored.toString("base64") : serialized;
    const summary = serialized.slice(0, 1000);

    if (stored.byteLength <= MAX_INLINE_BYTES) {
      this.db.saveResult(taskId, content, null, expiresAt, {
        encoding: compressed ? "gzip" : "identity",
        summary,
        archiveAt,
      });
      return;
    }

    await mkdir(this.directory, { recursive: true });
    const filePath = path.join(this.directory, `${randomUUID()}.json${compressed ? ".gz" : ""}`);
    await writeFile(filePath, stored, { flag: "wx" });
    try {
      this.db.saveResult(
        taskId,
        JSON.stringify({ storedAs: "file", sizeBytes: original.byteLength }),
        filePath,
        expiresAt,
        { encoding: compressed ? "gzip" : "identity", summary, archiveAt },
      );
    } catch (error) {
      await rm(filePath, { force: true });
      throw error;
    }
  }

  createDownloadUrl(taskId: string): { url: string; expiresAt: string } | undefined {
    const result = this.db.getResult(taskId);
    if ((!result?.resultFile && !result?.resultArchiveKey) || !result.resultExpiresAt) return undefined;

    const expires = Math.min(
      Math.floor(Date.now() / 1000) + DOWNLOAD_TTL_SECONDS,
      Math.floor(Date.parse(result.resultExpiresAt) / 1000),
    );
    const signature = this.sign(taskId, expires);
    return {
      url: `/api/tasks/${encodeURIComponent(taskId)}/result/download?expires=${expires}&signature=${signature}`,
      expiresAt: new Date(expires * 1000).toISOString(),
    };
  }

  async readSignedFile(taskId: string, expires: number, signature: string): Promise<Buffer | undefined> {
    if (!Number.isSafeInteger(expires) || expires < Math.floor(Date.now() / 1000)) return undefined;
    const expected = Buffer.from(this.sign(taskId, expires), "hex");
    let received: Buffer;
    try {
      received = Buffer.from(signature, "hex");
    } catch {
      return undefined;
    }
    if (received.length !== expected.length || !timingSafeEqual(received, expected)) return undefined;

    const result = this.db.getResult(taskId);
    if ((!result?.resultFile && !result?.resultArchiveKey) || !result.resultExpiresAt || Date.parse(result.resultExpiresAt) <= Date.now()) {
      return undefined;
    }
    const data = result.resultArchiveKey
      ? await this.archiveStore?.get(result.resultArchiveKey)
      : result.resultFile
        ? await readFile(result.resultFile)
        : undefined;
    if (!data) return undefined;
    return result.resultEncoding === "gzip" ? gunzipAsync(data) : data;
  }

  async readResult(taskId: string): Promise<Buffer | undefined> {
    const result = this.db.getResult(taskId);
    if (!result || result.resultStatus === "expired" || Date.parse(result.resultExpiresAt ?? "") <= Date.now()) return undefined;
    if (result.resultArchiveKey) {
      if (!this.archiveStore) throw new Error("Task result archive storage is not configured");
      const content = await this.archiveStore.get(result.resultArchiveKey);
      return result.resultEncoding === "gzip" ? gunzipAsync(content) : content;
    }
    if (result.resultFile) {
      const content = await readFile(result.resultFile);
      return result.resultEncoding === "gzip" ? gunzipAsync(content) : content;
    }
    if (!result.result) return undefined;
    const content = result.resultEncoding === "gzip"
      ? Buffer.from(result.result, "base64")
      : Buffer.from(result.result, "utf8");
    return result.resultEncoding === "gzip" ? gunzipAsync(content) : content;
  }

  async archiveExpired(now = new Date()): Promise<number> {
    if (!this.archiveStore) {
      if (this.db.listResultsToArchive(now.toISOString()).length > 0) {
        logger.warn("task result archival skipped because TASK_RESULT_S3_BUCKET is not configured");
      }
      return 0;
    }
    const due = this.db.listResultsToArchive(now.toISOString());
    let archived = 0;
    for (const item of due) {
      const result = this.db.getResult(item.id);
      if (!result?.result) continue;
      const compressed = result.resultEncoding === "gzip";
      const body = item.resultFile
        ? await readFile(item.resultFile)
        : compressed
          ? Buffer.from(result.result, "base64")
          : Buffer.from(result.result, "utf8");
      const key = item.resultArchiveKey ?? `task-results/${encodeURIComponent(item.id)}.json${compressed ? ".gz" : ""}`;
      await this.archiveStore.put(key, body);
      this.db.markResultArchived(item.id, key);
      if (item.resultFile) await rm(item.resultFile, { force: true });
      archived += 1;
    }
    return archived;
  }

  async cleanupExpired(now = new Date()): Promise<number> {
    const expired = this.db.listExpiredResults(now.toISOString());
    let removed = 0;
    for (const result of expired) {
      try {
        if (result.resultFile) await rm(result.resultFile, { force: true });
        if (result.resultArchiveKey) {
          if (!this.archiveStore) throw new Error("Cannot delete archived result without S3 configuration");
          await this.archiveStore.delete(result.resultArchiveKey);
        }
        this.db.clearResult(result.id);
        removed += 1;
      } catch (error) {
        logger.warn({ taskId: result.id, error }, "failed to clean expired task result");
      }
    }
    return removed;
  }

  startCleanup(intervalMs = CLEANUP_INTERVAL_MS): void {
    if (this.cleanupTimer) return;
    void this.runRetentionJobs().catch((error) => logger.error({ error }, "task result retention failed"));
    this.cleanupTimer = setInterval(() => {
      void this.runRetentionJobs().catch((error) => logger.error({ error }, "task result retention failed"));
    }, intervalMs);
    this.cleanupTimer.unref?.();
  }

  stopCleanup(): void {
    if (!this.cleanupTimer) return;
    clearInterval(this.cleanupTimer);
    this.cleanupTimer = null;
  }

  async runRetentionJobs(now = new Date()): Promise<{ archived: number; expired: number }> {
    const archived = await this.archiveExpired(now);
    const expired = await this.cleanupExpired(now);
    return { archived, expired };
  }

  private sign(taskId: string, expires: number): string {
    return createHmac("sha256", this.signingSecret)
      .update(`${taskId}:${expires}`)
      .digest("hex");
  }
}
