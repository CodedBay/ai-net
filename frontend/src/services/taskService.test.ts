import { afterEach, describe, expect, it, vi } from 'vitest';
import { apiClient } from './api';
import { estimateTaskCost } from './taskService';
import type { TaskEstimate } from '../types/api';

const estimate: TaskEstimate = {
  currency: 'XLM',
  breakdown: [{ agent: 'research', costXLM: 0.5 }],
  subtotalXLM: 0.5,
  platformFeeXLM: 0.025,
  platformFeeRate: 0.05,
  estimatedCostXLM: 0.525,
};

describe('estimateTaskCost', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('requests the estimate with a comma-separated agents query', async () => {
    const get = vi.spyOn(apiClient, 'get').mockResolvedValue(estimate);

    await expect(estimateTaskCost(['research', 'coding'])).resolves.toEqual(estimate);
    expect(get).toHaveBeenCalledWith(
      '/api/tasks/estimate?agents=research%2Ccoding',
      undefined,
    );
  });

  it('passes an abort signal through to the API client', async () => {
    const get = vi.spyOn(apiClient, 'get').mockResolvedValue(estimate);
    const controller = new AbortController();

    await estimateTaskCost(['design'], controller.signal);

    expect(get).toHaveBeenCalledWith('/api/tasks/estimate?agents=design', {
      signal: controller.signal,
    });
  });

  it('unwraps the v2 data envelope', async () => {
    vi.spyOn(apiClient, 'get').mockResolvedValue({ data: estimate });

    await expect(estimateTaskCost(['risk'])).resolves.toEqual(estimate);
  });
});
