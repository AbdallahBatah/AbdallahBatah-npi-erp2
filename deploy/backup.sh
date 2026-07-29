#!/bin/sh
# Nightly Postgres backup for the NPI ERP stack.
#
# - Dumps via the running postgres container (custom format => pg_restore-able)
# - Keeps the newest $KEEP dumps locally under $BACKUP_DIR
# - If OFFSITE_CMD is set, ships the fresh dump off-host (e.g. rclone/scp)
#
# Install (as root, from /opt/npi-erp):
#   chmod +x deploy/backup.sh
#   crontab -e   ->   0 2 * * * cd /opt/npi-erp && sh deploy/backup.sh >> /var/log/npi-backup.log 2>&1
#
# RESTORE PROCEDURE (test it after first install — an untested backup is not a backup):
#   docker compose -f docker-compose.prod.yml --env-file deploy/.env stop api web
#   docker compose -f docker-compose.prod.yml --env-file deploy/.env exec -T postgres \
#     sh -c 'dropdb -U npi --force npi_erp && createdb -U npi npi_erp'
#   docker compose -f docker-compose.prod.yml --env-file deploy/.env exec -T postgres \
#     pg_restore -U npi -d npi_erp --no-owner < /opt/npi-erp/backups/<FILE>.dump
#   docker compose -f docker-compose.prod.yml --env-file deploy/.env start api web

set -eu

BACKUP_DIR="${BACKUP_DIR:-/opt/npi-erp/backups}"
KEEP="${KEEP:-14}"
STAMP="$(date +%Y%m%d_%H%M%S)"
FILE="$BACKUP_DIR/npi_erp_$STAMP.dump"

mkdir -p "$BACKUP_DIR"

docker compose -f docker-compose.prod.yml --env-file deploy/.env exec -T postgres \
  pg_dump -U npi -d npi_erp --format=custom > "$FILE"

# Sanity: a dump that is suspiciously small means something went wrong.
SIZE=$(wc -c < "$FILE")
if [ "$SIZE" -lt 10000 ]; then
  echo "ERROR: dump is only ${SIZE} bytes — treating as failure" >&2
  exit 1
fi

# Rotate: keep the newest $KEEP dumps.
ls -1t "$BACKUP_DIR"/npi_erp_*.dump 2>/dev/null | tail -n +$((KEEP + 1)) | xargs -r rm -f

# Optional off-host copy, e.g.:
#   OFFSITE_CMD='rclone copy "$FILE" b2:npi-erp-backups'
#   OFFSITE_CMD='scp "$FILE" backup@10.0.0.2:/backups/'
if [ -n "${OFFSITE_CMD:-}" ]; then
  eval "$OFFSITE_CMD"
fi

echo "OK: $FILE ($SIZE bytes)"
