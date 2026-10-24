# Visual Regression Test Baselines

This directory contains Playwright visual regression tests for the ai-net frontend.

## Coverage

Every test runs at three viewport widths (mobile 375 px, tablet 768 px, desktop 1440 px)
and in both light and dark themes. Surfaces covered:

| Surface | Route | Auth |
|---|---|---|
| Landing page | `/` | Unauthenticated |
| Dashboard | `/dashboard` | Wallet connected (mocked) |
| Task detail — all 4 states (pending/running/completed/failed) | `/tasks/:id` | Connected + mock WebSocket |
| Task submission wizard — all 3 steps | `/tasks/new` | Connected |
| Agent registry list view | `/agents` | Connected |
| Agent detail modal | `/agents` | Connected |
| Task / payment history | `/tasks/history` | Connected |
| Wallet — not connected | `/wallet` | Unauthenticated |
| Wallet — connected | `/wallet` | Connected |
| Error boundary fallback | `/dashboard?__trigger_error=1` | Connected |
| 404 not found | `/this-route-does-not-exist-404` | Any |

## Running locally

```bash
cd frontend
npm run test:visual
```

Starts the Vite dev server (reusing an existing one on `:3000`) and compares
every snapshot against the committed baselines.

## Updating baselines

Run this after an **intentional** UI change to regenerate the reference PNGs:

```bash
cd frontend
npm run test:visual:update
```

**Baselines must be generated on Linux using the same Playwright Docker image
that CI uses**, or font/anti-aliasing differences will dominate the diff.
Use the pinned image to regenerate from any OS:

```bash
docker run --rm -v "$(pwd)/..:/work" -w /work/frontend \
  -e TZ=UTC \
  mcr.microsoft.com/playwright:v1.61.0-jammy \
  bash -c "npm ci && npm run test:visual:update"
```

After regenerating, review the changed PNGs with `git diff --stat` and commit
them together with the code change that caused the diff.

## Diff threshold

`maxDiffPixelRatio: 0.001` — at most **0.1 %** of pixels may differ between
the baseline and the current screenshot before the test fails. This is tight
enough to catch real layout/color regressions while allowing for minor
sub-pixel font-rendering variation between identical Linux builds.

The threshold is set in `frontend/playwright.visual.config.ts`.

## Baseline location

Baselines are stored under `tests/visual/pages.visual.spec.ts-snapshots/`
and versioned in git alongside the spec files. The snapshot directory name
includes the spec filename so it is obvious which file owns which baselines.

## CI

The `frontend-visual-regression` job in `.github/workflows/ci.yml` runs inside
the pinned `mcr.microsoft.com/playwright` image (same fonts, same rendering).
It uploads the HTML report as the `playwright-visual-report` artifact on every
run so you can inspect expected/actual/diff images directly in the GitHub UI.

A failure means a visual diff exceeded the 0.1 % threshold. Open the report
artifact and determine whether the diff is:

- **Intentional** — update baselines with `npm run test:visual:update` and
  commit the new PNGs.
- **A regression** — fix the code change that caused the diff.
