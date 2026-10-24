import React, { useState, useEffect, useRef, useCallback } from 'react'
import { Search, X, Bot, Tag, Sparkles } from 'lucide-react'
import { useTypeaheadNav } from '../../hooks/useSelectTypeahead'
import { getHighlightSegments } from '../../utils/fuzzy'
import type { TypeaheadSuggestion, SuggestionType } from '../../hooks/useAgentRegistry'
import styles from './SearchWithTypeahead.module.css'

export interface SearchWithTypeaheadProps {
  value: string
  onChange: (value: string) => void
  onSelectSuggestion?: (suggestion: TypeaheadSuggestion) => void
  getSuggestions: (query: string) => TypeaheadSuggestion[]
  placeholder?: string
  debounceMs?: number
}

const getIconForType = (type: SuggestionType) => {
  switch (type) {
    case 'agent':
      return <Bot size={14} aria-hidden="true" />
    case 'capability':
      return <Tag size={14} aria-hidden="true" />
    case 'type':
      return <Sparkles size={14} aria-hidden="true" />
  }
}

const getBadgeClass = (type: SuggestionType) => {
  switch (type) {
    case 'agent':
      return `${styles.typeBadge} ${styles.badgeAgent}`
    case 'capability':
      return `${styles.typeBadge} ${styles.badgeCapability}`
    case 'type':
      return `${styles.typeBadge} ${styles.badgeType}`
  }
}

export const SearchWithTypeahead: React.FC<SearchWithTypeaheadProps> = ({
  value,
  onChange,
  onSelectSuggestion,
  getSuggestions,
  placeholder = 'Search agents, capabilities, types...',
  debounceMs = 300,
}) => {
  const [inputValue, setInputValue] = useState(value)
  const [isOpen, setIsOpen] = useState(false)
  const [suggestions, setSuggestions] = useState<TypeaheadSuggestion[]>([])
  const containerRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  // Sync external value changes
  useEffect(() => {
    setInputValue(value)
  }, [value])

  // Debounce input change to avoid excessive re-renders & searches
  useEffect(() => {
    const timer = setTimeout(() => {
      onChange(inputValue)
      if (inputValue.trim().length > 0) {
        const results = getSuggestions(inputValue)
        setSuggestions(results)
      } else {
        setSuggestions([])
      }
    }, debounceMs)

    return () => clearTimeout(timer)
  }, [inputValue, onChange, getSuggestions, debounceMs])

  const handleSelect = useCallback(
    (suggestion: TypeaheadSuggestion) => {
      setInputValue(suggestion.value)
      onChange(suggestion.value)
      setIsOpen(false)
      if (onSelectSuggestion) {
        onSelectSuggestion(suggestion)
      }
    },
    [onChange, onSelectSuggestion]
  )

  const { highlightedIndex, handleKeyDown } = useTypeaheadNav({
    items: suggestions,
    onSelect: handleSelect,
    isOpen,
    onClose: () => setIsOpen(false),
  })

  // Close on outside click
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setIsOpen(false)
      }
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [])

  const handleClear = () => {
    setInputValue('')
    onChange('')
    setSuggestions([])
    setIsOpen(false)
    inputRef.current?.focus()
  }

  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const val = e.target.value
    setInputValue(val)
    if (val.trim().length > 0) {
      setIsOpen(true)
      setSuggestions(getSuggestions(val))
    } else {
      setIsOpen(false)
      setSuggestions([])
    }
  }

  const renderHighlighted = (text: string, indices: number[]) => {
    const segments = getHighlightSegments(text, indices)
    return (
      <span>
        {segments.map((seg, idx) =>
          seg.matched ? (
            <strong key={idx} className={styles.highlight}>
              {seg.text}
            </strong>
          ) : (
            <span key={idx}>{seg.text}</span>
          )
        )}
      </span>
    )
  }

  const showDropdown = isOpen && inputValue.trim().length > 0

  return (
    <div ref={containerRef} className={styles.searchContainer}>
      <div className={styles.inputWrapper}>
        <div className={styles.searchIcon}>
          <Search size={16} />
        </div>
        <input
          ref={inputRef}
          type="text"
          className={styles.input}
          value={inputValue}
          onChange={handleInputChange}
          onFocus={() => {
            if (inputValue.trim().length > 0) {
              setIsOpen(true)
              setSuggestions(getSuggestions(inputValue))
            }
          }}
          onKeyDown={handleKeyDown}
          placeholder={placeholder}
          aria-label="Search agents"
          aria-expanded={showDropdown}
          aria-autocomplete="list"
          role="combobox"
          data-testid="agent-search-input"
        />
        {inputValue && (
          <button
            type="button"
            className={styles.clearButton}
            onClick={handleClear}
            aria-label="Clear search input"
            title="Clear"
            data-testid="agent-search-clear"
          >
            <X size={12} />
          </button>
        )}
      </div>

      {showDropdown && (
        <div className={styles.dropdown} role="listbox" data-testid="agent-search-dropdown">
          {suggestions.length === 0 ? (
            <div className={styles.emptyState} data-testid="search-empty-message">
              No matches found for &quot;{inputValue}&quot;
            </div>
          ) : (
            <ul className={styles.suggestionList}>
              {suggestions.map((item, index) => (
                <li
                  key={item.id}
                  role="option"
                  aria-selected={highlightedIndex === index}
                  className={`${styles.suggestionItem} ${
                    highlightedIndex === index ? styles.highlighted : ''
                  }`}
                  onClick={() => handleSelect(item)}
                  data-testid={`search-suggestion-${item.id}`}
                >
                  <div className={styles.suggestionContent}>
                    {getIconForType(item.type)}
                    {renderHighlighted(item.label, item.indices)}
                  </div>
                  <span className={getBadgeClass(item.type)}>{item.type}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  )
}

export default SearchWithTypeahead
