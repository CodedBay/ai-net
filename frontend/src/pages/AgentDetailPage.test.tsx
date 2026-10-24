/**
 * AgentDetailPage — snapshot and behaviour tests
 *
 * Covers: loading skeleton, error state, 404 state, and loaded state
 * for each major section independently.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import AgentDetailPage from './AgentDetailPage'
import * as useAgentDetailModule from '../hooks/useAgentDetail'
import type { AgentDetailResult } from '../hooks/useAgentDetail'

// Mock the hook so we control what the page renders
vi.mock('../hooks/useAgentDetail')

const mockAgent = {
  id: 'GAGENT123456789',
  name: 'Solar Research Agent',
  capabilities: ['research', 'risk'],
  price: 1.5,
  reputation: 4.2,
  status: 'active',
  endpoint: 'https://agent.example.com',
  registrationTxHash: 'abc123tx',
}

const mockReputation = {
  id: 'GAGENT123456789',
  dimensions: { quality: 0.9, speed: 0.7, reliability: 0.85, cost: 0.6 },
  history: [
    { date: '2026-01-01', score: 70 },
    { date: '2026-02-01', score: 78 },
    { date: '2026-03-01', score: 84 },
  ],
}

const baseResult: AgentDetailResult = {
  agent: null,
  reputation: null,
  loading: false,
  agentLoading: false,
  reputationLoading: false,
  error: null,
  notFound: false,
  refetch: vi.fn(),
}

function renderPage(agentId = 'GAGENT123456789') {
  return render(
    <MemoryRouter initialEntries={[`/agents/${agentId}`]}>
      <Routes>
        <Route path="/agents/:id" element={<AgentDetailPage />} />
      </Routes>
    </MemoryRouter>,
  )
}

describe('AgentDetailPage', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('renders loading skeletons when agentLoading=true', () => {
    vi.mocked(useAgentDetailModule.useAgentDetail).mockReturnValue({
      ...baseResult,
      agentLoading: true,
      reputationLoading: true,
      loading: true,
    })

    const { container } = renderPage()

    expect(screen.getByTestId('header-skeleton')).toBeDefined()
    expect(screen.getByTestId('capabilities-skeleton')).toBeDefined()
    expect(screen.getByTestId('pricing-skeleton')).toBeDefined()
    expect(screen.getByTestId('reputation-skeleton')).toBeDefined()
    expect(container).toMatchSnapshot()
  })

  it('renders reputation skeleton independently while agent is loaded', () => {
    vi.mocked(useAgentDetailModule.useAgentDetail).mockReturnValue({
      ...baseResult,
      agent: mockAgent,
      agentLoading: false,
      reputationLoading: true,
    })

    renderPage()

    expect(screen.getByTestId('agent-header')).toBeDefined()
    expect(screen.getByTestId('reputation-skeleton')).toBeDefined()
  })

  it('renders 404 empty state when notFound=true', () => {
    vi.mocked(useAgentDetailModule.useAgentDetail).mockReturnValue({
      ...baseResult,
      notFound: true,
    })

    const { container } = renderPage()

    expect(screen.getByTestId('agent-not-found')).toBeDefined()
    expect(container).toMatchSnapshot()
  })

  it('renders error state with browse registry link', () => {
    vi.mocked(useAgentDetailModule.useAgentDetail).mockReturnValue({
      ...baseResult,
      error: 'Failed to load agent',
      agentLoading: false,
    })

    const { container } = renderPage()

    expect(screen.getByTestId('agent-error')).toBeDefined()
    expect(screen.getByRole('alert')).toBeDefined()
    expect(container).toMatchSnapshot()
  })

  it('renders fully loaded agent with all sections', () => {
    vi.mocked(useAgentDetailModule.useAgentDetail).mockReturnValue({
      ...baseResult,
      agent: mockAgent,
      reputation: mockReputation,
      agentLoading: false,
      reputationLoading: false,
    })

    const { container } = renderPage()

    expect(screen.getByTestId('agent-detail-page')).toBeDefined()
    expect(screen.getByTestId('agent-header')).toBeDefined()
    expect(screen.getByTestId('capabilities-section')).toBeDefined()
    expect(screen.getByTestId('pricing-section')).toBeDefined()
    expect(screen.getByTestId('reputation-section')).toBeDefined()
    expect(screen.getByTestId('task-history-section')).toBeDefined()
    expect(screen.getByTestId('hire-cta')).toBeDefined()
    expect(container).toMatchSnapshot()
  })

  it('shows agent name in heading', () => {
    vi.mocked(useAgentDetailModule.useAgentDetail).mockReturnValue({
      ...baseResult,
      agent: mockAgent,
      agentLoading: false,
      reputationLoading: false,
    })

    renderPage()

    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Solar Research Agent')
  })

  it('shows capability tags for each capability', () => {
    vi.mocked(useAgentDetailModule.useAgentDetail).mockReturnValue({
      ...baseResult,
      agent: mockAgent,
      agentLoading: false,
      reputationLoading: false,
    })

    renderPage()

    expect(screen.getByTestId('capability-research')).toBeDefined()
    expect(screen.getByTestId('capability-risk')).toBeDefined()
  })

  it('shows agent price in XLM', () => {
    vi.mocked(useAgentDetailModule.useAgentDetail).mockReturnValue({
      ...baseResult,
      agent: mockAgent,
      agentLoading: false,
      reputationLoading: false,
    })

    renderPage()

    expect(screen.getByTestId('agent-price')).toHaveTextContent('1.50')
  })

  it('hire button is disabled when agent is offline', () => {
    vi.mocked(useAgentDetailModule.useAgentDetail).mockReturnValue({
      ...baseResult,
      agent: { ...mockAgent, status: 'inactive' },
      agentLoading: false,
      reputationLoading: false,
    })

    renderPage()

    const hireBtn = screen.getByTestId('hire-agent-btn') as HTMLButtonElement
    expect(hireBtn.disabled).toBe(true)
    expect(hireBtn.getAttribute('aria-disabled')).toBe('true')
  })

  it('browse registry link is present and links to /agents', () => {
    vi.mocked(useAgentDetailModule.useAgentDetail).mockReturnValue({
      ...baseResult,
      agent: mockAgent,
      agentLoading: false,
      reputationLoading: false,
    })

    renderPage()

    const browseLink = screen.getByTestId('browse-registry-link') as HTMLAnchorElement
    expect(browseLink.getAttribute('href')).toBe('/agents')
  })
})
