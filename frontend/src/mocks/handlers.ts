import { http, HttpResponse } from 'msw'

export const handlers = [
  http.get('/api/agents', () => {
    return HttpResponse.json([
      {
        id: 'agent-1',
        name: 'Research Specialist',
        capabilities: ['research', 'report'],
        price: 0.5,
        reputation: 4.8,
        status: 'active',
      },
      {
        id: 'agent-2',
        name: 'Smart Contract Dev',
        capabilities: ['coding'],
        price: 1.2,
        reputation: 4.9,
        status: 'active',
      },
      {
        id: 'agent-3',
        name: 'QA Audit Agent',
        capabilities: ['coding', 'audit'],
        price: 0.8,
        reputation: 4.2,
        status: 'inactive',
      },
    ])
  }),

  http.post('/api/tasks', async () => {
    return HttpResponse.json({
      taskId: 'mock-task-e2e-123',
      status: 'pending',
    })
  }),

  http.get('/api/tasks/:id', ({ params, request }) => {
    const { id } = params
    // Visual regression tests can override the status via a URL query param
    // (?__task_status=failed) so the spec can capture each state without
    // needing a real backend. The override is only checked in visual tests;
    // functional e2e tests never set this param.
    const url = new URL(request.url)
    const statusOverride = url.searchParams.get('__task_status')
    const status = statusOverride ?? 'running'
    return HttpResponse.json({
      taskId: id,
      prompt: 'Build a decentralized agent network testing suite.',
      walletPublicKey: 'GBXV37U3P5SIH46YI77XQ6WPAUXF3C2EDTYO54PBYU11A7T5F2TY4S25',
      status,
      dag: [
        { nodeId: 'node-research', agentType: 'research', prompt: 'Research Agent', dependsOn: [], status: status === 'pending' ? 'pending' : 'running' },
        { nodeId: 'node-coding', agentType: 'coding', prompt: 'Code Generator', dependsOn: ['node-research'], status: 'pending' },
        { nodeId: 'node-report', agentType: 'report', prompt: 'Report Writer', dependsOn: ['node-coding'], status: 'pending' },
      ],
      createdAt: new Date('2026-08-01T10:00:00.000Z').toISOString(),
      updatedAt: new Date('2026-08-01T10:05:00.000Z').toISOString(),
    })
  }),

  // Agent detail endpoint — used by the AgentDetailModal in visual regression tests.
  http.get('/api/agents/:id', ({ params }) => {
    const { id } = params
    return HttpResponse.json({
      id,
      name: 'Research Specialist',
      capabilities: ['research', 'report', 'summarization'],
      price: 0.5,
      reputation: 4.8,
      status: 'active',
      description: 'Specialized in data gathering and market research using multi-source synthesis.',
      walletPublicKey: 'GBXV37U3P5SIH46YI77XQ6WPAUXF3C2EDTYO54PBYU11A7T5F2TY4S25',
      totalTasksCompleted: 142,
      averageResponseTime: 4200,
      registeredAt: new Date('2026-01-15T08:00:00.000Z').toISOString(),
    })
  }),

  // Dashboard KPIs. Without this handler `useNetworkStats` fails against the
  // dev server (no `/api/stats` backend proxy in dev mode), leaving the
  // dashboard stuck on an error toast instead of its real layout — which is
  // both a poor dev experience and unusable as a visual-regression baseline.
  http.get('/api/stats', () => {
    return HttpResponse.json({
      totalAgents: 12,
      totalTasks: 48,
      totalXLMTransacted: 156.75,
      uptimePercent: 99.95,
    })
  }),

  http.get('/api/wallets/:address/tasks', () => {
    return HttpResponse.json([
      {
        taskId: 'mock-task-recent-1',
        prompt: 'Summarize on-chain agent reputation trends.',
        walletPublicKey: 'GBXV37U3P5SIH46YI77XQ6WPAUXF3C2EDTYO54PBYU11A7T5F2TY4S25',
        status: 'completed',
        dag: [],
        createdAt: '2026-08-20T09:15:00.000Z',
        updatedAt: '2026-08-20T09:22:00.000Z',
      },
      {
        taskId: 'mock-task-recent-2',
        prompt: 'Draft a smart-contract audit checklist.',
        walletPublicKey: 'GBXV37U3P5SIH46YI77XQ6WPAUXF3C2EDTYO54PBYU11A7T5F2TY4S25',
        status: 'running',
        dag: [],
        createdAt: '2026-08-21T14:02:00.000Z',
        updatedAt: '2026-08-21T14:05:00.000Z',
      },
      {
        taskId: 'mock-task-recent-3',
        prompt: 'Generate a network health report.',
        walletPublicKey: 'GBXV37U3P5SIH46YI77XQ6WPAUXF3C2EDTYO54PBYU11A7T5F2TY4S25',
        status: 'failed',
        dag: [],
        createdAt: '2026-08-19T11:40:00.000Z',
        updatedAt: '2026-08-19T11:41:00.000Z',
      },
    ])
  }),
]
