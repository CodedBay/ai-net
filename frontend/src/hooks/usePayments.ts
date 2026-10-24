import { useCallback, useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'

// ─── Types ────────────────────────────────────────────────────────────────────

export interface PaymentRow {
  date: string
  taskId: string
  agentsPaid: string
  amountXLM: string
  status: 'completed' | 'locked' | 'released' | 'refunded' | 'unknown'
  txHash: string
  direction: 'in' | 'out'
}

export interface PaymentFilters {
  dateFrom: string
  dateTo: string
  status: string
}

export interface UsePaymentsResult {
  rows: PaymentRow[]
  loading: boolean
  error: string | null
  refresh: () => void
  exportCsv: (data: PaymentRow[]) => void
}

interface BackendPayment {
  taskId: string
  nodeId: string
  balanceId: string
  status: PaymentRow['status']
  amountStroops: string
  txHash: string | null
  date: string
}

interface HorizonPayment {
  amount: string
  from: string
  to: string
  transaction_hash: string
  created_at: string
  type: string
}

function stroopsToXlm(stroops: string): string {
  let value: bigint
  try {
    value = BigInt(stroops)
  } catch {
    throw new Error('Backend returned an invalid stroops amount')
  }
  const sign = value < 0n ? '-' : ''
  const absolute = value < 0n ? -value : value
  const whole = absolute / 10_000_000n
  const fraction = (absolute % 10_000_000n).toString().padStart(7, '0')
  return `${sign}${whole}.${fraction}`
}

async function fetchBackendPayments(walletPublicKey: string, signal: AbortSignal): Promise<BackendPayment[]> {
  const response = await fetch('/api/payments', {
    signal,
    headers: { walletpublickey: walletPublicKey },
  })
  if (!response.ok) throw new Error(`Payments API error: ${response.status}`)
  const body = (await response.json()) as { payments?: BackendPayment[] }
  if (!Array.isArray(body.payments)) throw new Error('Payments API returned an invalid response')
  return body.payments
}

async function fetchHorizonPayments(walletPublicKey: string, signal: AbortSignal): Promise<PaymentRow[]> {
  const response = await fetch(
    `https://horizon-testnet.stellar.org/accounts/${encodeURIComponent(walletPublicKey)}/payments?limit=200&order=desc`,
    { signal },
  )
  if (response.status === 404) return []
  if (!response.ok) throw new Error(`Stellar Horizon error: ${response.status}`)

  const body = (await response.json()) as {
    _embedded?: { records?: HorizonPayment[] }
  }
  const records = body._embedded?.records ?? []
  return records
    .filter((record) => record.type === 'payment')
    .map((record) => {
      const incoming = record.to === walletPublicKey
      return {
        date: record.created_at,
        taskId: record.transaction_hash,
        agentsPaid: incoming ? record.from : record.to,
        amountXLM: record.amount,
        status: 'completed' as const,
        txHash: record.transaction_hash,
        direction: incoming ? 'in' as const : 'out' as const,
      }
    })
}

// ─── Hook ────────────────────────────────────────────────────────────────────

/**
 * usePayments — combined payment data from Stellar Horizon + backend payments.db
 *
 * Merges Horizon transaction history with backend payment records, applies
 * client-side filters (date range, status), and provides CSV export.
 *
 * Horizon and backend records are cached independently per wallet and refreshed
 * in the background so revisiting the page does not repeat recent requests.
 */
export function usePayments(
  publicKey: string | null,
  filters: PaymentFilters
): UsePaymentsResult {
  const backendQuery = useQuery({
    queryKey: ['payments', 'backend', publicKey],
    queryFn: ({ signal }) => {
      if (!publicKey) throw new Error('Connect a wallet to load payments')
      return fetchBackendPayments(publicKey, signal)
    },
    enabled: Boolean(publicKey),
    staleTime: 30_000,
    refetchInterval: 60_000,
  })
  const horizonQuery = useQuery({
    queryKey: ['payments', 'horizon', publicKey],
    queryFn: ({ signal }) => {
      if (!publicKey) throw new Error('Connect a wallet to load payments')
      return fetchHorizonPayments(publicKey, signal)
    },
    enabled: Boolean(publicKey),
    staleTime: 30_000,
    refetchInterval: 60_000,
  })

  const allRows = useMemo(() => {
    const backendRows: PaymentRow[] = (backendQuery.data ?? []).map((payment) => ({
      date: payment.date,
      taskId: payment.taskId,
      agentsPaid: payment.nodeId,
      amountXLM: stroopsToXlm(payment.amountStroops),
      status: payment.status,
      txHash: payment.txHash ?? '',
      direction: payment.status === 'refunded' ? 'in' : 'out',
    }))
    const hashes = new Set(backendRows.map((row) => row.txHash).filter(Boolean))
    const horizonRows = (horizonQuery.data ?? []).filter(
      (row) => !row.txHash || !hashes.has(row.txHash),
    )
    return [...backendRows, ...horizonRows].sort(
      (a, b) => new Date(b.date).getTime() - new Date(a.date).getTime(),
    )
  }, [backendQuery.data, horizonQuery.data])

  const rows = useMemo(() => {
    const fromTime = filters.dateFrom ? new Date(filters.dateFrom).getTime() : null
    const toTime = filters.dateTo ? new Date(`${filters.dateTo}T23:59:59.999`).getTime() : null
    return allRows.filter((row) => {
      if (filters.status !== 'all' && row.status !== filters.status) return false
      const time = new Date(row.date).getTime()
      if (!Number.isNaN(time)) {
        if (fromTime !== null && time < fromTime) return false
        if (toTime !== null && time > toTime) return false
      }
      return true
    })
  }, [allRows, filters.dateFrom, filters.dateTo, filters.status])

  const refresh = useCallback(() => {
    void Promise.all([backendQuery.refetch(), horizonQuery.refetch()])
  }, [backendQuery.refetch, horizonQuery.refetch])

  const exportCsv = useCallback((data: PaymentRow[]) => {
    const headers = ['Date', 'Task ID', 'Agent Paid', 'Amount (XLM)', 'Status', 'TX Hash']
    const csvRows = data.map((row) => [
      row.date,
      row.taskId,
      row.agentsPaid,
      `${row.direction === 'in' ? '+' : '-'}${row.amountXLM}`,
      row.status,
      row.txHash,
    ])
    const csvContent = [headers, ...csvRows]
      .map((r) => r.map((cell) => `"${String(cell).replace(/"/g, '""')}"`).join(','))
      .join('\n')
    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' })
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = `payments-${new Date().toISOString().slice(0, 10)}.csv`
    document.body.appendChild(link)
    link.click()
    document.body.removeChild(link)
    URL.revokeObjectURL(url)
  }, [])

  return {
    rows,
    loading: backendQuery.isLoading || horizonQuery.isLoading,
    error: backendQuery.error?.message ?? horizonQuery.error?.message ?? null,
    refresh,
    exportCsv,
  }
}
