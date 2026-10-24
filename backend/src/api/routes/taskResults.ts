import { Router, Request, Response } from "express";
import { createTaskDb, getTaskDb } from "../../db/tasks";
import { TaskResultStorageService } from "../../services/taskResultStorage";

export function createTaskResultsRouter(): Router {
  const router = Router();
  const getDb = () => createTaskDb(getTaskDb());
  const storage = new TaskResultStorageService(getDb());

  router.get("/:id/result", async (req: Request, res: Response): Promise<void> => {
    const db = getDb();
    const task = db.findById(req.params.id);
    if (!task) {
      res.status(404).json({ error: "Task not found" });
      return;
    }
    if (req.headers["walletpublickey"] !== task.walletPublicKey) {
      res.status(403).json({ error: "Access denied" });
      return;
    }

    const stored = db.getResult(req.params.id);
    if (!stored || stored.resultStatus === "expired" || !stored.resultExpiresAt || Date.parse(stored.resultExpiresAt) <= Date.now()) {
      res.status(404).json({ error: "Task result not found" });
      return;
    }

    if (stored.resultFile || stored.resultArchiveKey) {
      const download = storage.createDownloadUrl(req.params.id);
      if (!download) {
        res.status(404).json({ error: "Task result not found" });
        return;
      }
      res.json({ taskId: req.params.id, downloadUrl: download.url, expiresAt: download.expiresAt });
      return;
    }

    try {
      const contents = await storage.readResult(req.params.id);
      if (!contents) {
        res.status(404).json({ error: "Task result not found" });
        return;
      }
      res.json({ taskId: req.params.id, result: JSON.parse(contents.toString("utf8")) as unknown });
    } catch {
      res.status(500).json({ error: "Stored task result is invalid" });
    }
  });

  router.get("/:id/result/download", async (req: Request, res: Response): Promise<void> => {
    const expires = Number(req.query.expires);
    const signature = typeof req.query.signature === "string" ? req.query.signature : "";
    try {
      const contents = await storage.readSignedFile(req.params.id, expires, signature);
      if (!contents) {
        res.status(403).json({ error: "Invalid or expired download link" });
        return;
      }
      res.type("application/json").send(contents);
    } catch {
      res.status(404).json({ error: "Task result not found" });
    }
  });

  return router;
}
