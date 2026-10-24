# 🚀 Contributor Onboarding Checklist

> **Target audience**: First-time open source contributors, students, and hackathon participants making their first PR to ai-net.
>
> This checklist walks you from a fresh clone to a merged pull request. Each section has a time estimate so you know what to expect.

---

## Table of Contents

- [Before You Start](#before-you-start)
- [Step 1: Environment Setup](#step-1-environment-setup-⏱-15-30-min)
- [Step 2: Find a Good First Issue](#step-2-find-a-good-first-issue-⏱-5-10-min)
- [Step 3: Create Your Branch](#step-3-create-your-branch-⏱-2-min)
- [Step 4: Make Your Changes](#step-4-make-your-changes-⏱-varies)
- [Step 5: Write and Run Tests](#step-5-write-and-run-tests-⏱-15-30-min)
- [Step 6: Commit Your Changes](#step-6-commit-your-changes-⏱-5-min)
- [Step 7: Open a Pull Request](#step-7-open-a-pull-request-⏱-10-min)
- [Step 8: Respond to Review Feedback](#step-8-respond-to-review-feedback-⏱-varies)
- [Common Mistakes That Block Merge](#common-mistakes-that-block-merge)
- [Getting Help](#getting-help)

---

## Before You Start

- [ ] Read the [README](../README.md) to understand what ai-net does *(5 min)*
- [ ] Read [CONTRIBUTING.md](../CONTRIBUTING.md) for the full SDLC and code quality standards *(10 min)*
- [ ] Read [AGENTS.md](../AGENTS.md) if you are an AI coding agent *(5 min)*
- [ ] Star the repository so you can find it again
- [ ] Create a [GitHub account](https://github.com/join) if you do not have one

---

## Step 1: Environment Setup ⏱ 15–30 min

### 1.1 Prerequisites

- [ ] Install **Node.js ≥ 20** — [download](https://nodejs.org/en/download)
- [ ] Install **Docker & Docker Compose** — [download](https://www.docker.com/products/docker-desktop)
- [ ] Install **Git** — [download](https://git-scm.com/downloads)
- [ ] Install **Rust** (only needed for smart contract changes) — [download](https://rustup.rs/)

Verify your setup:

```bash
node --version   # must be >= 20
docker --version
git --version
rustc --version  # only needed for smart contracts
```

### 1.2 Fork and Clone

- [ ] **Fork** the repository: click **Fork** on [github.com/CodedSceptre/ai-net](https://github.com/CodedSceptre/ai-net)
- [ ] Clone your fork:

```bash
git clone https://github.com/<YOUR_USERNAME>/ai-net.git
cd ai-net
```

- [ ] Add the upstream remote:

```bash
git remote add upstream https://github.com/CodedSceptre/ai-net.git
git remote -v  # should show both origin (your fork) and upstream
```

### 1.3 Install Dependencies

```bash
npm install
cp .env.example .env
# Open .env and fill in STELLAR_SECRET_KEY and VENICE_API_KEY
# For local dev you can use placeholder values for non-blockchain features
```

### 1.4 Verify the Setup Passes the Quality Gate

```bash
npm run gate
```

If this command exits without errors, your environment is ready. If it fails, see the [troubleshooting guide](docs/DEVELOPER_SETUP.md).

---

## Step 2: Find a Good First Issue ⏱ 5–10 min

- [ ] Browse [good first issues](https://github.com/CodedSceptre/ai-net/issues?q=label%3A%22good+first+issue%22) on the upstream repo
- [ ] Read [ISSUES.md](../ISSUES.md) for a curated list of open tasks
- [ ] Leave a comment on the issue: *"I'd like to work on this"* — this prevents duplicate effort
- [ ] Wait for a maintainer to assign the issue to you before starting

> **Tip**: Issues labeled `good first issue` + `documentation` require no code changes and are the fastest path to a first merged PR.

---

## Step 3: Create Your Branch ⏱ 2 min

Always branch from the **latest upstream main**, not from your fork's main:

```bash
# Sync with upstream first
git fetch upstream
git checkout main
git merge upstream/main

# Create your branch (follow the naming convention below)
git checkout -b docs/cross-chain-bridge-guide-461
```

### Branch Naming Convention

| Type | Format | Example |
|---|---|---|
| Feature | `feat/<short-name>-<issue>` | `feat/paginated-registry-339` |
| Bug fix | `fix/<short-name>-<issue>` | `fix/cursor-nonce-recovery-241` |
| Documentation | `docs/<topic>-<issue>` | `docs/node-operators-guide-342` |
| Test | `test/<suite>-<issue>` | `test/e2e-escrow-flow-180` |
| Refactor | `refactor/<name>-<issue>` | `refactor/venice-client-pool-400` |

- [ ] Branch name follows the convention above
- [ ] Branch is cut from the latest `upstream/main`

---

## Step 4: Make Your Changes ⏱ varies

- [ ] Make only the changes described in the issue — avoid scope creep
- [ ] Follow the existing code style (TypeScript for backend/frontend, Rust for contracts)
- [ ] Do not hardcode credentials, API keys, or testnet private keys
- [ ] Update documentation if you change a public API or contract interface
- [ ] Keep each commit focused — one logical change per commit

### Code Style Quick Reference

| Area | Standard |
|---|---|
| TypeScript | ESLint + Prettier (run `npm run format:fix`) |
| Rust | `cargo fmt --all` |
| Commit messages | [Conventional Commits](https://www.conventionalcommits.org/) (see Step 6) |
| File names | `kebab-case` for TypeScript, `snake_case` for Rust |

---

## Step 5: Write and Run Tests ⏱ 15–30 min

Every code change needs tests. Documentation-only changes are exempt.

- [ ] Write unit tests covering the happy path
- [ ] Write at least one test for error/edge cases
- [ ] Run the full quality gate and confirm it passes:

```bash
# Root quality gate (format + lint + typecheck + coverage)
npm run gate

# Or run only the relevant layer:
cd backend && npm test          # backend unit tests
cd frontend && npm test         # frontend unit tests
cd smart-contracts && cargo test  # Soroban contract tests
```

- [ ] Coverage has not dropped below the existing threshold (≥ 75% backend, ≥ 70% frontend)

---

## Step 6: Commit Your Changes ⏱ 5 min

ai-net uses [Conventional Commits](https://www.conventionalcommits.org/). Every commit must follow this format:

```
<type>(<scope>): <short description in present tense> (#<issue>)

[optional body: why was this change needed?]

[optional footer]
Resolves #<issue>
```

### Commit Message Examples

```bash
# Documentation
git commit -m "docs(contracts): expand cross-chain bridge integration guide (#461)"

# Feature
git commit -m "feat(backend): add paginated agent listing endpoint (#339)"

# Bug fix
git commit -m "fix(contracts): floor bond slash at zero to prevent underflow (#388)"

# Test
git commit -m "test(load): add WebSocket 500-connection stress test (#460)"
```

### Allowed Types

| Type | When to use |
|---|---|
| `feat` | New feature |
| `fix` | Bug fix |
| `docs` | Documentation only |
| `test` | Adding or fixing tests |
| `refactor` | Code restructuring (no behavior change) |
| `perf` | Performance improvement |
| `chore` | Maintenance, dependency bumps |
| `ci` | CI/CD workflow changes |

### Allowed Scopes

`contracts`, `backend`, `frontend`, `sdk`, `docs`, `ci`

- [ ] Commit message follows Conventional Commits format
- [ ] Commit message references the issue number
- [ ] No secrets or `.env` files are staged (`git status` to verify)

---

## Step 7: Open a Pull Request ⏱ 10 min

- [ ] Push your branch to your fork:

```bash
git push -u origin docs/cross-chain-bridge-guide-461
```

- [ ] Open a PR from your fork to `CodedSceptre/ai-net` `main`
- [ ] Use the PR template (`.github/pull_request_template.md`) — it pre-fills when you open the PR on GitHub
- [ ] PR title follows Conventional Commits format (same as your commit message)
- [ ] PR description includes:
  - [ ] **Summary** — what was changed and why
  - [ ] **Testing** — how it was verified
  - [ ] `Resolves #<issue>` in the footer to auto-close the issue on merge
- [ ] All CI checks are green before requesting review

### PR Title Examples

```
docs(contracts): expand cross-chain bridge integration guide (#461)
feat(backend): add paginated agent listing with cursor (#339)
fix(contracts): prevent bond underflow on double-slash (#388)
```

---

## Step 8: Respond to Review Feedback ⏱ varies

- [ ] Check your PR for reviewer comments within **3 business days**
- [ ] Reply to every comment — even if just "Done" or "Good point, updated"
- [ ] Push additional commits to the same branch (do **not** force-push unless asked)
- [ ] Re-request review after addressing all comments
- [ ] Do not close and re-open the PR — update the existing one

> **Tip**: If a reviewer asks for significant changes, ask for clarification before starting. A short back-and-forth question can save hours of rework.

---

## Common Mistakes That Block Merge

| Mistake | Symptom | How to Fix |
|---|---|---|
| Wrong commit message format | CI lint check fails | Follow Conventional Commits exactly: `type(scope): description (#issue)` |
| Branch not cut from `upstream/main` | Merge conflicts with unrelated changes | `git fetch upstream && git rebase upstream/main` |
| Missing test coverage | Coverage CI check fails | Add unit tests; run `npm run test:coverage` |
| Hardcoded secrets in diff | Security scan fails | Move secrets to `.env`; add key names to `.gitignore` |
| PR fixes more than the issue asked for | Scope creep; reviewer pushback | Open a separate issue/PR for unrelated improvements |
| No `Resolves #<issue>` in PR description | Issue stays open after merge | Add `Resolves #<issue>` to the PR description footer |
| Force-pushing without being asked | Overwrites reviewer's context | Use `git push` without `--force`; only force-push if a maintainer asks |
| Touching files outside the issue scope | Unnecessary CI runs; review delay | Revert unrelated changes; `git diff` to verify |
| `npm run gate` not run locally before push | CI fails on the first push | Always run `npm run gate` before `git push` |
| Missing issue reference in branch name | Harder to track across the project | Rename with `git branch -m <new-name>` before pushing |

---

## Getting Help

- **GitHub Discussions**: Ask questions at [github.com/CodedSceptre/ai-net/discussions](https://github.com/CodedSceptre/ai-net/discussions)
- **Issue comments**: Post questions directly on the issue you are working on
- **Developer setup**: See [docs/DEVELOPER_SETUP.md](docs/DEVELOPER_SETUP.md) for environment troubleshooting
- **Smart contract questions**: See [smart-contracts/CONTRIBUTING.md](../smart-contracts/CONTRIBUTING.md)

> **First PR stuck?** Drop a comment on the issue with what you have tried. Maintainers aim to respond within 24–48 hours.

---

## Further Reading

- [CONTRIBUTING.md](../CONTRIBUTING.md) — Full SDLC, review expectations, quality gate commands
- [AGENTS.md](../AGENTS.md) — Architectural invariants and commit hygiene for AI coding agents
- [docs/DEVELOPER_SETUP.md](docs/DEVELOPER_SETUP.md) — Fast day-one setup guide
- [smart-contracts/docs/cross-chain.md](../smart-contracts/docs/cross-chain.md) — Cross-chain bridge integration guide
- [Conventional Commits spec](https://www.conventionalcommits.org/) — Commit message standard
