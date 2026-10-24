import type { Meta, StoryObj } from '@storybook/react'
import { DataTable, type DataTableColumn } from '../common/DataTable'

type Row = {
  id: string
  name: string
  status: 'Healthy' | 'Pending' | 'Needs review'
  score: number
}

const rows: Row[] = [
  { id: '1', name: 'Atlas', status: 'Healthy', score: 98 },
  { id: '2', name: 'Nimbus', status: 'Pending', score: 76 },
  { id: '3', name: 'Helix', status: 'Needs review', score: 64 },
]

const columns: DataTableColumn<Row>[] = [
  { key: 'name', header: 'Name', sortable: true },
  { key: 'status', header: 'Status', sortable: true },
  { key: 'score', header: 'Score', sortable: true },
]

const meta: Meta<typeof DataTable<Row>> = {
  title: 'UI/DataTable',
  component: DataTable,
  args: {
    columns,
    rows,
    getRowKey: (row) => row.id,
  },
  argTypes: {
    rows: { control: 'object' },
    emptyState: { control: 'text' },
  },
}

export default meta

type Story = StoryObj<typeof DataTable<Row>>

export const WithData: Story = {}

export const Empty: Story = {
  args: { rows: [] },
}

export const Loading: Story = {
  args: {
    rows: [],
    emptyState: <div className="p-6 text-slate-300 animate-pulse">Loading records…</div>,
  },
}

export const Sorted: Story = {
  args: {
    rows: [...rows].sort((a, b) => b.score - a.score),
  },
}
