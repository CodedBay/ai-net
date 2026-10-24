import { Keypair } from '@stellar/stellar-sdk'
import { act, renderHook } from '@testing-library/react'
import type { ReactNode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { WalletProvider } from '../context/WalletContext'
import { connectWithFreighter, isFreighterAvailable } from '../services/freighter'
import { useWallet } from './useWallet'

vi.mock('../services/freighter', () => ({
  connectWithFreighter: vi.fn(),
  isFreighterAvailable: vi.fn(),
}))

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))

const wrapper = ({ children }: { children: ReactNode }) => (
  <WalletProvider>{children}</WalletProvider>
)

describe('useWallet', () => {
  beforeEach(() => {
    localStorage.clear()
    vi.clearAllMocks()
    vi.mocked(isFreighterAvailable).mockResolvedValue(true)
  })

  it('connects a secret key and exposes the public address', async () => {
    const keypair = Keypair.random()
    const { result } = renderHook(() => useWallet(), { wrapper })

    await act(async () => {
      await result.current.connect(keypair.secret())
    })

    expect(result.current.connected).toBe(true)
    expect(result.current.address).toBe(keypair.publicKey())
    expect(localStorage.getItem('wallet_connection_method')).toBe('secret-key')
  })

  it('connects and disconnects through Freighter', async () => {
    const publicKey = 'GDEUVS2EDX2ENN2RYHFIWJXT6XHXMOXI7EUKMU2YDF637JLJAOX4UT3J'
    vi.mocked(connectWithFreighter).mockResolvedValue(publicKey)
    const { result } = renderHook(() => useWallet(), { wrapper })

    await act(async () => {
      await result.current.connectFreighter()
    })

    expect(result.current.connected).toBe(true)
    expect(result.current.address).toBe(publicKey)
    expect(result.current.ready).toBe(true)

    act(() => result.current.disconnect())

    expect(result.current.connected).toBe(false)
    expect(localStorage.getItem('wallet_pubkey')).toBeNull()
  })
})