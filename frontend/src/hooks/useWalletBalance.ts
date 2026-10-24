import { useState, useEffect, useRef, useCallback } from 'react'

const HORIZON_URL = 'https://horizon-testnet.stellar.org'
const POLL_INTERVAL = 10_000

/** Minimum account reserve: 1 XLM base + 0.5 XLM per subentry */
const MIN_BASE_RESERVE_XLM = 1

export interface WalletBalance {
  asset_type: 'native' | 'credit_alphanum4' | 'credit_alphanum12'
  asset_code?: string
  asset_issuer?: string
  balance: string
}

interface BalanceInfo {
  /** Native XLM balance string (kept for backward compatibility). */
  balance: string
  /** Full set of on-chain balances including native XLM and issued tokens. */
  balances: WalletBalance[]
  /** Available (spendable) XLM balance after subtracting minimum reserve. */
  availableBalance: string
  /** Number of subentries on the account (trustlines, offers, etc.) */
  subentryCount: number
  loading: boolean
  error: string | null
  /** Whether the balance just changed — true for ~300ms after an update. */
  didChange: boolean
}

/**
 * Fetches a Stellar account's balances through Horizon, updating in response to
 * payment notifications and a polling fallback. Available balance subtracts
 * the minimum account reserve, and `didChange` flags brief balance updates.
 */
export function useWalletBalance(publicKey: string | null): BalanceInfo {
  const [balance, setBalance] = useState<string>('0')
  const [balances, setBalances] = useState<WalletBalance[]>([])
  const [availableBalance, setAvailableBalance] = useState<string>('0')
  const [subentryCount, setSubentryCount] = useState<number>(0)
  const [loading, setLoading] = useState<boolean>(true)
  const [error, setError] = useState<string | null>(null)
  const [didChange, setDidChange] = useState<boolean>(false)

  const isFirstLoad = useRef(true)
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const sseRef = useRef<EventSource | null>(null)
  const didChangTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const prevBalanceRef = useRef<string>('0')
  const keyRef = useRef<string | null>(publicKey)

  keyRef.current = publicKey

  /**
   * Compute available balance = total - minimum reserve.
   * Stellar minimum reserve = 1 XLM + 0.5 XLM per subentry.
   */
  function computeAvailable(rawBalance: string, entries: number): string {
    const total = parseFloat(rawBalance)
    if (!Number.isFinite(total)) return '0'
    const reserve = MIN_BASE_RESERVE_XLM + 0.5 * entries
    return Math.max(0, total - reserve).toFixed(7)
  }

  /** Flash the didChange flag for 300ms. */
  const flashChange = useCallback(() => {
    setDidChange(true)
    if (didChangTimerRef.current) clearTimeout(didChangTimerRef.current)
    didChangTimerRef.current = setTimeout(() => setDidChange(false), 300)
  }, [])

  const fetchBalance = useCallback(async () => {
    const key = keyRef.current
    if (!key) {
      setBalance('0')
      setAvailableBalance('0')
      setSubentryCount(0)
      setBalances([])
      setError(null)
      return
    }

    if (isFirstLoad.current) setLoading(true)

    try {
      const res = await fetch(`${HORIZON_URL}/accounts/${key}`)
      if (!res.ok) {
        if (res.status === 404) {
          setBalance('0')
          setAvailableBalance('0')
          setSubentryCount(0)
          setBalances([])
          setError(null)
          return
        }
        throw new Error(`Horizon error: ${res.status}`)
      }
      const data = await res.json()
      const rawBalances: WalletBalance[] = Array.isArray(data.balances) ? data.balances : []
      const xlmBalance = rawBalances.find((b) => b.asset_type === 'native')
      const newBalance = xlmBalance?.balance ?? '0'
      const entries: number = typeof data.subentry_count === 'number' ? data.subentry_count : 0

      // Only trigger the animation if the balance actually changed
      if (newBalance !== prevBalanceRef.current && !isFirstLoad.current) {
        flashChange()
      }
      prevBalanceRef.current = newBalance

      setBalance(newBalance)
      setBalances(rawBalances)
      setSubentryCount(entries)
      setAvailableBalance(computeAvailable(newBalance, entries))
      setError(null)
      isFirstLoad.current = false
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to fetch balance')
    } finally {
      setLoading(false)
    }
  }, [flashChange])

  /**
   * Subscribe to the Horizon payment SSE stream for real-time balance events.
   * Each incoming payment event triggers an immediate balance refetch so the
   * displayed balance updates without waiting for the 10s polling interval.
   *
   * Uses `cursor=now` so we only receive future events, not history.
   */
  const subscribeSSE = useCallback((key: string) => {
    // Clean up any existing SSE connection before creating a new one
    if (sseRef.current) {
      sseRef.current.close()
      sseRef.current = null
    }

    const url = `${HORIZON_URL}/accounts/${key}/payments?cursor=now&order=asc`
    const sse = new EventSource(url)
    sseRef.current = sse

    sse.addEventListener('message', () => {
      // A payment landed or left — refetch balance immediately
      fetchBalance()
    })

    sse.addEventListener('error', () => {
      // SSE stream error — polling fallback handles recovery automatically
      // Close and allow the next publicKey change / reconnect to reopen
      sse.close()
      if (sseRef.current === sse) sseRef.current = null
    })
  }, [fetchBalance])

  useEffect(() => {
    // Initial fetch + setup polling and SSE for the new public key
    fetchBalance()

    const handlePaymentEvent = (event: Event) => {
      const { type } = (event as CustomEvent<{ type?: string }>).detail ?? {}
      if (type === 'payment_received' || type === 'payment_released') {
        fetchBalance()
      }
    }
    window.addEventListener('ai-net-payment', handlePaymentEvent)

    if (publicKey) {
      subscribeSSE(publicKey)
    }

    intervalRef.current = setInterval(fetchBalance, POLL_INTERVAL)

    return () => {
      if (intervalRef.current) {
        clearInterval(intervalRef.current)
        intervalRef.current = null
      }
      if (sseRef.current) {
        sseRef.current.close()
        sseRef.current = null
      }
      window.removeEventListener('ai-net-payment', handlePaymentEvent)
      if (didChangTimerRef.current) {
        clearTimeout(didChangTimerRef.current)
        didChangTimerRef.current = null
      }
      isFirstLoad.current = true
      prevBalanceRef.current = '0'
    }
  }, [publicKey, fetchBalance, subscribeSSE])

  return { balance, balances, availableBalance, subentryCount, loading, error, didChange }
}
