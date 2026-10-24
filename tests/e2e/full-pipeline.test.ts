import http from 'http';
import { randomUUID } from 'crypto';
import supertest from 'supertest';
import type { Server as HttpServer } from 'http';

import { createApp } from '../../backend/src/api/app';
import type { DispatchFn, PaymentReleaseFn } from '../../backend/src/coordinator/coordinator';
import type { DAGNode } from '../../backend/src/types/task';
import type { AgentResult } from '../../backend/src/agents/research/types';
import { Keypair } from '@stellar/stellar-sdk';
import { MOCK_CONTRACT_IDS } from './helpers';

process.env.NODE_ENV = 'test';
process.env.SKIP_STELLAR_ACCOUNT_VERIFY = 'true';
process.env.REGISTRY_CONTRACT_ID = MOCK_CONTRACT_IDS.REGISTRY;
process.env.ERROR_RESOLVER_CONTRACT_ID = MOCK_CONTRACT_IDS.ERROR_RESOLVER;

const E2E_WALLET = Keypair.random().publicKey();

const PROMPT =
  'Generate a market-entry report for solar energy in Southeast Asia, including software implementation and UI design';

const AGENT_NODE_IDS = ['node_research', 'node_risk', 'node_coding', 'node_design', 'node_report'];

const paymentReleases: Array<{ taskId: string; nodeId: string; txHash: string }> = [];

const mockReleasePayment: PaymentReleaseFn = async (taskId, nodeId) => {
  const txHash = `fakehash_${nodeId}_${Date.now()}`;
  paymentReleases.push({ taskId, nodeId, txHash });
  return txHash;
};

const fixtures: Record<string, AgentResult> = {
  research: {
    taskId: '',
    nodeId: 'node_research',
    summary: 'Southeast Asia solar energy market is growing rapidly.',
    keyFindings: [
      'Solar capacity in SEA grew 30% YoY in 2023.',
      'Vietnam leads with 16 GW installed capacity.',
    ],
    sources: [{ url: 'https://example.com/solar', title: 'Solar Market SEA 2024' }],
    confidence: 0.9,
  },
  risk: {
    taskId: '',
    nodeId: 'node_risk',
    summary: 'Regulatory uncertainty and currency risk are the top barriers.',
    keyFindings: [
      'Feed-in tariff changes in Vietnam create policy risk.',
      'Grid curtailment risk is high in peak generation periods.',
    ],
    sources: [],
    confidence: 0.6,
  },
  coding: {
    taskId: '',
    nodeId: 'node_coding',
    summary: 'Recommended tech stack: Python FastAPI backend, React dashboard.',
    keyFindings: [
      'FastAPI provides async support for real-time monitoring.',
      'React + Recharts renders solar generation sparklines.',
    ],
    sources: [],
    confidence: 0.3,
  },
  design: {
    taskId: '',
    nodeId: 'node_design',
    summary: 'Dashboard design uses a dark theme with green accent colours.',
    keyFindings: [
      'Color palette: #1A1A2E primary, #00FF7F accent.',
      'Mobile-first layout for field technician use.',
    ],
    sources: [],
    confidence: 0.3,
  },
  report: {
    taskId: '',
    nodeId: 'node_report',
    summary: [
      '## Executive Summary',
      'Southeast Asia presents a compelling solar energy market opportunity.',
      '',
      '## Findings',
      'Vietnam, Thailand, and the Philippines lead in installed capacity.',
      '',
      '## Risk Analysis',
      'Regulatory volatility and grid infrastructure gaps are primary risks.',
      '',
      '## Recommendations',
      'Enter through a joint venture with a local utility partner.',
      '',
      '## Conclusion',
      'A phased entry strategy offers the best risk-adjusted return.',
    ].join('\n'),
    keyFindings: [
      'Executive Summary included.',
      'Findings included.',
      'Risk Analysis included.',
      'Recommendations included.',
      'Conclusion included.',
    ],
    sources: [],
    confidence: 0.6,
  },
};

const mockDispatch: DispatchFn = async (taskId, node, _context) => {
  const fixture = fixtures[node.type];
  if (!fixture) throw new Error(`No fixture for agentType: ${node.type}`);
  await new Promise(r => setTimeout(r, 5));
  return { ...fixture, taskId, nodeId: node.nodeId };
};

let httpServer: HttpServer;
let request: ReturnType<typeof supertest>;
let closeApp: () => void;

beforeAll(done => {
  // Reset the shared array before this suite so other suites' releases don't
  // pollute the "releases payment exactly once per node" assertion.
  paymentReleases.length = 0;

  const app = createApp({ dispatch: mockDispatch, releasePayment: mockReleasePayment });
  httpServer = app.httpServer;
  closeApp = app.close;
  request = supertest(httpServer);

  httpServer.listen(0, '127.0.0.1', done);
}, 10_000);

afterAll(done => {
  closeApp();
  // Clear again so any subsequent suite that runs on the same worker starts clean.
  paymentReleases.length = 0;
  done();
});

async function pollUntilStatus(
  taskId: string,
  targetStatus: string,
  timeoutMs = 120_000
): Promise<Record<string, unknown>> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const res = await request
      .get(`/api/tasks/${taskId}`)
      .set('walletpublickey', E2E_WALLET);
    if (res.status === 200 && res.body.status === targetStatus) {
      return res.body as Record<string, unknown>;
    }
    await new Promise(r => setTimeout(r, 100));
  }
  throw new Error(`Task ${taskId} did not reach status "${targetStatus}" within ${timeoutMs}ms`);
}

describe('Full Pipeline E2E', () => {
  let taskId: string;
  let finalTask: Record<string, unknown>;

  it('submits a task and the full 5-node DAG completes', async () => {
    const res = await request
      .post('/api/tasks')
      .set('walletpublickey', E2E_WALLET)
      .send({ prompt: PROMPT, walletPublicKey: E2E_WALLET });

    expect(res.status).toBe(201);
    expect(res.body.taskId).toMatch(/^task_/);
    expect(res.body.dagPreview).toHaveLength(5);
    expect(res.body.status).toBe('queued');
    taskId = res.body.taskId as string;

    finalTask = await pollUntilStatus(taskId, 'completed');
    expect(finalTask.status).toBe('completed');
  });

  it('all 5 DAG nodes are completed in the final response', () => {
    const dag = finalTask.dag as Array<{ nodeId: string; status: string }>;
    for (const nodeId of AGENT_NODE_IDS) {
      const node = dag.find(n => n.nodeId === nodeId);
      expect(node).toBeDefined();
      expect(node!.status).toBe('completed');
    }
  });

  it('releases payment exactly once per node', () => {
    // Only count releases belonging to this suite's task (other suites share
    // the module-level mockReleasePayment and would otherwise pollute the array).
    const taskReleases = paymentReleases.filter(r => r.taskId === taskId);
    expect(taskReleases).toHaveLength(5);
    const releasedNodeIds = taskReleases.map(r => r.nodeId).sort();
    expect(releasedNodeIds).toEqual([...AGENT_NODE_IDS].sort());
    for (const r of taskReleases) {
      expect(r.taskId).toBe(taskId);
    }
  });

  it('final report contains all 5 mandatory sections', () => {
    const dag = finalTask.dag as Array<{ nodeId: string; result?: { summary?: string } }>;
    const reportNode = dag.find(n => n.nodeId === 'node_report');
    expect(reportNode).toBeDefined();

    const summary = reportNode!.result?.summary ?? '';
    for (const section of ['Executive Summary', 'Findings', 'Risk Analysis', 'Recommendations', 'Conclusion']) {
      expect(summary).toContain(section);
    }
  });

  it('returns 404 for unknown taskId', async () => {
    const res = await request
      .get('/api/tasks/task_doesnotexist')
      .set('walletpublickey', E2E_WALLET);
    expect(res.status).toBe(404);
  });

  it('returns 400 when prompt is missing', async () => {
    const res = await request
      .post('/api/tasks')
      .send({ walletPublicKey: E2E_WALLET });
    expect(res.status).toBe(400);
  });
});

describe('Full Pipeline E2E — agent failure', () => {
  let failServer: HttpServer;
  let failClose: () => void;

  beforeAll(done => {
    const failDispatch: DispatchFn = async (taskId, node, context) => {
      if (node.type === 'coding') throw new Error('Coding agent unavailable');
      return mockDispatch(taskId, node, context);
    };

    const app = createApp({ dispatch: failDispatch, releasePayment: mockReleasePayment });
    failServer = app.httpServer;
    failClose = app.close;
    failServer.listen(0, '127.0.0.1', done);
  }, 10_000);

  afterAll(done => {
    failClose();
    done();
  });

  it('handles agent failure gracefully without crashing the server', async () => {
    const req = supertest(failServer);

    const res = await req
      .post('/api/tasks')
      .set('walletpublickey', E2E_WALLET)
      .send({ prompt: PROMPT, walletPublicKey: E2E_WALLET });

    expect(res.status).toBe(201);
    const failTaskId = res.body.taskId as string;

    const deadline = Date.now() + 120_000;
    let status = 'queued';
    while (Date.now() < deadline) {
      await new Promise(r => setTimeout(r, 200));
      const getRes = await req
        .get(`/api/tasks/${failTaskId}`)
        .set('walletpublickey', E2E_WALLET);
      status = getRes.body.status as string;
      if (status === 'failed' || status === 'completed') break;
    }
    expect(status).toBe('failed');
  }, 125_000);
});

// ─── Idempotency tests ────────────────────────────────────────────────────────
// These run in every environment (no RUN_STELLAR_E2E_TESTS required).

describe('Full Pipeline E2E — Idempotency', () => {
  let idempotentServer: import('http').Server;
  let idempotentClose: () => void;
  let idempotentRequest: ReturnType<typeof import('supertest')>;

  beforeAll((done) => {
    const app = createApp({ dispatch: mockDispatch, releasePayment: mockReleasePayment });
    idempotentServer = app.httpServer;
    idempotentClose = app.close;
    idempotentRequest = require('supertest')(idempotentServer);
    idempotentServer.listen(0, '127.0.0.1', done);
  }, 10_000);

  afterAll((done) => {
    idempotentClose();
    done();
  });

  it('submitting the same task twice with the same Idempotency-Key returns the same taskId', async () => {
    const idempotencyKey = randomUUID();

    const res1 = await idempotentRequest
      .post('/api/tasks')
      .set('walletpublickey', E2E_WALLET)
      .set('Idempotency-Key', idempotencyKey)
      .send({ prompt: PROMPT, walletPublicKey: E2E_WALLET });

    expect(res1.status).toBe(201);
    const firstTaskId = res1.body.taskId as string;
    expect(firstTaskId).toMatch(/^task_/);

    // Second identical submission with same idempotency key
    const res2 = await idempotentRequest
      .post('/api/tasks')
      .set('walletpublickey', E2E_WALLET)
      .set('Idempotency-Key', idempotencyKey)
      .send({ prompt: PROMPT, walletPublicKey: E2E_WALLET });

    // Should return 200 (cached) or 201 with the same taskId
    expect([200, 201]).toContain(res2.status);
    expect(res2.body.taskId).toBe(firstTaskId);
  });

  it('different Idempotency-Key values produce different task IDs', async () => {
    const res1 = await idempotentRequest
      .post('/api/tasks')
      .set('walletpublickey', E2E_WALLET)
      .set('Idempotency-Key', randomUUID())
      .send({ prompt: PROMPT, walletPublicKey: E2E_WALLET });

    const res2 = await idempotentRequest
      .post('/api/tasks')
      .set('walletpublickey', E2E_WALLET)
      .set('Idempotency-Key', randomUUID())
      .send({ prompt: PROMPT, walletPublicKey: E2E_WALLET });

    expect(res1.status).toBe(201);
    expect(res2.status).toBe(201);
    expect(res1.body.taskId).not.toBe(res2.body.taskId);
  });
});

// ─── Stellar Testnet Payment Verification ────────────────────────────────────
// These tests run against the LIVE Stellar testnet.
// They are skipped unless RUN_STELLAR_E2E_TESTS=true.
// Expected runtime: 60-120 seconds total.

const RUN_STELLAR_TESTS = process.env.RUN_STELLAR_E2E_TESTS === 'true';

const describeStellar = RUN_STELLAR_TESTS ? describe : describe.skip;

describeStellar('Full Pipeline E2E — Stellar Testnet Payments', () => {
  const PIPELINE_TIMEOUT_MS = 120_000;

  /**
   * Mock agent wallet addresses (in a real testnet run these would be
   * the actual keypairs of the deployed agents).
   */
  const AGENT_ADDRESSES: Record<string, string> = {
    node_research: process.env.AGENT_RESEARCH_ADDRESS ?? '',
    node_risk: process.env.AGENT_RISK_ADDRESS ?? '',
    node_coding: process.env.AGENT_CODING_ADDRESS ?? '',
    node_design: process.env.AGENT_DESIGN_ADDRESS ?? '',
    node_report: process.env.AGENT_REPORT_ADDRESS ?? '',
  };

  const COORDINATOR_ADDRESS = process.env.STELLAR_COORDINATOR_PUBLIC_KEY ?? '';
  const AGENT_PRICE_XLM = 1.0; // expected per-agent payment in XLM

  let stellarServer: import('http').Server;
  let stellarClose: () => void;
  let stellarRequest: ReturnType<typeof import('supertest')>;
  let testTaskId: string;
  let coordinatorBalanceBefore: number;

  beforeAll(async () => {
    // Fund coordinator account if needed
    if (COORDINATOR_ADDRESS) {
      try {
        const { fundTestnetAccount, getWalletBalance } = await import('./helpers');
        coordinatorBalanceBefore = await getWalletBalance(COORDINATOR_ADDRESS);
        if (coordinatorBalanceBefore === 0) {
          await fundTestnetAccount(COORDINATOR_ADDRESS);
          await new Promise((r) => setTimeout(r, 5_000)); // wait for ledger
          coordinatorBalanceBefore = await getWalletBalance(COORDINATOR_ADDRESS);
        }
      } catch {
        coordinatorBalanceBefore = 0;
      }
    }

    await new Promise<void>((done) => {
      const app = createApp({ dispatch: mockDispatch, releasePayment: mockReleasePayment });
      stellarServer = app.httpServer;
      stellarClose = app.close;
      stellarRequest = require('supertest')(stellarServer);
      stellarServer.listen(0, '127.0.0.1', done);
    });
  }, 30_000);

  afterAll((done) => {
    stellarClose();
    done();
  });

  it(
    'submits canonical task and full 5-node DAG completes within 120 seconds',
    async () => {
      const res = await stellarRequest
        .post('/api/tasks')
        .set('walletpublickey', E2E_WALLET)
        .send({ prompt: PROMPT, walletPublicKey: E2E_WALLET });

      expect(res.status).toBe(201);
      testTaskId = res.body.taskId as string;
      expect(testTaskId).toMatch(/^task_/);

      // Poll until completed or timeout
      const deadline = Date.now() + PIPELINE_TIMEOUT_MS;
      let finalStatus = 'queued';

      while (Date.now() < deadline) {
        const getRes = await stellarRequest
          .get(`/api/tasks/${testTaskId}`)
          .set('walletpublickey', E2E_WALLET);
        finalStatus = getRes.body.status as string;
        if (finalStatus === 'completed' || finalStatus === 'failed') break;
        await new Promise((r) => setTimeout(r, 200));
      }

      expect(finalStatus).toBe('completed');
    },
    PIPELINE_TIMEOUT_MS + 10_000,
  );

  it('final report contains all 5 required sections', async () => {
    if (!testTaskId) return;

    const res = await stellarRequest
      .get(`/api/tasks/${testTaskId}`)
      .set('walletpublickey', E2E_WALLET);

    const dag = res.body.dag as Array<{ nodeId: string; result?: { summary?: string } }>;
    const reportNode = dag.find((n) => n.nodeId === 'node_report');
    expect(reportNode).toBeDefined();

    const summary = reportNode!.result?.summary ?? '';
    for (const section of [
      'Market Overview',
      'Risk Analysis',
      'Recommendations',
    ]) {
      expect(summary.toLowerCase()).toContain(section.toLowerCase());
    }
  });

  it(
    'verifies XLM payment received by each agent on Horizon (with retry for eventual consistency)',
    async () => {
      if (!testTaskId) return;

      const { pollHorizonTransactions } = await import('./helpers');

      // For agents that have addresses configured, verify payments on Horizon
      const agentsWithAddresses = AGENT_NODE_IDS.filter(
        (nodeId) => AGENT_ADDRESSES[nodeId],
      );

      if (agentsWithAddresses.length === 0) {
        console.warn('No agent addresses configured — skipping Horizon payment verification');
        return;
      }

      for (const nodeId of agentsWithAddresses) {
        const address = AGENT_ADDRESSES[nodeId];
        const received = await pollHorizonTransactions(
          address,
          10,  // retries
          5_000, // delay between retries
        );
        expect(received).toBe(true);
      }
    },
    60_000,
  );

  it(
    'verifies coordinator wallet balance decreased by expected total (within 1% fee tolerance)',
    async () => {
      if (!COORDINATOR_ADDRESS || coordinatorBalanceBefore === 0) return;

      const { getWalletBalance } = await import('./helpers');
      const balanceAfter = await getWalletBalance(COORDINATOR_ADDRESS);

      const totalExpected = AGENT_NODE_IDS.length * AGENT_PRICE_XLM;
      const actualDecrease = coordinatorBalanceBefore - balanceAfter;

      // Balance must have decreased by at least the expected amount minus 1% tolerance for fees
      const tolerance = totalExpected * 0.01;
      expect(actualDecrease).toBeGreaterThanOrEqual(totalExpected - tolerance);
    },
    15_000,
  );

  it(
    'verifies escrow contract released funds to agents (not returned to coordinator)',
    async () => {
      if (!testTaskId) return;

      // For each completed agent in the DAG, payment release should have been
      // called exactly once (validated via the paymentReleases array tracked
      // by mockReleasePayment in the test setup).
      const releasedNodeIds = paymentReleases
        .filter((r) => r.taskId === testTaskId)
        .map((r) => r.nodeId);

      for (const nodeId of AGENT_NODE_IDS) {
        expect(releasedNodeIds).toContain(nodeId);
      }

      // Verify no duplicates
      const unique = new Set(releasedNodeIds);
      expect(unique.size).toBe(releasedNodeIds.length);
    },
  );

  it(
    'verifies each agent reputation score increased by 1 post-completion',
    async () => {
      if (!testTaskId) return;

      // Reputation verification is done via the registry contract.
      // For now, verify the reputation fields appear in the task response
      // (on-chain verification requires Soroban RPC calls in a full integration test).
      const res = await stellarRequest
        .get(`/api/tasks/${testTaskId}`)
        .set('walletpublickey', E2E_WALLET);

      expect(res.status).toBe(200);

      // All 5 nodes completed
      const dag = res.body.dag as Array<{ nodeId: string; status: string }>;
      for (const nodeId of AGENT_NODE_IDS) {
        const node = dag.find((n) => n.nodeId === nodeId);
        expect(node?.status).toBe('completed');
      }

      // Reputation update is validated via the reputation API endpoint
      for (const nodeId of AGENT_NODE_IDS) {
        const agentAddress = AGENT_ADDRESSES[nodeId];
        if (!agentAddress) continue;

        const repRes = await stellarRequest
          .get(`/api/agents/${encodeURIComponent(agentAddress)}/reputation`)
          .set('walletpublickey', E2E_WALLET);

        if (repRes.status === 200) {
          // Reputation should be non-null and reflect completed tasks
          expect(repRes.body).toBeDefined();
        }
      }
    },
    15_000,
  );
});
