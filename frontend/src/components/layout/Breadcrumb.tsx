import React, { createContext, useContext, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { useLocation, Link } from 'react-router-dom'
import { NAV_ITEMS } from './navigation'
import './Breadcrumb.css'

/** Root of the in-app hierarchy. `/` is the public landing page, not this. */
const HOME_PATH = '/dashboard'

/**
 * Segments that exist only as URL structure and have no page of their own.
 * They render as plain text rather than a link that would 404.
 */
const PARENT_LINKS: Record<string, string> = {
  '/tasks': '/tasks/history',
}

interface BreadcrumbPageLabel {
  pathname: string
  label: string
}

interface BreadcrumbContextValue {
  pageLabel: BreadcrumbPageLabel | null
  setPageLabel: (pathname: string, label: string) => void
}

export const BreadcrumbContext = createContext<BreadcrumbContextValue>({
  pageLabel: null,
  setPageLabel: () => undefined,
})

export function useBreadcrumbLabel(label: string): void {
  const { setPageLabel } = useContext(BreadcrumbContext)
  const location = useLocation()

  useEffect(() => {
    setPageLabel(location.pathname, label)
  }, [label, location.pathname, setPageLabel])
}

function truncateLabel(label: string): string {
  const characters = Array.from(label)
  return characters.length > 30 ? `${characters.slice(0, 29).join('')}…` : label
}

/**
 * Breadcrumb trail derived from the current pathname.
 *
 * Labels come from the shared nav config where a segment corresponds to a real
 * nav destination, so a rename in one place moves the sidebar and the trail
 * together.
 */
const Breadcrumb: React.FC = () => {
  const { t } = useTranslation()
  const location = useLocation()
  const { pageLabel } = useContext(BreadcrumbContext)
  const segments = location.pathname.split('/').filter(Boolean)

  const labelFor = (fullPath: string, segment: string, index: number): string => {
    const navItem = NAV_ITEMS.find((item) => item.path === fullPath)
    if (navItem) return t(navItem.labelKey)

    if (fullPath === '/tasks') return t('nav.tasks')
    // `/tasks/<id>` — a detail page, named by the id it is showing.
    if (index === 1 && segments[0] === 'tasks') {
      return t('nav.taskWithId', { id: segment })
    }
    return segment.charAt(0).toUpperCase() + segment.slice(1)
  }

  // Nothing above the root to show a trail for.
  if (segments.length === 0) return null
  const isAtHome = location.pathname === HOME_PATH
  if (isAtHome) return null

  const trail = [
    { label: t('nav.dashboard'), path: HOME_PATH, isLast: false },
    ...segments.map((segment, index) => {
      const fullPath = '/' + segments.slice(0, index + 1).join('/')
      const isLast = index === segments.length - 1
      const customLabel = isLast && pageLabel?.pathname === location.pathname
        ? pageLabel.label
        : undefined

      return {
        label: customLabel ?? labelFor(fullPath, segment, index),
        path: PARENT_LINKS[fullPath] ?? fullPath,
        isLast,
      }
    }),
  ]

  const jsonLd = JSON.stringify({
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: trail.map((item, index) => ({
      '@type': 'ListItem',
      position: index + 1,
      name: item.label,
      item: `${window.location.origin}${item.path}`,
    })),
  })

  useEffect(() => {
    const script = document.createElement('script')
    script.id = 'breadcrumb-jsonld'
    script.type = 'application/ld+json'
    script.textContent = jsonLd
    document.head.appendChild(script)

    return () => script.remove()
  }, [jsonLd])

  return (
    <nav className={`breadcrumb${segments.length > 1 ? ' breadcrumb--deep' : ''}`} aria-label={t('a11y.breadcrumb')}>
      <ol>
        {trail.map((item, index) => {
          const isLast = item.isLast ?? false
          const visibleLabel = isLast ? truncateLabel(item.label) : item.label
          return (
            <li
              key={item.path}
              className={index === 0 && segments.length > 1 ? 'breadcrumb-home' : undefined}
            >
              {index > 0 && <span className="separator" aria-hidden="true">/</span>}
              {!isLast ? (
                <Link to={item.path}>{item.label}</Link>
              ) : (
                <span aria-current="page" title={item.label}>{visibleLabel}</span>
              )}
            </li>
          )
        })}
      </ol>
    </nav>
  )
}

export default Breadcrumb
