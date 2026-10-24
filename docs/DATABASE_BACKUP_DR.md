# Database Backup & Disaster Recovery

This document covers the automated backup strategy, S3 retention policy, encryption details, alerting, and disaster recovery (DR) procedures for all three ai-net production SQLite databases.

**Resolves [#125](https://github.com/Chrisnec265/ai-net/issues/125)**

---

## Overview

| Database | File | Purpose |
|---|---|---|
| `payments.db` | `$DB_DIR/payments.db` | Stellar payment records and escrow state |
| `agents.db` | `$DB_DIR/agents.db` | Agent registry and heartbeat data |
| `tasks.db` | `$DB_DIR/tasks.db` | Task execution state and event log |

---

## Recovery Objectives

| Objective | Target |
|---|---|
| **RTO** (Recovery Time Objective) | **4 hours** — The system must be restored and accepting traffic within 4 hours of a declared disaster |
| **RPO** (Recovery Point Objective) | **24 hours** — Maximum acceptable data loss is one day's worth of transactions |

These objectives are achievable because backups run daily at 02:00 UTC and full restoration from S3 to a running instance takes approximately 30–60 minutes.

---

## Backup Strategy

### Schedule

Production backups run **daily at 02:00 UTC**. A separate GitHub Actions
workflow verifies synthetic SQLite backups weekly and can upload the verified
artifacts to the Terraform-managed backup verification bucket when its OIDC
role and `BACKUP_VERIFY_AWS_ROLE_ARN` / `BACKUP_VERIFY_TEST_BUCKET` repository
variables are configured. Deploy production backups via one of:

**Option A — cron (on the backend host):**

```cron
0 2 * * * /app/backend/scripts/backup-databases.sh >> /var/log/ai-net-backup.log 2>&1
```

**Option B — AWS EventBridge + Lambda:**

1. Create a Lambda function that runs the backup logic (or invokes the script via SSM Run Command on the EC2 instance).
2. Set an EventBridge rule: `cron(0 2 * * ? *)` targeting the Lambda.
3. Configure a Dead Letter Queue (DLQ) on the Lambda to capture failures.

### Backup Method

Each database is backed up using `sqlite3 .backup` which produces a consistent point-in-time snapshot without locking the database for more than a few milliseconds. The backup is then gzip-compressed and uploaded to S3.

### S3 Bucket Layout

```
s3://<S3_BACKUP_BUCKET>/
└── backups/sqlite/
    └── 20241015T020000Z/
        ├── 20241015T020000Z-payments.db.gz
        ├── 20241015T020000Z-agents.db.gz
        ├── 20241015T020000Z-tasks.db.gz
        └── manifest.json
```

The manifest contains the SHA-256 checksum of each compressed file, the S3 key, the database name, and the timestamp. Always verify checksums during restoration.

### S3 Retention Policy

The Terraform-managed SQLite backup bucket expires objects after 90 days. The
workflow test bucket is isolated from production data and also uses a 90-day
lifecycle. For local verification, use disposable fixture databases and a
temporary output directory; this mode needs no AWS credentials:

```bash
DB_DIR=/tmp/ai-net-backup-fixtures \
  ./backend/scripts/backup-databases.sh --local --integrity-check \
  --output-dir /tmp/ai-net-verified-backups
```

Configure a 90-day lifecycle rule on the backup bucket:

```json
{
  "Rules": [
    {
      "ID": "ai-net-sqlite-backup-retention",
      "Status": "Enabled",
      "Filter": { "Prefix": "backups/sqlite/" },
      "Expiration": { "Days": 90 }
    }
  ]
}
```

Apply via AWS CLI:

```bash
aws s3api put-bucket-lifecycle-configuration \
  --bucket "${S3_BACKUP_BUCKET}" \
  --lifecycle-configuration file://docs/s3-lifecycle-policy.json
```

### Encryption

Backups are encrypted at rest using **AES-256**:

- **Default**: S3-managed keys (`--sse AES256`)
- **Enhanced**: KMS-managed key — set `ENCRYPTION_KEY_ARN` in the environment to use `aws:kms` encryption. This provides an audit trail of every key usage in CloudTrail.

Encryption is enforced in the upload step of `backend/scripts/backup-databases.sh`.

---

## Running the Backup Script

```bash
# Copy environment defaults
cp .env.example .env
# Set: S3_BACKUP_BUCKET, DB_DIR, SLACK_WEBHOOK_URL (optional), ALERT_EMAIL (optional)

# Test with dry run (no S3 uploads)
cd backend
./scripts/backup-databases.sh --dry-run

# Production run
./scripts/backup-databases.sh
```

### Required Environment Variables

| Variable | Description | Required |
|---|---|---|
| `S3_BACKUP_BUCKET` | S3 bucket name | ✅ Yes for S3 mode; not required for `--local` |
| `DB_DIR` | Directory containing `.db` files | ✅ Yes (default: `/app/data`) |
| `S3_BACKUP_PREFIX` | S3 key prefix | No (default: `backups/sqlite`) |
| `SLACK_WEBHOOK_URL` | Slack webhook for failure alerts | No |
| `ALERT_EMAIL` | Email for failure alerts via SES | No |
| `ENCRYPTION_KEY_ARN` | KMS key ARN for enhanced encryption | No |

---

## Alerting on Backup Failure

The script sends alerts to **both Slack and email** when:

- `S3_BACKUP_BUCKET` is not configured
- A `.db` file is missing or unreadable
- An S3 upload fails
- The manifest upload fails

**Slack message format:**

```
🚨 ai-net DB Backup Alert
Backup partially failed — 20241015T020000Z
One or more databases could not be backed up. Check the backup host logs.
```

For Lambda-based deployments, also configure a CloudWatch alarm on the Lambda's error metric to page on-call via SNS.

---

## Disaster Recovery Procedure

### Prerequisites

- AWS CLI configured with access to the backup S3 bucket
- SQLite 3 installed on the target host
- The target `DB_DIR` exists and is writable

### Step 1 — Identify the Recovery Point

List available backups to find the most recent (or the specific point-in-time needed):

```bash
aws s3 ls s3://${S3_BACKUP_BUCKET}/backups/sqlite/ | sort | tail -5
```

Note the timestamp of the desired backup (e.g. `20241015T020000Z`).

### Step 2 — Download the Manifest

```bash
TIMESTAMP="20241015T020000Z"
aws s3 cp \
  "s3://${S3_BACKUP_BUCKET}/backups/sqlite/${TIMESTAMP}/manifest.json" \
  ./manifest.json
cat manifest.json
```

### Step 3 — Download and Verify the Backups

```bash
for DB in payments agents tasks; do
  aws s3 cp \
    "s3://${S3_BACKUP_BUCKET}/backups/sqlite/${TIMESTAMP}/${TIMESTAMP}-${DB}.db.gz" \
    "./${TIMESTAMP}-${DB}.db.gz"

  # Verify SHA-256 against manifest
  EXPECTED=$(jq -r ".files[] | select(.database==\"${DB}.db\") | .sha256" manifest.json)
  ACTUAL=$(sha256sum "${TIMESTAMP}-${DB}.db.gz" | awk '{print $1}')

  if [[ "${EXPECTED}" != "${ACTUAL}" ]]; then
    echo "❌ CHECKSUM MISMATCH for ${DB}.db — abort and try another backup!"
    exit 1
  fi
  echo "✅ ${DB}.db checksum verified"
done
```

### Step 4 — Decompress and Restore

```bash
DB_DIR="/app/data"

for DB in payments agents tasks; do
  # Stop the backend first to avoid write conflicts
  # sudo systemctl stop ai-net-backend  # or docker compose stop backend

  gunzip -c "${TIMESTAMP}-${DB}.db.gz" > "${DB_DIR}/${DB}.db"
  echo "Restored ${DB}.db to ${DB_DIR}/${DB}.db"
done
```

### Step 5 — Verify Data Integrity

Run a quick integrity check on each restored database:

```bash
for DB in payments agents tasks; do
  echo "Checking ${DB}.db..."
  sqlite3 "${DB_DIR}/${DB}.db" "PRAGMA integrity_check;"
  sqlite3 "${DB_DIR}/${DB}.db" "SELECT COUNT(*) FROM sqlite_master WHERE type='table';"
done
```

### Step 6 — Restart the Backend

```bash
# Direct
cd backend && npm run dev

# Docker Compose
docker compose up -d backend
```

### Step 7 — Smoke Test

```bash
curl -f http://localhost:3000/health
curl -f http://localhost:3000/api/agents
```

If the health check passes and agents are returned, the restore is complete.

---

## Quarterly DR Drill

Schedule a DR drill at the beginning of each quarter. The drill tests the full restore procedure against a **staging** environment.

### Drill Procedure

1. **Announce** the drill in `#incidents` Slack at least 24 hours before (staging only — no production impact).
2. **Download** the most recent backup to a staging host following Steps 1–4 above.
3. **Verify** checksums pass.
4. **Restore** to staging `DB_DIR`.
5. **Run** `npm run db:migrate` to confirm schema version matches.
6. **Smoke test** the staging backend API.
7. **Record** the drill outcome (RTO achieved, any blockers) in `docs/dr-drill-log.md`.
8. **Update** this document if any step needs improvement.

### Drill Log

| Date | Performed By | Backup Used | RTO Achieved | Notes |
|---|---|---|---|---|
| _(Add entries after each drill)_ | | | | |

---

## S3 Bucket Setup Reference

```bash
# Create the backup bucket (if not already exists)
aws s3api create-bucket \
  --bucket "${S3_BACKUP_BUCKET}" \
  --region us-east-1 \
  --create-bucket-configuration LocationConstraint=us-east-1

# Enable versioning (allows recovery from accidental overwrites)
aws s3api put-bucket-versioning \
  --bucket "${S3_BACKUP_BUCKET}" \
  --versioning-configuration Status=Enabled

# Block all public access
aws s3api put-public-access-block \
  --bucket "${S3_BACKUP_BUCKET}" \
  --public-access-block-configuration \
    "BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true"
```

---

## Related

- Backup script: `backend/scripts/backup-databases.sh`
- Database migrations: `backend/src/db/migrations/`
- DB connection layer: `backend/src/db/index.ts`
