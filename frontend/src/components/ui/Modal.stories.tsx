import type { Meta, StoryObj } from '@storybook/react'
import { useState } from 'react'

const ModalShell = ({ title, description, confirmText = 'Confirm' }: { title: string; description: string; confirmText?: string }) => {
  const [open, setOpen] = useState(true)

  if (!open) return <button onClick={() => setOpen(true)}>Open modal</button>

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/60 p-6">
      <div className="w-full max-w-md rounded-2xl border border-slate-700 bg-slate-900 p-6 text-slate-100 shadow-2xl">
        <h3 className="text-lg font-semibold">{title}</h3>
        <p className="mt-2 text-sm text-slate-300">{description}</p>
        <div className="mt-6 flex justify-end gap-3">
          <button className="rounded-lg border border-slate-600 px-3 py-2" onClick={() => setOpen(false)}>Cancel</button>
          <button className="rounded-lg bg-cyan-500 px-3 py-2 font-medium text-slate-950" onClick={() => setOpen(false)}>{confirmText}</button>
        </div>
      </div>
    </div>
  )
}

const meta: Meta<typeof ModalShell> = {
  title: 'UI/Modal',
  component: ModalShell,
  args: {
    title: 'Confirmation',
    description: 'This action cannot be undone once it is submitted.',
    confirmText: 'Confirm',
  },
  argTypes: {
    title: { control: 'text' },
    description: { control: 'text' },
    confirmText: { control: 'text' },
  },
}

export default meta

type Story = StoryObj<typeof ModalShell>

export const Basic: Story = {}

export const WithForm: Story = {
  args: {
    title: 'Create task',
    description: 'Choose a task template and assign the worker.',
    confirmText: 'Create task',
  },
}

export const Confirmation: Story = {
  args: {
    title: 'Remove agent',
    description: 'Are you sure you want to remove this agent from the network?',
    confirmText: 'Remove',
  },
}
