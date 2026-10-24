/**
 * PaymentsEmptyIllustration
 *
 * Inline SVG illustration for the "no payments" empty state.
 * Themeable via CSS custom properties. aria-hidden because parent provides text.
 */
export function PaymentsEmptyIllustration() {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 200 160"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      style={{ width: '10rem', height: '8rem' }}
    >
      {/* Background glow */}
      <ellipse cx="100" cy="85" rx="68" ry="58" fill="var(--status-success-surface, rgba(16,185,129,0.1))" />

      {/* Wallet body */}
      <rect x="40" y="55" width="120" height="75" rx="10" fill="var(--surface-elevated, #1e293b)" stroke="var(--status-success-border, rgba(16,185,129,0.3))" strokeWidth="1.5" />

      {/* Wallet flap */}
      <rect x="40" y="55" width="120" height="20" rx="10" fill="var(--surface-raised, #1a1f2e)" stroke="var(--status-success-border, rgba(16,185,129,0.3))" strokeWidth="1.5" />
      <rect x="40" y="65" width="120" height="10" fill="var(--surface-raised, #1a1f2e)" />

      {/* Coin slot */}
      <rect x="120" y="82" width="30" height="30" rx="8" fill="var(--surface-secondary, #161b24)" stroke="var(--border-muted, rgba(255,255,255,0.1))" strokeWidth="1" />

      {/* Coin */}
      <circle cx="135" cy="97" r="10" fill="var(--status-success-surface-strong, rgba(16,185,129,0.2))" stroke="var(--status-success, #34d399)" strokeWidth="1.5" />
      {/* XLM symbol */}
      <text x="135" y="101" textAnchor="middle" fontSize="9" fontWeight="700" fill="var(--status-success, #34d399)" fontFamily="monospace">₹</text>

      {/* Empty balance lines */}
      <rect x="50" y="85" width="55" height="6" rx="3" fill="var(--border-muted, rgba(255,255,255,0.12))" />
      <rect x="50" y="97" width="40" height="4" rx="2" fill="var(--border-muted, rgba(255,255,255,0.08))" />
      <rect x="50" y="108" width="48" height="4" rx="2" fill="var(--border-muted, rgba(255,255,255,0.08))" />

      {/* Up-arrow transaction hint */}
      <circle cx="158" cy="48" r="14" fill="var(--status-success, #34d399)" />
      <path d="M158 54V42M153 47l5-5 5 5" stroke="white" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />

      {/* Decorative dots */}
      <circle cx="42" cy="42" r="3" fill="var(--status-success, #34d399)" opacity="0.4" />
      <circle cx="162" cy="130" r="2.5" fill="var(--accent-info, #38bdf8)" opacity="0.5" />
    </svg>
  );
}
