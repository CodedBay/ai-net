/**
 * AgentsEmptyIllustration
 *
 * Inline SVG illustration for the "no agents found" empty state.
 * Themeable via CSS custom properties — works in both dark and light mode.
 * aria-hidden="true" because the parent EmptyState provides accessible text.
 */
export function AgentsEmptyIllustration() {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 200 160"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      style={{ width: '10rem', height: '8rem' }}
    >
      {/* Background circle */}
      <circle cx="100" cy="80" r="70" fill="var(--accent-surface, rgba(99,102,241,0.12))" />

      {/* Grid dots */}
      {[60, 80, 100, 120, 140].map((x) =>
        [40, 60, 80, 100, 120].map((y) => (
          <circle
            key={`${x}-${y}`}
            cx={x}
            cy={y}
            r="1.5"
            fill="var(--border-muted, rgba(255,255,255,0.08))"
          />
        ))
      )}

      {/* Main agent card */}
      <rect x="55" y="55" width="90" height="65" rx="10" fill="var(--surface-elevated, #1e293b)" stroke="var(--accent-border, rgba(99,102,241,0.3))" strokeWidth="1.5" />

      {/* Agent avatar circle */}
      <circle cx="100" cy="78" r="16" fill="var(--accent-surface-strong, rgba(99,102,241,0.25))" />
      <circle cx="100" cy="73" r="7" fill="var(--accent-text, #c4b5fd)" />
      <path d="M84 94c0-8.837 7.163-12 16-12s16 3.163 16 12" fill="var(--accent-text, #c4b5fd)" />

      {/* Status dots */}
      <circle cx="82" cy="108" r="3" fill="var(--status-success, #34d399)" />
      <rect x="88" y="105.5" width="24" height="5" rx="2.5" fill="var(--border-muted, rgba(255,255,255,0.12))" />

      {/* Plus badge (call to action hint) */}
      <circle cx="130" cy="55" r="13" fill="var(--accent, #8b5cf6)" />
      <path d="M130 49v12M124 55h12" stroke="white" strokeWidth="2.5" strokeLinecap="round" />

      {/* Small decorative agent cards */}
      <rect x="22" y="65" width="28" height="36" rx="6" fill="var(--surface-raised, #1a1f2e)" stroke="var(--border-subtle, #1f2630)" strokeWidth="1" opacity="0.6" />
      <circle cx="36" cy="78" r="8" fill="var(--agent-research-surface, rgba(56,189,248,0.13))" />
      <circle cx="36" cy="76" r="3.5" fill="var(--accent-info, #38bdf8)" opacity="0.8" />

      <rect x="150" y="65" width="28" height="36" rx="6" fill="var(--surface-raised, #1a1f2e)" stroke="var(--border-subtle, #1f2630)" strokeWidth="1" opacity="0.6" />
      <circle cx="164" cy="78" r="8" fill="var(--agent-coding-surface, rgba(167,139,250,0.13))" />
      <circle cx="164" cy="76" r="3.5" fill="var(--accent-text-strong, #a78bfa)" opacity="0.8" />

      {/* Network lines */}
      <line x1="50" y1="83" x2="55" y2="83" stroke="var(--border-muted, rgba(255,255,255,0.08))" strokeWidth="1" strokeDasharray="2 2" />
      <line x1="145" y1="83" x2="150" y2="83" stroke="var(--border-muted, rgba(255,255,255,0.08))" strokeWidth="1" strokeDasharray="2 2" />
    </svg>
  );
}
