import { useEffect, useState } from 'react'
import { Check, Volume2, VolumeX, X } from 'lucide-react'
import { useAnimatedCounter } from '../../hooks/useAnimatedCounter'
import { usePaymentFeedback } from '../../hooks/usePaymentFeedback'

const SOUND_KEY = 'payment_success_sound_enabled'

function readSoundPreference(): boolean {
  try { return localStorage.getItem(SOUND_KEY) === 'true' } catch { return false }
}

function playSuccessSound(): void {
  const AudioContextConstructor = window.AudioContext
  if (!AudioContextConstructor) return
  const context = new AudioContextConstructor()
  const oscillator = context.createOscillator()
  const gain = context.createGain()
  oscillator.frequency.value = 660
  gain.gain.setValueAtTime(0.04, context.currentTime)
  gain.gain.exponentialRampToValueAtTime(0.001, context.currentTime + 0.16)
  oscillator.connect(gain)
  gain.connect(context.destination)
  oscillator.start()
  oscillator.stop(context.currentTime + 0.16)
  oscillator.onended = () => { void context.close() }
}

export function PaymentFeedback() {
  const event = usePaymentFeedback()
  const amount = useAnimatedCounter(event?.amount ?? 0, { decimals: 7 })
  const [soundEnabled, setSoundEnabled] = useState(readSoundPreference)

  useEffect(() => {
    if (event?.status === 'success' && soundEnabled) playSuccessSound()
  }, [event?.id, event?.status, soundEnabled])

  const toggleSound = () => {
    setSoundEnabled((enabled) => {
      const next = !enabled
      try { localStorage.setItem(SOUND_KEY, String(next)) } catch { /* Preference is optional. */ }
      return next
    })
  }

  if (!event) return null

  const succeeded = event.status === 'success'
  return (
    <section
      key={event.id}
      className={`payment-feedback ${succeeded ? 'payment-feedback-success' : 'payment-feedback-failure payment-failure-shake'}`}
      aria-live="polite"
      aria-atomic="true"
      role={succeeded ? 'status' : 'alert'}
    >
      <span className={`payment-feedback-icon ${succeeded ? 'payment-success-check' : ''}`} aria-hidden="true">
        {succeeded ? <Check size={22} /> : <X size={22} />}
      </span>
      <div className="payment-feedback-copy">
        <strong>{succeeded ? 'Payment confirmed' : 'Payment failed'}</strong>
        <span>
          {succeeded ? (
            <>
              <span aria-hidden="true">{amount.toFixed(7)} XLM transferred. </span>
              <span className="sr-only">{event.amount.toFixed(7)} XLM transferred. </span>
              {event.message}
            </>
          ) : event.message}
        </span>
      </div>
      {succeeded && (
        <span className="payment-confetti" aria-hidden="true">
          {Array.from({ length: 8 }, (_, index) => <i key={index} />)}
        </span>
      )}
      <button
        type="button"
        className="payment-sound-toggle"
        onClick={toggleSound}
        aria-label={soundEnabled ? 'Disable payment success sound' : 'Enable payment success sound'}
        title={soundEnabled ? 'Disable payment success sound' : 'Enable payment success sound'}
      >
        {soundEnabled ? <Volume2 size={16} /> : <VolumeX size={16} />}
      </button>
    </section>
  )
}