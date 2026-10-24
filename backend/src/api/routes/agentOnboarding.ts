import { randomUUID } from "crypto";
import { lookup } from "dns/promises";
import { isIP } from "net";
import { Router, Request, Response, NextFunction } from "express";
import { z } from "zod";
import {
  AgentRecord,
  AgentDb,
  AgentRegistrationDraft,
  AgentRegistrationDraftStore,
  createAgentRegistrationDraftStore,
  createAgentDb,
  getAgentDb,
} from "../../db/agents";
import { invalidateAgentsCache } from "../../cache/invalidation";

const STELLAR_PUBLIC_KEY_REGEX = /^G[A-Z2-7]{55}$/;
const DRAFT_TTL_MS = 24 * 60 * 60 * 1000;
const ENDPOINT_TIMEOUT_MS = 5_000;

const StartSchema = z.object({
  agentId: z.string().trim().min(1).max(64),
  stellarPublicKey: z.string().regex(STELLAR_PUBLIC_KEY_REGEX),
});
const CapabilitiesSchema = z.object({
  capabilities: z.array(z.string().trim().min(1).max(64)).min(1).max(50),
}).refine(({ capabilities }) => new Set(capabilities).size === capabilities.length, {
  message: "Capabilities must be unique",
});
const PricingSchema = z.object({ pricingXLM: z.number().finite().min(0.001) });
const EndpointSchema = z.object({ endpoint: z.string().url() });

export interface AgentOnboardingOptions {
  draftStore?: AgentRegistrationDraftStore;
  agentDb?: AgentDb;
  checkEndpoint?: (endpoint: string) => Promise<boolean>;
  registerOnChain?: (agent: AgentRecord) => Promise<string | void>;
}

function isPublicAddress(address: string): boolean {
  if (isIP(address) === 4) {
    const [first, second] = address.split(".").map(Number);
    return !(
      first === 0 || first === 10 || first === 127 ||
      (first === 100 && second! >= 64 && second! <= 127) ||
      (first === 169 && second === 254) ||
      (first === 172 && second! >= 16 && second! <= 31) ||
      (first === 192 && second === 168) || first! >= 224
    );
  }
  if (isIP(address) === 6) {
    const normalized = address.toLowerCase();
    return normalized !== "::1" && !normalized.startsWith("fe8") &&
      !normalized.startsWith("fe9") && !normalized.startsWith("fea") &&
      !normalized.startsWith("feb") && !normalized.startsWith("fc") &&
      !normalized.startsWith("fd") && !normalized.startsWith("::ffff:127.");
  }
  return false;
}

async function checkReachability(endpoint: string): Promise<boolean> {
  const url = new URL(endpoint);
  if (url.protocol !== "http:" && url.protocol !== "https:") return false;

  const addresses = isIP(url.hostname)
    ? [{ address: url.hostname }]
    : await lookup(url.hostname, { all: true });
  if (addresses.length === 0 || addresses.some(({ address }) => !isPublicAddress(address))) {
    return false;
  }

  try {
    const response = await fetch(url, {
      method: "HEAD",
      redirect: "manual",
      signal: AbortSignal.timeout(ENDPOINT_TIMEOUT_MS),
    });
    return response.ok;
  } catch {
    return false;
  }
}

function refreshDraft(draft: AgentRegistrationDraft): AgentRegistrationDraft {
  const now = new Date();
  return {
    ...draft,
    lastActivityAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + DRAFT_TTL_MS).toISOString(),
  };
}

function validBody<T>(schema: z.ZodType<T>, body: unknown, res: Response): T | undefined {
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid onboarding data", details: parsed.error.flatten() });
    return undefined;
  }
  return parsed.data;
}

export function createAgentOnboardingRouter(options: AgentOnboardingOptions = {}): Router {
  const router = Router();
  const db = options.agentDb ?? createAgentDb(getAgentDb());
  const drafts = options.draftStore ?? createAgentRegistrationDraftStore(getAgentDb());
  const probe = options.checkEndpoint ?? checkReachability;

  function getDraft(draftId: string, res: Response): AgentRegistrationDraft | undefined {
    const draft = drafts.find(draftId);
    if (!draft) {
      res.status(404).json({ error: "Onboarding draft not found or expired", code: "DRAFT_NOT_FOUND" });
      return undefined;
    }
    return draft;
  }

  router.post("/start", (req: Request, res: Response): void => {
    const data = validBody(StartSchema, req.body, res);
    if (!data) return;
    if (db.findById(data.agentId)) {
      res.status(409).json({ error: "Agent ID is already registered", code: "AGENT_ALREADY_REGISTERED" });
      return;
    }
    const now = new Date().toISOString();
    const draft: AgentRegistrationDraft = {
      draftId: randomUUID(),
      ...data,
      createdAt: now,
      lastActivityAt: now,
      expiresAt: new Date(Date.now() + DRAFT_TTL_MS).toISOString(),
    };
    drafts.deleteExpired(now);
    drafts.create(draft);
    res.status(201).json({ draft_id: draft.draftId, expires_at: draft.expiresAt });
  });

  router.get("/:draft_id", (req: Request, res: Response): void => {
    const draft = getDraft(req.params.draft_id, res);
    if (!draft) return;
    const refreshed = refreshDraft(draft);
    drafts.update(refreshed);
    res.json({
      draft_id: refreshed.draftId,
      expires_at: refreshed.expiresAt,
      steps: {
        capabilities: !!refreshed.capabilities,
        pricing: refreshed.pricingXLM !== undefined,
        endpoint: !!refreshed.endpoint,
      },
      preview: {
        id: refreshed.agentId,
        capabilities: refreshed.capabilities ?? [],
        pricingXLM: refreshed.pricingXLM ?? null,
        endpoint: refreshed.endpoint ?? null,
        stellarPublicKey: refreshed.stellarPublicKey,
      },
    });
  });

  router.put("/:draft_id/capabilities", (req: Request, res: Response): void => {
    const data = validBody(CapabilitiesSchema, req.body, res);
    if (!data) return;
    const draft = getDraft(req.params.draft_id, res);
    if (!draft) return;
    const updated = refreshDraft({ ...draft, capabilities: data.capabilities });
    drafts.update(updated);
    res.json({ draft_id: updated.draftId, capabilities: updated.capabilities, expires_at: updated.expiresAt });
  });

  router.put("/:draft_id/pricing", (req: Request, res: Response): void => {
    const data = validBody(PricingSchema, req.body, res);
    if (!data) return;
    const draft = getDraft(req.params.draft_id, res);
    if (!draft) return;
    const updated = refreshDraft({ ...draft, pricingXLM: data.pricingXLM });
    drafts.update(updated);
    res.json({ draft_id: updated.draftId, pricingXLM: updated.pricingXLM, expires_at: updated.expiresAt });
  });

  router.put("/:draft_id/endpoint", async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const data = validBody(EndpointSchema, req.body, res);
    if (!data) return;
    const draft = getDraft(req.params.draft_id, res);
    if (!draft) return;
    try {
      if (!(await probe(data.endpoint))) {
        res.status(422).json({ error: "Agent endpoint is unreachable", code: "ENDPOINT_UNREACHABLE" });
        return;
      }
      const updated = refreshDraft({ ...draft, endpoint: data.endpoint });
      drafts.update(updated);
      res.json({ draft_id: updated.draftId, endpoint: updated.endpoint, expires_at: updated.expiresAt });
    } catch (error) {
      next(error);
    }
  });

  router.post("/:draft_id/submit", async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const draft = getDraft(req.params.draft_id, res);
    if (!draft) return;
    if (!draft.capabilities || draft.pricingXLM === undefined || !draft.endpoint) {
      res.status(409).json({ error: "Complete all onboarding steps before submitting", code: "ONBOARDING_INCOMPLETE" });
      return;
    }
    if (!options.registerOnChain) {
      res.status(503).json({ error: "On-chain registration is not configured", code: "STELLAR_REGISTRATION_UNAVAILABLE" });
      return;
    }

    const now = new Date().toISOString();
    const agent: AgentRecord = {
      id: draft.agentId,
      capabilities: draft.capabilities,
      pricingXLM: draft.pricingXLM,
      endpoint: draft.endpoint,
      stellarPublicKey: draft.stellarPublicKey,
      reputationScore: 0,
      lastSeenAt: now,
      status: "online",
    };

    try {
      const transactionHash = await options.registerOnChain(agent);
      db.upsert(agent);
      drafts.delete(draft.draftId);
      await invalidateAgentsCache().catch(() => undefined);
      res.status(201).json({ agent, transactionHash: transactionHash ?? null });
    } catch (error) {
      next(error);
    }
  });

  return router;
}