#!/usr/bin/env bash
# redis-backup.sh — Back up Redis dump.rdb to a local directory and optionally
# to an S3-compatible object store.
#
# Usage:
#   ./redis-backup.sh [backup_dir]
#
# Environment variables:
#   REDIS_HOST             Redis hostname        (default: localhost)
#   REDIS_PORT             Redis port            (default: 6379)
#   REDIS_PASSWORD         Redis AUTH password   (default: empty = no auth)
#   AWS_S3_BACKUP_BUCKET   S3 bucket name        (optional; upload skipped if unset)
#   AWS_DEFAULT_REGION     AWS region            (default: us-east-1)
#
# Dependencies: redis-cli, cp, optionally aws (for S3 upload)

set -euo pipefail

BACKUP_DIR="${1:-/var/backups/redis}"
REDIS_HOST="${REDIS_HOST:-localhost}"
REDIS_PORT="${REDIS_PORT:-6379}"
REDIS_PASSWORD="${REDIS_PASSWORD:-}"
TIMESTAMP=$(date +%Y%m%d_%H%M%S)
BACKUP_FILE="${BACKUP_DIR}/dump_${TIMESTAMP}.rdb"

echo "[$(date -u +%FT%TZ)] Starting Redis backup..."

mkdir -p "${BACKUP_DIR}"

# Build the redis-cli auth flag array (empty when no password is set).
if [ -n "${REDIS_PASSWORD}" ]; then
  AUTH_FLAGS=(-a "${REDIS_PASSWORD}")
else
  AUTH_FLAGS=()
fi

# Trigger a background save and wait for it to complete.
redis-cli -h "${REDIS_HOST}" -p "${REDIS_PORT}" "${AUTH_FLAGS[@]}" BGSAVE

echo "Waiting for BGSAVE to finish..."
for i in $(seq 1 30); do
  SAVING=$(redis-cli -h "${REDIS_HOST}" -p "${REDIS_PORT}" "${AUTH_FLAGS[@]}" LASTSAVE)
  sleep 2
  NEW_SAVE=$(redis-cli -h "${REDIS_HOST}" -p "${REDIS_PORT}" "${AUTH_FLAGS[@]}" LASTSAVE)
  if [ "${NEW_SAVE}" -gt "${SAVING}" ]; then
    echo "BGSAVE completed."
    break
  fi
done

# Locate the dump.rdb file.
REDIS_DATA_DIR=$(redis-cli -h "${REDIS_HOST}" -p "${REDIS_PORT}" "${AUTH_FLAGS[@]}" CONFIG GET dir | tail -1)
DUMP_FILE="${REDIS_DATA_DIR}/dump.rdb"

if [ ! -f "${DUMP_FILE}" ]; then
  echo "ERROR: dump.rdb not found at ${DUMP_FILE}" >&2
  exit 1
fi

cp "${DUMP_FILE}" "${BACKUP_FILE}"
echo "Backup saved locally: ${BACKUP_FILE} ($(du -sh "${BACKUP_FILE}" | cut -f1))"

# Upload to S3 if bucket is configured.
if [ -n "${AWS_S3_BACKUP_BUCKET:-}" ]; then
  REGION="${AWS_DEFAULT_REGION:-us-east-1}"
  S3_KEY="redis/$(basename "${BACKUP_FILE}")"
  echo "Uploading to s3://${AWS_S3_BACKUP_BUCKET}/${S3_KEY} ..."
  aws s3 cp "${BACKUP_FILE}" "s3://${AWS_S3_BACKUP_BUCKET}/${S3_KEY}" \
    --region "${REGION}" \
    --storage-class STANDARD_IA
  echo "S3 upload complete."
fi

# Prune local backups — keep the most recent 7.
EXCESS=$(ls -t "${BACKUP_DIR}"/dump_*.rdb 2>/dev/null | tail -n +8)
if [ -n "${EXCESS}" ]; then
  echo "Pruning old backups:"
  echo "${EXCESS}" | xargs -r rm -v
fi

echo "[$(date -u +%FT%TZ)] Redis backup completed successfully."
