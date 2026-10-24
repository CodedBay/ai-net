import React, { createContext, useEffect, useState } from 'react'

export type ThemeMode = 'light' | 'dark' | 'system'

export interface ThemeContextValue {
  mode: ThemeMode
  setMode: (mode: ThemeMode) => void
  effectiveTheme: 'light' | 'dark'
}

const ThemeContext = createContext<ThemeContextValue>({
  mode: 'system',
  setMode: () => {},
  effectiveTheme: 'dark',
})

export const ThemeProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [mode, setMode] = useState<ThemeMode>(() => {
    try {
      const stored = localStorage.getItem('theme-mode')
      if (stored === 'light' || stored === 'dark' || stored === 'system') return stored
    } catch {
      // Use the system preference when localStorage is unavailable.
    }
    return 'system'
  })

  const [systemPrefersDark, setSystemPrefersDark] = useState<boolean>(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return true
    return window.matchMedia('(prefers-color-scheme: dark)').matches
  })

  // Apply theme class to root, update meta theme-color, and persist preference
  useEffect(() => {
    const effective = mode === 'system' ? (systemPrefersDark ? 'dark' : 'light') : mode
    const root = document.documentElement

    if (effective === 'light') {
      root.classList.add('theme-light')
      root.classList.remove('theme-dark')
    } else {
      root.classList.remove('theme-light')
      root.classList.add('theme-dark')
    }

    const metaThemeColor = document.querySelector('meta[name="theme-color"]')
    if (metaThemeColor) {
      const canvasColor = getComputedStyle(root).getPropertyValue('--surface-canvas').trim()
      if (canvasColor) metaThemeColor.setAttribute('content', canvasColor)
    }

    try {
      localStorage.setItem('theme-mode', mode)
    } catch {
      // Theme selection still applies for this session if persistence is blocked.
    }
  }, [mode, systemPrefersDark])

  // Cross-tab synchronization via storage event
  useEffect(() => {
    if (typeof window === 'undefined') return

    const handleStorageChange = (e: StorageEvent) => {
      if (e.key === 'theme-mode' && e.newValue) {
        if (e.newValue === 'light' || e.newValue === 'dark' || e.newValue === 'system') {
          setMode(e.newValue)
        }
      }
    }

    window.addEventListener('storage', handleStorageChange)
    return () => window.removeEventListener('storage', handleStorageChange)
  }, [])

  // Listen to system preference changes in real-time
  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return
    const mql = window.matchMedia('(prefers-color-scheme: dark)')
    const handler = (e: MediaQueryListEvent) => setSystemPrefersDark(e.matches)

    if (typeof mql.addEventListener === 'function') {
      mql.addEventListener('change', handler)
    } else {
      mql.addListener(handler)
    }

    return () => {
      if (typeof mql.removeEventListener === 'function') {
        mql.removeEventListener('change', handler)
      } else {
        mql.removeListener(handler)
      }
    }
  }, [])

  const effectiveTheme = mode === 'system' ? (systemPrefersDark ? 'dark' : 'light') : mode

  return (
    <ThemeContext.Provider value={{ mode, setMode, effectiveTheme }}>
      {children}
    </ThemeContext.Provider>
  )
}

export default ThemeContext
