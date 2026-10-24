/**
 * SearchEmptyIllustration
 *
 * Inline SVG illustration for the "no search results" empty state.
 * Themeable via CSS custom properties. aria-hidden because parent provides text.
 */
export function SearchEmptyIllustration() {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 200 160"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      style={{ width: '10rem', height: '8rem' }}
    >
      {/* Background glow */}
      <circle cx="100" cy="80" r="62" fill="var(--surface-hover, rgba(255,255,255,0.04))" />

      {/* Magnifying glass circle */}
      <circle cx="88" cy="72" r="30" fill="var(--surface-elevated, #1e293b)" stroke="var(--border-strong, #475569)" strokeWidth="3" />

      {/* Inner "empty" */}
      <circle cx="88" cy="72" r="22" fill="var(--surface-raised, #1a1f2e)" />

      {/* X inside magnifier */}
      <path d="M80 64l16 16M96 64L80 80" stroke="var(--text-secondary, #94a3b8)" strokeWidth="2.5" strokeLinecap="round" />

      {/* Handle */}
      <line x1="112" y1="96" x2="130" y2="114" stroke="var(--border-strong, #475569)" strokeWidth="5" strokeLinecap="round" />

      {/* Dashed suggestion lines */}
      <rect x="125" y="50" width="36" height="5" rx="2.5" fill="var(--border-muted, rgba(255,255,255,0.1))" />
      <rect x="125" y="62" width="26" height="4" rx="2" fill="var(--border-muted, rgba(255,255,255,0.07))" />
      <rect x="125" y="72" width="30" height="4" rx="2" fill="var(--border-muted, rgba(255,255,255,0.07))" />

      {/* Question mark decoration */}
      <circle cx="145" cy="118" r="12" fill="var(--accent-surface, rgba(99,102,241,0.15))" stroke="var(--accent-border, rgba(99,102,241,0.3))" strokeWidth="1" />
      <text x="145" y="123" textAnchor="middle" fontSize="14" fontWeight="700" fill="var(--accent-text, #c4b5fd)" fontFamily="sans-serif">?</text>

      {/* Small decorative dots */}
      <circle cx="42" cy="50" r="3" fill="var(--accent-info, #38bdf8)" opacity="0.4" />
      <circle cx="50" cy="125" r="2" fill="var(--accent, #8b5cf6)" opacity="0.3" />
    </svg>
  );
}
