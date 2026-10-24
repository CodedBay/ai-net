import type { Meta, StoryObj } from '@storybook/react'

const statuses = [
  { label: 'Queued', state: 'pending' as const },
  { label: 'Review', state: 'running' as const },
  { label: 'Deploy', state: 'complete' as const },
  { label: 'Verify', state: 'failed' as const },
]

const Template = ({ items = statuses }: { items?: typeof statuses }) => (
  <div className="space-y-4 w-[360px]">
    {items.map((item, index) => (
      <div key={item.label} className="flex items-center gap-3">
        <div
          className={[
            'h-3 w-3 rounded-full',
            item.state === 'pending' && 'bg-slate-500',
            item.state === 'running' && 'bg-cyan-400 animate-pulse',
            item.state === 'complete' && 'bg-emerald-500',
            item.state === 'failed' && 'bg-rose-500',
          ].join(' ')}
        />
        <div className="flex-1 text-sm text-slate-200">{index + 1}. {item.label}</div>
      </div>
    ))}
  </div>
)

const meta: Meta<typeof Template> = {
  title: 'UI/TaskProgressTimeline',
  component: Template,
  args: { items: statuses },
}

export default meta

type Story = StoryObj<typeof Template>

export const Pending: Story = { args: { items: statuses.map((item, idx) => ({ ...item, state: idx === 0 ? 'pending' : 'pending' })) } }
export const Running: Story = { args: { items: statuses.map((item, idx) => ({ ...item, state: idx === 1 ? 'running' : 'pending' })) } }
export const Complete: Story = { args: { items: statuses.map((item) => ({ ...item, state: 'complete' })) } }
export const Failed: Story = { args: { items: statuses.map((item, idx) => ({ ...item, state: idx === 3 ? 'failed' : idx === 2 ? 'complete' : 'pending' })) } }
