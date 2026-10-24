import type { Meta, StoryObj } from '@storybook/react'

const FilterPanel = ({ activeFilters }: { activeFilters: string[] }) => (
  <div className="w-[320px] rounded-xl border border-slate-700 bg-slate-900 p-4 text-sm text-slate-100">
    <div className="mb-3 font-semibold">Filters</div>
    <div className="space-y-2">
      {['Online', 'Research', 'Featured', 'New York'].map((filter) => (
        <label key={filter} className="flex items-center gap-2 rounded-lg bg-slate-800 px-2 py-1.5">
          <input type="checkbox" checked={activeFilters.includes(filter)} readOnly />
          <span>{filter}</span>
        </label>
      ))}
    </div>
  </div>
)

const meta: Meta<typeof FilterPanel> = {
  title: 'UI/FilterPanel',
  component: FilterPanel,
  args: { activeFilters: [] },
  argTypes: { activeFilters: { control: 'object' } },
}

export default meta

type Story = StoryObj<typeof FilterPanel>

export const NoFilters: Story = {}
export const MultipleActiveFilters: Story = { args: { activeFilters: ['Online', 'Research', 'Featured'] } }
