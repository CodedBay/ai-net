import type { Meta, StoryObj } from '@storybook/react'

const meta: Meta = {
  title: 'UI/ToastNotification',
}

const ToastCard = ({ type, label }: { type: 'success' | 'error' | 'warning' | 'info'; label: string }) => (
  <div className="rounded-xl border border-slate-700 bg-slate-900 p-4 text-sm text-slate-100 shadow-lg">
    <div className="mb-2 flex items-center gap-2">
      <span
        className={[
          'h-2.5 w-2.5 rounded-full',
          type === 'success' && 'bg-emerald-400',
          type === 'error' && 'bg-rose-400',
          type === 'warning' && 'bg-amber-400',
          type === 'info' && 'bg-cyan-400',
        ].join(' ')}
      />
      <strong>{label}</strong>
    </div>
    <div className="text-slate-300">{type === 'success' && 'Sync completed successfully.'}{type === 'error' && 'Payment failed. Please retry.'}{type === 'warning' && 'Rate limit reached in 30s.'}{type === 'info' && 'A new workflow is available.'}</div>
  </div>
)

export default meta

export const Success = () => <ToastCard type="success" label="Success" />
export const Error = () => <ToastCard type="error" label="Error" />
export const Warning = () => <ToastCard type="warning" label="Warning" />
export const Info = () => <ToastCard type="info" label="Info" />
