import { useState } from 'react'
import type { Meta, StoryObj } from '@storybook/react'
import AgentCard, { type AgentData } from '../landing/AgentCard'

const agent: AgentData = {
  id: 'agent-1',
  name: 'Atlas Research',
  type: 'Research',
  description:
    'Aggregates market intelligence and synthesizes strategic recommendations for new market entry programs.',
  icon: <span aria-hidden>🔎</span>,
  tasksCompleted: 128,
  successRate: 96,
  capabilities: ['research', 'report'],
  isOnline: true,
  lastHeartbeat: Date.now() - 18000,
  reputation: 92,
}

const meta: Meta<typeof AgentCard> = {
  title: 'UI/AgentCard',
  component: AgentCard,
  args: { agent, index: 0 },
  argTypes: {
    index: { control: 'number' },
    agent: { control: 'object' },
  },
}

export default meta

type Story = StoryObj<typeof AgentCard>

export const Online: Story = {}

export const Offline: Story = {
  args: {
    agent: { ...agent, isOnline: false, lastHeartbeat: Date.now() - 3600000 },
  },
}

export const Featured: Story = {
  args: {
    agent: { ...agent, reputation: 100, successRate: 100 },
  },
}

export const ComparisonSelection: Story = {
  render: () => {
    const SelectableAgentCard = () => {
      const [selected, setSelected] = useState(false)
      return <AgentCard agent={agent} index={0} selected={selected} onSelect={() => setSelected((value) => !value)} />
    }
    return <SelectableAgentCard />
  },
}

export const Loading: Story = {
  render: () => (
    <div className="bg-slate-900 p-6 rounded-xl animate-pulse">
      <div className="h-16 rounded-xl bg-slate-700/80" />
    </div>
  ),
}
