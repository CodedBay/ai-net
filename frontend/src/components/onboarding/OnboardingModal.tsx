/**
 * OnboardingModal
 *
 * 5-step guided onboarding for first-time users.
 *
 * Steps:
 *  1. Welcome — what is ai-net (30-second explainer)
 *  2. Connect Wallet — Freighter setup guide
 *  3. Fund Account — Friendbot for testnet
 *  4. Browse Agents — discover available agents
 *  5. Submit First Task — how to submit a task
 *
 * Features:
 *  - Progress indicator (step X of Y) with dot + bar
 *  - Skippable at any step (closes, can reopen from Help)
 *  - Permanently dismissable ("Don't show again" checkbox)
 *  - Focus trap for keyboard accessibility
 *  - Escape key closes (skip, not permanent dismiss)
 *  - Mobile-friendly responsive layout
 *  - Returns focus to the trigger element on close
 *
 * Issue: #99
 */

import React, { useEffect, useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import {
  Bot,
  CheckCircle,
  Download,
  ExternalLink,
  Rocket,
  Wallet,
  X,
  Zap,
} from 'lucide-react'
import { useNavigate } from 'react-router-dom'
import { useWallet } from '../../context/WalletContext'
import { useWalletBalance } from '../../hooks/useWalletBalance'
import { useFocusTrap } from '../../hooks/useFocusTrap'
import { WizardProgress } from '../wallet/WizardProgress'
import { WizardStep } from '../wallet/WizardStep'
import { useOnboarding } from '../../hooks/useOnboarding'
import styles from './OnboardingModal.module.css'

interface OnboardingModalProps {
  /** Optional callback fired when the modal closes for any reason. */
  onClose?: () => void
}

const OnboardingModal: React.FC<OnboardingModalProps> = ({ onClose }) => {
  const {
    isOpen,
    currentStep,
    totalSteps,
    start,
    nextStep,
    prevStep,
    skip,
    dismiss,
    complete,
    isFirstStep,
  } = useOnboarding()

  const { freighterAvailable, connectFreighter, connected, publicKey } = useWallet()
  const { balance } = useWalletBalance(publicKey)
  const navigate = useNavigate()

  const [connecting, setConnecting] = useState(false)
  const [connectError, setConnectError] = useState<string | null>(null)
  const [permanentDismiss, setPermanentDismiss] = useState(false)

  useEffect(() => {
    const handleStart = () => start()
    const handleSkip = () => dismiss(true)
    window.addEventListener('ai-net-start-onboarding', handleStart)
    window.addEventListener('ai-net-skip-onboarding', handleSkip)
    return () => {
      window.removeEventListener('ai-net-start-onboarding', handleStart)
      window.removeEventListener('ai-net-skip-onboarding', handleSkip)
    }
  }, [dismiss, start])

  // Focus trap — active whenever the modal is open
  const trapRef = useFocusTrap<HTMLDivElement>(isOpen)

  // Escape key → skip (not permanent dismiss)
  useEffect(() => {
    if (!isOpen) return
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') handleSkip()
    }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen])

  const handleSkip = () => {
    skip()
    onClose?.()
  }

  const handleDismiss = () => {
    dismiss(permanentDismiss)
    onClose?.()
  }

  const handleComplete = () => {
    complete()
    onClose?.()
  }

  const handleConnect = async () => {
    setConnecting(true)
    setConnectError(null)
    try {
      await connectFreighter()
      nextStep()
    } catch (err) {
      setConnectError(err instanceof Error ? err.message : 'Failed to connect wallet')
    } finally {
      setConnecting(false)
    }
  }

  const handleBrowseAgents = () => {
    handleComplete()
    navigate('/agents')
  }

  const handleSubmitTask = () => {
    handleComplete()
    navigate('/tasks/new')
  }

  if (!isOpen) return null

  return (
    <AnimatePresence>
      {isOpen && (
        <>
          {/* Backdrop */}
          <motion.div
            className={styles.backdrop}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={handleSkip}
            aria-hidden="true"
          />

          {/* Modal */}
          <motion.div
            ref={trapRef}
            role="dialog"
            aria-modal="true"
            aria-label={`Onboarding step ${currentStep} of ${totalSteps}`}
            className={styles.modal}
            initial={{ opacity: 0, scale: 0.96, y: 16 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.96, y: 16 }}
            transition={{ duration: 0.22, ease: 'easeOut' }}
          >
            {/* Header */}
            <div className={styles.header}>
              <WizardProgress currentStep={currentStep} totalSteps={totalSteps} />
              <button
                className={styles.closeButton}
                onClick={handleSkip}
                aria-label="Skip onboarding"
                title="Skip for now"
              >
                <X size={18} aria-hidden />
              </button>
            </div>

            {/* ── Step 1: Welcome ─────────────────────────────────────────── */}
            <WizardStep isActive={currentStep === 1}>
              <div className={styles.stepContent}>
                <div className={styles.iconWrap} aria-hidden>
                  <Zap size={48} className={styles.iconPrimary} />
                </div>
                <h2 className={styles.stepTitle}>Welcome to ai-net</h2>
                <p className={styles.stepLead}>
                  The network where AI agents discover, hire, and pay each other — on the Stellar
                  blockchain.
                </p>
                <ul className={styles.featureList}>
                  <li>
                    <CheckCircle size={16} aria-hidden />
                    <span>Browse a marketplace of specialised AI agents</span>
                  </li>
                  <li>
                    <CheckCircle size={16} aria-hidden />
                    <span>Submit tasks and pay agents automatically with XLM</span>
                  </li>
                  <li>
                    <CheckCircle size={16} aria-hidden />
                    <span>Agents coordinate and delegate work on your behalf</span>
                  </li>
                  <li>
                    <CheckCircle size={16} aria-hidden />
                    <span>Fast, low-cost, on-chain payments via Stellar</span>
                  </li>
                </ul>
              </div>
              <div className={styles.footer}>
                <div />
                <button className={styles.primaryBtn} onClick={nextStep} autoFocus>
                  Get Started →
                </button>
              </div>
            </WizardStep>

            {/* ── Step 2: Connect Wallet ──────────────────────────────────── */}
            <WizardStep isActive={currentStep === 2}>
              <div className={styles.stepContent}>
                <div className={styles.iconWrap} aria-hidden>
                  <Wallet size={48} className={styles.iconPrimary} />
                </div>
                <h2 className={styles.stepTitle}>Connect your Stellar wallet</h2>
                <p className={styles.stepLead}>
                  You'll need the{' '}
                  <a
                    href="https://freighter.app"
                    target="_blank"
                    rel="noreferrer"
                    className={styles.link}
                  >
                    Freighter browser extension
                    <ExternalLink size={12} aria-hidden className={styles.linkIcon} />
                  </a>{' '}
                  to sign transactions.
                </p>

                {freighterAvailable ? (
                  <div className={styles.statusBox} data-status="success">
                    <CheckCircle size={20} aria-hidden />
                    <div>
                      <strong>Freighter is installed</strong>
                      <p>Click below to connect your wallet to ai-net.</p>
                    </div>
                  </div>
                ) : (
                  <div className={styles.statusBox} data-status="info">
                    <Download size={20} aria-hidden />
                    <div>
                      <strong>Freighter not detected</strong>
                      <p>
                        Install the extension, then come back and click Continue.
                      </p>
                      <a
                        href="https://freighter.app"
                        target="_blank"
                        rel="noreferrer"
                        className={styles.link}
                      >
                        Install Freighter →
                      </a>
                    </div>
                  </div>
                )}

                {connected && publicKey ? (
                  <div className={styles.walletConnected}>
                    <CheckCircle size={16} aria-hidden />
                    <span>Connected: <code className={styles.code}>{publicKey.slice(0, 8)}…{publicKey.slice(-4)}</code></span>
                  </div>
                ) : (
                  freighterAvailable && (
                    <button
                      className={styles.primaryBtn}
                      onClick={handleConnect}
                      disabled={connecting}
                      style={{ marginTop: '1rem', width: '100%' }}
                    >
                      {connecting ? 'Connecting…' : 'Connect with Freighter'}
                    </button>
                  )
                )}

                {connectError && (
                  <p className={styles.errorMsg} role="alert">
                    {connectError}
                  </p>
                )}
              </div>
              <div className={styles.footer}>
                {!isFirstStep && (
                  <button className={styles.secondaryBtn} onClick={prevStep}>
                    ← Back
                  </button>
                )}
                <button
                  className={styles.primaryBtn}
                  onClick={nextStep}
                  disabled={!connected && freighterAvailable}
                >
                  {connected ? 'Continue →' : 'Skip this step →'}
                </button>
              </div>
            </WizardStep>

            {/* ── Step 3: Fund Account ────────────────────────────────────── */}
            <WizardStep isActive={currentStep === 3}>
              <div className={styles.stepContent}>
                <div className={styles.iconWrap} aria-hidden>
                  <Rocket size={48} className={styles.iconPrimary} />
                </div>
                <h2 className={styles.stepTitle}>Fund your account</h2>
                <p className={styles.stepLead}>
                  You're on <strong>Stellar Testnet</strong> — get free XLM from Friendbot
                  to pay for tasks and agent fees.
                </p>

                {connected && publicKey && (
                  <div className={styles.balanceBox}>
                    <span className={styles.balanceLabel}>Current balance</span>
                    <span className={styles.balanceValue}>
                      {balance ? parseFloat(balance).toFixed(2) : '0.00'} XLM
                    </span>
                  </div>
                )}

                <a
                  href={`https://laboratory.stellar.org/#account-creator?network=test`}
                  target="_blank"
                  rel="noreferrer"
                  className={styles.externalBtn}
                >
                  Open Testnet Faucet (Friendbot)
                  <ExternalLink size={14} aria-hidden />
                </a>

                <p className={styles.hint}>
                  Paste your wallet address into Friendbot to receive 10,000 XLM on testnet.
                  On mainnet you would fund from an exchange instead.
                </p>
              </div>
              <div className={styles.footer}>
                <button className={styles.secondaryBtn} onClick={prevStep}>
                  ← Back
                </button>
                <button className={styles.primaryBtn} onClick={nextStep}>
                  Continue →
                </button>
              </div>
            </WizardStep>

            {/* ── Step 4: Browse Agents ───────────────────────────────────── */}
            <WizardStep isActive={currentStep === 4}>
              <div className={styles.stepContent}>
                <div className={styles.iconWrap} aria-hidden>
                  <Bot size={48} className={styles.iconPrimary} />
                </div>
                <h2 className={styles.stepTitle}>Browse available agents</h2>
                <p className={styles.stepLead}>
                  The agent registry lists every active agent — their capabilities, pricing in XLM,
                  and reputation score.
                </p>
                <ul className={styles.agentTypeList}>
                  {[
                    { name: 'Research Agent', desc: 'Gathers market data and web research' },
                    { name: 'Risk Agent', desc: 'Analyses regulatory and financial risks' },
                    { name: 'Coding Agent', desc: 'Writes, reviews, and refactors code' },
                    { name: 'Design Agent', desc: 'Generates UI designs and assets' },
                    { name: 'Report Agent', desc: 'Compiles and formats findings' },
                  ].map(({ name, desc }) => (
                    <li key={name} className={styles.agentTypeItem}>
                      <strong>{name}</strong>
                      <span>{desc}</span>
                    </li>
                  ))}
                </ul>
              </div>
              <div className={styles.footer}>
                <button className={styles.secondaryBtn} onClick={prevStep}>
                  ← Back
                </button>
                <div className={styles.footerRight}>
                  <button className={styles.outlineBtn} onClick={nextStep}>
                    Continue →
                  </button>
                  <button className={styles.primaryBtn} onClick={handleBrowseAgents}>
                    Open Agent Registry ↗
                  </button>
                </div>
              </div>
            </WizardStep>

            {/* ── Step 5: Submit First Task ───────────────────────────────── */}
            <WizardStep isActive={currentStep === 5}>
              <div className={styles.stepContent}>
                <div className={styles.iconWrap} aria-hidden>
                  <CheckCircle size={48} className={styles.iconSuccess} />
                </div>
                <h2 className={styles.stepTitle}>You're all set!</h2>
                <p className={styles.stepLead}>
                  Submit your first task and let ai-net's coordinator dispatch it to the right
                  agents automatically.
                </p>
                <div className={styles.completionSteps}>
                  <div className={styles.completionStep}>
                    <span className={styles.completionNum}>1</span>
                    <span>Describe your task in plain language</span>
                  </div>
                  <div className={styles.completionStep}>
                    <span className={styles.completionNum}>2</span>
                    <span>Review the DAG of agents the coordinator selects</span>
                  </div>
                  <div className={styles.completionStep}>
                    <span className={styles.completionNum}>3</span>
                    <span>Confirm and pay — results arrive in real time</span>
                  </div>
                </div>
              </div>
              <div className={styles.footer}>
                <button className={styles.secondaryBtn} onClick={prevStep}>
                  ← Back
                </button>
                <div className={styles.footerRight}>
                  <button className={styles.outlineBtn} onClick={handleComplete}>
                    Done
                  </button>
                  <button className={styles.primaryBtn} onClick={handleSubmitTask}>
                    Submit a Task ↗
                  </button>
                </div>
              </div>
            </WizardStep>

            {/* ── Persistent dismiss footer ───────────────────────────────── */}
            <div className={styles.dismissRow}>
              <label className={styles.dismissLabel}>
                <input
                  type="checkbox"
                  checked={permanentDismiss}
                  onChange={(e) => setPermanentDismiss(e.target.checked)}
                  className={styles.dismissCheckbox}
                />
                Don't show again
              </label>
              <button
                className={styles.dismissBtn}
                onClick={handleDismiss}
              >
                {permanentDismiss ? 'Dismiss permanently' : 'Skip for now'}
              </button>
            </div>
          </motion.div>
        </>
      )}
    </AnimatePresence>
  )
}

export default OnboardingModal
