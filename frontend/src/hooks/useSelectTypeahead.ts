import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from 'react'

interface TypeaheadOption<T> {
  label: string
  value: T
}

interface SelectTypeaheadOptions<T> {
  options: readonly TypeaheadOption<T>[]
  onMatch: (value: T) => void
  timeoutMs?: number
}

/**
 * Adds deterministic prefix matching to native selects while retaining their
 * built-in semantics and platform UI. Printable keys are buffered briefly so
 * multi-character labels such as "100" can be selected directly.
 */
export function useSelectTypeahead<T>({
  options,
  onMatch,
  timeoutMs = 700,
}: SelectTypeaheadOptions<T>) {
  const bufferRef = useRef('')
  const resetTimerRef = useRef<number | undefined>(undefined)

  useEffect(() => () => window.clearTimeout(resetTimerRef.current), [])

  return useCallback((event: KeyboardEvent<HTMLSelectElement>) => {
    if (event.altKey || event.ctrlKey || event.metaKey || event.key.length !== 1) return

    const nextBuffer = `${bufferRef.current}${event.key}`.toLocaleLowerCase()
    const match = options.find((option) => option.label.toLocaleLowerCase().startsWith(nextBuffer))

    window.clearTimeout(resetTimerRef.current)
    resetTimerRef.current = window.setTimeout(() => { bufferRef.current = '' }, timeoutMs)

    if (!match) {
      bufferRef.current = event.key.toLocaleLowerCase()
      const singleKeyMatch = options.find((option) => option.label.toLocaleLowerCase().startsWith(bufferRef.current))
      if (singleKeyMatch) {
        event.preventDefault()
        onMatch(singleKeyMatch.value)
      }
      return
    }

    event.preventDefault()
    bufferRef.current = nextBuffer
    onMatch(match.value)
  }, [onMatch, options, timeoutMs])
}

export interface UseTypeaheadNavOptions<T> {
  items: readonly T[]
  onSelect: (item: T) => void
  isOpen: boolean
  onClose?: () => void
}

/**
 * Handles keyboard navigation (ArrowDown, ArrowUp, Enter, Escape) for typeahead
 * dropdown suggestion lists.
 */
export function useTypeaheadNav<T>({
  items,
  onSelect,
  isOpen,
  onClose,
}: UseTypeaheadNavOptions<T>) {
  const [highlightedIndex, setHighlightedIndex] = useState<number>(-1)

  useEffect(() => {
    setHighlightedIndex(-1)
  }, [items])

  const handleKeyDown = useCallback(
    (event: KeyboardEvent<HTMLElement>) => {
      if (!isOpen || items.length === 0) {
        if (event.key === 'Escape') {
          onClose?.()
        }
        return
      }

      if (event.key === 'ArrowDown') {
        event.preventDefault()
        setHighlightedIndex((prev) => (prev + 1 >= items.length ? 0 : prev + 1))
      } else if (event.key === 'ArrowUp') {
        event.preventDefault()
        setHighlightedIndex((prev) => (prev <= 0 ? items.length - 1 : prev - 1))
      } else if (event.key === 'Enter') {
        if (highlightedIndex >= 0 && highlightedIndex < items.length) {
          event.preventDefault()
          onSelect(items[highlightedIndex])
        }
      } else if (event.key === 'Escape') {
        event.preventDefault()
        onClose?.()
      }
    },
    [isOpen, items, highlightedIndex, onSelect, onClose],
  )

  return {
    highlightedIndex,
    setHighlightedIndex,
    handleKeyDown,
  }
}

