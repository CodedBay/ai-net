import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TaskSubmissionWizard } from './TaskSubmissionWizard';
import type { TaskEstimate } from '../../types/api';

const { mockEstimateTaskCost, mockSubmitTask } = vi.hoisted(() => ({
  mockEstimateTaskCost: vi.fn(),
  mockSubmitTask: vi.fn(),
}));

vi.mock('../../services/taskService', () => ({
  estimateTaskCost: mockEstimateTaskCost,
}));

vi.mock('../../hooks/useTaskSubmit', () => ({
  useTaskSubmit: () => ({
    submitTask: mockSubmitTask,
    status: 'idle',
    error: null,
    data: null,
  }),
}));

vi.mock('../../context/ToastContext', () => ({
  ToastProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  useToast: () => ({ showToast: vi.fn() }),
}));

vi.mock('../../context/WalletContext', () => ({
  useWallet: () => ({ publicKey: 'GTESTWALLET' }),
}));

vi.mock('../../hooks/useWalletBalance', () => ({
  useWalletBalance: () => ({ balance: '100', balances: [], loading: false, error: null }),
}));

vi.mock('framer-motion', () => ({
  motion: {
    div: ({ children, ...props }: React.HTMLAttributes<HTMLDivElement>) => (
      <div {...props}>{children}</div>
    ),
  },
}));

const serverEstimate: TaskEstimate = {
  currency: 'XLM',
  breakdown: [
    { agent: 'research', costXLM: 2 },
    { agent: 'coding', costXLM: 3 },
  ],
  subtotalXLM: 5,
  platformFeeXLM: 0.25,
  platformFeeRate: 0.05,
  estimatedCostXLM: 5.25,
};

function renderWizard() {
  return render(
    <MemoryRouter initialEntries={['/tasks/new']}>
      <TaskSubmissionWizard />
    </MemoryRouter>,
  );
}

async function goToReview() {
  fireEvent.change(screen.getByLabelText('Task prompt'), {
    target: { value: 'Build a report' },
  });
  fireEvent.click(screen.getByRole('button', { name: /^Next/ }));
  await screen.findByRole('heading', { name: 'Choose agents & capabilities' });

  fireEvent.click(screen.getByLabelText(/Research Agent/));
  fireEvent.click(screen.getByLabelText(/Coding Agent/));
  fireEvent.click(screen.getByRole('button', { name: /^Next/ }));
  await screen.findByRole('heading', { name: 'Review budget & DAG' });
}

describe('TaskSubmissionWizard estimate integration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.localStorage.clear();
    window.sessionStorage.clear();
    mockSubmitTask.mockReset();
  });

  it('uses the server estimate breakdown on the review step', async () => {
    mockEstimateTaskCost.mockResolvedValue(serverEstimate);

    renderWizard();
    await goToReview();

    await waitFor(() =>
      expect(screen.getByTestId('cost-research')).toHaveTextContent('2.00 XLM'),
    );
    expect(screen.getByTestId('cost-coding')).toHaveTextContent('3.00 XLM');
    expect(screen.getByTestId('summary-total-cost')).toHaveTextContent('5.25 XLM');
    expect(mockEstimateTaskCost).toHaveBeenLastCalledWith(
      ['research', 'coding'],
      expect.anything(),
    );
  });

  it('falls back to local constants when the estimate request fails', async () => {
    mockEstimateTaskCost.mockRejectedValue(new Error('estimate unavailable'));

    renderWizard();
    await goToReview();

    await waitFor(() => expect(mockEstimateTaskCost).toHaveBeenCalled());
    await waitFor(() =>
      expect(screen.queryByTestId('estimate-loading')).not.toBeInTheDocument(),
    );

    expect(screen.getByTestId('cost-research')).toHaveTextContent('0.50 XLM');
    expect(screen.getByTestId('cost-coding')).toHaveTextContent('0.80 XLM');
    expect(screen.getByTestId('summary-total-cost')).toHaveTextContent('1.36 XLM');
    expect(screen.getByRole('button', { name: 'Submit task' })).toBeEnabled();
  });

  it('shows a loading hint and blocks submit while the estimate could change totals', async () => {
    mockEstimateTaskCost.mockImplementation(() => new Promise(() => {}));

    renderWizard();
    await goToReview();

    expect(await screen.findByTestId('estimate-loading')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Submit task' })).toBeDisabled();
  });
});
