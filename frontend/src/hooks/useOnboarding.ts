/**
 * useOnboarding
 *
 * Manages state for the 5-step first-time-user onboarding flow.
 *
 * Persistence keys (localStorage):
 *   onboarding_dismissed   — "true" when the user chose "Don't show again"
 *   onboarding_completed   — "true" when the user finished all 5 steps
 *   onboarding_step        — last step number the user was on (resumable)
 *
 * Issue: #99
 */

import { useCallback, useState } from 'react'

const KEYS = {
  dismissed: 'onboarding_dismissed',
  completed: 'onboarding_completed',
  step: 'onboarding_step',
} as const

export const ONBOARDING_TOTAL_STEPS = 5

function readBool(key: string): boolean {
  try {
    return localStorage.getItem(key) === 'true'
  } catch {
    return false
  }
}

function readInt(key: string, fallback: number): number {
  try {
    const raw = localStorage.getItem(key)
    if (raw === null) return fallback
    const n = parseInt(raw, 10)
    return Number.isFinite(n) ? n : fallback
  } catch {
    return fallback
  }
}

function persist(key: string, value: string): void {
  try {
    localStorage.setItem(key, value)
  } catch {
    /* storage unavailable — still run in memory */
  }
}

export interface UseOnboardingReturn {
  /** Whether the onboarding modal should be visible. */
  isOpen: boolean
  /** 1-based current step index. */
  currentStep: number
  totalSteps: number
  /** User permanently dismissed onboarding ("Don't show again"). */
  isDismissed: boolean
  /** User completed all steps. */
  isCompleted: boolean
  /** Advance to the next step. */
  nextStep: () => void
  /** Start the guided tour after the welcome screen. */
  start: () => void
  /** Go back to the previous step. */
  prevStep: () => void
  /** Jump to a specific step. */
  goToStep: (step: number) => void
  /** Skip without dismissing — closes modal, can be reopened from Help. */
  skip: () => void
  /**
   * Permanently dismiss — sets "Don't show again" flag, closes modal.
   * @param permanently When true sets the localStorage flag so returning
   *   users never see it again.
   */
  dismiss: (permanently?: boolean) => void
  /** Mark all steps done and close. */
  complete: () => void
  /** Re-open the onboarding from the Help menu. */
  reopen: () => void
  isFirstStep: boolean
  isLastStep: boolean
}

export function useOnboarding(): UseOnboardingReturn {
  const [isDismissed, setIsDismissed] = useState(() => readBool(KEYS.dismissed))
  const [isCompleted, setIsCompleted] = useState(() => readBool(KEYS.completed))
  const [currentStep, setCurrentStep] = useState(() =>
    readInt(KEYS.step, 1),
  )
  // isOpen: show unless dismissed or already completed (and not re-opened)
  const [isOpen, setIsOpen] = useState(() => {
    const hasSavedProgress = readInt(KEYS.step, 0) > 0
    let hasStarted = false
    try { hasStarted = localStorage.getItem('onboarding_started') === 'true' } catch { /* Storage unavailable. */ }
    return !readBool(KEYS.dismissed) && !readBool(KEYS.completed) && (hasStarted || hasSavedProgress)
  })

  const start = useCallback(() => {
    setIsOpen(true)
    persist('onboarding_started', 'true')
  }, [])

  const nextStep = useCallback(() => {
    setCurrentStep((prev) => {
      const next = Math.min(prev + 1, ONBOARDING_TOTAL_STEPS)
      persist(KEYS.step, String(next))
      return next
    })
  }, [])

  const prevStep = useCallback(() => {
    setCurrentStep((prev) => {
      const next = Math.max(prev - 1, 1)
      persist(KEYS.step, String(next))
      return next
    })
  }, [])

  const goToStep = useCallback((step: number) => {
    const clamped = Math.max(1, Math.min(step, ONBOARDING_TOTAL_STEPS))
    setCurrentStep(clamped)
    persist(KEYS.step, String(clamped))
  }, [])

  const skip = useCallback(() => {
    setIsOpen(false)
  }, [])

  const dismiss = useCallback((permanently = true) => {
    setIsOpen(false)
    if (permanently) {
      setIsDismissed(true)
      persist(KEYS.dismissed, 'true')
    }
  }, [])

  const complete = useCallback(() => {
    setIsOpen(false)
    setIsCompleted(true)
    persist(KEYS.completed, 'true')
    persist(KEYS.step, String(ONBOARDING_TOTAL_STEPS))
  }, [])

  const reopen = useCallback(() => {
    setIsOpen(true)
  }, [])

  return {
    isOpen,
    currentStep,
    totalSteps: ONBOARDING_TOTAL_STEPS,
    start,
    isDismissed,
    isCompleted,
    nextStep,
    prevStep,
    goToStep,
    skip,
    dismiss,
    complete,
    reopen,
    isFirstStep: currentStep === 1,
    isLastStep: currentStep === ONBOARDING_TOTAL_STEPS,
  }
}
