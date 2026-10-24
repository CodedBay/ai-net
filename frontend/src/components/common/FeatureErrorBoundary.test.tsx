import { fireEvent, render, screen } from '@testing-library/react'
import { FeatureErrorBoundary } from './FeatureErrorBoundary'

function MaybeThrow({ shouldThrow }: { shouldThrow: boolean }) {
  if (shouldThrow) throw new Error('A test failure')
  return <p>Feature content</p>
}

describe('FeatureErrorBoundary', () => {
  it('catches child errors and offers focused recovery actions', () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { rerender } = render(
      <FeatureErrorBoundary featureName="Payment History">
        <MaybeThrow shouldThrow={false} />
      </FeatureErrorBoundary>,
    )

    rerender(
      <FeatureErrorBoundary featureName="Payment History">
        <MaybeThrow shouldThrow />
      </FeatureErrorBoundary>,
    )

    const fallback = screen.getByRole('alert')
    expect(fallback).toHaveFocus()
    expect(fallback).toHaveTextContent('Payment History is unavailable')
    expect(fallback).toHaveTextContent('A test failure')
    expect(screen.getByRole('link', { name: 'Report Issue' })).toHaveAttribute(
      'href',
      expect.stringContaining('/issues/new?'),
    )

    rerender(
      <FeatureErrorBoundary featureName="Payment History">
        <MaybeThrow shouldThrow={false} />
      </FeatureErrorBoundary>,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))

    expect(screen.getByText('Feature content')).toBeInTheDocument()
    consoleError.mockRestore()
  })
})