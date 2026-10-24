/**
 * tokens.ts — TypeScript design token constants
 *
 * These constants mirror the CSS custom properties defined in tokens.css.
 * Use them anywhere you need token values in JavaScript/TypeScript (e.g.
 * recharts, canvas drawing, dynamic styles, tests).
 *
 * Rule: every token here must have a matching --<name> CSS custom property
 * in tokens.css, and vice-versa.
 *
 * Issue: #96
 */

// ── Colors: Primary / Secondary ───────────────────────────────────────────────

export const COLOR_PRIMARY    = 'var(--accent)' as const;
export const COLOR_PRIMARY_HOVER = 'var(--accent-hover)' as const;
export const COLOR_SECONDARY  = 'var(--accent-secondary)' as const;
export const COLOR_BACKGROUND = 'var(--surface-canvas)' as const;
export const COLOR_SURFACE    = 'var(--surface-primary)' as const;
export const COLOR_SURFACE_RAISED = 'var(--surface-raised)' as const;
export const COLOR_BORDER     = 'var(--border-primary)' as const;

// ── Colors: Text ─────────────────────────────────────────────────────────────

export const COLOR_TEXT_PRIMARY   = 'var(--text-primary)' as const;
export const COLOR_TEXT_SECONDARY = 'var(--text-secondary)' as const;
export const COLOR_TEXT_MUTED     = 'var(--text-muted)' as const;
export const COLOR_TEXT_DISABLED  = 'var(--text-disabled)' as const;
export const COLOR_TEXT_INVERSE   = 'var(--text-inverse)' as const;

// ── Colors: Status ────────────────────────────────────────────────────────────

export const COLOR_STATUS_SUCCESS = 'var(--status-success)' as const;
export const COLOR_STATUS_WARNING = 'var(--status-warning)' as const;
export const COLOR_STATUS_DANGER  = 'var(--status-danger)' as const;
export const COLOR_STATUS_INFO    = 'var(--status-info)' as const;

export const COLOR_STATUS_SUCCESS_SURFACE = 'var(--status-success-surface)' as const;
export const COLOR_STATUS_WARNING_SURFACE = 'var(--status-warning-surface)' as const;
export const COLOR_STATUS_DANGER_SURFACE  = 'var(--status-danger-surface)' as const;
export const COLOR_STATUS_INFO_SURFACE    = 'var(--status-info-surface)' as const;

export const COLOR_STATUS_SUCCESS_BORDER = 'var(--status-success-border)' as const;
export const COLOR_STATUS_WARNING_BORDER = 'var(--status-warning-border)' as const;
export const COLOR_STATUS_DANGER_BORDER  = 'var(--status-danger-border)' as const;
export const COLOR_STATUS_INFO_BORDER    = 'var(--status-info-border)' as const;

export const COLOR_STATUS_SUCCESS_TEXT = 'var(--status-success-text)' as const;
export const COLOR_STATUS_WARNING_TEXT = 'var(--status-warning-text)' as const;
export const COLOR_STATUS_DANGER_TEXT  = 'var(--status-danger-text)' as const;
export const COLOR_STATUS_INFO_TEXT    = 'var(--status-info-text)' as const;

// ── Colors: Accent / Info ─────────────────────────────────────────────────────

export const COLOR_ACCENT         = 'var(--accent)' as const;
export const COLOR_ACCENT_INFO    = 'var(--accent-info)' as const;
export const COLOR_ACCENT_TEXT    = 'var(--accent-text)' as const;
export const COLOR_ACCENT_SURFACE = 'var(--accent-surface)' as const;
export const COLOR_ACCENT_BORDER  = 'var(--accent-border)' as const;

// ── Raw hex values (for use where var() is not supported, e.g. recharts) ──────
// Dark-mode values are the defaults.

export const RAW = {
  // Surfaces
  surfaceCanvas:   '#0a0e14',
  surfacePrimary:  '#11151d',
  surfaceSecondary:'#161b24',
  surfaceRaised:   '#1a1f2e',
  surfaceMuted:    '#334155',

  // Text
  textPrimary:   '#f5f7fa',
  textSecondary: '#8a93a3',
  textMuted:     '#94a3b8',

  // Borders
  borderPrimary: '#2a3040',
  borderSubtle:  '#1f2630',

  // Accent
  accent:          '#8b5cf6',
  accentHover:     '#7c3aed',
  accentInfo:      '#38bdf8',
  accentSecondary: '#6366f1',
  accentText:      '#c4b5fd',

  // Status (dark)
  statusSuccess: '#34d399',
  statusWarning: '#fbbf24',
  statusDanger:  '#ef4444',
  statusInfo:    '#38bdf8',

  // Gradients
  gradientPrimary: 'linear-gradient(90deg, #38bdf8 0%, #8b5cf6 100%)',
  gradientAccent:  'linear-gradient(135deg, #6366f1 0%, #8b5cf6 100%)',
} as const;

// ── Typography: Font families ─────────────────────────────────────────────────

export const FONT_SANS = 'var(--font-sans)' as const;
export const FONT_MONO = 'var(--font-mono)' as const;

// ── Typography: Font-size scale ───────────────────────────────────────────────

export const TEXT_XS   = 'var(--text-xs)'   as const;  // 0.75rem  / 12px
export const TEXT_SM   = 'var(--text-sm)'   as const;  // 0.875rem / 14px
export const TEXT_BASE = 'var(--text-base)' as const;  // 1rem     / 16px
export const TEXT_LG   = 'var(--text-lg)'   as const;  // 1.125rem / 18px
export const TEXT_XL   = 'var(--text-xl)'   as const;  // 1.25rem  / 20px
export const TEXT_2XL  = 'var(--text-2xl)'  as const;  // 1.5rem   / 24px
export const TEXT_3XL  = 'var(--text-3xl)'  as const;  // 1.875rem / 30px
export const TEXT_4XL  = 'var(--text-4xl)'  as const;  // 2.25rem  / 36px

/** Raw pixel sizes for tools that can't use CSS vars (e.g. canvas, PDF) */
export const TEXT_SIZE_PX = {
  xs:   12,
  sm:   14,
  base: 16,
  lg:   18,
  xl:   20,
  '2xl': 24,
  '3xl': 30,
  '4xl': 36,
} as const;

// ── Typography: Font weights ──────────────────────────────────────────────────

export const FONT_WEIGHT_NORMAL   = 'var(--font-weight-normal)'   as const;
export const FONT_WEIGHT_MEDIUM   = 'var(--font-weight-medium)'   as const;
export const FONT_WEIGHT_SEMIBOLD = 'var(--font-weight-semibold)' as const;
export const FONT_WEIGHT_BOLD     = 'var(--font-weight-bold)'     as const;

export const FONT_WEIGHT = {
  normal:   400,
  medium:   500,
  semibold: 600,
  bold:     700,
} as const;

// ── Typography: Line heights ──────────────────────────────────────────────────

export const LEADING_TIGHT   = 'var(--leading-tight)'   as const;
export const LEADING_SNUG    = 'var(--leading-snug)'    as const;
export const LEADING_NORMAL  = 'var(--leading-normal)'  as const;
export const LEADING_RELAXED = 'var(--leading-relaxed)' as const;
export const LEADING_LOOSE   = 'var(--leading-loose)'   as const;

// ── Spacing — 4 px base grid ──────────────────────────────────────────────────

export const SPACE_1  = 'var(--space-1)'  as const;  //  4px
export const SPACE_2  = 'var(--space-2)'  as const;  //  8px
export const SPACE_3  = 'var(--space-3)'  as const;  // 12px
export const SPACE_4  = 'var(--space-4)'  as const;  // 16px
export const SPACE_5  = 'var(--space-5)'  as const;  // 20px
export const SPACE_6  = 'var(--space-6)'  as const;  // 24px
export const SPACE_8  = 'var(--space-8)'  as const;  // 32px
export const SPACE_10 = 'var(--space-10)' as const;  // 40px
export const SPACE_12 = 'var(--space-12)' as const;  // 48px
export const SPACE_16 = 'var(--space-16)' as const;  // 64px
export const SPACE_24 = 'var(--space-24)' as const;  // 96px

/** Raw pixel values for tools that can't use CSS vars */
export const SPACING_PX = {
  1:  4,
  2:  8,
  3:  12,
  4:  16,
  5:  20,
  6:  24,
  8:  32,
  10: 40,
  12: 48,
  16: 64,
  24: 96,
} as const;

// ── Border radius ─────────────────────────────────────────────────────────────

export const RADIUS_SM   = 'var(--radius-sm)'   as const;
export const RADIUS_MD   = 'var(--radius-md)'   as const;
export const RADIUS_LG   = 'var(--radius-lg)'   as const;
export const RADIUS_XL   = 'var(--radius-xl)'   as const;
export const RADIUS_2XL  = 'var(--radius-2xl)'  as const;
export const RADIUS_FULL = 'var(--radius-full)' as const;
export const RADIUS_PILL = 'var(--radius-pill)' as const;

// ── Shadows ───────────────────────────────────────────────────────────────────

export const SHADOW_SM      = 'var(--shadow-sm)'      as const;
export const SHADOW_MD      = 'var(--shadow-md)'      as const;
export const SHADOW_LG      = 'var(--shadow-lg)'      as const;
export const SHADOW_XL      = 'var(--shadow-xl)'      as const;
export const SHADOW_POPOVER = 'var(--shadow-popover)' as const;
export const FOCUS_RING     = 'var(--focus-ring)'     as const;

// ── Breakpoints ───────────────────────────────────────────────────────────────
// Use these in JS matchMedia / useMediaQuery calls.

export const BREAKPOINTS = {
  sm:  640,
  md:  768,
  lg:  1024,
  xl:  1280,
  '2xl': 1536,
} as const;

export type Breakpoint = keyof typeof BREAKPOINTS;

/** Returns a min-width media query string for the given breakpoint. */
export function mediaQuery(bp: Breakpoint): string {
  return `(min-width: ${BREAKPOINTS[bp]}px)`;
}

// ── Gradients ─────────────────────────────────────────────────────────────────

export const GRADIENT_PRIMARY = 'var(--gradient-primary)' as const;
export const GRADIENT_ACCENT  = 'var(--gradient-accent)'  as const;

// ── Convenience token map (for dynamic lookups) ───────────────────────────────

export const TOKENS = {
  color: {
    primary:    COLOR_PRIMARY,
    secondary:  COLOR_SECONDARY,
    background: COLOR_BACKGROUND,
    surface:    COLOR_SURFACE,
    border:     COLOR_BORDER,
    text: {
      primary:   COLOR_TEXT_PRIMARY,
      secondary: COLOR_TEXT_SECONDARY,
      muted:     COLOR_TEXT_MUTED,
      disabled:  COLOR_TEXT_DISABLED,
    },
    status: {
      success: COLOR_STATUS_SUCCESS,
      warning: COLOR_STATUS_WARNING,
      error:   COLOR_STATUS_DANGER,
      danger:  COLOR_STATUS_DANGER,
      info:    COLOR_STATUS_INFO,
    },
  },
  font: {
    sans: FONT_SANS,
    mono: FONT_MONO,
    size: {
      xs: TEXT_XS, sm: TEXT_SM, base: TEXT_BASE,
      lg: TEXT_LG, xl: TEXT_XL, '2xl': TEXT_2XL,
      '3xl': TEXT_3XL, '4xl': TEXT_4XL,
    },
    weight: FONT_WEIGHT,
  },
  spacing: SPACING_PX,
  radius: {
    sm: RADIUS_SM, md: RADIUS_MD, lg: RADIUS_LG,
    xl: RADIUS_XL, '2xl': RADIUS_2XL, full: RADIUS_FULL,
  },
  shadow: {
    sm: SHADOW_SM, md: SHADOW_MD, lg: SHADOW_LG,
    xl: SHADOW_XL, popover: SHADOW_POPOVER,
  },
  breakpoints: BREAKPOINTS,
} as const;
