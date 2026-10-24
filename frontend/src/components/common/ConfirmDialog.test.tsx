import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ConfirmDialog } from './ConfirmDialog';

const defaultProps = {
  open: true,
  title: 'Cancel Task',
  description: 'Are you sure you want to cancel this task?',
  consequence: 'Your task will be cancelled and a refund processed within 24h.',
  confirmLabel: 'Confirm Cancel',
  onConfirm: vi.fn(),
  onCancel: vi.fn(),
};

describe('ConfirmDialog', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders nothing when open=false', () => {
    render(<ConfirmDialog {...defaultProps} open={false} />);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('renders dialog with title and description when open=true', () => {
    render(<ConfirmDialog {...defaultProps} />);
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(screen.getByText('Cancel Task')).toBeInTheDocument();
    expect(screen.getByText('Are you sure you want to cancel this task?')).toBeInTheDocument();
    expect(
      screen.getByText('Your task will be cancelled and a refund processed within 24h.'),
    ).toBeInTheDocument();
  });

  it('renders both Cancel and Confirm buttons', () => {
    render(<ConfirmDialog {...defaultProps} />);
    expect(screen.getByTestId('confirm-dialog-cancel')).toBeInTheDocument();
    expect(screen.getByTestId('confirm-dialog-confirm')).toBeInTheDocument();
    expect(screen.getByTestId('confirm-dialog-confirm')).toHaveTextContent('Confirm Cancel');
  });

  it('calls onCancel when Cancel button is clicked', () => {
    render(<ConfirmDialog {...defaultProps} />);
    fireEvent.click(screen.getByTestId('confirm-dialog-cancel'));
    expect(defaultProps.onCancel).toHaveBeenCalledTimes(1);
    expect(defaultProps.onConfirm).not.toHaveBeenCalled();
  });

  it('calls onConfirm when Confirm button is clicked', () => {
    render(<ConfirmDialog {...defaultProps} />);
    fireEvent.click(screen.getByTestId('confirm-dialog-confirm'));
    expect(defaultProps.onConfirm).toHaveBeenCalledTimes(1);
  });

  it('calls onCancel when Escape key is pressed', () => {
    render(<ConfirmDialog {...defaultProps} />);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(defaultProps.onCancel).toHaveBeenCalledTimes(1);
  });

  it('calls onCancel when overlay backdrop is clicked', () => {
    render(<ConfirmDialog {...defaultProps} />);
    // The overlay is the parent element of the dialog
    const dialog = screen.getByRole('dialog');
    fireEvent.click(dialog.parentElement!);
    expect(defaultProps.onCancel).toHaveBeenCalledTimes(1);
  });

  it('does NOT call onCancel when clicking inside dialog', () => {
    render(<ConfirmDialog {...defaultProps} />);
    const dialog = screen.getByRole('dialog');
    fireEvent.click(dialog);
    expect(defaultProps.onCancel).not.toHaveBeenCalled();
  });

  it('uses default cancelLabel="Cancel" when not provided', () => {
    render(<ConfirmDialog {...defaultProps} />);
    expect(screen.getByTestId('confirm-dialog-cancel')).toHaveTextContent('Cancel');
  });

  it('uses custom cancelLabel when provided', () => {
    render(<ConfirmDialog {...defaultProps} cancelLabel="Keep Task" />);
    expect(screen.getByTestId('confirm-dialog-cancel')).toHaveTextContent('Keep Task');
  });

  it('renders without consequence section when not provided', () => {
    render(<ConfirmDialog {...defaultProps} consequence={undefined} />);
    expect(
      screen.queryByText('Your task will be cancelled and a refund processed within 24h.'),
    ).toBeNull();
  });

  it('has correct ARIA attributes', () => {
    render(<ConfirmDialog {...defaultProps} />);
    const dialog = screen.getByRole('dialog');
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(dialog).toHaveAttribute('aria-labelledby');
    expect(dialog).toHaveAttribute('aria-describedby');
  });

  it('does not cleanup Escape listener after close', () => {
    const { rerender } = render(<ConfirmDialog {...defaultProps} />);
    rerender(<ConfirmDialog {...defaultProps} open={false} />);
    fireEvent.keyDown(document, { key: 'Escape' });
    // After close, Escape no longer fires onCancel
    expect(defaultProps.onCancel).not.toHaveBeenCalled();
  });
});
