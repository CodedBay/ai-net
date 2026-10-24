import { useState, useCallback } from 'react'
import { CreditCard, Download, RefreshCw, ExternalLink } from 'lucide-react'
import { useWallet } from '../context/WalletContext'
import { usePayments, type PaymentRow } from '../hooks/usePayments'
import { useBreadcrumbLabel } from '../components/layout/Breadcrumb'
import { Skeleton } from '../components/common/Skeleton'
import { PaymentFeedback } from '../components/wallet/PaymentFeedback'
import styles from './PaymentsPage.module.css'

const ITEMS_PER_PAGE = 20
const STELLAR_EXPLORER = 'https://stellar.expert/explorer/testnet'

function formatDate(ts: string): string {
  try {
    return new Intl.DateTimeFormat(undefined, {
      year: 'numeric',
      month: 'short',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    }).format(new Date(ts))
  } catch {
    return ts
  }
}

function truncate(s: string, front = 6, back = 4): string {
  if (!s) return '—'
  if (s.length <= front + back + 3) return s
  return `${s.slice(0, front)}...${s.slice(-back)}`
}

function statusClass(status: PaymentRow['status'], styles: Record<string, string>): string {
  switch (status) {
    case 'completed':
    case 'released':
      return styles.statusSuccess
    case 'locked':
      return styles.statusWarning
    case 'refunded':
      return styles.statusDanger
    default:
      return styles.statusDefault
  }
}

/**
 * PaymentsPage — /payments
 *
 * Displays the user's wallet transaction history fetched from Stellar Horizon
 * and the backend payments.db. Supports date-range + status filters, pagination,
 * and CSV export.
 */
function PaymentsPage() {
  const { publicKey, connected } = useWallet()

  const [dateFrom, setDateFrom] = useState('')
  const [dateTo, setDateTo] = useState('')
  const [statusFilter, setStatusFilter] = useState('all')
  const [page, setPage] = useState(1)

  const { rows, loading, error, refresh, exportCsv } = usePayments(publicKey, {
    dateFrom,
    dateTo,
    status: statusFilter,
  })
  useBreadcrumbLabel('Payment History')

  const totalPages = Math.max(1, Math.ceil(rows.length / ITEMS_PER_PAGE))
  const pagedRows = rows.slice((page - 1) * ITEMS_PER_PAGE, page * ITEMS_PER_PAGE)

  const handleExport = useCallback(() => {
    exportCsv(rows)
  }, [exportCsv, rows])

  const clearFilters = useCallback(() => {
    setDateFrom('')
    setDateTo('')
    setStatusFilter('all')
    setPage(1)
  }, [])

  const hasActiveFilters = dateFrom || dateTo || statusFilter !== 'all'

  if (!connected) {
    return (
      <div className={styles.page}>
        <div className={styles.header}>
          <h1 className={styles.title}>
            <CreditCard size={24} aria-hidden="true" />
            Payment History
          </h1>
        </div>
        <div className={styles.emptyState}>
          <CreditCard size={48} aria-hidden="true" className={styles.emptyIcon} />
          <p>Connect your wallet to view payment history.</p>
        </div>
      </div>
    )
  }

  return (
    <div className={styles.page}>
      {/* ── Header ─────────────────────────────────────────────────────── */}
      <div className={styles.header}>
        <h1 className={styles.title}>
          <CreditCard size={24} aria-hidden="true" />
          Payment History
        </h1>
        <div className={styles.actions}>
          <button
            className={styles.refreshButton}
            onClick={refresh}
            disabled={loading}
            aria-label="Refresh payment history"
          >
            <RefreshCw size={15} aria-hidden="true" />
            Refresh
          </button>
          <button
            className={styles.exportButton}
            onClick={handleExport}
            disabled={rows.length === 0}
            aria-label="Export payment history as CSV"
          >
            <Download size={15} aria-hidden="true" />
            Export CSV
          </button>
        </div>
      </div>

      <PaymentFeedback />

      {/* ── Filters ────────────────────────────────────────────────────── */}
      <div className={styles.filters} role="search" aria-label="Filter payments">
        <div className={styles.filterGroup}>
          <label htmlFor="pay-date-from" className={styles.filterLabel}>From</label>
          <input
            id="pay-date-from"
            type="date"
            className={styles.filterInput}
            value={dateFrom}
            onChange={(e) => { setDateFrom(e.target.value); setPage(1) }}
            aria-label="Filter from date"
          />
        </div>
        <div className={styles.filterGroup}>
          <label htmlFor="pay-date-to" className={styles.filterLabel}>To</label>
          <input
            id="pay-date-to"
            type="date"
            className={styles.filterInput}
            value={dateTo}
            onChange={(e) => { setDateTo(e.target.value); setPage(1) }}
            aria-label="Filter to date"
          />
        </div>
        <div className={styles.filterGroup}>
          <label htmlFor="pay-status" className={styles.filterLabel}>Status</label>
          <select
            id="pay-status"
            className={styles.filterSelect}
            value={statusFilter}
            onChange={(e) => { setStatusFilter(e.target.value); setPage(1) }}
            aria-label="Filter by payment status"
          >
            <option value="all">All</option>
            <option value="completed">Completed</option>
            <option value="locked">Locked</option>
            <option value="released">Released</option>
            <option value="refunded">Refunded</option>
          </select>
        </div>
        {hasActiveFilters && (
          <button className={styles.clearFilters} onClick={clearFilters} aria-label="Clear all filters">
            Clear filters
          </button>
        )}
      </div>

      {/* ── Error ──────────────────────────────────────────────────────── */}
      {error && (
        <div className={styles.errorBanner} role="alert">
          Error loading payments: {error}
        </div>
      )}

      {/* ── Table ──────────────────────────────────────────────────────── */}
      <div className={styles.tableWrapper}>
        <table className={styles.table} aria-label="Payment history">
          <thead>
            <tr>
              <th scope="col">Date</th>
              <th scope="col">Task ID</th>
              <th scope="col">Agents Paid</th>
              <th scope="col">Amount (XLM)</th>
              <th scope="col">Status</th>
              <th scope="col">TX Hash</th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              Array.from({ length: 5 }).map((_, i) => (
                <tr key={i} aria-hidden="true">
                  {Array.from({ length: 6 }).map((_, j) => (
                    <td key={j}><Skeleton height="1rem" width="80%" /></td>
                  ))}
                </tr>
              ))
            ) : pagedRows.length === 0 ? (
              <tr>
                <td colSpan={6} className={styles.emptyCell}>
                  No payment records found.
                </td>
              </tr>
            ) : (
              pagedRows.map((row, i) => (
                <tr key={`${row.txHash}-${i}`} className={styles.tableRow}>
                  <td className={styles.dateCell}>{formatDate(row.date)}</td>
                  <td className={styles.taskCell} title={row.taskId}>
                    {truncate(row.taskId, 8, 4)}
                  </td>
                  <td className={styles.agentCell} title={row.agentsPaid}>
                    {truncate(row.agentsPaid)}
                  </td>
                  <td className={`${styles.amountCell} ${row.direction === 'in' ? styles.amountIn : styles.amountOut}`}>
                    {row.direction === 'in' ? '+' : '−'}{row.amountXLM}
                  </td>
                  <td>
                    <span className={`${styles.statusBadge} ${statusClass(row.status, styles)}`}>
                      {row.status}
                    </span>
                  </td>
                  <td className={styles.txCell}>
                    {row.txHash ? (
                      <a
                        href={`${STELLAR_EXPLORER}/tx/${row.txHash}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className={styles.txLink}
                        aria-label={`View transaction ${truncate(row.txHash)} on Stellar Explorer`}
                      >
                        {truncate(row.txHash)}
                        <ExternalLink size={11} aria-hidden="true" />
                      </a>
                    ) : (
                      <span className={styles.noTx}>—</span>
                    )}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {/* ── Pagination ─────────────────────────────────────────────────── */}
      {!loading && rows.length > ITEMS_PER_PAGE && (
        <nav className={styles.pagination} aria-label="Pagination">
          <button
            className={styles.pageButton}
            onClick={() => setPage((p) => Math.max(1, p - 1))}
            disabled={page === 1}
            aria-label="Previous page"
          >
            Previous
          </button>
          <span className={styles.pageInfo} aria-live="polite">
            Page {page} of {totalPages}
          </span>
          <button
            className={styles.pageButton}
            onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
            disabled={page === totalPages}
            aria-label="Next page"
          >
            Next
          </button>
        </nav>
      )}
    </div>
  )
}

export default PaymentsPage
