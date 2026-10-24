# 🛠️ AI-Net Developer Onboarding & Local Setup Guide

Welcome to **AI-Net**! This guide takes you from a clean machine checkout to a fully running multi-agent platform and local/testnet development environment in minutes.

---

## 1. System Prerequisites

Install the following foundational toolchains before starting:

| Tool | Recommended Version | Purpose | Installation Guide |
|---|---|---|---|
| **Node.js** | `v20.x LTS` (or `v22.x`) | Backend API & Next.js Frontend | [nodejs.org](https://nodejs.org/) |
| **npm** | `v10.x+` | Package management | Included with Node.js |
| **Rust & Cargo** | `v1.80.0+` | Soroban Smart Contracts | `curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs \| sh` |
| **WASM Target** | `wasm32-unknown-unknown` | Compiling Rust to WebAssembly | `rustup target add wasm32-unknown-unknown` |
| **Stellar CLI** | `v21.x+` | Soroban contract deployments & RPC | `cargo install --locked stellar-cli --features opt` |
| **Docker & Compose** | `v24.x+` / Compose `v2.x+` | PostgreSQL, Redis, and local node | [docker.com](https://www.docker.com/) |

---

## 2. Quick Start (All-in-One Local Setup)

### Step 1: Clone Repository
```bash
git clone https://github.com/Epta-Node/ai-net.git
cd ai-net
```

### Step 2: Configure Environment Variables
Copy the example environment configurations:

```bash
cp backend/.env.example backend/.env
cp frontend/.env.example frontend/.env.local
```

Default local `.env` values:
```ini
# Backend configuration (.env)
PORT=3000
DATABASE_URL=postgresql://postgres:postgres@localhost:5432/ai_net_dev
REDIS_URL=redis://localhost:6379
STELLAR_NETWORK=testnet
STELLAR_RPC_URL=https://soroban-testnet.stellar.org
VENICE_API_KEY=mock_local_key
```

### Step 3: Start Infrastructure via Docker Compose
Start PostgreSQL 16 and Redis 7 in the background:

```bash
docker-compose up -d postgres redis
```

### Step 4: Install Dependencies & Run Database Migrations
```bash
# Install root, backend, and frontend packages
npm install
cd backend && npm install && cd ../frontend && npm install && cd ..

# Run backend DB migrations
cd backend && npm run db:migrate && cd ..
```

### Step 5: Start Development Servers
```bash
# In Terminal 1 — Backend API:
cd backend && npm run dev

# In Terminal 2 — Frontend Web App:
cd frontend && npm run dev
```

* **Backend API**: `http://localhost:3000` (`http://localhost:3000/health`)
* **Frontend Web App**: `http://localhost:3001` (or `http://localhost:3000`)

---

## 3. Stellar Soroban Smart Contract Development

### 3.1 Build Smart Contracts
Compile all smart contracts to optimized WebAssembly (`.wasm`):

```bash
cd smart-contracts
cargo build --target wasm32-unknown-unknown --release
```

### 3.2 Run Smart Contract Tests
Execute the Rust unit and contract invariant test suite:

```bash
cargo test
```

### 3.3 Deploy to Stellar Testnet

1. **Generate a Developer Keypair**:
   ```bash
   stellar keys generate alice --network testnet
   ```

2. **Fund Keypair via Friendbot Faucet**:
   ```bash
   stellar keys fund alice --network testnet
   # Or using curl:
   curl "https://friendbot.stellar.org?addr=$(stellar keys address alice)"
   ```

3. **Deploy Agent Registry & Escrow Contracts**:
   ```bash
   # Deploy Agent Registry
   stellar contract deploy \
     --wasm target/wasm32-unknown-unknown/release/agent_registry.wasm \
     --source alice \
     --network testnet
   ```

---

## 4. Wallet Setup (Freighter Browser Extension)

For the dedicated 10-minute guide, including testnet funding alternatives,
network verification, mobile-wallet limitations, and troubleshooting, see the
[Freighter Wallet Setup Guide](WALLET_SETUP.md).

To test the frontend with on-chain payments:

1. Install the **[Freighter Wallet Extension](https://www.freighter.app/)** for Chrome / Firefox / Brave.
2. In Freighter Settings, toggle the network to **Testnet**.
3. Copy your public key (`G...`) and fund it using Friendbot:
   ```bash
   curl "https://friendbot.stellar.org?addr=<YOUR_FREIGHTER_PUBLIC_KEY>"
   ```
4. Connect Freighter to the frontend at `http://localhost:3001`.

---

## 5. Running the Automated Test Suite

AI-Net uses a multi-tier testing pipeline:

```bash
# 1. Run Backend Unit & Integration Tests:
cd backend && npm test

# 2. Run Frontend Unit Tests:
cd frontend && npm test

# 3. Run Smart Contract Tests:
cd smart-contracts && cargo test

# 4. Run End-to-End Pipeline Tests:
cd backend && npm run test:e2e
```

---

## 6. Operating System Quirks & Troubleshooting

### 🐧 Linux (Ubuntu / Debian / Arch / Fedora)
* **Docker permissions**: Ensure your user is in the `docker` group (`sudo usermod -aG docker $USER && newgrp docker`).
* **File Watcher Limits**: If `npm run dev` fails with `ENOSPC`, increase inotify watchers:
  ```bash
  echo fs.inotify.max_user_watches=524288 | sudo tee -a /etc/sysctl.conf && sudo sysctl -p
  ```

### 🍏 macOS (Apple Silicon M1/M2/M3)
* **Rust WASM target**: Install Xcode command line tools (`xcode-select --install`).
* **Docker Colima / OrbStack**: Ensure port forwarding is enabled for `5432` and `6379`.

### 🪟 Windows (WSL2 Required)
* **Always run inside WSL2 (Ubuntu)**: Avoid running Node/Rust in native Windows CMD/PowerShell to prevent path and symlink issues.
* **Git Line Endings**: Configure autocrlf to prevent newline mismatches in bash scripts:
  ```bash
  git config --global core.autocrlf input
  ```

---

## 7. Staging Environment

Every merge to `main` that passes CI is automatically deployed to the shared staging environment by `.github/workflows/staging-deploy.yml`. This section explains how the pipeline works and how to configure the required secrets.

### How it works

1. The `CI` workflow completes successfully on `main`.
2. The `Staging Deployment` workflow triggers automatically via `workflow_run`.
3. Multi-arch Docker images (`linux/amd64` + `linux/arm64`) are built for frontend and backend and pushed to GitHub Container Registry (GHCR):
   - `ghcr.io/<owner>/ai-net/frontend:staging` (latest)
   - `ghcr.io/<owner>/ai-net/frontend:sha-<commit>` (immutable)
   - `ghcr.io/<owner>/ai-net/backend:staging` (latest)
   - `ghcr.io/<owner>/ai-net/backend:sha-<commit>` (immutable)
4. Smart contracts are deployed to Stellar testnet (`./smart-contracts/scripts/deploy.sh --network testnet`).
5. Containers are updated on the staging server via `docker compose pull && docker compose up -d`.
6. Smoke tests verify the deployment:
   - `GET /health` → HTTP 200
   - `GET /api/agents` → valid JSON array/object
7. On success: a deployment summary (image digests, run URL) is written to the GitHub workflow run summary.
8. On failure: a GitHub issue is opened automatically with the failure log.

The workflow can also be triggered manually via **GitHub → Actions → Staging Deployment → Run workflow**.

### Staging environment URLs

| Resource | URL |
|---|---|
| Frontend | `$STAGING_FRONTEND_URL` (set in the `staging` GitHub environment) |
| Backend | `$STAGING_BACKEND_URL` (set in the `staging` GitHub environment) |

### Required GitHub Actions secrets and variables

Configure these under **Settings → Environments → staging**:

| Key | Type | Description |
|---|---|---|
| `STELLAR_DEPLOY_SECRET` | Secret | Stellar testnet secret key for contract deployment |
| `STAGING_SSH_KEY` | Secret | SSH private key for the staging server (if using remote SSH deploy) |
| `STAGING_HOST` | Secret | Hostname or IP of the staging server |
| `STAGING_FRONTEND_URL` | Variable | Public URL of the staging frontend |
| `STAGING_BACKEND_URL` | Variable | Public URL of the staging backend |
| `STELLAR_DEPLOY_ENABLED` | Variable | Set to `true` to enable testnet contract deployment |

> **Forks and first-time setups**: If `STAGING_HOST` is not set, the container
> deploy step is skipped and a notice is printed. The image build and push steps
> still run so image artifacts are always produced, even without a staging server.

### Pulling a specific staging image locally

```bash
# Log in to GHCR
echo $GITHUB_TOKEN | docker login ghcr.io -u $GITHUB_ACTOR --password-stdin

# Pull the latest staging backend
docker pull ghcr.io/<owner>/ai-net/backend:staging

# Or a specific commit
docker pull ghcr.io/<owner>/ai-net/backend:sha-<full-commit-sha>
```
