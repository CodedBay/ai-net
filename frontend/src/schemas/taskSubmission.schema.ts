import { z } from 'zod';
import type { TFunction } from 'i18next';

/** Agent capability values accepted by the task submission wizard. */
export const AGENT_PREFERENCE_VALUES = ['research', 'risk', 'coding', 'design', 'report'] as const;

/** Prompt ceiling, matching the API contract for task submissions. */
export const TASK_DESCRIPTION_MAX_CHARS = 4000;

export type AgentPreferenceValue = (typeof AGENT_PREFERENCE_VALUES)[number];

const fallbackMessages = {
  promptRequired: 'Task description is required',
  promptTooLong: `Task description must be ${TASK_DESCRIPTION_MAX_CHARS} characters or fewer`,
  agentRequired: 'Select at least one specialist agent to handle your task',
} as const;

/**
 * Build the task submission schema for the wizard.
 *
 * When a translation function is supplied, validation messages are resolved
 * through i18next so they follow the active language. Without one the schema
 * falls back to English copy, which keeps it usable in non-React contexts.
 */
export function makeTaskSubmissionSchema(t?: TFunction) {
  const message = (key: keyof typeof fallbackMessages) => {
    const i18nKey = {
      promptRequired: 'validation.promptRequired',
      promptTooLong: 'validation.promptTooLong',
      agentRequired: 'validation.agentRequired',
    }[key];
    return t ? t(i18nKey) : fallbackMessages[key];
  };

  return z.object({
    description: z
      .string()
      .trim()
      .min(1, message('promptRequired'))
      .max(TASK_DESCRIPTION_MAX_CHARS, message('promptTooLong')),
    agentPreferences: z
      .array(z.enum(AGENT_PREFERENCE_VALUES))
      .min(1, message('agentRequired')),
  });
}

export type TaskSubmissionValues = z.infer<ReturnType<typeof makeTaskSubmissionSchema>>;
