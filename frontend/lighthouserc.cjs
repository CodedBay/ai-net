/**
 * Lighthouse CI configuration for ai-net frontend.
 *
 * Enforced gates (CI fails if violated):
 *   - Performance:     >= 90
 *   - Accessibility:   >= 95
 *   - Best Practices:  >= 95
 *   - SEO:             >= 90
 *
 * Core Web Vitals thresholds (CI fails if violated):
 *   - LCP (Largest Contentful Paint):  < 2500ms
 *   - CLS (Cumulative Layout Shift):   < 0.1
 *   - TBT (Total Blocking Time):       < 200ms
 *
 * Bundle size budget (CI fails if violated):
 *   - JavaScript (main chunk):   < 200KB gzipped
 *   - Total resources:           < 500KB
 *
 * Routes tested:
 *   - /        (Landing page — primary entry point)
 *   - /agents  (Agent registry browser — public browsing page)
 */

module.exports = {
  ci: {
    collect: {
      // Use production build served via vite preview.
      startServerCommand: 'npx vite preview --host 0.0.0.0 --port 4173',
      startServerReadyPattern: 'Local:',
      url: [
        'http://localhost:4173/',
        'http://localhost:4173/agents',
      ],
      numberOfRuns: 3,
      // Chromium flags for headless CI environments.
      settings: {
        chromeFlags: '--no-sandbox --disable-gpu --disable-dev-shm-usage',
      },
    },
    assert: {
      assertions: {
        // ── Score gates (hard — CI fails if violated) ─────────────────
        'categories:performance':    ['error', { minScore: 0.90 }],
        'categories:accessibility':  ['error', { minScore: 0.95 }],
        'categories:best-practices': ['error', { minScore: 0.95 }],
        'categories:seo':            ['error', { minScore: 0.90 }],

        // ── Core Web Vitals (hard — CI fails if violated) ─────────────
        // LCP: Largest Contentful Paint < 2.5s
        'largest-contentful-paint': ['error', { maxNumericValue: 2500 }],
        // CLS: Cumulative Layout Shift < 0.1
        'cumulative-layout-shift': ['error', { maxNumericValue: 0.1 }],
        // TBT: Total Blocking Time < 200ms (proxy for FID/INP in lab)
        'total-blocking-time': ['error', { maxNumericValue: 200 }],
        // FCP: First Contentful Paint < 1.8s
        'first-contentful-paint': ['warn', { maxNumericValue: 1800 }],
        // Speed Index < 3.4s
        'speed-index': ['warn', { maxNumericValue: 3400 }],
        // Time to Interactive < 3.8s
        'interactive': ['warn', { maxNumericValue: 3800 }],

        // ── Bundle size budget (hard — CI fails if violated) ──────────
        // Main JS chunk < 200KB (uncompressed; Lighthouse reports transfer size)
        'resource-summary:script:size': ['error', { maxNumericValue: 204800 }],
        // Total page weight < 500KB
        'resource-summary:total:size': ['error', { maxNumericValue: 512000 }],

        // ── Additional resource budgets (informational) ────────────────
        'resource-summary:image:size': ['warn', { maxNumericValue: 153600 }],
        'resource-summary:font:size':  ['warn', { maxNumericValue: 51200 }],

        // ── Accessibility audit failures (hard) ────────────────────────
        'color-contrast':          ['error', { minScore: 1 }],
        'image-alt':               ['error', { minScore: 1 }],
        'label':                   ['error', { minScore: 1 }],
        'link-name':               ['error', { minScore: 1 }],
        'html-has-lang':           ['error', { minScore: 1 }],

        // ── SEO fundamentals (hard) ────────────────────────────────────
        'meta-description':        ['error', { minScore: 1 }],
        'document-title':          ['error', { minScore: 1 }],
        'viewport':                ['error', { minScore: 1 }],

        // ── Security & best-practice audits (hard) ─────────────────────
        'uses-https':              ['error', { minScore: 1 }],
        'is-on-https':             ['warn', { minScore: 1 }],
        'no-vulnerable-libraries': ['error', { minScore: 1 }],
        'csp-xss':                 ['warn', { minScore: 1 }],
      },
    },
    upload: {
      // Store results as GitHub Actions artifacts for trend analysis.
      // Falls back to temporary public storage when LHCI_GITHUB_APP_TOKEN
      // is not configured.
      target: 'filesystem',
      outputDir: '.lighthouseci',
    },
    server: {
      // Port used by vite preview during CI collection.
      port: 4173,
    },
  },
}
