import { createHash, randomUUID } from 'crypto';
import type { AddressInfo } from 'net';
import { Keypair } from '@stellar/stellar-sdk';
import { createApp } from '../../backend/src/api/app';
import type { DispatchFn, PaymentReleaseFn } from '../../backend/src/coordinator/coordinator';
import { closeAgentDb } from '../../backend/src/db/agents';
import { closeAuthDb } from '../../backend/src/db/auth';
import { closeDb } from '../../backend/src/db';
import { closeTaskDb } from '../../backend/src/db/tasks';
import { closeJobDb } from '../../backend/src/queue/jobStore';
import { invoke } from '../../smart-contracts/tests/testnet/client';
import { lockEscrow, releasePayment } from '../../smart-contracts/src/payment/payment';

const enabled = process.env.RUN_STELLAR_E2E_TESTS === 'true';
const describeTestnet = enabled ? describe : describe.skip;
const requiredCapabilities = ['research', 'risk', 'coding', 'design', 'report'];
const horizonUrl = process.env.STELLAR_HORIZON_URL ?? 'https://horizon-testnet.stellar.org';
const friendbotUrl = process.env.STELLAR_FRIENDBOT_URL ?? 'https://friendbot.stellar.org';
const paymentAmount = '0.1000000';

jest.setTimeout(240_000);

interface RegisteredAgent {
  capability: string;
  id: string;
  keypair: Keypair;
}

interface PendingPayment {
  memo: string;
  recipient: string;
}

let stellarQueue: Promise<unknown> = Promise.resolve();

function serializeStellar<T>(operation: () => Promise<T>): Promise<T> {
  const result = stellarQueue.then(operation, operation);
  stellarQueue = result.then(() => undefined, () => undefined);
  return result;
}

function paymentMemo(taskId: string, nodeId: string): string {
  const digest = createHash('sha256').update(`${taskId}:${nodeId}`).digest('hex');
  return `mr${digest.slice(0, 16)}`;
}

async function fundWithFriendbot(publicKey: string): Promise<void> {
  const response = await fetch(`${friendbotUrl}/?addr=${encodeURIComponent(publicKey)}`, {
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok && response.status !== 400) {
    throw new Error(`Friendbot funding failed for ${publicKey}: HTTP ${response.status}`);
  }
}

async function registerOnChain(registryId: string, agent: RegisteredAgent): Promise<void> {
  const previousSecret = process.env.STELLAR_SECRET_KEY;
  process.env.STELLAR_SECRET_KEY = agent.keypair.secret();
  try {
    const record = JSON.stringify({
      id: agent.id,
      capability: agent.capability,
      price_stroops: '1000000',
      endpoint: `https://${agent.capability}.e2e.ai-net.invalid/execute`,
      owner: agent.keypair.publicKey(),
      metadata: {},
      bond_amount: '100000000',
    });
    await invoke(registryId, 'register_agent', ['--record', record]);
    const lookup = await invoke(registryId, 'lookup_agents', ['--capability', agent.capability]);
    if (!lookup.stdout.includes(agent.id)) {
      throw new Error(`On-chain registry lookup did not return ${agent.id}`);
    }
  } finally {
    if (previousSecret === undefined) delete process.env.STELLAR_SECRET_KEY;
    else process.env.STELLAR_SECRET_KEY = previousSecret;
  }
}

function responseFor(capability: string): { markdown?: string; summary: string } {
  if (capability === 'research') {
    return { summary: 'Regional solar demand is rising, led by utility-scale and commercial projects.' };
  }
  if (capability === 'risk') {
    return { summary: 'Primary risks include permitting changes, grid capacity, and currency volatility.' };
  }
  if (capability === 'coding') {
    return { summary: 'A five-market sizing model was prepared for the entry analysis.' };
  }
  if (capability === 'design') {
    return { summary: 'The report uses a country comparison and an implementation timeline.' };
  }
  return {
    summary: 'Market report assembled.',
    markdown: [
      '# Southeast Asia Solar Market Entry',
      '',
      '## Executive Summary',
      'Demand is growing across regional utility-scale and commercial solar markets.',
      '',
      '## Findings',
      'Vietnam and the Philippines show strong demand; grid readiness differs by market.',
      '',
      '## Risk Analysis',
      'Permitting, interconnection capacity, and currency volatility require mitigation.',
      '',
      '## Recommendations',
      'Stage country entry, secure local regulatory support, and pre-screen grid capacity.',
      '',
      '## Conclusion',
      'A phased launch is recommended, beginning with markets that have clear demand signals.',
    ].join('\n'),
  };
}

describeTestnet('five-agent market report pipeline on Stellar testnet', () => {
  let coordinator: Keypair;
  let agents: RegisteredAgent[];
  let server: ReturnType<typeof createApp>['httpServer'];
  let closeApp: ReturnType<typeof createApp>['close'];
  let baseUrl: string;
  const pendingPayments = new Map<string, PendingPayment>();
  const releaseHashes: string[] = [];

  beforeAll(async () => {
    const registryId = process.env.REGISTRY_CONTRACT_ID;
    const coordinatorSecret = process.env.STELLAR_COORDINATOR_SECRET;
    if (!registryId) throw new Error('REGISTRY_CONTRACT_ID is required for Stellar E2E.');
    if (!coordinatorSecret) throw new Error('STELLAR_COORDINATOR_SECRET is required for Stellar E2E.');
    if (!process.env.STELLAR_RPC_URL) throw new Error('STELLAR_RPC_URL is required for Stellar E2E.');

    coordinator = Keypair.fromSecret(coordinatorSecret);
    const registrationSeed = Date.now().toString(36);
    agents = requiredCapabilities.map((capability) => ({
      capability,
      id: `e2e_${capability}_${registrationSeed}`,
      keypair: Keypair.random(),
    }));

    process.env.STELLAR_NETWORK = 'testnet';
    process.env.STELLAR_SECRET_KEY = coordinator.secret();
    await Promise.all([
      fundWithFriendbot(coordinator.publicKey()),
      ...agents.map((agent) => fundWithFriendbot(agent.keypair.publicKey())),
    ]);
    for (const agent of agents) await registerOnChain(registryId, agent);

    const agentByCapability = new Map(agents.map((agent) => [agent.capability, agent]));
    const dispatch: DispatchFn = async (taskId, node) => {
      const agent = agentByCapability.get(node.type);
      if (!agent) throw new Error(`No testnet agent registered for pipeline step ${node.type}`);
      const memo = paymentMemo(taskId, node.nodeId);
      pendingPayments.set(`${taskId}:${node.nodeId}`, {
        memo,
        recipient: agent.keypair.publicKey(),
      });
      await serializeStellar(() => lockEscrow(
        coordinator,
        agent.keypair.publicKey(),
        paymentAmount,
        memo,
      ));
      return responseFor(node.type);
    };
    const release: PaymentReleaseFn = async (taskId, nodeId) => {
      const payment = pendingPayments.get(`${taskId}:${nodeId}`);
      if (!payment) throw new Error(`No escrow was created for ${nodeId} in ${taskId}`);
      const hash = await serializeStellar(() => releasePayment(
        coordinator,
        payment.recipient,
        payment.memo,
      ));
      releaseHashes.push(hash);
      return hash;
    };

    process.env.VENICE_API_KEY ??= 'testnet-e2e-no-external-inference';
    const app = createApp({ dispatch, releasePayment: release, enableHeartbeatCleanup: false });
    server = app.httpServer;
    closeApp = app.close;
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const address = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterAll(async () => {
    try {
      if (closeApp) await new Promise<void>((resolve) => closeApp(resolve));
    } finally {
      closeAgentDb();
      closeAuthDb();
      closeDb();
      closeJobDb();
      closeTaskDb();
    }
  });

  it('registers all agents, executes every API pipeline step, pays agents, and returns Markdown', async () => {
    const walletPublicKey = coordinator.publicKey();
    const createResponse = await fetch(`${baseUrl}/api/tasks`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'API-Version': '1.0',
        walletpublickey: walletPublicKey,
        'Idempotency-Key': randomUUID(),
      },
      body: JSON.stringify({
        prompt: 'Generate a market entry report including risk, software implementation, and design recommendations for Southeast Asia solar.',
        walletPublicKey,
        maxBudgetXLM: 1,
      }),
    });
    const created = await createResponse.json() as { taskId?: string };
    if (createResponse.status !== 201 || !created.taskId) {
      throw new Error(`Task API submission failed (${createResponse.status}): ${JSON.stringify(created)}`);
    }

    const deadline = Date.now() + 150_000;
    let task: any;
    while (Date.now() < deadline) {
      const response = await fetch(`${baseUrl}/api/tasks/${created.taskId}`, {
        headers: { 'API-Version': '1.0', walletpublickey: walletPublicKey },
      });
      if (!response.ok) {
        throw new Error(`Task API polling failed (${response.status}): ${await response.text()}`);
      }
      task = await response.json();
      if (task.status === 'completed' || task.status === 'failed') break;
      await new Promise((resolve) => setTimeout(resolve, 1_000));
    }

    if (!task || task.status !== 'completed') {
      const failedNode = task?.dag?.find((node: any) => node.status === 'failed');
      throw new Error(`Pipeline did not complete: ${failedNode?.error ?? task?.status ?? 'task unavailable'}`);
    }
    expect(task.dag.map((node: any) => node.type).sort()).toEqual([...requiredCapabilities].sort());
    expect(task.dag.every((node: any) => node.status === 'completed')).toBe(true);
    expect(releaseHashes).toHaveLength(requiredCapabilities.length);

    const reportNode = task.dag.find((node: any) => node.type === 'report');
    const markdown = reportNode?.result?.markdown;
    if (typeof markdown !== 'string' || !markdown.startsWith('# ') || !markdown.includes('## Conclusion')) {
      throw new Error('Final report result was not valid Markdown with a title and conclusion.');
    }

    const response = await fetch(
      `${horizonUrl}/accounts/${coordinator.publicKey()}/payments?order=desc&limit=200`,
    );
    if (!response.ok) throw new Error(`Horizon payment query failed: HTTP ${response.status}`);
    const paymentPage = await response.json() as { _embedded?: { records?: any[] } };
    const payments = paymentPage._embedded?.records ?? [];
    for (const agent of agents) {
      const agentHashes = new Set(releaseHashes);
      const paid = payments.some((record) =>
        record.type === 'payment' &&
        record.asset_type === 'native' &&
        record.to === agent.keypair.publicKey() &&
        agentHashes.has(record.transaction_hash),
      );
      if (!paid) throw new Error(`Horizon has no confirmed XLM payment for ${agent.id}`);
    }
  });
});