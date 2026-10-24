# Staging Environment — Rollback Guide

This document describes how to roll back the staging deployment to a previous
Docker image when a deployment produces a broken staging environment.

---

## Overview

Every successful staging deployment records the short commit SHA in
`staging/LAST_DEPLOYED_SHA` (committed to `main` automatically by the
`staging-deploy.yml` workflow with `[skip ci]`). Images are tagged
`sha-<SHORT_SHA>` and pushed to GHCR with a 30-day retention policy, so any
of the last ~20 successful images can be rolled back to immediately.

---

## Finding the last good SHA

```bash
# Option 1 — read the tracked file
cat staging/LAST_DEPLOYED_SHA

# Option 2 — list recent backend images from GHCR
gh api /orgs/NancieDev/packages/container/ai-net%2Fbackend/versions \
  --paginate --jq '.[].metadata.container.tags[]' | grep "^sha-"

# Option 3 — check workflow run history
gh run list --workflow staging-deploy.yml --status success --limit 10
```

---

## Rolling back via workflow_dispatch

The fastest rollback path is re-running the staging workflow with a specific
SHA:

1. Go to **Actions → Staging Deployment**.
2. Click **Run workflow**.
3. Enter the target commit SHA in the **sha** field (e.g. `a1b2c3d`).
4. Click **Run workflow**.

The workflow will rebuild the image (or find it cached in GHCR), redeploy it,
and run smoke tests. If smoke tests pass the deployment is recorded.

---

## Rolling back manually via SSH

If the workflow is unavailable (e.g. CI infrastructure is down), SSH into the
staging host and restart containers with the previous image tag:

```bash
# SSH into staging host
ssh <STAGING_SSH_USER>@<STAGING_SSH_HOST>

# Identify the last known-good tag
ROLLBACK_SHA="<SHORT_SHA_FROM_LAST_DEPLOYED_SHA>"
REGISTRY="ghcr.io/<YOUR_ORG>/ai-net"
BACKEND_IMAGE="${REGISTRY}/backend:sha-${ROLLBACK_SHA}"
FRONTEND_IMAGE="${REGISTRY}/frontend:sha-${ROLLBACK_SHA}"

# Log in to GHCR (use a personal access token with read:packages scope)
echo "<PAT>" | docker login ghcr.io -u <GITHUB_USERNAME> --password-stdin

# Pull the rollback images
docker pull "${BACKEND_IMAGE}"
docker pull "${FRONTEND_IMAGE}"

# Restart backend
docker stop ai-net-staging-backend
docker rm   ai-net-staging-backend
docker run -d \
  --name ai-net-staging-backend \
  --network ai-net-staging \
  --restart unless-stopped \
  -p 3000:3000 \
  -v /opt/ai-net/staging/data:/app/data \
  -e NODE_ENV=staging \
  -e PORT=3000 \
  -e DATABASE_URL="sqlite:///app/data/ai_net.db" \
  -e STELLAR_HORIZON_URL="https://horizon-testnet.stellar.org" \
  -e STELLAR_NETWORK=testnet \
  -e SOROBAN_RPC_URL="https://soroban-testnet.stellar.org" \
  -e VENICE_API_KEY="${VENICE_API_KEY}" \
  "${BACKEND_IMAGE}"

# Restart frontend
docker stop ai-net-staging-frontend
docker rm   ai-net-staging-frontend
docker run -d \
  --name ai-net-staging-frontend \
  --network ai-net-staging \
  --restart unless-stopped \
  -p 5173:5173 \
  -e VITE_API_BASE_URL=https://staging.ai-net.dev \
  -e VITE_STELLAR_NETWORK=testnet \
  -e VITE_SOROBAN_RPC_URL="https://soroban-testnet.stellar.org" \
  "${FRONTEND_IMAGE}"

# Verify
curl -s https://staging.ai-net.dev/health | python3 -m json.tool
```

---

## Verifying rollback health

After any rollback (manual or via workflow), confirm the smoke tests pass:

```bash
# /health must return 200
curl -s -o /dev/null -w "%{http_code}" https://staging.ai-net.dev/health

# /metrics must contain ainet_up 1
curl -s https://staging.ai-net.dev/metrics | grep "ainet_up 1"

# /api/agents must return 200
curl -s -o /dev/null -w "%{http_code}" https://staging.ai-net.dev/api/agents
```

All three commands should output `200` / the metric line.

---

## Staging environment details

| Property | Value |
|---|---|
| Backend URL | `https://staging.ai-net.dev` |
| Frontend URL | `https://staging.ai-net.dev` (served by Nginx on the same VM) |
| Stellar Network | Testnet (`horizon-testnet.stellar.org`) |
| Database | SQLite at `/opt/ai-net/staging/data/ai_net.db` on the staging VM |
| Docker registry | `ghcr.io/<ORG>/ai-net/backend` and `.../frontend` |
| Image retention | 30 days in GHCR |

---

## Required secrets (GitHub repository → Settings → Secrets)

| Secret | Description |
|---|---|
| `STAGING_SSH_HOST` | Staging VM IP or hostname |
| `STAGING_SSH_USER` | SSH username (e.g. `ubuntu`) |
| `STAGING_SSH_KEY` | PEM private key for SSH |
| `STAGING_VENICE_API_KEY` | Venice AI key for staging |
| `SLACK_WEBHOOK_URL` | Slack incoming webhook (optional) |
