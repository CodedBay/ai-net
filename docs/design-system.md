# ai-net Design System

The design system is driven by `frontend/src/styles/tokens.css` and exposed to Tailwind through `frontend/tailwind.config.js`. Components should consume semantic tokens instead of raw colors, radii, shadows, or spacing values.

## Token Groups

| Group | Examples | Usage |
|---|---|---|
| Surface | `--surface-canvas`, `--surface-primary`, `--surface-raised`, `--surface-overlay` | Page backgrounds, panels, popovers, scrims |
| Text | `--text-primary`, `--text-secondary`, `--text-muted`, `--text-inverse` | Body copy, labels, metadata, text on filled accents |
| Border | `--border-primary`, `--border-subtle`, `--border-muted`, `--border-strong` | Input, panel, table, and divider borders |
| Accent | `--accent`, `--accent-info`, `--accent-text`, `--accent-surface`, `--accent-border` | Primary actions, focus states, selected states |
| Status | `--status-success-*`, `--status-warning-*`, `--status-danger-*` | Success, pending, warning, failed, destructive states |
| Agent | `--agent-research`, `--agent-risk`, `--agent-coding`, `--agent-design`, `--agent-report` | Agent labels, badges, timeline markers |
| Layout | `--space-*`, `--radius-*`, `--shadow-*`, `--focus-ring` | Component spacing, shape, elevation, focus treatment |

## Theme Model

The dark theme is defined on `:root` and `.theme-dark`; `.theme-light` overrides the same semantic variables. Components should not branch manually for light and dark themes. Prefer:

```css
.panel {
  background: var(--surface-primary);
  color: var(--text-primary);
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-lg);
  box-shadow: var(--shadow-sm);
}
```

Tailwind names mirror the semantic layer:

```tsx
<section className="bg-surface-primary text-text-primary border border-border-subtle rounded-lg shadow-sm">
  ...
</section>
```

## Component Conventions

Buttons use semantic accent and status tokens. Primary actions use `--gradient-primary` or `--accent`; destructive actions use `--status-danger` and `--status-danger-surface`. Disabled controls use `--text-muted` or `--text-disabled`.

Form fields use `--surface-primary`, `--border-primary`, `--focus-ring`, and status tokens for validation. Use `--radius-lg` or `--radius-xl`; avoid one-off pixel radii.

Cards are for repeated items, modals, and framed tools only. Keep card radius at `--radius-lg` or `--radius-xl`; page sections should be full-width bands or unframed layouts.

Tables, lists, timelines, and dashboards should use `--surface-*`, `--border-*`, and `--text-*` tokens for dense, scan-friendly operational UI.

Agent visuals use the `--agent-*` token set. Do not hard-code agent hex colors in components.

### Agent Tokens and Tailwind

The agent color tokens (`--agent-research`, `--agent-risk`, `--agent-coding`, `--agent-design`, `--agent-report`) and their `-surface` and `-border` variants are **not exposed as named Tailwind classes** in `tailwind.config.js`. This is intentional — the set of agent types is extensible and they are consumed by a small number of components.

**Use inline `style` props with `var()` references** when you need agent token colors in JSX:

```tsx
// ✅ Correct — use inline styles with CSS variables
const capabilityTokens = {
  research: {
    color: 'var(--agent-research)',
    surface: 'var(--agent-research-surface)',
    border: 'var(--agent-research-border)',
  },
  // ...
}

<span
  className="px-2 py-0.5 rounded-full border text-xs"
  style={{ color: tokens.color, backgroundColor: tokens.surface, borderColor: tokens.border }}
>
  research
</span>

// ❌ Wrong — hardcoded hex values that break theming
<span className="text-[#60A5FA] bg-[#60A5FA]/15 border-[#60A5FA]/30">research</span>

// ❌ Wrong — inline hex values
<span style={{ color: '#60A5FA' }}>research</span>
```

For icon colors in demo/marketing components use the same `style={{ color: 'var(--agent-research)' }}` pattern rather than Tailwind arbitrary classes.

If a future refactor warrants exposing agent tokens to Tailwind (e.g., more widespread use across non-landing components), add them to the `colors.agent` section of `tailwind.config.js` following the pattern of the existing `accent` and `status` tokens.

Shadows and glow effects use `--shadow-*`, `--glow-*`, or `--info-glow-*`. Do not add raw `rgba()` shadows in component CSS.

## Review Checklist

Before merging UI changes:

1. Check new CSS/TSX for raw `#hex`, `rgb()`, `rgba()`, one-off shadow values, and arbitrary radii.
2. Confirm any remaining raw values are user content, canvas drawing internals, or a new value that belongs in `tokens.css`.
3. Verify light and dark themes inherit from the same semantic token names.
4. Prefer Tailwind semantic names over arbitrary values when the token exists.

## Dark Mode Color Contrast (WCAG AA)

The dark theme was audited against WCAG 2.1 Success Criterion 1.4.3 (Contrast — Minimum, Level AA).
All values below reflect the tokens in `tokens.css` **after** the audit remediation.

### Requirements applied

| Text type | Minimum ratio |
|---|---|
| Normal text (< 18 px regular or < 14 px bold) | **4.5 : 1** |
| Large text (≥ 18 px regular or ≥ 14 px bold) | **3 : 1** |
| Non-text focus indicators (WCAG 2.2 SC 2.4.11) | **3 : 1** |
| Disabled / inactive controls (WCAG 1.4.3 exception) | exempt |
| Placeholder / hint text (best-effort) | **3 : 1** |

### Dark mode surfaces (reference)

| Token | Hex | Relative luminance |
|---|---|---|
| `--surface-canvas` | `#0a0e14` | 0.003 |
| `--surface-primary` | `#11151d` | 0.007 |
| `--surface-secondary` | `#161b24` | 0.011 |
| `--surface-raised` | `#1a1f2e` | 0.015 |
| `--surface-elevated` | `#1e293b` | 0.022 |
| `--surface-muted` | `#334155` | 0.052 |

### Contrast ratio table — dark mode text tokens

Ratios are measured against the surfaces on which each token is used in practice.
Cells marked **–** indicate the combination does not occur in the UI.
"large" = large-text threshold (3 : 1) is sufficient; "AA" = normal-text threshold (4.5 : 1).

| Token | Hex (post-audit) | canvas | primary | secondary | raised | elevated | muted | Notes |
|---|---|---|---|---|---|---|---|---|
| `--text-primary` | `#f5f7fa` | 18.0 AA | 17.0 AA | 16.1 AA | 15.3 AA | 13.6 AA | 9.7 AA | — |
| `--text-secondary` | `#9ba3b5` *(was #8a93a3)* | 7.6 AA | 7.2 AA | 6.8 AA | 6.5 AA | 5.8 AA | 4.1 large | Not used on muted; large-only acceptable |
| `--text-muted` | `#a8b4c8` *(was #94a3b8)* | 9.2 AA | 8.7 AA | 8.2 AA | 7.8 AA | 7.0 AA | 4.9 AA | — |
| `--text-subtle` | `rgba(148,163,184, **0.75**)` *(was 0.60)* | 4.7 AA | 4.5 AA | 4.4 large | 4.2 large | 3.9 large | 3.0 large | Placeholder/hint text |
| `--text-disabled` | `rgba(148,163,184, 0.35)` | ~2.1 | ~2.0 | ~1.8 | ~1.8 | ~1.6 | ~1.1 | **Exempt** — WCAG 1.4.3 inactive-UI exception |
| `--accent` | `#9d72fa` *(was #8b5cf6)* | 5.7 AA | 5.4 AA | 5.1 AA | 4.9 AA | 4.3 large | 3.1 large | On elevated/muted: large icon/heading only |
| `--accent-info` | `#38bdf8` | 9.0 AA | 8.5 AA | 8.1 AA | 7.7 AA | 6.8 AA | 4.8 AA | — |
| `--accent-text` | `#c4b5fd` | 10.5 AA | 9.9 AA | 9.4 AA | 8.9 AA | 7.9 AA | 5.6 AA | — |
| `--accent-text-strong` | `#a78bfa` | 7.6 AA | 7.2 AA | 6.8 AA | 6.4 AA | 5.7 AA | 4.1 large | — |
| `--status-success` | `#34d399` | 10.1 AA | 9.5 AA | 9.0 AA | 8.5 AA | 7.6 AA | 5.4 AA | — |
| `--status-warning` | `#fbbf24` | 11.6 AA | 11.0 AA | 10.3 AA | 9.8 AA | 8.8 AA | 6.2 AA | — |
| `--status-danger` | `#f47474` *(was #ef4444)* | 7.0 AA | 6.6 AA | 6.3 AA | 5.9 AA | 5.3 AA | 3.8 large | On muted: large icon only |
| `--status-success-text` | `#a7f3d0` | 10.9 AA | 10.3 AA | 9.7 AA | 9.2 AA | 8.2 AA | 5.8 AA | Used inside tinted chip |
| `--status-warning-text` | `#fde68a` | 13.3 AA | 12.6 AA | 11.9 AA | 11.3 AA | 10.1 AA | 7.1 AA | Used inside tinted chip |
| `--status-danger-text` | `#fca5a5` | 8.3 AA | 7.8 AA | 7.4 AA | 7.0 AA | 6.3 AA | 4.4 large | Used inside tinted chip |
| `--agent-design` | `#f472b6` | 6.3 AA | 5.9 AA | 5.6 AA | 5.3 AA | 4.7 AA | 3.4 large | Large badge text — 3:1 threshold |

### Focus ring

| Token | Base colour | canvas | primary | secondary | Requirement |
|---|---|---|---|---|---|
| `--focus-ring` | `#6366f1` (indigo 500) | 4.3 large | 4.0 large | 3.8 large | ≥ 3:1 non-text indicator — **PASS** |

> The `--focus-ring` box-shadow spreads at 15 % opacity for a soft glow effect; the hard
> 3 px outline uses the element's own border colour, which is `#6366f1` at full opacity.

### Tokens changed by this audit

| Token | Old value | New value | Reason |
|---|---|---|---|
| `--text-secondary` | `#8a93a3` | `#9ba3b5` | Failed 4.5:1 on primary surface (was 4.07) |
| `--text-muted` | `#94a3b8` | `#a8b4c8` | Failed 4.5:1 on muted surface (was 4.04) |
| `--accent` | `#8b5cf6` | `#9d72fa` | Failed 4.5:1 on primary surface when used as text (was 4.32) |
| `--accent-hover` | `#7c3aed` | `#8b5cf6` | Original accent shifted to hover shade; visual continuity preserved |
| `--status-danger` | `#ef4444` | `#f47474` | Failed 4.5:1 on raised surface when used as text (was 4.36) |
| `--text-subtle` (alpha) | `rgba(148,163,184, 0.60)` | `rgba(148,163,184, 0.75)` | Failed 3:1 placeholder threshold on canvas (was 3.54 → need 4.5 for normal, 3:1 for placeholder) |

### Audit methodology

1. Extracted all CSS custom property values from `tokens.css` dark-mode block (`:root` / `.theme-dark`).
2. Computed WCAG 2.1 relative luminance using the standard sRGB formula for each solid colour.
3. For `rgba()` tokens, alpha-composited each foreground over each candidate background before computing luminance.
4. Calculated contrast ratio `(L_lighter + 0.05) / (L_darker + 0.05)` for every text × surface pair that occurs in the UI.
5. Identified failures against the 4.5:1 (normal text) and 3:1 (large text / non-text indicators) thresholds.
6. Adjusted failing tokens to the minimum value required for compliance while preserving visual brand character.
7. Automated the matrix as a Playwright unit test in `frontend/tests/e2e/accessibility.spec.ts` (pure-JS, no browser needed) so future token edits are caught in CI. Per-route axe-core scans cover rendered contrast in the live DOM.
