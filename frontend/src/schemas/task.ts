import { z } from 'zod';

export const taskSchema = z.object({
  prompt: z
    .string()
    .trim()
    .min(1, 'Task description is required — describe what you want the agent network to do.')
    .min(20, 'Task description must be at least 20 characters — describe your goal in detail.')
    .max(2000, 'Task description must be 2000 characters or fewer — shorten your description.'),
  maxBudgetXLM: z
    .preprocess((value) => {
      if (typeof value === 'string') {
        return Number(value);
      }
      return value;
    }, z.number().min(0.1, 'Minimum budget is 0.1 XLM — enter a higher amount.')),
  agentPreferences: z
    .array(z.enum(['research', 'risk', 'coding', 'design', 'report']))
    .min(1, 'Select at least one specialist agent to handle your task.'),
});

export type TaskFormValues = z.infer<typeof taskSchema>;
