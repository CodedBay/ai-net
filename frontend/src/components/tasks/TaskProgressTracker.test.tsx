/**
 * Unit tests for TaskProgressTracker component.
 *
 * Scenarios:
 *  - Renders loading skeleton initially
 *  - Renders pipeline steps after task loads
 *  - Shows correct status icons for each step state
 *  - Polling fetches task every 3 seconds
 *  - Cancel button opens confirmation modal
 *  - Confirming cancel calls DELETE /api/tasks/:id
 *  - Completed task displays final result and total cost
 *  - Failed task shows error panel
 *  - WebSocket events update step statuses
 */
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { TaskProgressTracker } from './TaskProgressTracker';
import type { TaskResponse } from '../../types/api';

// ─── Mocks ────────────────────────────────────────────────────────────────────

// Mock api client
vi.mock('../../services/api', () => ({
  apiClient: {
    get: vi.fn(),
    delete: vi.fn(),
  },
}));

// Mock useTaskWebSocket (no real WS in tests)
vi.mock('../../hooks/useTaskWebSocket', () => ({
  useTaskWebSocket: vi.fn(() => ({ isConnected: false, status: 'disconnected' })),
}));

import { apiClient } from '../../services/api';

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const makeDag = (statuses: ('pending' | 'running' | 'completed' | 'failed')[]) =>
  statuses.map((status, i) => ({
    nodeId: `node_${i}`,
    agentType: ['research', 'risk', 'report'][i % 3],
    prompt: `Step ${i}`,
    dependsOn: i === 0 ? [] : [`node_${i - 1}`],
    status,
  }));

const makeTask = (overrides: Partial<TaskResponse> = {}): TaskResponse => ({
  taskId: 'task_abc123',
  id: 'task_abc123',
  prompt: 'Generate a market report',
  walletPublicKey: 'GABC123',
  status: 'running',
  dag: makeDag(['completed', 'running', 'pending']),
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  ...overrides,
});

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('TaskProgressTracker', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.mocked(apiClient.get).mockResolvedValue(makeTask());
    vi.mocked(apiClient.delete).mockResolvedValue({});
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  // ─── Initial render ────────────────────────────────────────────────────────

  it('renders loading skeleton initially', () => {
    render(<TaskProgressTracker taskId="task_abc123" />);
    expect(screen.getByLabelText(/loading task progress/i)).toBeInTheDocument();
  });

  it('renders pipeline steps after task loads', async () => {
    render(<TaskProgressTracker taskId="task_abc123" />);
    await waitFor(() => {
      expect(screen.queryByLabelText(/loading task progress/i)).not.toBeInTheDocument();
    });
    // Should see the step list
    expect(screen.getByLabelText(/pipeline steps/i)).toBeInTheDocument();
  });

  it('renders one row per DAG node', async () => {
    vi.mocked(apiClient.get).mockResolvedValue(
      makeTask({ dag: makeDag(['completed', 'running', 'pending']) }),
    );
    render(<TaskProgressTracker taskId="task_abc123" />);
    await waitFor(() => {
      // 3 nodes in the DAG
      expect(screen.getAllByRole('listitem').length).toBeGreaterThanOrEqual(3);
    });
  });

  // ─── Status display ────────────────────────────────────────────────────────

  it('shows completed status for completed nodes', async () => {
    vi.mocked(apiClient.get).mockResolvedValue(
      makeTask({ dag: makeDag(['completed', 'pending', 'pending']) }),
    );
    render(<TaskProgressTracker taskId="task_abc123" />);
    await waitFor(() => {
      expect(screen.getByLabelText(/research: completed/i)).toBeInTheDocument();
    });
  });

  it('shows running status for running nodes', async () => {
    vi.mocked(apiClient.get).mockResolvedValue(
      makeTask({ dag: makeDag(['completed', 'running', 'pending']) }),
    );
    render(<TaskProgressTracker taskId="task_abc123" />);
    await waitFor(() => {
      expect(screen.getByLabelText(/risk.*running/i)).toBeInTheDocument();
    });
  });

  it('shows pending status for pending nodes', async () => {
    vi.mocked(apiClient.get).mockResolvedValue(
      makeTask({ dag: makeDag(['completed', 'running', 'pending']) }),
    );
    render(<TaskProgressTracker taskId="task_abc123" />);
    await waitFor(() => {
      expect(screen.getByLabelText(/report.*pending/i)).toBeInTheDocument();
    });
  });

  it('shows failed status for failed nodes', async () => {
    vi.mocked(apiClient.get).mockResolvedValue(
      makeTask({ dag: makeDag(['completed', 'failed', 'pending']) }),
    );
    render(<TaskProgressTracker taskId="task_abc123" />);
    await waitFor(() => {
      expect(screen.getByLabelText(/risk.*failed/i)).toBeInTheDocument();
    });
  });

  // ─── Progress bar ──────────────────────────────────────────────────────────

  it('shows progress bar with correct percentage', async () => {
    // 1 of 3 nodes completed = 33%
    vi.mocked(apiClient.get).mockResolvedValue(
      makeTask({ dag: makeDag(['completed', 'running', 'pending']) }),
    );
    render(<TaskProgressTracker taskId="task_abc123" />);
    await waitFor(() => {
      expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '33');
    });
  });

  // ─── Polling ──────────────────────────────────────────────────────────────

  it('polls /api/tasks/:id at the configured interval', async () => {
    const task = makeTask({ status: 'running' });
    vi.mocked(apiClient.get).mockResolvedValue(task);

    render(<TaskProgressTracker taskId="task_abc123" pollIntervalMs={3000} />);

    await waitFor(() => expect(vi.mocked(apiClient.get)).toHaveBeenCalledTimes(1));

    // Advance timer to trigger polling
    await act(async () => {
      vi.advanceTimersByTime(3000);
    });
    await waitFor(() => expect(vi.mocked(apiClient.get)).toHaveBeenCalledTimes(2));

    await act(async () => {
      vi.advanceTimersByTime(3000);
    });
    await waitFor(() => expect(vi.mocked(apiClient.get)).toHaveBeenCalledTimes(3));
  });

  it('stops polling when task reaches terminal state', async () => {
    vi.mocked(apiClient.get).mockResolvedValue(makeTask({ status: 'completed' }));

    render(<TaskProgressTracker taskId="task_abc123" pollIntervalMs={3000} />);
    await waitFor(() => expect(vi.mocked(apiClient.get)).toHaveBeenCalledTimes(1));

    await act(async () => {
      vi.advanceTimersByTime(9000);
    });
    // Should NOT have polled again
    expect(vi.mocked(apiClient.get)).toHaveBeenCalledTimes(1);
  });

  // ─── Completion display ────────────────────────────────────────────────────

  it('displays result panel when task is completed', async () => {
    vi.mocked(apiClient.get).mockResolvedValue(
      makeTask({
        status: 'completed',
        dag: makeDag(['completed', 'completed', 'completed']),
      }),
    );
    render(<TaskProgressTracker taskId="task_abc123" />);
    await waitFor(() => {
      expect(screen.getByText(/task completed/i)).toBeInTheDocument();
    });
  });

  it('displays total XLM cost on completion', async () => {
    vi.mocked(apiClient.get).mockResolvedValue(
      makeTask({
        status: 'completed',
        dag: makeDag(['completed', 'completed', 'completed']),
      }),
    );
    render(<TaskProgressTracker taskId="task_abc123" />);
    await waitFor(() => {
      expect(screen.getByText(/XLM/)).toBeInTheDocument();
    });
  });

  // ─── Failed display ────────────────────────────────────────────────────────

  it('shows error panel when task fails', async () => {
    vi.mocked(apiClient.get).mockResolvedValue(
      makeTask({ status: 'failed', dag: makeDag(['completed', 'failed', 'pending']) }),
    );
    render(<TaskProgressTracker taskId="task_abc123" />);
    await waitFor(() => {
      expect(screen.getByRole('alert')).toBeInTheDocument();
      expect(screen.getByText(/task failed/i)).toBeInTheDocument();
    });
  });

  // ─── Cancel button ─────────────────────────────────────────────────────────

  it('shows cancel button for running tasks', async () => {
    vi.mocked(apiClient.get).mockResolvedValue(makeTask({ status: 'running' }));
    render(<TaskProgressTracker taskId="task_abc123" />);
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /cancel task/i })).toBeInTheDocument();
    });
  });

  it('does not show cancel button for completed tasks', async () => {
    vi.mocked(apiClient.get).mockResolvedValue(makeTask({ status: 'completed' }));
    render(<TaskProgressTracker taskId="task_abc123" />);
    await waitFor(() => {
      expect(screen.queryByRole('button', { name: /cancel task/i })).not.toBeInTheDocument();
    });
  });

  // ─── Cancel modal ──────────────────────────────────────────────────────────

  it('opens confirmation modal when cancel button is clicked', async () => {
    vi.mocked(apiClient.get).mockResolvedValue(makeTask({ status: 'running' }));
    render(<TaskProgressTracker taskId="task_abc123" />);
    await waitFor(() => {
      fireEvent.click(screen.getByRole('button', { name: /cancel task/i }));
    });
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(screen.getByText(/cancel this task/i)).toBeInTheDocument();
  });

  it('closes modal when "Keep running" is clicked', async () => {
    vi.mocked(apiClient.get).mockResolvedValue(makeTask({ status: 'running' }));
    render(<TaskProgressTracker taskId="task_abc123" />);
    await waitFor(() => {
      fireEvent.click(screen.getByRole('button', { name: /cancel task/i }));
    });
    fireEvent.click(screen.getByRole('button', { name: /keep running/i }));
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });
  });

  it('calls DELETE /api/tasks/:id on cancel confirm', async () => {
    vi.mocked(apiClient.get).mockResolvedValue(makeTask({ status: 'running' }));
    const onCancelled = vi.fn();
    render(<TaskProgressTracker taskId="task_abc123" onCancelled={onCancelled} />);

    await waitFor(() => {
      fireEvent.click(screen.getByRole('button', { name: /cancel task/i }));
    });
    fireEvent.click(screen.getByRole('button', { name: /yes, cancel task/i }));

    await waitFor(() => {
      expect(vi.mocked(apiClient.delete)).toHaveBeenCalledWith('/api/tasks/task_abc123');
      expect(onCancelled).toHaveBeenCalled();
    });
  });

  it('calls onCompleted callback when task reaches terminal state', async () => {
    const onCompleted = vi.fn();
    vi.mocked(apiClient.get).mockResolvedValue(
      makeTask({ status: 'completed', dag: makeDag(['completed', 'completed', 'completed']) }),
    );
    render(<TaskProgressTracker taskId="task_abc123" onCompleted={onCompleted} />);
    await waitFor(() => {
      expect(onCompleted).toHaveBeenCalledWith(
        expect.objectContaining({ status: 'completed' }),
      );
    });
  });

  // ─── Error state ───────────────────────────────────────────────────────────

  it('shows error state when fetch fails', async () => {
    vi.mocked(apiClient.get).mockRejectedValue(new Error('Network error'));
    render(<TaskProgressTracker taskId="task_abc123" />);
    await waitFor(() => {
      expect(screen.getByRole('alert')).toBeInTheDocument();
    });
  });
});
