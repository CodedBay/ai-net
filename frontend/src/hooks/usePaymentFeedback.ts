import { useEffect, useState } from 'react'

export interface PaymentFeedbackEvent {
  id: number
  status: 'success' | 'failure'
  amount: number
  message: string
}

function parsePaymentEvent(event: unknown): Omit<PaymentFeedbackEvent, 'id'> | null {
  if (!event || typeof event !== 'object') return null
  const data = event as { type?: unknown; payload?: unknown }
  if (typeof data.type !== 'string') return null
  const payload = data.payload && typeof data.payload === 'object'
    ? data.payload as Record<string, unknown>
    : {}
  const failed = ['payment_failed', 'payment_error', 'payment_rejected'].includes(data.type)
  if (!failed && !['payment_received', 'payment_released', 'payment_completed'].includes(data.type)) return null
  const amount = Number(payload.amount ?? payload.amountXLM ?? 0)
  const error = payload.error ?? payload.message

  return {
    status: failed ? 'failure' : 'success',
    amount: Number.isFinite(amount) ? amount : 0,
    message: failed
      ? typeof error === 'string' ? error : 'The payment could not be completed. Please check the transaction and try again.'
      : 'Payment completed successfully.',
  }
}

export function usePaymentFeedback(): PaymentFeedbackEvent | null {
  const [feedback, setFeedback] = useState<PaymentFeedbackEvent | null>(null)

  useEffect(() => {
    let closed = false
    let socket: WebSocket | null = null
    let reconnect: ReturnType<typeof setTimeout> | null = null
    let attempts = 0

    const handleEvent = (event: unknown) => {
      const parsed = parsePaymentEvent(event)
      if (parsed) setFeedback({ ...parsed, id: Date.now() })
    }

    const handleCustomEvent = (event: Event) => {
      handleEvent((event as CustomEvent).detail)
    }

    const connect = () => {
      if (closed || typeof WebSocket === 'undefined') return
      try {
        const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
        socket = new WebSocket(`${protocol}//${window.location.hostname}:3001/events`)
        socket.onopen = () => { attempts = 0 }
        socket.onmessage = (event) => {
          try { handleEvent(JSON.parse(event.data)) } catch { /* Ignore malformed events. */ }
        }
        socket.onclose = () => {
          if (closed || attempts >= 5) return
          reconnect = setTimeout(connect, 1000 * 2 ** attempts++)
        }
      } catch {
        if (!closed && attempts < 5) reconnect = setTimeout(connect, 1000 * 2 ** attempts++)
      }
    }

    window.addEventListener('ai-net-payment-event', handleCustomEvent)
    connect()
    return () => {
      closed = true
      if (reconnect) clearTimeout(reconnect)
      window.removeEventListener('ai-net-payment-event', handleCustomEvent)
      socket?.close()
    }
  }, [])

  return feedback
}