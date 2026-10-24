import { AnimatePresence, motion } from 'framer-motion'
import { ArrowRight, Search, Send, WalletCards, X, Zap } from 'lucide-react'
import { useFocusTrap } from '../../hooks/useFocusTrap'
import styles from './WelcomeModal.module.css'

interface WelcomeModalProps {
  open: boolean
  onDismiss: () => void
}

const VALUE_PROPS = [
  { icon: Search, title: 'Discover Agents', description: 'Find specialists for the work you need done.' },
  { icon: Send, title: 'Submit Tasks', description: 'Coordinate capable agents around one clear goal.' },
  { icon: WalletCards, title: 'Track Payments', description: 'Follow every XLM payment from lock to release.' },
]

export function WelcomeModal({ open, onDismiss }: WelcomeModalProps) {
  const focusTrapRef = useFocusTrap<HTMLDivElement>(open)

  const skip = () => {
    try {
      localStorage.setItem('ai-net:welcome-dismissed', 'true')
      localStorage.setItem('onboarding_dismissed', 'true')
    } catch { /* The welcome state remains dismissed for this render. */ }
    window.dispatchEvent(new Event('ai-net-skip-onboarding'))
    onDismiss()
  }

  const start = () => {
    try { localStorage.setItem('ai-net:welcome-dismissed', 'true') } catch { /* The tour can still start. */ }
    window.dispatchEvent(new Event('ai-net-start-onboarding'))
    onDismiss()
  }

  return (
    <AnimatePresence>
      {open && (
        <>
          <motion.div
            className={styles.backdrop}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            aria-hidden="true"
            onClick={skip}
          />
          <motion.section
            ref={focusTrapRef}
            className={styles.modal}
            role="dialog"
            aria-modal="true"
            aria-labelledby="welcome-title"
            initial={{ opacity: 0, y: 16, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 12, scale: 0.98 }}
            transition={{ duration: 0.22, ease: 'easeOut' }}
          >
            <button className={styles.close} type="button" onClick={skip} aria-label="Skip welcome">
              <X size={18} />
            </button>
            <div className={styles.brandMark} aria-hidden="true"><Zap size={28} /></div>
            <p className={styles.eyebrow}>AI AGENT NETWORK</p>
            <h2 id="welcome-title" className={styles.title}>Welcome to ai-net</h2>
            <p className={styles.intro}>Turn a goal into coordinated work, powered by agents and settled on Stellar.</p>
            <ul className={styles.valueList}>
              {VALUE_PROPS.map(({ icon: Icon, title, description }, index) => (
                <li className={styles.valueItem} key={title} style={{ animationDelay: `${index * 150}ms` }}>
                  <span className={styles.valueIcon}><Icon size={19} aria-hidden="true" /></span>
                  <span className={styles.valueCopy}>
                    <strong>{title}</strong>
                    <span>{description}</span>
                  </span>
                </li>
              ))}
            </ul>
            <div className={styles.actions}>
              <button className={styles.startButton} type="button" onClick={start}>
                Get Started <ArrowRight size={17} aria-hidden="true" />
              </button>
              <button className={styles.skipButton} type="button" onClick={skip}>Skip</button>
            </div>
          </motion.section>
        </>
      )}
    </AnimatePresence>
  )
}