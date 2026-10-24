/**
 * TaskFailedIllustration
 *
 * Inline SVG illustration for the "task failed" empty state.
 * Themeable via CSS custom properties. aria-hidden because parent provides text.
 */
export function TaskFailedIllustration() {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 200 160"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      style={{ width: '10rem', height: '8rem' }}
    >
      {/* Background glow */}
      <ellipse cx="100" cy="85" rx="65" ry="55" fill="var(--status-danger-surface, rgba(239,68,68,0.1))" />

      {/* Warning triangle */}
      <path
        d="M100 38 L148 118 H52 L100 38Z"
        fill="var(--status-danger-surface-strong, rgba(239,68,68,0.2))"
        stroke="var(--status-danger, #ef4444)"
        strokeWidth="2"
        strokeLinejoin="round"
      />

      {/* Exclamation mark - stem */}
      <rect x="96" y="64" width="8" height="30" rx="4" fill="var(--status-danger, #ef4444)" />

      {/* Exclamation mark - dot */}
      <circle cx="100" cy="104" r="5" fill="var(--status-danger, #ef4444)" />

      {/* Circuit break lines */}
      <line x1="38" y1="65" x2="52" y2="65" stroke="var(--status-danger-border, rgba(239,68,68,0.4))" strokeWidth="1.5" strokeDasharray="3 2" />
      <line x1="148" y1="65" x2="162" y2="65" stroke="var(--status-danger-border, rgba(239,68,68,0.4))" strokeWidth="1.5" strokeDasharray="3 2" />
      <line x1="38" y1="105" x2="52" y2="118" stroke="var(--status-danger-border, rgba(239,68,68,0.4))" strokeWidth="1.5" strokeDasharray="3 2" />
      <line x1="162" y1="105" x2="148" y2="118" stroke="var(--status-danger-border, rgba(239,68,68,0.4))" strokeWidth="1.5" strokeDasharray="3 2" />

      {/* Retry arrow hint */}
      <circle cx="160" cy="38" r="14" fill="var(--status-danger-surface-strong, rgba(239,68,68,0.2))" stroke="var(--status-danger-border-strong, rgba(239,68,68,0.4))" strokeWidth="1" />
      <path d="M155 38 a5 5 0 1 1 5 5" stroke="var(--status-danger, #ef4444)" strokeWidth="2" strokeLinecap="round" fill="none" />
      <path d="M160 43l2-3-3-1" fill="var(--status-danger, #ef4444)" />

      {/* Small dots */}
      <circle cx="40" cy="40" r="2.5" fill="var(--status-danger, #ef4444)" opacity="0.4" />
      <circle cx="165" cy="125" r="2" fill="var(--status-warning, #fbbf24)" opacity="0.5" />
    </svg>
  );
}
