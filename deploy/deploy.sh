#!/bin/sh
# Zero-downtime rolling deploy for the NPI ERP stack (single host).
#
#   sh deploy/deploy.sh            deploy the current checkout
#   sh deploy/deploy.sh --rollback redeploy the previously running images
#
# How it stays up: the new container is started NEXT TO the old one (compose
# scale 2), traffic reaches both through Docker's DNS round-robin behind Caddy,
# and the old one is retired only after the new one's healthcheck — which
# proves DB reachability, not just a listening port — has passed. Caddy retries
# a failed dial for 5s (lb_try_duration), so requests in flight at the exact
# moment of the swap land on the survivor instead of returning 502.
#
# Why migrations cannot break this: every migration must be tolerated by the
# PREVIOUS code version (see deploy/MIGRATIONS_AR.md — expand/contract). The
# schema is migrated first, while the old code is still serving; if the
# migration fails, the swap never starts and the old version keeps running.
#
# Rollback re-runs the same swap with the previous image tag. It does NOT
# revert migrations — the compatibility rule is exactly what makes that safe.
#
# Rehearsed 2026-08-17 on the local stack: a full deploy under a 1-second
# health probe — zero failed requests. See docs/WORK_ORDER_AR.md phase 4.

set -eu

COMPOSE="docker compose -f docker-compose.prod.yml --env-file deploy/.env"
HISTORY_FILE="deploy/.deploy_history"
TIMEOUT=120

log() { printf '%s %s\n' "$(date +%H:%M:%S)" "$*"; }
die() { printf 'DEPLOY FAILED: %s\n' "$*" >&2; exit 1; }

# ── helpers ────────────────────────────────────────────────────────────────

# Wait until a specific container reports healthy.
wait_healthy() { # $1=container-id  $2=label
  n=0
  while :; do
    s=$(docker inspect -f '{{.State.Health.Status}}' "$1" 2>/dev/null || echo gone)
    [ "$s" = healthy ] && return 0
    [ "$s" = gone ] && die "$2: container disappeared while waiting for health"
    n=$((n + 1))
    [ "$n" -ge "$TIMEOUT" ] && die "$2: not healthy after ${TIMEOUT}s (status: $s)"
    sleep 1
  done
}

# Start a new container for a service beside the old one, wait for health,
# then retire the old. The service keeps answering throughout.
swap() { # $1=service
  svc=$1
  old=$($COMPOSE ps -q "$svc")
  [ -n "$old" ] || die "$svc: no running container — this script updates a live stack, use 'up -d' for first install"
  [ "$(printf '%s\n' "$old" | wc -l)" -eq 1 ] || die "$svc: expected exactly one running container"

  log "$svc: starting replacement beside $(echo "$old" | cut -c1-12)"
  $COMPOSE up -d --no-deps --no-recreate --scale "$svc=2" "$svc" >/dev/null 2>&1

  new=$($COMPOSE ps -q "$svc" | grep -v "^$old\$" || true)
  [ -n "$new" ] || die "$svc: replacement container was not created"

  log "$svc: waiting for the replacement to pass its healthcheck"
  wait_healthy "$new" "$svc"

  log "$svc: retiring the old container"
  docker stop -t 20 "$old" >/dev/null
  docker rm "$old" >/dev/null
  # Settle compose's bookkeeping back to scale 1 (no-op for the survivor).
  $COMPOSE up -d --no-deps --no-recreate --scale "$svc=1" "$svc" >/dev/null 2>&1
}

verify() {
  # Through Caddy, not directly: the user's path is the one that matters.
  # -L because Caddy 308-redirects plain HTTP to HTTPS whenever SITE_ADDRESS
  # is a real domain (production) — only the bare :80 of the local rehearsal
  # answers on HTTP directly, and 2026-08-31 that difference failed a verify
  # after a deploy that was in fact healthy.
  code=$(curl -sL -o /dev/null -w '%{http_code}' http://localhost/api/health || echo 000)
  [ "$code" = 200 ] || die "post-deploy verify: /api/health via Caddy returned $code"
  log "verify: /api/health via Caddy → 200"
}

# ── modes ──────────────────────────────────────────────────────────────────

if [ "${1:-}" = "--rollback" ]; then
  [ -f "$HISTORY_FILE" ] || die "no deploy history to roll back to"
  prev=$(tail -n 2 "$HISTORY_FILE" | head -n 1)
  cur=$(tail -n 1 "$HISTORY_FILE")
  [ -n "$prev" ] && [ "$prev" != "$cur" ] || die "no previous version recorded before $cur"

  log "rolling back $cur → $prev (migrations are NOT reverted — see MIGRATIONS_AR.md)"
  docker image inspect "npi-erp-api:$prev" >/dev/null 2>&1 || die "image npi-erp-api:$prev is gone"
  docker tag "npi-erp-api:$prev" npi-erp-api
  docker tag "npi-erp-web:$prev" npi-erp-web

  swap api
  swap web
  verify
  echo "$prev" >> "$HISTORY_FILE"
  log "rollback complete: $prev is serving"
  exit 0
fi

sha=$(git rev-parse --short HEAD 2>/dev/null || date +%Y%m%d%H%M%S)
log "deploying $sha"

log "build: api + web images"
$COMPOSE build api web >/dev/null

# Archive under the commit tag — this is what rollback redeploys.
docker tag npi-erp-api "npi-erp-api:$sha"
docker tag npi-erp-web "npi-erp-web:$sha"

# Migrate BEFORE swapping, while the old code is still serving. The
# expand/contract rule is what makes this window safe; a failed migration
# stops here with the old version untouched.
log "migrate: prisma migrate deploy (old version still serving)"
$COMPOSE run --rm --no-deps api \
  npx prisma migrate deploy --schema packages/db/prisma/schema.prisma \
  || die "migration failed — nothing was swapped, the old version is still serving"

swap api
swap web
verify

echo "$sha" >> "$HISTORY_FILE"
log "deploy complete: $sha is serving"
