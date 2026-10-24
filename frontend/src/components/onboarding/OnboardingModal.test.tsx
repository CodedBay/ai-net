/**
 * OnboardingModal.test.tsx — Issue #99
 */
import React from 'react'
import { render, screen, fireEvent } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { MemoryRouter } from 'react-router-dom'
import OnboardingModal from './OnboardingModal'

// Mock framer-motion to avoid animation side-effects in tests
vi.mock('framer-motion', () => ({
  AnimatePresence: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  motion: {
    div: ({ children, ...props }: React.HTMLAttributes<HTMLDivElement> & { children?: React.ReactNode }) => (
      <div {...props}>{children}</div>
    ),
  },
}))

// Mock WalletContext
vi.mock('../../context/WalletContext', () => ({
  useWallet: () => ({
    freighterAvailable: true,
    connectFreighter: vi.fn(),
    connected: false,
    publicKey: null,
  }),
}))

// Mock useWalletBalance
vi.mock('../../hooks/useWalletBalance', () => ({
  useWalletBalance: () => ({ balance: null, balances: [] }),
}))

// Mock useOnboarding to control isOpen
const mockDismiss = vi.fn()
const mockSkip = vi.fn()
const mockComplete = vi.fn()
const mockNextStep = vi.fn()
const mockPrevStep = vi.fn()

vi.mock('../../hooks/useOnboarding', () => ({
  useOnboarding: () => ({
    isOpen: true,
    currentStep: 1,
    totalSteps: 5,
    isDismissed: false,
    isCompleted: false,
    nextStep: mockNextStep,
    prevStep: mockPrevStep,
    goToStep: vi.fn(),
    skip: mockSkip,
    dismiss: mockDismiss,
    complete: mockComplete,
    reopen: vi.fn(),
    isFirstStep: true,
    isLastStep: false,
  }),
  ONBOARDING_TOTAL_STEPS: 5,
}))

const renderModal = () =>
  render(
    <MemoryRouter>
      <OnboardingModal />
    </MemoryRouter>,
  )

describe('OnboardingModal', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    // Clear localStorage between tests
    localStorage.clear()
  })

  it('renders step 1 welcome content', () => {
    renderModal()
    expect(screen.getByText('Welcome to ai-net')).toBeInTheDocument()
    expect(screen.getByText('Get Started →')).toBeInTheDocument()
  })

  it('shows correct progress indicator', () => {
    renderModal()
    expect(screen.getByText('Step 1 of 5')).toBeInTheDocument()
  })

  it('has a close/skip button', () => {
    renderModal()
    const closeBtn = screen.getByRole('button', { name: /skip onboarding/i })
    expect(closeBtn).toBeInTheDocument()
  })

  it('calls skip when close button is clicked', () => {
    renderModal()
    fireEvent.click(screen.getByRole('button', { name: /skip onboarding/i }))
    expect(mockSkip).toHaveBeenCalledTimes(1)
  })

  it('calls skip on Escape key press', () => {
    renderModal()
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(mockSkip).toHaveBeenCalledTimes(1)
  })

  it('has a "Don\'t show again" checkbox', () => {
    renderModal()
    const checkbox = screen.getByRole('checkbox')
    expect(checkbox).toBeInTheDocument()
    expect(checkbox).not.toBeChecked()
  })

  it('calls dismiss with permanently=true when checkbox is checked and dismissed', () => {
    renderModal()
    const checkbox = screen.getByRole('checkbox')
    fireEvent.click(checkbox)
    const dismissBtn = screen.getByRole('button', { name: /dismiss permanently/i })
    fireEvent.click(dismissBtn)
    expect(mockDismiss).toHaveBeenCalledWith(true)
  })

  it('calls nextStep when Get Started button is clicked', () => {
    renderModal()
    fireEvent.click(screen.getByText('Get Started →'))
    expect(mockNextStep).toHaveBeenCalledTimes(1)
  })

  it('has role=dialog and aria-modal', () => {
    renderModal()
    const dialog = screen.getByRole('dialog')
    expect(dialog).toHaveAttribute('aria-modal', 'true')
  })
})
