# Frontend Visual Regression Testing

This document describes the Playwright-based visual regression suite that guards the frontend's key UI surfaces against unintentional CSS/layout changes, in both the light and dark themes.

---

## Overview

The suite lives at `frontend/tests/visual/` and is driven by its own config, `frontend/playwright.visual.config.ts`, kept separate from the functional e2e suite (`frontend/playwright.config.ts`). Screenshot baselines are tied to a single browser engine and OS rendering stack, so the visual suite runs on Chromium only — mixing it into the functional suite's Chromium+Firefox matrix would double the baselines to maintain without adding regression coverage.

### Covered Surfaces

Each surface is captured in **both `light` and `dark`** themes:

| Surface | Route | Auth state | Spec file |
|---|---|---|---|
| Homepage / landing page | `/` | Unauthenticated | `all-surfaces.visual.spec.ts` |
| Agents list page | `/agents` | Wallet connected (mocked) | `all-surfaces.visual.spec.ts` |
| Agent detail page | `/agents` → modal | Wallet connected (mocked) | `all-surfaces.visual.spec.ts` |
| Task submission wizard — step 1 | `/tasks/new` | Wallet connected (mocked) | `all-surfaces.visual.spec.ts` |
| Task submission wizard — step 2 | `/tasks/new` | Wallet connected (mocked) | `all-surfaces.visual.spec.ts` |
| Task submission wizard — step 3 | `/tasks/new` | Wallet connected (mocked) | `all-surfaces.visual.spec.ts` |
| Task progress tracker | `/tasks/:id` | Wallet connected (mocked), mock WS | `all-surfaces.visual.spec.ts` |
| Payment history table | `/wallet` | Wallet connected (mocked) | `all-surfaces.visual.spec.ts` |
| Admin dashboard | `/dashboard` | Wallet connected (mocked) | `all-surfaces.visual.spec.ts` |
| Dashboard | `/dashboard` | Wallet connected (mocked) | `pages.visual.spec.ts` |
| Task detail | `/tasks/:id` | Wallet connected (mocked), mock WS | `pages.visual.spec.ts` |
| Wallet connect form | `/wallet` | Unauthenticated | `pages.visual.spec.ts` |
| Landing page | `/` | Unauthenticated | `pages.visual.spec.ts` |

### Pixel-Diff Threshold

The allowed pixel difference is **1%** (`maxDiffPixelRatio: 0.01`) per test — enough headroom for sub-pixel anti-aliasing jitter, but not enough to hide a real layout shift or styling regression. This threshold is set:

- Per-test via the `maxDiffPixelRatio` option in `expect(page).toHaveScreenshot(...)` calls in `all-surfaces.visual.spec.ts`
- Globally via `expect.toHaveScreenshot.maxDiffPixelRatio: 0.02` in `playwright.visual.config.ts` (original pages spec — kept at 2% for backward compatibility with existing baselines)

To tighten or loosen the threshold, edit either the per-test call or the global config.

---

## How it works

The dashboard and task-detail tests seed `localStorage` (`wallet_pubkey`, `walletAddress`, `wallet_connection_method`, `wallet_wizard_completed`) before the app boots so `ProtectedRoute` renders the real page instead of redirecting. The task-detail and task-progress-tracker tests also start a local WebSocket listener on port 3001 (mirroring `tests/e2e/task-monitoring.spec.ts`) so the connection-status chip settles on "connected" instead of cycling through reconnect/backoff states.

Dashboard KPI and recent-task data come from MSW handlers in `frontend/src/mocks/handlers.ts` so the page renders deterministic fixture data instead of an empty/error state.

### Stabilizing screenshots

Two sources of nondeterminism are handled explicitly:

- **CSS transitions/animations** — disabled globally via `expect.toHaveScreenshot.animations: 'disabled'` in `playwright.visual.config.ts`.
- **JS-driven motion** (framer-motion) that doesn't check `prefers-reduced-motion` — `tests/visual/utils.ts`'s `preparePage()` sets `prefers-reduced-motion: reduce`, and `waitForMotionToSettle()` adds a fixed post-`networkidle` wait (default 1200ms) so screenshots are taken after transitions have settled rather than mid-flight.

---

## Running locally

```bash
cd frontend
npm run test:visual
```

This starts the Vite dev server (reusing one already running on `:3000`) and runs every visual spec against it, comparing against the committed baselines under `tests/visual/*-snapshots/`.

---

## Baseline Update Process

When an intentional UI change makes existing baselines stale:

### 1. Update baselines locally (Linux only)

```bash
cd frontend
npm run test:visual:update
```

Review the changed PNG files in `frontend/tests/visual/all-surfaces.visual.spec.ts-snapshots/` and `frontend/tests/visual/pages.visual.spec.ts-snapshots/`, then commit them.

### 2. Update baselines via Docker (recommended — guaranteed to match CI)

**Baselines must be generated on Linux with the same browser build CI uses**, or every diff will be dominated by font/anti-aliasing noise instead of the real change. Generate them through the pinned Playwright Docker image (the same image the CI job runs in):

```bash
docker run --rm \
  -v "$(pwd)/..:/work" \
  -w /work/frontend \
  -e TZ=UTC \
  mcr.microsoft.com/playwright:v1.61.0-jammy \
  bash -c "npm ci && npm run test:visual:update"
```

Keep the image tag in sync with:
- The `@playwright/test` version resolved in `frontend/package-lock.json`
- The `container.image` tag in the `frontend-visual-regression` job in `.github/workflows/ci.yml`

A mismatch reintroduces the same rendering drift this setup is meant to avoid.

### 3. Commit the updated baselines

```bash
git add frontend/tests/visual/all-surfaces.visual.spec.ts-snapshots/
git add frontend/tests/visual/pages.visual.spec.ts-snapshots/
git commit -m "chore(visual): update visual regression baselines after <description>"
```

---

## Dark Mode Snapshots

Every surface is captured twice — once in `light` theme and once in `dark` theme. The theme is seeded via `localStorage.setItem('theme-mode', 'dark')` through Playwright's `addInitScript` before the first page load, so `ThemeProvider` picks it up on its very first render.

Dark mode baselines are stored alongside light mode baselines in the same `-snapshots/` directory, using `*-dark.png` naming.

---

## CI Reporting

The `frontend-visual-regression` job in `.github/workflows/ci.yml`:

1. Runs inside the pinned `mcr.microsoft.com/playwright:v1.61.0-jammy` image so its rendering matches the Docker-based baseline update flow above.
2. Runs `npm run test:visual`.
3. Uploads the HTML report (`frontend/playwright-report-visual/`) as the `playwright-visual-report` build artifact on every run (pass or fail).
4. On failure, writes a pointer to that artifact into the job's step summary so reviewers can open `index.html` and see expected/actual/diff images side-by-side.

The job is `continue-on-error: true`: a visual diff is visible on the PR's checks list and via the artifact, but does not block merging. Treat a red run as a prompt to open the report and confirm whether the diff is an intentional UI change (update baselines) or a regression (fix the code).

### Viewing diffs in PR comments

On a failing run:
1. Go to the **Actions** tab → select the workflow run.
2. Download the `playwright-visual-report` artifact.
3. Unzip and open `index.html` — each failing test shows an inline expected/actual/diff comparison.

---

## Adding a New Surface

1. Add a new `test.describe` block in `all-surfaces.visual.spec.ts` following the existing pattern.
2. Run `npm run test:visual:update` (via Docker on Linux) to generate initial baselines.
3. Commit the new baseline PNGs.
4. Update the table in this document.
