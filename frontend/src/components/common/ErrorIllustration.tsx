/**
 * SVG illustrations for error pages.
 *
 * All colors use CSS design tokens (var(--*)) so illustrations adapt to
 * light and dark themes without any JS. Sizes are responsive — the SVG
 * scales down to 300px max on mobile via the container class.
 *
 * Each illustration has:
 *   - role="img"            — identifies it as an image to screen readers
 *   - aria-label            — describes the illustration
 *   - focusable="false"     — prevents IE focus ring on SVG
 */

import React from 'react'
import styles from './ErrorIllustration.module.css'

interface IllustrationProps {
  /** Override aria-label for i18n. Defaults to a sensible English value. */
  ariaLabel?: string
  className?: string
}

// ---------------------------------------------------------------------------
// 404 — Lost robot agent
// ---------------------------------------------------------------------------

export const NotFoundIllustration: React.FC<IllustrationProps> = ({
  ariaLabel = 'Lost robot agent illustration',
  className,
}) => (
  <div className={`${styles.container} ${className ?? ''}`}>
    <svg
      viewBox="0 0 280 240"
      xmlns="http://www.w3.org/2000/svg"
      role="img"
      aria-label={ariaLabel}
      focusable="false"
      className={styles.svg}
    >
      <title>{ariaLabel}</title>

      {/* Stars in background */}
      <circle cx="20"  cy="30"  r="2" fill="var(--accent)" opacity="0.5" />
      <circle cx="60"  cy="15"  r="1.5" fill="var(--accent-info)" opacity="0.6" />
      <circle cx="240" cy="20"  r="2.5" fill="var(--accent)" opacity="0.4" />
      <circle cx="260" cy="50"  r="1.5" fill="var(--accent-info)" opacity="0.5" />
      <circle cx="15"  cy="80"  r="1.5" fill="var(--accent)" opacity="0.3" />
      <circle cx="265" cy="100" r="2"   fill="var(--accent-info)" opacity="0.4" />
      <circle cx="35"  cy="150" r="1.5" fill="var(--accent)" opacity="0.3" />
      <circle cx="250" cy="170" r="2"   fill="var(--accent-info)" opacity="0.3" />

      {/* Ground / shadow */}
      <ellipse cx="140" cy="218" rx="70" ry="8" fill="var(--border-subtle)" opacity="0.5" />

      {/* Robot body */}
      <rect x="90" y="110" width="100" height="80" rx="12" fill="var(--surface-primary)" stroke="var(--border-primary)" strokeWidth="2" />

      {/* Robot head */}
      <rect x="100" y="70" width="80" height="52" rx="10" fill="var(--surface-raised)" stroke="var(--border-primary)" strokeWidth="2" />

      {/* Antenna */}
      <line x1="140" y1="70" x2="140" y2="52" stroke="var(--border-primary)" strokeWidth="2" />
      <circle cx="140" cy="48" r="5" fill="var(--accent)" />

      {/* Eyes (sad) */}
      <ellipse cx="122" cy="90" rx="8" ry="9" fill="var(--bg-primary)" stroke="var(--border-primary)" strokeWidth="1.5" />
      <ellipse cx="158" cy="90" rx="8" ry="9" fill="var(--bg-primary)" stroke="var(--border-primary)" strokeWidth="1.5" />
      {/* Pupils pointing down-left (looking lost) */}
      <circle cx="120" cy="93" r="3.5" fill="var(--accent-info)" />
      <circle cx="156" cy="93" r="3.5" fill="var(--accent-info)" />
      <circle cx="119" cy="92" r="1.5" fill="var(--bg-primary)" />
      <circle cx="155" cy="92" r="1.5" fill="var(--bg-primary)" />

      {/* Sad mouth */}
      <path d="M 126 108 Q 140 104 154 108" stroke="var(--border-primary)" strokeWidth="2" fill="none" strokeLinecap="round" />

      {/* Body details — chest panel */}
      <rect x="108" y="125" width="64" height="38" rx="6" fill="var(--bg-primary)" stroke="var(--border-subtle)" strokeWidth="1.5" />

      {/* Chest panel lights */}
      <circle cx="122" cy="138" r="4" fill="var(--status-warning)" opacity="0.8" />
      <circle cx="140" cy="138" r="4" fill="var(--accent)" opacity="0.7" />
      <circle cx="158" cy="138" r="4" fill="var(--accent-info)" opacity="0.8" />
      <rect x="116" y="150" width="48" height="5" rx="2.5" fill="var(--border-subtle)" />

      {/* Arms (one raised, confused) */}
      {/* Left arm — hanging down */}
      <rect x="72" y="115" width="20" height="50" rx="10" fill="var(--surface-primary)" stroke="var(--border-primary)" strokeWidth="2" />
      <circle cx="82" cy="168" r="8" fill="var(--surface-raised)" stroke="var(--border-primary)" strokeWidth="2" />
      {/* Right arm — raised up, scratching head */}
      <rect x="188" y="78" width="20" height="50" rx="10" fill="var(--surface-primary)" stroke="var(--border-primary)" strokeWidth="2" transform="rotate(-40 198 103)" />
      <circle cx="210" cy="80" r="8" fill="var(--surface-raised)" stroke="var(--border-primary)" strokeWidth="2" />

      {/* Legs */}
      <rect x="108" y="188" width="22" height="24" rx="8" fill="var(--surface-primary)" stroke="var(--border-primary)" strokeWidth="2" />
      <rect x="150" y="188" width="22" height="24" rx="8" fill="var(--surface-primary)" stroke="var(--border-primary)" strokeWidth="2" />

      {/* Question mark floating */}
      <text x="218" y="72" fontSize="22" fontWeight="700" fill="var(--accent)" opacity="0.6" fontFamily="monospace">?</text>
      <text x="52" y="95" fontSize="18" fontWeight="700" fill="var(--accent-info)" opacity="0.5" fontFamily="monospace">?</text>
    </svg>
  </div>
)

// ---------------------------------------------------------------------------
// 500 — Server malfunction
// ---------------------------------------------------------------------------

export const ServerErrorIllustration: React.FC<IllustrationProps> = ({
  ariaLabel = 'Server malfunction illustration',
  className,
}) => (
  <div className={`${styles.container} ${className ?? ''}`}>
    <svg
      viewBox="0 0 280 240"
      xmlns="http://www.w3.org/2000/svg"
      role="img"
      aria-label={ariaLabel}
      focusable="false"
      className={styles.svg}
    >
      <title>{ariaLabel}</title>

      {/* Ground shadow */}
      <ellipse cx="140" cy="220" rx="80" ry="8" fill="var(--border-subtle)" opacity="0.4" />

      {/* Server rack — main body */}
      <rect x="60" y="50" width="160" height="160" rx="8" fill="var(--surface-primary)" stroke="var(--border-primary)" strokeWidth="2" />

      {/* Server unit 1 (top) */}
      <rect x="72" y="64" width="136" height="30" rx="4" fill="var(--surface-raised)" stroke="var(--border-subtle)" strokeWidth="1" />
      <circle cx="90" cy="79" r="5" fill="var(--accent-info)" opacity="0.9" />
      <rect x="102" y="74" width="60" height="10" rx="2" fill="var(--bg-primary)" />
      <circle cx="196" cy="79" r="4" fill="var(--status-success)" opacity="0.8" />

      {/* Server unit 2 (middle) */}
      <rect x="72" y="102" width="136" height="30" rx="4" fill="var(--surface-raised)" stroke="var(--border-subtle)" strokeWidth="1" />
      <circle cx="90" cy="117" r="5" fill="var(--status-danger)" opacity="0.9" />
      <rect x="102" y="112" width="60" height="10" rx="2" fill="var(--bg-primary)" />
      {/* Blinking warning on unit 2 */}
      <circle cx="196" cy="117" r="4" fill="var(--status-warning)" opacity="0.9" />

      {/* Server unit 3 (lower-middle) */}
      <rect x="72" y="140" width="136" height="30" rx="4" fill="var(--surface-raised)" stroke="var(--border-subtle)" strokeWidth="1" />
      <circle cx="90" cy="155" r="5" fill="var(--status-danger)" opacity="0.8" />
      <rect x="102" y="150" width="40" height="10" rx="2" fill="var(--bg-primary)" />
      <circle cx="196" cy="155" r="4" fill="var(--status-danger)" opacity="0.7" />

      {/* Server unit 4 (bottom) */}
      <rect x="72" y="178" width="136" height="24" rx="4" fill="var(--surface-raised)" stroke="var(--border-subtle)" strokeWidth="1" />
      <rect x="88" y="185" width="80" height="10" rx="2" fill="var(--bg-primary)" />

      {/* Smoke / steam wisps coming from unit 2 */}
      <path d="M 140 100 Q 148 88 140 76 Q 132 64 140 52" stroke="var(--text-muted)" strokeWidth="3" fill="none" strokeLinecap="round" opacity="0.4" />
      <path d="M 160 100 Q 168 86 160 72 Q 152 58 162 46" stroke="var(--text-muted)" strokeWidth="2.5" fill="none" strokeLinecap="round" opacity="0.3" />

      {/* Spark / lightning bolt */}
      <path d="M 172 60 L 163 78 L 170 78 L 162 96" stroke="var(--status-warning)" strokeWidth="2.5" fill="none" strokeLinecap="round" strokeLinejoin="round" opacity="0.9" />

      {/* Error X indicator */}
      <circle cx="48" cy="90" r="16" fill="var(--status-danger)" opacity="0.15" />
      <line x1="41" y1="83" x2="55" y2="97" stroke="var(--status-danger)" strokeWidth="3" strokeLinecap="round" opacity="0.8" />
      <line x1="55" y1="83" x2="41" y2="97" stroke="var(--status-danger)" strokeWidth="3" strokeLinecap="round" opacity="0.8" />

      {/* Warning triangle top-right */}
      <path d="M 228 44 L 244 72 L 212 72 Z" fill="var(--status-warning)" opacity="0.15" stroke="var(--status-warning)" strokeWidth="1.5" />
      <text x="228" y="67" textAnchor="middle" fontSize="16" fontWeight="700" fill="var(--status-warning)" opacity="0.9">!</text>

    </svg>
  </div>
)

// ---------------------------------------------------------------------------
// 403 — Locked door
// ---------------------------------------------------------------------------

export const ForbiddenIllustration: React.FC<IllustrationProps> = ({
  ariaLabel = 'Locked door illustration',
  className,
}) => (
  <div className={`${styles.container} ${className ?? ''}`}>
    <svg
      viewBox="0 0 280 240"
      xmlns="http://www.w3.org/2000/svg"
      role="img"
      aria-label={ariaLabel}
      focusable="false"
      className={styles.svg}
    >
      <title>{ariaLabel}</title>

      {/* Wall */}
      <rect x="30" y="30" width="220" height="185" rx="4" fill="var(--surface-primary)" stroke="var(--border-subtle)" strokeWidth="1.5" />

      {/* Brick pattern */}
      {[0,1,2,3,4].map(row => (
        <React.Fragment key={row}>
          {[0,1,2].map(col => (
            <rect
              key={col}
              x={30 + col * 74 + (row % 2 === 0 ? 0 : 37)}
              y={30 + row * 37}
              width="70"
              height="33"
              rx="2"
              fill="none"
              stroke="var(--border-muted)"
              strokeWidth="1"
              opacity="0.5"
            />
          ))}
        </React.Fragment>
      ))}

      {/* Ground */}
      <rect x="0" y="215" width="280" height="25" rx="0" fill="var(--surface-secondary)" />
      <line x1="0" y1="215" x2="280" y2="215" stroke="var(--border-primary)" strokeWidth="1.5" />

      {/* Door frame */}
      <rect x="90" y="65" width="100" height="150" rx="6" fill="var(--surface-raised)" stroke="var(--border-primary)" strokeWidth="2.5" />

      {/* Door panel detail */}
      <rect x="100" y="75" width="80" height="60" rx="4" fill="var(--bg-primary)" stroke="var(--border-subtle)" strokeWidth="1" opacity="0.7" />
      <rect x="100" y="145" width="80" height="60" rx="4" fill="var(--bg-primary)" stroke="var(--border-subtle)" strokeWidth="1" opacity="0.7" />

      {/* Door handle */}
      <circle cx="178" cy="148" r="6" fill="var(--accent)" stroke="var(--border-primary)" strokeWidth="1.5" />

      {/* Padlock body */}
      <rect x="116" y="120" width="48" height="40" rx="8" fill="var(--accent)" stroke="var(--border-primary)" strokeWidth="2" />

      {/* Padlock shackle */}
      <path d="M 126 120 L 126 108 Q 140 98 154 108 L 154 120" fill="none" stroke="var(--accent)" strokeWidth="7" strokeLinecap="round" />
      <path d="M 126 120 L 126 108 Q 140 98 154 108 L 154 120" fill="none" stroke="var(--border-primary)" strokeWidth="2" strokeLinecap="round" />

      {/* Padlock keyhole */}
      <circle cx="140" cy="136" r="7" fill="var(--bg-primary)" opacity="0.8" />
      <rect x="137" y="136" width="6" height="12" rx="3" fill="var(--bg-primary)" opacity="0.8" />

      {/* 403 label */}
      <text x="140" y="52" textAnchor="middle" fontSize="15" fontWeight="700" fill="var(--accent)" opacity="0.7" fontFamily="monospace">403</text>

      {/* No-entry circles on sides */}
      <circle cx="48" cy="148" r="14" fill="none" stroke="var(--status-danger)" strokeWidth="3" opacity="0.5" />
      <line x1="38" y1="148" x2="58" y2="148" stroke="var(--status-danger)" strokeWidth="3" strokeLinecap="round" opacity="0.5" />
      <circle cx="232" cy="148" r="14" fill="none" stroke="var(--status-danger)" strokeWidth="3" opacity="0.5" />
      <line x1="222" y1="148" x2="242" y2="148" stroke="var(--status-danger)" strokeWidth="3" strokeLinecap="round" opacity="0.5" />
    </svg>
  </div>
)
