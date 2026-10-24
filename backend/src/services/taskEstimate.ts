/**
 * Shared cost-estimate logic for `GET /api/tasks/estimate`.
 *
 * The endpoint is mounted by both the v1 and v2 task routers; the calculation
 * and query parsing live here so the two versions cannot drift.
 */

export const ESTIMATE_AGENTS = ["research", "risk", "coding", "design", "report"] as const;

export type EstimateAgent = (typeof ESTIMATE_AGENTS)[number];

/** Per-agent base costs in XLM, mirrored by the frontend fallback constants. */
export const AGENT_BASE_COSTS_XLM: Record<EstimateAgent, number> = {
  research: 0.5,
  risk: 0.4,
  coding: 0.8,
  design: 0.6,
  report: 0.3,
};

/** Platform fee charged on top of the agent subtotal. */
export const PLATFORM_FEE_RATE = 0.05;

export interface TaskEstimateBreakdownItem {
  agent: EstimateAgent;
  costXLM: number;
}

export interface TaskEstimate {
  currency: "XLM";
  breakdown: TaskEstimateBreakdownItem[];
  subtotalXLM: number;
  platformFeeXLM: number;
  platformFeeRate: number;
  estimatedCostXLM: number;
}

export type ParsedEstimateAgents =
  | { ok: true; agents: EstimateAgent[] }
  | { ok: false; code: "INVALID_AGENTS"; message: string };

const MAX_DECIMALS = 6;

/** Keep monetary values free of floating-point noise (e.g. 1.3650000000000002). */
function roundXLM(value: number): number {
  const factor = 10 ** MAX_DECIMALS;
  return Math.round(value * factor) / factor;
}

function isEstimateAgent(value: string): value is EstimateAgent {
  return (ESTIMATE_AGENTS as readonly string[]).includes(value);
}

function flattenQueryValue(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) {
    return value.flatMap((entry) => flattenQueryValue(entry));
  }
  return [];
}

/**
 * Parse agent selections from a query object.
 *
 * Accepts both comma-separated `agents=` values and repeated `agentHints=`
 * values (and, defensively, arrays/comma-separated values for either).
 * Duplicates are removed while preserving request order.
 */
export function parseEstimateAgentsQuery(query: Record<string, unknown>): ParsedEstimateAgents {
  const raw = [
    ...flattenQueryValue(query.agents),
    ...flattenQueryValue(query.agentHints),
  ]
    .flatMap((value) => value.split(","))
    .map((value) => value.trim())
    .filter((value) => value.length > 0);

  if (raw.length === 0) {
    return {
      ok: false,
      code: "INVALID_AGENTS",
      message: `At least one agent is required. Allowed agents: ${ESTIMATE_AGENTS.join(", ")}`,
    };
  }

  const invalid = raw.filter((value) => !isEstimateAgent(value));
  if (invalid.length > 0) {
    return {
      ok: false,
      code: "INVALID_AGENTS",
      message: `Unknown agent(s): ${Array.from(new Set(invalid)).join(", ")}. Allowed agents: ${ESTIMATE_AGENTS.join(", ")}`,
    };
  }

  const agents = Array.from(new Set(raw)) as EstimateAgent[];
  return { ok: true, agents };
}

/** Compute the cost breakdown for a non-empty, validated list of agents. */
export function computeTaskEstimate(agents: EstimateAgent[]): TaskEstimate {
  const uniqueAgents = Array.from(new Set(agents));

  const breakdown = uniqueAgents.map((agent) => ({
    agent,
    costXLM: AGENT_BASE_COSTS_XLM[agent],
  }));

  const subtotalXLM = roundXLM(
    breakdown.reduce((sum, item) => sum + item.costXLM, 0),
  );
  const platformFeeXLM = roundXLM(subtotalXLM * PLATFORM_FEE_RATE);

  return {
    currency: "XLM",
    breakdown,
    subtotalXLM,
    platformFeeXLM,
    platformFeeRate: PLATFORM_FEE_RATE,
    estimatedCostXLM: roundXLM(subtotalXLM + platformFeeXLM),
  };
}
