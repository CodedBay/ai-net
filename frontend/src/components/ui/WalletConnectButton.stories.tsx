import type { Meta, StoryObj } from '@storybook/react'

const Button = ({ connected, loading }: { connected: boolean; loading: boolean }) => (
  <button
    className={[
      'rounded-full px-4 py-2 font-medium transition',
      connected ? 'bg-emerald-500 text-slate-950' : 'bg-slate-200 text-slate-900',
      loading ? 'opacity-75 cursor-wait' : '',
    ].join(' ')}
    disabled={loading}
  >
    {loading ? 'Connecting…' : connected ? 'Connected • GABC…6F2A' : 'Connect Wallet'}
  </button>
)

const meta: Meta<typeof Button> = {
  title: 'UI/WalletConnectButton',
  component: Button,
  args: { connected: false, loading: false },
  argTypes: {
    connected: { control: 'boolean' },
    loading: { control: 'boolean' },
  },
}

export default meta

type Story = StoryObj<typeof Button>

export const Disconnected: Story = {}
export const Connecting: Story = { args: { loading: true } }
export const Connected: Story = { args: { connected: true } }
