#!/bin/bash
# /home/ec2-user/claude-agent-web/backup-to-s3.sh
# Daily backup of SQLite DBs to S3.
set -euo pipefail

S3_BUCKET="${S3_BACKUP_BUCKET:-mysql-backup-ap-northeast-1}"
S3_PREFIX="${S3_BACKUP_PREFIX:-ai-agent}"
APP_DIR="/home/ec2-user/claude-agent-web"
WORK_DIR="/tmp/ai-agent-backup"
DATE=$(date +%Y%m%d_%H%M%S)
LOG_FILE="$APP_DIR/backup.log"

log() { echo "[$(date '+%F %T')] $1" | tee -a "$LOG_FILE"; }

log "=== backup start ==="

mkdir -p "$WORK_DIR"
find "$WORK_DIR" -mindepth 1 -delete

for db in audit.db sessions.db agent.db; do
  if [ -f "$APP_DIR/$db" ]; then
    sqlite3 "$APP_DIR/$db" ".backup '$WORK_DIR/$db'"
    log "snapshotted $db ($(stat -c%s "$WORK_DIR/$db") bytes)"
  fi
done

cp -p "$APP_DIR/.env" "$WORK_DIR/env.backup"

ARCHIVE="$WORK_DIR/ai-agent-${DATE}.tar.gz"
tar czf "$ARCHIVE" -C "$WORK_DIR" $(ls "$WORK_DIR" | grep -vE '\.tar\.gz$')
SIZE=$(stat -c%s "$ARCHIVE")
log "archive $ARCHIVE ($SIZE bytes)"

S3_KEY="$S3_PREFIX/$(date +%Y/%m)/ai-agent-${DATE}.tar.gz"
if aws s3 cp "$ARCHIVE" "s3://$S3_BUCKET/$S3_KEY" --no-progress; then
  log "uploaded to s3://$S3_BUCKET/$S3_KEY"
else
  log "ERROR upload failed"
  exit 1
fi

find "$WORK_DIR" -mindepth 1 -delete
log "=== backup done ==="
