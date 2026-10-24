import { useEffect, useMemo, useRef, useState } from 'react';
import { useForm, Controller, useWatch } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { AlertCircle, CheckCircle2 } from 'lucide-react';
import { useTaskSubmit } from '../../hooks/useTaskSubmit';
import { useToast } from '../../context/ToastContext';
import { useTaskDraft } from '../../hooks/useTaskDraft';
import { useWalletBalance } from '../../hooks/useWalletBalance';
import { useWallet } from '../../context/WalletContext';
import { WizardProgress } from '../wallet/WizardProgress';
import { WizardStep } from '../wallet/WizardStep';
import { ConfirmDialog } from '../common/ConfirmDialog';
import styles from '../agents/TaskWizard.module.css';
import formStyles from '../agents/TaskSubmissionForm.module.css';
import { estimateTaskCost, type AgentPreference, type TaskEstimate } from '../../services/taskService';
import { addPendingTask } from '../../services/optimisticTasks';
import {
  AGENT_PREFERENCE_VALUES,
  TASK_DESCRIPTION_MAX_CHARS,
  makeTaskSubmissionSchema,
  type TaskSubmissionValues,
} from '../../schemas/taskSubmission.schema';
import type { DAGNode, TaskSubmitResponse } from '../../types/api';

// ── Constants ─────────────────────────────────────────────────────────────────

/**
 * Per-agent cost estimates in XLM. These are illustrative estimates used to
 * show a cost breakdown on the review step before submission.
 */
const AGENT_COST_ESTIMATES: Record<AgentPreference, number> = {
  research: 0.5,
  risk: 0.4,
  coding: 0.8,
  design: 0.6,
  report: 0.3,
};

/** Platform fee as a fraction of total agent costs. */
const PLATFORM_FEE_RATE = 0.05;

const TOTAL_STEPS = 3;

/** Debounce before asking the server for a fresh estimate. */
const ESTIMATE_DEBOUNCE_MS = 250;

type TaskFormValues = TaskSubmissionValues;

// ── Cost helpers ──────────────────────────────────────────────────────────────

function computeCostBreakdown(agents: AgentPreference[]) {
  const agentCosts = agents.map((agent) => ({
    agent,
    cost: AGENT_COST_ESTIMATES[agent],
  }));
  const subtotal = agentCosts.reduce((sum, { cost }) => sum + cost, 0);
  const platformFee = subtotal * PLATFORM_FEE_RATE;
  const total = subtotal + platformFee;
  return { agentCosts, subtotal, platformFee, total };
}

function breakdownFromEstimate(estimate: TaskEstimate) {
  return {
    agentCosts: estimate.breakdown.map(({ agent, costXLM }) => ({
      agent,
      cost: costXLM,
    })),
    subtotal: estimate.subtotalXLM,
    platformFee: estimate.platformFeeXLM,
    total: estimate.estimatedCostXLM,
  };
}

/**
 * Convert a submit response's DAG preview into history-card nodes. The v1/v2
 * handlers return `{ nodes, edges }`; older payloads returned a bare array.
 */
function dagFromSubmitResponse(response: TaskSubmitResponse): DAGNode[] {
  const preview = response.dagPreview as unknown;
  const rawNodes = Array.isArray(preview)
    ? preview
    : Array.isArray((preview as { nodes?: unknown })?.nodes)
    ? ((preview as { nodes: unknown[] }).nodes)
    : [];

  return rawNodes.map((raw) => {
    const node = raw as Record<string, unknown>;
    return {
      nodeId: String(node.nodeId ?? node.id ?? ''),
      agentType: String(node.agentType ?? node.label ?? ''),
      prompt: typeof node.prompt === 'string' ? node.prompt : '',
      dependsOn: Array.isArray(node.dependsOn) ? (node.dependsOn as string[]) : [],
      status: 'pending' as const,
    };
  });
}

// ── Component ─────────────────────────────────────────────────────────────────

export function TaskSubmissionWizard() {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const { showToast } = useToast();
  const { load, save, clear } = useTaskDraft();
  const { submitTask, status, error } = useTaskSubmit();
  const pendingNav = useRef<number | null>(null);
  const { publicKey } = useWallet();
  const { balance } = useWalletBalance(publicKey);
  const [showInsufficientBalanceConfirm, setShowInsufficientBalanceConfirm] = useState(false);
  const [pendingSubmitValues, setPendingSubmitValues] = useState<TaskFormValues | null>(null);
  const [estimateState, setEstimateState] = useState<{
    agentsKey: string;
    estimate: TaskEstimate;
  } | null>(null);
  const [estimateLoading, setEstimateLoading] = useState(false);

  const initialDraft = useMemo(() => load(), [load]);
  const [currentStep, setCurrentStep] = useState<number>(initialDraft?.currentStep ?? 1);

  const agentOptions = useMemo(
    () =>
      AGENT_PREFERENCE_VALUES.map((value) => ({
        value,
        label: t(`task.submit.pref.${value}`),
        description: t(`task.submit.pref.${value}.description`, { defaultValue: '' }),
        estimatedCost: AGENT_COST_ESTIMATES[value],
        recommended: ['research', 'report'].includes(value),
      })),
    [t],
  );

  const taskSchema = useMemo(() => makeTaskSubmissionSchema(t), [t]);

  const {
    register,
    handleSubmit,
    control,
    trigger,
    formState: { errors, isSubmitting, isSubmitted },
  } = useForm<TaskFormValues>({
    mode: 'onChange',
    resolver: zodResolver(taskSchema),
    defaultValues: {
      description: initialDraft?.prompt ?? '',
      agentPreferences: (initialDraft?.agentPreferences ?? []) as AgentPreference[],
    },
  });

  const watchedValues = useWatch({ control });
  const descriptionValue = watchedValues.description ?? '';
  const charCount = descriptionValue.length;
  const charCountExceeded = charCount > TASK_DESCRIPTION_MAX_CHARS;
  const charCountWarning =
    charCount > TASK_DESCRIPTION_MAX_CHARS * 0.9 && !charCountExceeded;

  const watchedPreferences = (useWatch({ control, name: 'agentPreferences' }) ??
    []) as AgentPreference[];
  const selectedAgentsKey = watchedPreferences.join(',');
  const selectedPreferences = useMemo(
    () => (selectedAgentsKey ? (selectedAgentsKey.split(',') as AgentPreference[]) : []),
    [selectedAgentsKey],
  );

  const localCostBreakdown = useMemo(
    () => computeCostBreakdown(selectedPreferences),
    [selectedPreferences],
  );

  const activeEstimate =
    estimateState?.agentsKey === selectedAgentsKey ? estimateState.estimate : null;

  const costBreakdown = useMemo(
    () => (activeEstimate ? breakdownFromEstimate(activeEstimate) : localCostBreakdown),
    [activeEstimate, localCostBreakdown],
  );

  // ── Server estimate ────────────────────────────────────────────────────────
  useEffect(() => {
    if (selectedPreferences.length === 0) {
      setEstimateState(null);
      setEstimateLoading(false);
      return;
    }

    const controller = new AbortController();
    let cancelled = false;

    setEstimateState((prev) =>
      prev?.agentsKey === selectedAgentsKey ? prev : null,
    );
    setEstimateLoading(true);

    const timer = window.setTimeout(() => {
      estimateTaskCost(selectedPreferences, controller.signal)
        .then((estimate) => {
          if (cancelled) return;
          setEstimateState({ agentsKey: selectedAgentsKey, estimate });
        })
        .catch((error: unknown) => {
          if (cancelled) return;
          if ((error as Error)?.name === 'AbortError') return;
          // Fall back to the local constants.
          setEstimateState(null);
        })
        .finally(() => {
          if (!cancelled) setEstimateLoading(false);
        });
    }, ESTIMATE_DEBOUNCE_MS);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [selectedAgentsKey, selectedPreferences]);

  // ── Draft persistence ──────────────────────────────────────────────────────
  useEffect(() => {
    save({
      prompt: descriptionValue,
      maxBudgetXLM: costBreakdown.total,
      agentPreferences: selectedPreferences,
      currentStep,
    });
  }, [descriptionValue, selectedPreferences, currentStep, save, costBreakdown.total]);

  // ── i18n re-validation ─────────────────────────────────────────────────────
  const language = i18n.language;
  const lastLanguage = useRef(language);
  useEffect(() => {
    if (lastLanguage.current === language) return;
    lastLanguage.current = language;
    if (isSubmitted) void trigger();
  }, [language, isSubmitted, trigger]);

  useEffect(() => {
    return () => {
      if (pendingNav.current) window.clearTimeout(pendingNav.current);
    };
  }, []);

  // ── Navigation ─────────────────────────────────────────────────────────────

  const validateCurrentStep = async (): Promise<boolean> => {
    switch (currentStep) {
      case 1:
        return trigger('description');
      case 2:
        return trigger('agentPreferences');
      default:
        return true;
    }
  };

  const goNext = async () => {
    const valid = await validateCurrentStep();
    if (valid) {
      setCurrentStep((step) => Math.min(step + 1, TOTAL_STEPS));
    }
  };

  const goBack = () => {
    setCurrentStep((step) => Math.max(step - 1, 1));
  };

  // ── Submit ─────────────────────────────────────────────────────────────────

  const doSubmit = async (values: TaskFormValues) => {
    try {
      const result = await submitTask({
        prompt: values.description,
        maxBudgetXLM: costBreakdown.total,
        agentPreferences: values.agentPreferences,
      });
      clear();

      const now = new Date().toISOString();
      addPendingTask({
        taskId: result.taskId,
        prompt: values.description,
        walletPublicKey: publicKey ?? 'anonymous',
        status: 'queued',
        dag: dagFromSubmitResponse(result),
        createdAt: now,
        updatedAt: now,
      });

      const timer = window.setTimeout(() => {
        navigate(`/tasks/${result.taskId}`);
      }, 300);
      pendingNav.current = timer;

      showToast(t('task.submit.success'), 'success', {
        duration: 6000,
        action: {
          label: t('common.undo') || 'Undo',
          onClick: () => {
            if (pendingNav.current) {
              window.clearTimeout(pendingNav.current);
              pendingNav.current = null;
            }
            showToast('Task creation undone', 'info', 3000);
          },
        },
      });
    } catch (submitError) {
      const message =
        submitError instanceof Error ? submitError.message : t('task.submit.unableToSubmit');
      const isNetworkError =
        message.toLowerCase().includes('network') || message.toLowerCase().includes('fetch');
      showToast(message, 'error', {
        duration: isNetworkError ? 8000 : 6000,
        ...(isNetworkError
          ? {
              action: {
                label: t('common.retry') || 'Retry',
                onClick: () => {
                  void handleSubmit(onSubmit)();
                },
              },
            }
          : {}),
      });
    }
  };

  const onSubmit = async (values: TaskFormValues) => {
    const walletBalance = parseFloat(balance ?? '0');
    const hasInsufficientBalance = walletBalance < costBreakdown.total;

    if (hasInsufficientBalance) {
      setPendingSubmitValues(values);
      setShowInsufficientBalanceConfirm(true);
      return;
    }

    await doSubmit(values);
  };

  const isLoading = status === 'loading' || isSubmitting;

  // ── Step titles ────────────────────────────────────────────────────────────
  const stepTitles = useMemo(
    () => ({
      description: t('task.wizard.step.goal', { defaultValue: 'Task Description' }),
      agents: t('task.wizard.step.agents', { defaultValue: 'Select Agents' }),
      review: t('task.wizard.step.review', { defaultValue: 'Review & Confirm' }),
    }),
    [t],
  );

  // ── Agent checkbox renderer ────────────────────────────────────────────────
  const renderAgentCheckboxes = (field: {
    value: AgentPreference[];
    onChange: (next: AgentPreference[]) => void;
    onBlur: () => void;
    name: string;
  }) => (
    <div
      role="group"
      aria-labelledby="agentPreferences-label"
      aria-describedby="agentPreferences-error"
      aria-invalid={Boolean(errors.agentPreferences)}
      className={formStyles.agentGrid}
    >
      {agentOptions.map((option) => {
        const isChecked = field.value.includes(option.value as AgentPreference);
        return (
          <label
            key={option.value}
            htmlFor={`pref-${option.value}`}
            className={`${formStyles.agentOption} ${isChecked ? formStyles.agentOptionSelected : ''}`}
          >
            <div className={formStyles.agentOptionHeader}>
              <input
                id={`pref-${option.value}`}
                type="checkbox"
                value={option.value}
                checked={isChecked}
                onChange={(event) => {
                  const current = field.value;
                  const next = event.target.checked
                    ? ([...current, option.value] as AgentPreference[])
                    : current.filter((v: AgentPreference) => v !== option.value);
                  field.onChange(next);
                }}
                onBlur={field.onBlur}
                name={field.name}
                className={formStyles.checkbox}
              />
              <span className={formStyles.agentName}>{option.label}</span>
              {option.recommended && (
                <span className={formStyles.recommendedBadge} aria-label="Recommended">
                  {t('common.recommended', { defaultValue: 'Recommended' })}
                </span>
              )}
            </div>
            <div className={formStyles.agentCost}>
              ~{option.estimatedCost.toFixed(2)} XLM
            </div>
          </label>
        );
      })}
    </div>
  );

  return (
    <main className={styles.wizardWrapper}>
      <h1 className={styles.title}>{t('task.submit.title', { defaultValue: 'Submit a Task' })}</h1>

      <div className={styles.progressHeader}>
        <WizardProgress currentStep={currentStep} totalSteps={TOTAL_STEPS} />
      </div>

      {/* ── Step 1: Task Description ─────────────────────────────────────── */}
      <WizardStep isActive={currentStep === 1}>
        <h2 className={styles.stepTitle}>{stepTitles.description}</h2>

        <div className={styles.field}>
          <label htmlFor="description" className={styles.label}>
            {t('task.submit.promptLabel', { defaultValue: 'Describe your task' })}
          </label>
          <textarea
            id="description"
            {...register('description')}
            rows={8}
            maxLength={TASK_DESCRIPTION_MAX_CHARS}
            className={`${styles.textarea} ${errors.description ? formStyles.inputError : ''}`}
            aria-invalid={Boolean(errors.description)}
            aria-describedby="description-error description-counter"
            placeholder={t('task.submit.promptPlaceholder', {
              defaultValue:
                'Describe what you want the agent network to do. Be specific about your goal, any constraints, and the expected output format.',
            })}
          />
          <div className={formStyles.charCounterRow}>
            <p
              id="description-error"
              className={styles.errorText}
              data-testid="description-error"
              role="alert"
              aria-live="polite"
            >
              {errors.description?.message}
            </p>
            <span
              id="description-counter"
              className={`${formStyles.charCounter} ${
                charCountExceeded
                  ? formStyles.charCounterExceeded
                  : charCountWarning
                  ? formStyles.charCounterWarning
                  : ''
              }`}
              aria-live="polite"
              aria-atomic="true"
            >
              {charCount}/{TASK_DESCRIPTION_MAX_CHARS}
            </span>
          </div>
        </div>

        <div className={styles.buttonGroup}>
          <span />
          <button
            type="button"
            className={styles.nextButton}
            onClick={() => void goNext()}
            disabled={charCountExceeded}
          >
            {t('task.wizard.next', { defaultValue: 'Next' })} →
          </button>
        </div>
      </WizardStep>

      {/* ── Step 2: Agent Selection ──────────────────────────────────────── */}
      <WizardStep isActive={currentStep === 2}>
        <h2 className={styles.stepTitle}>{stepTitles.agents}</h2>
        <p className={formStyles.stepDescription}>
          {t('task.submit.agentsHint', {
            defaultValue:
              'Select the specialist agents to handle your task. Recommended agents are pre-selected for most tasks.',
          })}
        </p>

        <div className={styles.field}>
          <span id="agentPreferences-label" className={styles.label}>
            {t('task.submit.preferencesLabel', { defaultValue: 'Agent Selection' })}
          </span>
          <Controller
            control={control}
            name="agentPreferences"
            render={({ field }) => renderAgentCheckboxes(field)}
          />
          <div
            aria-live="polite"
            id="agentPreferences-error"
            data-testid="agents-error"
            role="alert"
          >
            {errors.agentPreferences && (
              <p className={styles.agentError ?? formStyles.fieldError}>
                <AlertCircle size={16} aria-hidden="true" />
                {errors.agentPreferences.message}
              </p>
            )}
          </div>
        </div>

        <div className={styles.buttonGroup}>
          <button type="button" className={styles.backButton} onClick={goBack}>
            ← {t('task.wizard.back', { defaultValue: 'Back' })}
          </button>
          <button type="button" className={styles.nextButton} onClick={() => void goNext()}>
            {t('task.wizard.next', { defaultValue: 'Next' })} →
          </button>
        </div>
      </WizardStep>

      {/* ── Step 3: Review & Confirm ─────────────────────────────────────── */}
      <WizardStep isActive={currentStep === 3}>
        <h2 className={styles.stepTitle}>{stepTitles.review}</h2>

        <form onSubmit={handleSubmit(onSubmit)} noValidate id="task-form">
          {/* Task description summary */}
          <section className={formStyles.reviewSection}>
            <h3 className={formStyles.reviewSectionTitle}>
              {t('task.wizard.step.goal', { defaultValue: 'Task Description' })}
            </h3>
            <p className={formStyles.reviewDescription} data-testid="summary-description">
              {descriptionValue ||
                t('task.wizard.summary.noPrompt', { defaultValue: '(No description provided)' })}
            </p>
          </section>

          {/* Cost estimate breakdown */}
          <section
            className={formStyles.reviewSection}
            aria-label="Cost estimate breakdown"
            aria-busy={estimateLoading}
          >
            <h3 className={formStyles.reviewSectionTitle}>
              {t('task.submit.costBreakdown', { defaultValue: 'Estimated Cost Breakdown' })}
            </h3>

            {estimateLoading && (
              <p
                className={formStyles.estimateLoading}
                data-testid="estimate-loading"
                role="status"
              >
                {t('task.submit.estimateLoading', {
                  defaultValue: 'Updating cost estimate…',
                })}
              </p>
            )}

            {costBreakdown.agentCosts.length === 0 ? (
              <p className={formStyles.noAgentsNote}>
                {t('task.wizard.summary.noAgents', { defaultValue: 'No agents selected' })}
              </p>
            ) : (
              <div className={formStyles.costTable}>
                {costBreakdown.agentCosts.map(({ agent, cost }) => (
                  <div key={agent} className={formStyles.costRow}>
                    <div className={formStyles.costLabel}>
                      <CheckCircle2 size={14} className={formStyles.costIcon} aria-hidden="true" />
                      <span>{t(`task.submit.pref.${agent}`, { defaultValue: agent })}</span>
                      <span className={formStyles.costAgentLabel}>
                        {t('task.submit.agentLabel', { defaultValue: 'Agent' })}
                      </span>
                    </div>
                    <span className={formStyles.costValue} data-testid={`cost-${agent}`}>
                      {cost.toFixed(2)} XLM
                    </span>
                  </div>
                ))}

                <div className={`${formStyles.costRow} ${formStyles.costRowSubtotal}`}>
                  <span className={formStyles.costLabel}>
                    {t('task.submit.subtotal', { defaultValue: 'Subtotal' })}
                  </span>
                  <span className={formStyles.costValue}>
                    {costBreakdown.subtotal.toFixed(2)} XLM
                  </span>
                </div>

                <div className={`${formStyles.costRow} ${formStyles.costRowFee}`}>
                  <span className={formStyles.costLabel}>
                    {t('task.submit.platformFee', {
                      defaultValue: `Platform fee (${(PLATFORM_FEE_RATE * 100).toFixed(0)}%)`,
                    })}
                  </span>
                  <span className={formStyles.costValue}>
                    {costBreakdown.platformFee.toFixed(2)} XLM
                  </span>
                </div>

                <div className={`${formStyles.costRow} ${formStyles.costRowTotal}`}>
                  <span className={formStyles.costLabelTotal}>
                    {t('task.submit.totalCost', { defaultValue: 'Estimated Total' })}
                  </span>
                  <span
                    className={formStyles.costValueTotal}
                    data-testid="summary-total-cost"
                  >
                    {costBreakdown.total.toFixed(2)} XLM
                  </span>
                </div>
              </div>
            )}

            <p className={formStyles.costDisclaimer}>
              {t('task.submit.costDisclaimer', {
                defaultValue:
                  'Cost estimates are approximate. Actual charges may vary based on task complexity.',
              })}
            </p>
          </section>

          <div className={styles.buttonGroup}>
            <button type="button" className={styles.backButton} onClick={goBack}>
              ← {t('task.wizard.back', { defaultValue: 'Back' })}
            </button>
            <button
              type="submit"
              id="btn-submit-task"
              className={styles.submitButton}
              disabled={
                isLoading ||
                costBreakdown.agentCosts.length === 0 ||
                (estimateLoading && !activeEstimate)
              }
            >
              {isLoading
                ? t('task.submit.submitting', { defaultValue: 'Submitting…' })
                : t('task.submit.submit', { defaultValue: 'Confirm & Submit' })}
            </button>
          </div>
        </form>

        {status === 'success' && (
          <span className={styles.successText}>
            {t('task.submit.success', { defaultValue: 'Task submitted successfully!' })}
          </span>
        )}
      </WizardStep>

      {error && (
        <div role="alert" className={styles.errorBanner}>
          {error}
        </div>
      )}

      <ConfirmDialog
        open={showInsufficientBalanceConfirm}
        title={t('task.submit.insufficientBalance.title', { defaultValue: 'Insufficient Balance Warning' })}
        description={t('task.submit.insufficientBalance.description', {
          total: costBreakdown.total.toFixed(2),
          balance: parseFloat(balance ?? '0').toFixed(2),
          defaultValue: `Your estimated task cost is ${costBreakdown.total.toFixed(2)} XLM but your wallet balance is ${parseFloat(balance ?? '0').toFixed(2)} XLM.`,
        })}
        consequence={t('task.submit.insufficientBalance.consequence', { defaultValue: 'The task may fail if your balance is too low. Top up your wallet before proceeding, or continue at your own risk.' })}
        confirmLabel={t('task.submit.insufficientBalance.confirm', { defaultValue: 'Submit Anyway' })}
        cancelLabel={t('common.cancel', { defaultValue: 'Cancel' })}
        onConfirm={async () => {
          setShowInsufficientBalanceConfirm(false);
          if (pendingSubmitValues) await doSubmit(pendingSubmitValues);
          setPendingSubmitValues(null);
        }}
        onCancel={() => {
          setShowInsufficientBalanceConfirm(false);
          setPendingSubmitValues(null);
        }}
      />
    </main>
  );
}

export default TaskSubmissionWizard;
