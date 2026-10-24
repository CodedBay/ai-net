import { describe, expect, it, vi } from 'vitest';
import type { TFunction } from 'i18next';
import {
  AGENT_PREFERENCE_VALUES,
  TASK_DESCRIPTION_MAX_CHARS,
  makeTaskSubmissionSchema,
} from './taskSubmission.schema';

const validValues = {
  description: 'Build a market report',
  agentPreferences: ['research' as const],
};

describe('makeTaskSubmissionSchema', () => {
  it('accepts a valid step-1 description and step-2 agent selection', () => {
    const result = makeTaskSubmissionSchema().safeParse(validValues);
    expect(result.success).toBe(true);
  });

  it('trims the description before validating its length', () => {
    const result = makeTaskSubmissionSchema().safeParse({
      ...validValues,
      description: '  Build a market report  ',
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.description).toBe('Build a market report');
    }
  });

  it('rejects an empty or whitespace-only description', () => {
    const schema = makeTaskSubmissionSchema();
    expect(schema.safeParse({ ...validValues, description: '' }).success).toBe(false);
    expect(schema.safeParse({ ...validValues, description: '   ' }).success).toBe(false);
  });

  it(`accepts exactly ${TASK_DESCRIPTION_MAX_CHARS} characters and rejects one more`, () => {
    const schema = makeTaskSubmissionSchema();
    const atLimit = 'a'.repeat(TASK_DESCRIPTION_MAX_CHARS);

    expect(schema.safeParse({ ...validValues, description: atLimit }).success).toBe(true);
    expect(schema.safeParse({ ...validValues, description: `${atLimit}a` }).success).toBe(false);
  });

  it('requires at least one valid agent preference', () => {
    const schema = makeTaskSubmissionSchema();

    expect(schema.safeParse({ ...validValues, agentPreferences: [] }).success).toBe(false);
    expect(
      schema.safeParse({ ...validValues, agentPreferences: ['wizard'] }).success,
    ).toBe(false);
    expect(
      schema.safeParse({ ...validValues, agentPreferences: [...AGENT_PREFERENCE_VALUES] }).success,
    ).toBe(true);
  });

  it('uses translated validation messages when a t function is supplied', () => {
    const t = vi.fn((key: string) => `translated:${key}`) as unknown as TFunction;
    const schema = makeTaskSubmissionSchema(t);

    const missingPrompt = schema.safeParse({ ...validValues, description: '' });
    expect(missingPrompt.success).toBe(false);
    if (!missingPrompt.success) {
      expect(missingPrompt.error.issues[0].message).toBe('translated:validation.promptRequired');
    }

    const tooLong = schema.safeParse({
      ...validValues,
      description: 'a'.repeat(TASK_DESCRIPTION_MAX_CHARS + 1),
    });
    expect(tooLong.success).toBe(false);
    if (!tooLong.success) {
      expect(tooLong.error.issues[0].message).toBe('translated:validation.promptTooLong');
    }

    const noAgents = schema.safeParse({ ...validValues, agentPreferences: [] });
    expect(noAgents.success).toBe(false);
    if (!noAgents.success) {
      expect(noAgents.error.issues[0].message).toBe('translated:validation.agentRequired');
    }
  });
});
