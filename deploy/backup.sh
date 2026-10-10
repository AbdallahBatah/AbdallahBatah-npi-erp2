#!/bin/sh
# Nightly Postgres backup for the NPI ERP stack.
#
# - Dumps via the running postgres container (custom format => pg_restore-able)
# - Keeps the newest $KEEP dumps locally under $BACKUP_DIR
# - If OFFSITE_CMD is set, ships the fresh dump off-host (e.g. rclone/scp)
# - Madar copilot (T-41, spec/madar/02 §11): also dumps its database
#   npi_copilot (npi_copilot_<stamp>.dump, same size + readability checks,
#   same rotation) and archives its uploaded documents from the copilot_docs
#   volume (copilot_docs_<stamp>.tar.gz) through the running copilot
#   container. Both are skipped with a line in the log on a server where the
#   copilot has not been deployed yet (no npi_copilot database).
# - `sh deploy/backup.sh --dry-run` prints what would be written, runs nothing.
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
#
# RESTORE PROCEDURE — Madar copilot (npi_copilot + copilot_docs)
#
# The copilot's rows point at NPI's ids (organization, users, customers…), so
# restore both sides from the SAME night; a copilot dump older than NPI's
# would describe documents and jobs NPI no longer knows. Same steps, its own
# database and container; NPI's stack keeps running throughout.
#
#   DUMP=$(ls -1t /opt/npi-erp/backups/npi_copilot_*.dump | head -1); echo "$DUMP"
#   DOCS=$(ls -1t /opt/npi-erp/backups/copilot_docs_*.tar.gz | head -1); echo "$DOCS"
#   pg_restore --list "$DUMP" > /dev/null || { echo "UNREADABLE DUMP"; exit 1; }
#   tar -tzf "$DOCS" > /dev/null || { echo "UNREADABLE DOCS ARCHIVE"; exit 1; }
#
#   docker compose $C stop copilot
#   docker compose $C exec -T postgres \
#     sh -c 'dropdb -U npi --force npi_copilot && createdb -U npi npi_copilot'
#   docker compose $C exec -T postgres \
#     pg_restore -U npi -d npi_copilot --no-owner --exit-on-error < "$DUMP"
#
#   # The documents: empty the volume, then unpack the archive into it. The
#   # copilot container is stopped, so `run` is used (same image, same mount).
#   docker compose $C run --rm --no-deps --entrypoint sh copilot \
#     -c 'find /data/copilot_docs -mindepth 1 -delete'
#   docker compose $C run --rm --no-deps --entrypoint sh -T copilot \
#     -c 'tar -xzf - -C /data/copilot_docs' < "$DOCS"
#
#   # Migrations newer than the dump, then start (the container runs
#   # `migrate deploy` on boot as well — this makes a failure visible here).
#   docker compose $C run --rm --no-deps copilot \
#     node node_modules/prisma/build/index.js migrate deploy --schema apps/copilot/prisma/schema.prisma
#   docker compose $C start copilot
#
#   # Verify: the counts must match the night's figures, and every stored
#   # document row must have its file (the copilot refuses a document whose
#   # file is missing, so a mismatch shows up as 404s in the chat).
#   docker compose $C exec -T postgres psql -U npi -d npi_copilot -c \
#     'SELECT (SELECT count(*) FROM documents) AS documents,
#             (SELECT count(*) FROM intake_jobs) AS intake_jobs,
#             (SELECT count(*) FROM llm_audit) AS llm_audit;'
#   docker compose $C exec -T copilot sh -c 'find /data/copilot_docs -type f | wc -l'

set -eu

BACKUP_DIR="${BACKUP_DIR:-/opt/npi-erp/backups}"
KEEP="${KEEP:-14}"
STAMP="$(date +%Y%m%d_%H%M%S)"
FILE="$BACKUP_DIR/npi_erp_$STAMP.dump"
COPILOT_FILE="$BACKUP_DIR/npi_copilot_$STAMP.dump"
DOCS_FILE="$BACKUP_DIR/copilot_docs_$STAMP.tar.gz"
COMPOSE="docker compose -f docker-compose.prod.yml --env-file deploy/.env"

if [ "${1:-}" = "--dry-run" ]; then
  echo "dry-run: would write $FILE (pg_dump npi_erp, custom format)"
  echo "dry-run: would write $COPILOT_FILE (pg_dump npi_copilot, custom format; skipped if the database does not exist)"
  echo "dry-run: would write $DOCS_FILE (tar of /data/copilot_docs from the running copilot container)"
  echo "dry-run: would verify each dump with pg_restore --list, then keep the newest $KEEP of each kind under $BACKUP_DIR"
  [ -n "${OFFSITE_CMD:-}" ] && echo "dry-run: would run OFFSITE_CMD for each file"
  exit 0
fi

mkdir -p "$BACKUP_DIR"

$COMPOSE exec -T postgres \
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

# ── Madar copilot: npi_copilot + the documents volume (T-41) ───────────────
#
# Checked the same way (size, then pg_restore --list). A fresh npi_copilot
# with its schema alone dumps to well over the 10 KB floor, so the floor is
# shared. On a server where the copilot has never been deployed the database
# does not exist: that is reported and skipped, not treated as a failure, so
# NPI's backup above still counts as the night's success.
COPILOT_SIZE=0
DOCS_SIZE=0
if $COMPOSE exec -T postgres psql -U npi -d postgres -Atc \
     "SELECT 1 FROM pg_database WHERE datname = 'npi_copilot'" | grep -q 1; then
  $COMPOSE exec -T postgres \
    pg_dump -U npi -d npi_copilot --format=custom > "$COPILOT_FILE"
  COPILOT_SIZE=$(wc -c < "$COPILOT_FILE")
  if [ "$COPILOT_SIZE" -lt 10000 ]; then
    echo "ERROR: copilot dump is only ${COPILOT_SIZE} bytes — treating as failure" >&2
    exit 1
  fi
  if ! $COMPOSE exec -T postgres sh -c \
       'cat > /tmp/verify.dump && pg_restore --list /tmp/verify.dump > /dev/null 2>&1; rc=$?; rm -f /tmp/verify.dump; exit $rc' \
       < "$COPILOT_FILE"; then
    echo "ERROR: copilot dump is not readable by pg_restore — treating as failure" >&2
    exit 1
  fi

  # The uploaded documents, read from the volume through the running copilot
  # container (busybox tar; the image is Alpine). The copilot refuses a
  # document whose file is missing, so a database restored without its files
  # is only half a restore — the archive is verified by listing it, as the
  # dumps are. An empty volume (no upload yet) is a valid, tiny archive.
  if [ -n "$($COMPOSE ps -q copilot)" ]; then
    $COMPOSE exec -T copilot tar -czf - -C /data/copilot_docs . > "$DOCS_FILE"
    DOCS_SIZE=$(wc -c < "$DOCS_FILE")
    if ! tar -tzf "$DOCS_FILE" > /dev/null 2>&1; then
      echo "ERROR: copilot documents archive is not readable by tar — treating as failure" >&2
      exit 1
    fi
  else
    echo "WARN: copilot container is not running — documents volume not archived tonight" >&2
  fi
else
  echo "copilot: database npi_copilot does not exist on this server — skipped"
fi

# Rotate: keep the newest $KEEP dumps (and archives) of each kind.
ls -1t "$BACKUP_DIR"/npi_erp_*.dump 2>/dev/null | tail -n +$((KEEP + 1)) | xargs -r rm -f
ls -1t "$BACKUP_DIR"/npi_copilot_*.dump 2>/dev/null | tail -n +$((KEEP + 1)) | xargs -r rm -f
ls -1t "$BACKUP_DIR"/copilot_docs_*.tar.gz 2>/dev/null | tail -n +$((KEEP + 1)) | xargs -r rm -f

# Optional off-host copy, e.g.:
#   OFFSITE_CMD='rclone copy "$FILE" b2:npi-erp-backups'
#   OFFSITE_CMD='scp "$FILE" backup@10.0.0.2:/backups/'
# It is evaluated once per file written tonight, with $FILE set to each in
# turn (NPI's dump, then the copilot's dump and documents archive when present).
if [ -n "${OFFSITE_CMD:-}" ]; then
  NPI_FILE="$FILE"
  for f in "$NPI_FILE" "$COPILOT_FILE" "$DOCS_FILE"; do
    [ -f "$f" ] || continue
    FILE="$f"
    eval "$OFFSITE_CMD"
  done
  FILE="$NPI_FILE"
fi

echo "OK: $FILE ($SIZE bytes)"
[ "$COPILOT_SIZE" -gt 0 ] && echo "OK: $COPILOT_FILE ($COPILOT_SIZE bytes)"
[ "$DOCS_SIZE" -gt 0 ] && echo "OK: $DOCS_FILE ($DOCS_SIZE bytes)"
exit 0
