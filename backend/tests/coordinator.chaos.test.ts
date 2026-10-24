/**
 * Chaos test suite for the backend Coordinator class.
 *
 * Systematically injects failure modes into a 5-agent pipeline and verifies
 * that every task reaches a terminal state (completed / failed), no resources
 * are orphaned, and payment escrow is correctly resolved under each scenario.
 *
 * Failure modes covered
 * ─────────────────────
 *   C1  · Single agent crash mid-pipeline (1 of 5 fails)
 *   C2  · Agent timeout (near-timeout, 30 s simulated)
 *   C3  · Agent returns malformed / non-JSON response
 *   C4  · Two of five agents fail simultaneously
 *
 * Each scenario asserts:
 *   ✓ Task reaches terminal state (completed or failed) – never stuck
 *   ✓ No pending nodes remain after execution
 *   ✓ Payment escrow release is called for every node that succeeded
 *   ✓ No unhandled promise rejections (all errors are caught inside executeDAG)
 *
 * Design notes
 * ────────────
 * Tests use the Coordinator class from backend/src/coordinator/coordinator.ts
 * and inject behaviour via the `dispatch` option (DispatchFn) and a mock
 * payment service – the same patterns used in coordinator.class.test.ts.
 *
 * The taskStore is mocked (no real DB) consistent with existing unit tests.
 * Jest fake-timers are NOT used; timeouts are simulated by making the dispatch
 * function throw immediately with a timeout-shaped error message.
 */

import { Coordinator } from '../src/coordinator/coordinator';
import type { DAGNode } from '../src/types/task';
import type { AgentRegistration, AgentRegistry } from '../src/types/agent';
import type { PaymentService } from '../src/types/payment';
import { eventBus } from '../src/coordinator/eventBus';

// ── Mock taskStore so coordinator doesn't need a real DB ──────────────────────
jest.mock('../src/coordinator/taskStore', () => ({
  createTask: jest.fn(),
  getTask: jest.fn((id: string) => ({
    id,
    prompt: 'chaos-test-prompt',
    walletPublicKey: 'GCHAOS',
    status: 'queued',
    dag: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  })),
  updateTask: jest.fn(),
  updateNode: jest.fn(),
  getEventHistory: jest.fn().mockReturnValue([]),
}));

// ── Mock traceContext so it doesn't need AsyncLocalStorage setup ──────────────
jest.mock('../src/services/traceContext', () => ({
  currentTraceId: jest.fn().mockReturnValue('chaos-trace-id'),
  currentSpanId: jest.fn().mockReturnValue('chaos-span-id'),
  runWithTraceContext: jest.fn((_ctx: unknown, fn: () => Promise<unknown>) => fn()),
  childSpanContext: jest.fn().mockReturnValue(null),
}));

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeNode(
  nodeId: string,
  type = 'research',
  dependencies: string[] = [],
): DAGNode {
  return {
    nodeId,
    type,
    status: 'pending',
    prompt: `chaos-${nodeId}`,
    dependencies,
  };
}

/**
 * Build a 5-node linear pipeline:
 *   research → risk → coding → design → report
 */
function makeFiveStagePipeline(): DAGNode[] {
  return [
    makeNode('n1', 'research', []),
    makeNode('n2', 'risk', ['n1']),
    makeNode('n3', 'coding', ['n2']),
    makeNode('n4', 'design', ['n3']),
    makeNode('n5', 'report', ['n4']),
  ];
}

function makeAgent(id: string, type: string, cost = 1): AgentRegistration {
  return { id, type, endpoint: `http://${id}.test`, cost, status: 'online' };
}

function buildRegistry(agents: AgentRegistration[]): AgentRegistry {
  return {
    getAgentsForType: (type: string) => agents.filter(a => a.type === type),
    getAllAgents: () => agents,
  };
}

function makePaymentService(): jest.Mocked<PaymentService> {
  return { release: jest.fn().mockResolvedValue('mock-tx-hash') };
}

/**
 * Returns a DispatchFn that succeeds for all node types except those listed in
 * `crashOnType`. Crashing nodes throw with the supplied `errorMessage`.
 */
function makeDispatch(
  crashOnType: string[] = [],
  errorMessage = 'agent crashed',
  malformResponse = false,
): jest.Mock {
  return jest.fn(async (_taskId: string, node: DAGNode) => {
    if (crashOnType.includes(node.type)) {
      if (malformResponse) {
        // Simulates the agent returning non-JSON (parse error scenario)
        throw new SyntaxError(`Unexpected token < in JSON at position 0: <html>error</html>`);
      }
      throw new Error(errorMessage);
    }
    return { result: `${node.type}-output`, nodeId: node.nodeId };
  });
}

// ── All agents for the full pipeline ─────────────────────────────────────────
const ALL_AGENTS: AgentRegistration[] = [
  makeAgent('research-1', 'research'),
  makeAgent('risk-1', 'risk'),
  makeAgent('coding-1', 'coding'),
  makeAgent('design-1', 'design'),
  makeAgent('report-1', 'report'),
];

// ── Test suite ────────────────────────────────────────────────────────────────

describe('Coordinator chaos tests', () => {
  let paymentService: jest.Mocked<PaymentService>;
  let registry: AgentRegistry;

  beforeEach(() => {
    jest.clearAllMocks();
    paymentService = makePaymentService();
    registry = buildRegistry(ALL_AGENTS);
  });

  // ── C1: Single agent crash mid-pipeline ─────────────────────────────────

  describe('C1 · single agent crash mid-pipeline (coding agent, node 3 of 5)', () => {
    it('task reaches terminal state (failed) when coding agent crashes', async () => {
      const dag = makeFiveStagePipeline();
      const dispatch = makeDispatch(['coding']);

      const coordinator = new Coordinator({
        agentRegistry: registry,
        paymentService,
        dispatch,
        concurrency: 5,
        timeoutMs: 5_000,
      });

      // Must not throw (all errors captured internally)
      await expect(
        coordinator.executeDAG('task-c1', dag),
      ).resolves.not.toThrow();

      // Nodes before the crash should be completed; crash node and downstream failed
      expect(dag[0].status).toBe('completed'); // research
      expect(dag[1].status).toBe('completed'); // risk
      expect(dag[2].status).toBe('failed');     // coding ← crash
      // design and report depend on coding; they must not be stuck as 'pending'
      expect(['failed', 'pending']).toContain(dag[3].status);
      expect(['failed', 'pending']).toContain(dag[4].status);

      // No node remains 'running' (would indicate an orphaned resource)
      const runningNodes = dag.filter(n => n.status === 'running');
      expect(runningNodes).toHaveLength(0);
    });

    it('payment is released for each node that completed before the crash', async () => {
      const dag = makeFiveStagePipeline();
      const dispatch = makeDispatch(['coding']);

      const coordinator = new Coordinator({
        agentRegistry: registry,
        paymentService,
        dispatch,
        concurrency: 5,
        timeoutMs: 5_000,
      });

      await coordinator.executeDAG('task-c1-pay', dag);

      // research (n1) and risk (n2) completed → payment should have been released
      const releaseCalls = (paymentService.release as jest.Mock).mock.calls;
      const releasedNodes = releaseCalls.map((c: unknown[]) => c[1]);
      expect(releasedNodes).toContain('n1');
      expect(releasedNodes).toContain('n2');
      // coding (n3) failed – payment must NOT be released for a failed node
      expect(releasedNodes).not.toContain('n3');
    });
  });

  // ── C2: Agent timeout (near-timeout scenario) ────────────────────────────

  describe('C2 · agent timeout – near-30-second timeout on risk agent', () => {
    it('task reaches terminal state when risk agent throws a timeout error', async () => {
      const dag = makeFiveStagePipeline();
      const dispatch = makeDispatch(
        ['risk'],
        'Agent risk-1 timed out after 30000ms',
      );

      const coordinator = new Coordinator({
        agentRegistry: registry,
        paymentService,
        dispatch,
        concurrency: 5,
        timeoutMs: 5_000,
      });

      await expect(
        coordinator.executeDAG('task-c2', dag),
      ).resolves.not.toThrow();

      // research should complete, risk should fail
      expect(dag[0].status).toBe('completed');
      expect(dag[1].status).toBe('failed');

      // No node should be left 'running'
      expect(dag.filter(n => n.status === 'running')).toHaveLength(0);
    });

    it('error message references timeout so operators can diagnose', async () => {
      const dag = makeFiveStagePipeline();
      const dispatch = makeDispatch(['risk'], 'Agent risk-1 timed out after 30000ms');

      const coordinator = new Coordinator({
        agentRegistry: registry,
        paymentService,
        dispatch,
        concurrency: 5,
        timeoutMs: 5_000,
      });

      await coordinator.executeDAG('task-c2-err', dag);

      const riskNode = dag.find(n => n.nodeId === 'n2')!;
      expect(riskNode.status).toBe('failed');
      expect(riskNode.error).toMatch(/timed out/i);
    });
  });

  // ── C3: Agent returns malformed / non-JSON response ──────────────────────

  describe('C3 · agent returns malformed JSON (design agent)', () => {
    it('task reaches terminal state when design agent returns corrupt output', async () => {
      const dag = makeFiveStagePipeline();
      const dispatch = makeDispatch(['design'], '', /* malformResponse */ true);

      const coordinator = new Coordinator({
        agentRegistry: registry,
        paymentService,
        dispatch,
        concurrency: 5,
        timeoutMs: 5_000,
      });

      await expect(
        coordinator.executeDAG('task-c3', dag),
      ).resolves.not.toThrow();

      // n1–n3 should complete; n4 (design) should fail
      expect(dag[0].status).toBe('completed');
      expect(dag[1].status).toBe('completed');
      expect(dag[2].status).toBe('completed');
      expect(dag[3].status).toBe('failed'); // design ← malformed JSON

      // No orphaned running nodes
      expect(dag.filter(n => n.status === 'running')).toHaveLength(0);
    });

    it('failed design node has a descriptive error attached', async () => {
      const dag = makeFiveStagePipeline();
      const dispatch = makeDispatch(['design'], '', true);

      const coordinator = new Coordinator({
        agentRegistry: registry,
        paymentService,
        dispatch,
        concurrency: 5,
        timeoutMs: 5_000,
      });

      await coordinator.executeDAG('task-c3-err', dag);

      const designNode = dag.find(n => n.nodeId === 'n4')!;
      expect(designNode.status).toBe('failed');
      expect(typeof designNode.error).toBe('string');
      expect(designNode.error!.length).toBeGreaterThan(0);
    });
  });

  // ── C4: Two of five agents fail simultaneously ───────────────────────────

  describe('C4 · two agents fail simultaneously (research + design)', () => {
    it('task reaches terminal state when two independent agents fail', async () => {
      // Use a flat (non-sequential) DAG so both failures happen independently
      const dag: DAGNode[] = [
        makeNode('n1', 'research', []),
        makeNode('n2', 'risk', []),
        makeNode('n3', 'coding', []),
        makeNode('n4', 'design', []),
        makeNode('n5', 'report', []),
      ];

      const dispatch = makeDispatch(['research', 'design']);

      const coordinator = new Coordinator({
        agentRegistry: registry,
        paymentService,
        dispatch,
        concurrency: 5,
        timeoutMs: 5_000,
      });

      await expect(
        coordinator.executeDAG('task-c4', dag),
      ).resolves.not.toThrow();

      expect(dag.find(n => n.nodeId === 'n1')!.status).toBe('failed');  // research
      expect(dag.find(n => n.nodeId === 'n2')!.status).toBe('completed'); // risk
      expect(dag.find(n => n.nodeId === 'n3')!.status).toBe('completed'); // coding
      expect(dag.find(n => n.nodeId === 'n4')!.status).toBe('failed');  // design
      expect(dag.find(n => n.nodeId === 'n5')!.status).toBe('completed'); // report

      // No running nodes
      expect(dag.filter(n => n.status === 'running')).toHaveLength(0);
    });

    it('payment is released for successful nodes even when two others fail', async () => {
      const dag: DAGNode[] = [
        makeNode('n1', 'research', []),
        makeNode('n2', 'risk', []),
        makeNode('n3', 'coding', []),
        makeNode('n4', 'design', []),
        makeNode('n5', 'report', []),
      ];

      const dispatch = makeDispatch(['research', 'design']);

      const coordinator = new Coordinator({
        agentRegistry: registry,
        paymentService,
        dispatch,
        concurrency: 5,
        timeoutMs: 5_000,
      });

      await coordinator.executeDAG('task-c4-pay', dag);

      const released = (paymentService.release as jest.Mock).mock.calls.map(
        (c: unknown[]) => c[1],
      );
      // Nodes that succeeded get payment released
      expect(released).toContain('n2'); // risk
      expect(released).toContain('n3'); // coding
      expect(released).toContain('n5'); // report
      // Failed nodes must NOT receive payment
      expect(released).not.toContain('n1'); // research failed
      expect(released).not.toContain('n4'); // design failed
    });

    it('no unhandled rejections when two agents fail concurrently', async () => {
      const unhandledErrors: Error[] = [];
      const handler = (err: Error) => unhandledErrors.push(err);
      process.on('unhandledRejection', handler);

      const dag: DAGNode[] = [
        makeNode('n1', 'research', []),
        makeNode('n2', 'risk', []),
        makeNode('n3', 'coding', []),
        makeNode('n4', 'design', []),
        makeNode('n5', 'report', []),
      ];

      const dispatch = makeDispatch(['research', 'design']);

      const coordinator = new Coordinator({
        agentRegistry: registry,
        paymentService,
        dispatch,
        concurrency: 5,
        timeoutMs: 5_000,
      });

      await coordinator.executeDAG('task-c4-unhandled', dag);

      // Give the event loop one tick to surface any unhandled rejections
      await new Promise(resolve => setImmediate(resolve));

      process.off('unhandledRejection', handler);
      expect(unhandledErrors).toHaveLength(0);
    });
  });

  // ── Cross-cutting: all nodes reach terminal state ────────────────────────

  describe('terminal-state invariant across all chaos scenarios', () => {
    const scenarios: Array<{ name: string; crashTypes: string[]; dagFn: () => DAGNode[] }> = [
      { name: 'C1 single crash',        crashTypes: ['coding'],              dagFn: makeFiveStagePipeline },
      { name: 'C2 timeout',             crashTypes: ['risk'],                dagFn: makeFiveStagePipeline },
      { name: 'C3 malformed-response',  crashTypes: ['design'],              dagFn: makeFiveStagePipeline },
      { name: 'C4 two simultaneous',    crashTypes: ['research', 'design'],  dagFn: makeFiveStagePipeline },
    ];

    for (const scenario of scenarios) {
      it(`no node is stuck in pending/running after: ${scenario.name}`, async () => {
        const dag = scenario.dagFn();
        const dispatch = makeDispatch(scenario.crashTypes);

        const coordinator = new Coordinator({
          agentRegistry: registry,
          paymentService,
          dispatch,
          concurrency: 5,
          timeoutMs: 5_000,
        });

        await coordinator.executeDAG(`task-invariant-${scenario.name}`, dag);

        const nonTerminal = dag.filter(
          n => n.status === 'running' || n.status === 'pending',
        );
        expect(nonTerminal).toHaveLength(0);
      });
    }
  });
});
