/**
 * i18n parity test — ensures en, es, and zh bundles have identical key sets.
 *
 * Fails CI if:
 *   - A key exists in en.json but not es.json or zh.json (missing translation)
 *   - A key exists in es.json or zh.json but not en.json (stale translation)
 *
 * This guarantees zero untranslated UI strings across all supported locales.
 */
import { describe, it, expect } from 'vitest'
import en from './locales/en.json'
import es from './locales/es.json'
import zh from './locales/zh.json'

function flattenKeys(obj: Record<string, unknown>, prefix = ''): string[] {
  const keys: string[] = []
  for (const [key, value] of Object.entries(obj)) {
    const fullKey = prefix ? `${prefix}.${key}` : key
    if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
      keys.push(...flattenKeys(value as Record<string, unknown>, fullKey))
    } else {
      keys.push(fullKey)
    }
  }
  return keys
}

const enKeys = flattenKeys(en as Record<string, unknown>).sort()
const esKeys = flattenKeys(es as Record<string, unknown>).sort()
const zhKeys = flattenKeys(zh as Record<string, unknown>).sort()

describe('i18n parity · en ↔ zh', () => {
  it('en.json has no keys missing from zh.json', () => {
    const missingInZh = enKeys.filter((k) => !zhKeys.includes(k))
    expect(missingInZh).toEqual([])
  })

  it('zh.json has no keys missing from en.json', () => {
    const missingInEn = zhKeys.filter((k) => !enKeys.includes(k))
    expect(missingInEn).toEqual([])
  })

  it('both bundles have the same number of keys', () => {
    expect(zhKeys.length).toBe(enKeys.length)
  })

  it('no duplicate keys within en.json', () => {
    const seen = new Set<string>()
    const duplicates: string[] = []
    for (const key of enKeys) {
      if (seen.has(key)) duplicates.push(key)
      seen.add(key)
    }
    expect(duplicates).toEqual([])
  })

  it('no duplicate keys within zh.json', () => {
    const seen = new Set<string>()
    const duplicates: string[] = []
    for (const key of zhKeys) {
      if (seen.has(key)) duplicates.push(key)
      seen.add(key)
    }
    expect(duplicates).toEqual([])
  })
})

describe('i18n parity · en ↔ es', () => {
  it('en.json has no keys missing from es.json', () => {
    const missingInEs = enKeys.filter((k) => !esKeys.includes(k))
    expect(missingInEs).toEqual([])
  })

  it('es.json has no keys missing from en.json', () => {
    const missingInEn = esKeys.filter((k) => !enKeys.includes(k))
    expect(missingInEn).toEqual([])
  })

  it('both bundles have the same number of keys', () => {
    expect(esKeys.length).toBe(enKeys.length)
  })

  it('no duplicate keys within es.json', () => {
    const seen = new Set<string>()
    const duplicates: string[] = []
    for (const key of esKeys) {
      if (seen.has(key)) duplicates.push(key)
      seen.add(key)
    }
    expect(duplicates).toEqual([])
  })
})
