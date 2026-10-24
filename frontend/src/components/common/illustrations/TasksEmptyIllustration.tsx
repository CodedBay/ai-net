/**
 * TasksEmptyIllustration
 *
 * Inline SVG illustration for the "no tasks yet" empty state.
 * Themeable via CSS custom properties. aria-hidden because parent provides text.
 */
export function TasksEmptyIllustration() {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 200 160"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      style={{ width: '10rem', height: '8rem' }}
    >
      {/* Background glow */}
      <ellipse cx="100" cy="90" rx="65" ry="55" fill="var(--accent-surface, rgba(99,102,241,0.1))" />

      {/* Main document */}
      <rect x="62" y="30" width="76" height="96" rx="8" fill="var(--surface-elevated, #1e293b)" stroke="var(--accent-border, rgba(99,102,241,0.3))" strokeWidth="1.5" />

      {/* Document fold */}
      <path d="M118 30 L138 50 H118 V30Z" fill="var(--surface-raised, #1a1f2e)" stroke="var(--accent-border, rgba(99,102,241,0.3))" strokeWidth="1.5" strokeLinejoin="round" />

      {/* Lines on document */}
      <rect x="72" y="58" width="44" height="5" rx="2.5" fill="var(--border-muted, rgba(255,255,255,0.15))" />
      <rect x="72" y="70" width="36" height="4" rx="2" fill="var(--border-muted, rgba(255,255,255,0.1))" />
      <rect x="72" y="81" width="40" height="4" rx="2" fill="var(--border-muted, rgba(255,255,255,0.1))" />
      <rect x="72" y="92" width="30" height="4" rx="2" fill="var(--border-muted, rgba(255,255,255,0.08))" />

      {/* Checkbox empty */}
      <rect x="72" y="105" width="12" height="12" rx="3" fill="none" stroke="var(--border-strong, #475569)" strokeWidth="1.5" />
      <rect x="89" y="108" width="25" height="5" rx="2.5" fill="var(--border-muted, rgba(255,255,255,0.1))" />

      {/* Floating send/submit icon */}
      <circle cx="148" cy="50" r="18" fill="var(--accent, #8b5cf6)" />
      {/* Paper-plane icon */}
      <path d="M140 50l16-7-7 16-3-6-6-3z" fill="white" opacity="0.9" />
      <path d="M149.5 43.5l-6 9" stroke="white" strokeWidth="1.5" strokeLinecap="round" />

      {/* Sparkles */}
      <circle cx="55" cy="45" r="3" fill="var(--accent-info, #38bdf8)" opacity="0.6" />
      <circle cx="160" cy="100" r="2" fill="var(--status-success, #34d399)" opacity="0.5" />
      <circle cx="50" cy="110" r="2" fill="var(--accent, #8b5cf6)" opacity="0.4" />
    </svg>
  );
}
