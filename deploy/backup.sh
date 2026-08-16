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
# RESTORE PROCEDURE
#
# Rehearsed 2026-08-17 against PostgreSQL 16 with 66 invoices / 139 journal
# lines: 4 seconds from dropped database to restored data, verified by row
# counts, a balanced trial balance and the full integration suite. Rehearse it
# again on your own hardware — the number below is the measurement, not a
# promise, and restore time grows with the database.
#
#   C=" -f docker-compose.prod.yml --env-file deploy/.env"
#
#   # 1. Pick the newest dump explicitly, rather than guessing at a filename.
#   DUMP=$(ls -1t /opt/npi-erp/backups/npi_erp_*.dump | head -1); echo "$DUMP"
#
#   # 2. Prove the dump is readable BEFORE destroying anything. This is the
#   #    step whose absence turns a bad backup into a lost company.
#   pg_restore --list "$DUMP" > /dev/null || { echo "UNREADABLE DUMP"; exit 1; }
#
#   # 3. Stop the writers. Leaving them up means they reconnect mid-restore and
#   #    write into a half-populated schema.
#   docker compose $C stop api web
#
#   # 4. Recreate the database empty.
#   docker compose $C exec -T postgres \
#     sh -c 'dropdb -U npi --force npi_erp && createdb -U npi npi_erp'
#
#   # 5. Restore. --exit-on-error matters: without it pg_restore reports
#   #    success having skipped every statement that failed, and you discover
#   #    the gap at the next audit instead of now.
#   docker compose $C exec -T postgres \
#     pg_restore -U npi -d npi_erp --no-owner --exit-on-error < "$DUMP"
#
#   # 6. Apply any migrations newer than the dump. A dump taken before the last
#   #    deploy restores the OLD schema, and the API then fails on startup
#   #    against columns that no longer exist.
#   docker compose $C run --rm api npx prisma migrate deploy
#
#   # 7. VERIFY BEFORE DECLARING SUCCESS. A partial restore looks exactly like
#   #    a complete one until someone opens the books.
#   docker compose $C exec -T postgres psql -U npi -d npi_erp -c \
#     'SELECT (SELECT count(*) FROM "Invoice") AS invoices,
#             (SELECT count(*) FROM "JournalLine") AS journal_lines,
#             (SELECT COALESCE(SUM(debit-credit),0) FROM "JournalLine") AS must_be_zero;'
#
#   # 8. Only now bring the application back.
#   docker compose $C start api web

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

# Size is a weak test: a dump truncated by a full disk mid-write clears 10 KB
# comfortably and still restores nothing. Reading the archive's table of
# contents is what actually proves pg_restore can open it. This is the whole
# difference between holding backups and holding files.
#
# The dump is copied to a file inside the container first: a custom-format
# archive has a table of contents that pg_restore seeks to, and a pipe cannot
# seek — reading it from stdin fails for a perfectly good backup. Verified both
# ways on 2026-08-17: a healthy dump passes, and one truncated to 28 KB (well
# past the size threshold above) is rejected.
if ! docker compose -f docker-compose.prod.yml --env-file deploy/.env exec -T postgres sh -c \
     'cat > /tmp/verify.dump && pg_restore --list /tmp/verify.dump > /dev/null 2>&1; rc=$?; rm -f /tmp/verify.dump; exit $rc' \
     < "$FILE"; then
  echo "ERROR: dump is not readable by pg_restore — treating as failure" >&2
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
