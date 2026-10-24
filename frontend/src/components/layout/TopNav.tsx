import React, { useState } from 'react'
import { useLocation } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { useWallet } from '../../context/WalletContext'
import { useWalletBalance } from '../../hooks/useWalletBalance'
import { useToast } from '../../hooks/useToast'
import { NotificationBell } from '../notifications/NotificationBell'
import { SUPPORTED_LANGUAGES } from '../../i18n/options'
import { NAV_ITEMS } from './navigation'
import type { SupportedLanguage } from '../../i18n/options'
import type { WsConnectionState } from '../../hooks/useAgentStatusSocket'
import './TopNav.css'
import useTheme from '../../hooks/useTheme'
import { Sun, Moon, Wallet } from 'lucide-react'

// ── WS status indicator ────────────────────────────────────────────────────

const WS_STATUS_COLORS: Record<WsConnectionState, string> = {
  connecting: 'var(--status-warning-text)',
  connected: 'var(--status-success-text, #22c55e)',
  reconnecting: 'var(--status-warning-text)',
  disconnected: 'var(--status-danger-text, #ef4444)',
  error: 'var(--status-danger-text, #ef4444)',
  fallback: 'var(--accent-info, #60a5fa)',
}

interface WsStatusIndicatorProps {
  state: WsConnectionState
}

const WsStatusIndicator: React.FC<WsStatusIndicatorProps> = ({ state }) => {
  const { t } = useTranslation()
  const label = t(`ws.status.${state}`, { defaultValue: state })
  const color = WS_STATUS_COLORS[state]
  const isPulsing = state === 'connecting' || state === 'reconnecting'

  return (
    <span
      className="ws-status-indicator"
      aria-label={`Agent network: ${label}`}
      title={`Agent network: ${label}`}
      style={{ display: 'inline-flex', alignItems: 'center', gap: '4px', fontSize: '11px', color }}
    >
      <span
        style={{
          width: 8,
          height: 8,
          borderRadius: '50%',
          background: color,
          display: 'inline-block',
          animation: isPulsing ? 'ws-pulse 1.4s ease-in-out infinite' : 'none',
        }}
        aria-hidden="true"
      />
      <span aria-hidden="true">{label}</span>
    </span>
  )
}

interface TopNavProps {
  onMenuClick: () => void
  onToggleSidebar: () => void
  sidebarCollapsed: boolean
  isMobile: boolean
  isDrawerOpen?: boolean
  /** Current WebSocket connection state for the agent status indicator. */
  wsConnectionState?: WsConnectionState
}

/**
 * Presentation for each language in the switcher.
 *
 * Language names stay in their own language by convention, so they are not
 * translated. Typing this as a `Record<SupportedLanguage, ...>` makes the build
 * fail if a language is added to `SUPPORTED_LANGUAGES` without an entry here.
 */
const LANGUAGE_OPTIONS: Record<
  SupportedLanguage,
  { flag: string; nativeName: string; shortLabel: string }
> = {
  en: { flag: '🇬🇧', nativeName: 'English', shortLabel: 'EN' },
  es: { flag: '🇪🇸', nativeName: 'Español', shortLabel: 'ES' },
  zh: { flag: '🇨🇳', nativeName: '中文', shortLabel: '中文' },
}

const TopNav: React.FC<TopNavProps> = ({ 
  onMenuClick, 
  onToggleSidebar, 
  sidebarCollapsed, 
  isMobile,
  isDrawerOpen = false,
  wsConnectionState,
}) => {
  const { publicKey, connected, ready, connectionMethod, connectFreighter, disconnect } = useWallet()
  const { balance, loading: balanceLoading } = useWalletBalance(publicKey)
  const { showToast } = useToast()
  const { t, i18n } = useTranslation()
  const location = useLocation()
  const { setMode, effectiveTheme } = useTheme()
  const [isConnecting, setIsConnecting] = useState(false)

  const activeLanguage = (i18n.resolvedLanguage ?? 'en') as SupportedLanguage

  // The title mirrors the sidebar's labels via the shared nav config, so the
  // page heading and the highlighted nav entry can never disagree.
  const getTitle = () => {
    const path = location.pathname
    // The registry page gets a fuller heading than its terse nav label.
    if (path === '/agents') return t('nav.agentRegistry')

    const navItem = NAV_ITEMS.find((item) => item.path === path)
    if (navItem) return t(navItem.labelKey)

    if (path.startsWith('/tasks/')) return t('nav.taskMonitoring')
    return t('nav.dashboard')
  }

  const truncateKey = (key: string) => {
    if (key.length <= 8) return key
    return `${key.slice(0, 4)}...${key.slice(-3)}`
  }

  const handleConnectFreighter = async () => {
    setIsConnecting(true)
    try {
      await connectFreighter()
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err)
      if (message.toLowerCase().includes('not installed') || message.toLowerCase().includes('not connected')) {
        showToast(t('wallet.freighterNotDetected'), 'error')
      } else if (message.toLowerCase().includes('denied') || message.toLowerCase().includes('rejected') || message.toLowerCase().includes('user')) {
        showToast(t('wallet.failedToConnectFreighter'), 'warning')
      } else {
        showToast(`${t('wallet.failedToConnect')}: ${message}`, 'error')
      }
    } finally {
      setIsConnecting(false)
    }
  }

  return (
    <header className="top-nav" role="banner">
      <div className="nav-left">
        {isMobile ? (
          <button 
            className="hamburger"
            onClick={onMenuClick}
            aria-label={t('a11y.openNavigationMenu')}
            aria-expanded={isDrawerOpen}
          >
            <span></span>
            <span></span>
            <span></span>
          </button>
        ) : (
          <button 
            className="sidebar-toggle"
            onClick={onToggleSidebar}
            aria-label={sidebarCollapsed ? t('a11y.expandSidebar') : t('a11y.collapseSidebar')}
            aria-expanded={!sidebarCollapsed}
          >
            <svg width="20" height="20" viewBox="0 0 20 20" fill="currentColor">
              <path d="M3 5h14v2H3V5zm0 4h14v2H3V9zm0 4h14v2H3v-2z"/>
            </svg>
          </button>
        )}
        
        <div className="logo">
          <span>ai-net</span>
        </div>
        
        <h1 className="page-title" id="page-title">
          {getTitle()}
        </h1>
      </div>

      <div className="nav-right">
        {wsConnectionState !== undefined && (
          <WsStatusIndicator state={wsConnectionState} />
        )}
        <NotificationBell />

        <button
          className="theme-toggle"
          onClick={() => setMode(effectiveTheme === 'dark' ? 'light' : 'dark')}
          type="button"
          role="switch"
          aria-label={`Switch to ${effectiveTheme === 'dark' ? 'light' : 'dark'} theme`}
          aria-checked={effectiveTheme === 'dark'}
          title={`Switch to ${effectiveTheme === 'dark' ? 'light' : 'dark'} theme`}
        >
          {effectiveTheme === 'dark' ? <Moon size={16} /> : <Sun size={16} />}
        </button>

        <div
          className="language-switcher"
          id="language-switcher"
          role="group"
          aria-label={t('a11y.languageSwitcher')}
        >
          {SUPPORTED_LANGUAGES.map((language) => (
            <button
              key={language}
              type="button"
              id={`btn-lang-${language}`}
              className={`language-option ${language === activeLanguage ? 'active' : ''}`}
              onClick={() => { void i18n.changeLanguage(language) }}
              aria-pressed={language === activeLanguage}
              aria-label={t('a11y.switchToLanguage', {
                language: LANGUAGE_OPTIONS[language].nativeName,
              })}
            >
              <span className="language-flag" aria-hidden="true">
                {LANGUAGE_OPTIONS[language].flag}
              </span>
              <span aria-hidden="true">{LANGUAGE_OPTIONS[language].shortLabel}</span>
            </button>
          ))}
        </div>
        {connected && publicKey ? (
          ready ? (
            <>
              <span className="wallet-chip connected" id="wallet-pubkey-display" title={publicKey}>
                {truncateKey(publicKey)}
              </span>
              <span
                className="wallet-chip connected wallet-balance"
                id="wallet-balance-display"
                aria-label={`XLM balance: ${balance}`}
              >
                {balanceLoading ? '…' : `${parseFloat(balance).toFixed(2)} XLM`}
              </span>
              {connectionMethod && (
                <span className="wallet-chip connected wallet-method" style={{ fontSize: '10px', padding: '2px 6px' }}>
                  {connectionMethod === 'freighter' ? t('wallet.freighter') : t('wallet.secretKey')}
                </span>
              )}
              <button
                className="disconnect-btn"
                onClick={disconnect}
                id="btn-disconnect"
              >
                {t('wallet.disconnect')}
              </button>
            </>
          ) : (
            <>
              <span className="wallet-chip connected" id="wallet-pubkey-display" style={{ opacity: 0.6 }} title={publicKey}>
                {truncateKey(publicKey)}
              </span>
              <span className="wallet-chip" style={{ fontSize: '10px', padding: '2px 6px', background: 'var(--status-warning-surface-strong)', color: 'var(--status-warning-text)' }}>
                {t('wallet.reconnectRequired')}
              </span>
            </>
          )
        ) : (
          <button
            className="connect-wallet-btn"
            onClick={() => { void handleConnectFreighter() }}
            disabled={isConnecting}
            id="btn-connect-wallet"
            aria-label={t('wallet.connectWithFreighter')}
          >
            <Wallet size={16} aria-hidden="true" />
            <span>{isConnecting ? t('common.connecting') : t('wallet.connectWithFreighter')}</span>
          </button>
        )}
      </div>
    </header>
  )
}

export default TopNav
