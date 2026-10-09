#!/bin/sh
# Zero-downtime rolling deploy for the NPI ERP stack (single host).
#
#   sh deploy/deploy.sh            deploy the current checkout
#   sh deploy/deploy.sh --rollback redeploy the previously running images
#   sh deploy/deploy.sh --dry-run  print the plan (no docker command runs);
#                                  combines with --rollback
#
# Madar copilot (T-41, spec/madar/02 §11): the same deploy also builds the
# copilot image, migrates its own database npi_copilot (before the swap, the
# same rule as NPI's), swaps the copilot container, reloads Caddy's routes and
# verifies /copilot/api/health through Caddy. A server that has never run the
# copilot gets it started on its first deploy (there is nothing to swap).
# Rollback covers the copilot image when the previous deploy had one.
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

# --dry-run (T-41): every docker/compose call goes through `run`, which prints
# the command instead of executing it; the swap/verify helpers print the step.
# The option may come first or after --rollback.
DRY=0
for arg in "$@"; do [ "$arg" = "--dry-run" ] && DRY=1; done
[ "${1:-}" = "--dry-run" ] && shift

log() { printf '%s %s\n' "$(date +%H:%M:%S)" "$*"; }
die() { printf 'DEPLOY FAILED: %s\n' "$*" >&2; exit 1; }
run() { if [ "$DRY" = 1 ]; then log "(dry-run) $*"; else "$@"; fi; }

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
  if [ "$DRY" = 1 ]; then log "(dry-run) swap $svc: start replacement, wait healthy, retire old"; return 0; fi
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

# A service added to a stack that is already live (the copilot, T-41) has no
# container to swap on its first deploy: start it beside the others and wait
# for its healthcheck; every later deploy takes the swap path above.
swap_or_start() { # $1=service
  svc=$1
  if [ "$DRY" = 1 ]; then log "(dry-run) swap_or_start $svc"; return 0; fi
  if [ -n "$($COMPOSE ps -q "$svc")" ]; then
    swap "$svc"
    return 0
  fi
  log "$svc: no running container — first install, starting it"
  $COMPOSE up -d --no-deps --no-recreate "$svc" >/dev/null 2>&1
  new=$($COMPOSE ps -q "$svc")
  [ -n "$new" ] || die "$svc: container was not created"
  wait_healthy "$new" "$svc"
}

# Caddy mounts deploy/Caddyfile read-only. The tarball extraction replaces the
# file on the host (a new inode), which a running container's bind mount does
# not follow — so the new routes (the copilot's /copilot*, T-40) are handed to
# Caddy's admin API from this copy, as a graceful reload (no dropped
# connection). The container's own file catches up at its next (re)start.
reload_caddy() {
  if [ "$DRY" = 1 ]; then log "(dry-run) caddy: validate deploy/Caddyfile and reload"; return 0; fi
  $COMPOSE exec -T caddy sh -c 'cat > /tmp/Caddyfile.new && caddy validate --config /tmp/Caddyfile.new --adapter caddyfile >/dev/null 2>&1 && caddy reload --config /tmp/Caddyfile.new --adapter caddyfile' \
    < deploy/Caddyfile || die "caddy: reload of deploy/Caddyfile failed — the old routes are still serving"
  log "caddy: routes reloaded from deploy/Caddyfile"
}

verify() {
  # Through Caddy, not directly: the user's path is the one that matters.
  # When SITE_ADDRESS is a real domain (production) Caddy 308-redirects plain
  # HTTP to HTTPS and holds a certificate for that name only, so the probe asks
  # for the domain itself, pinned to this host. Following the redirect from
  # http://localhost ends on https://localhost, where the TLS handshake fails —
  # that failed the verify of two healthy deploys (2026-08-31, 2026-09-27).
  # Only the bare :80 of the local rehearsal answers on HTTP directly.
  # The copilot's probe (/copilot/api/health, T-40) is checked the same way:
  # it proves Caddy's /copilot* route and the copilot's database together.
  if [ "$DRY" = 1 ]; then log "(dry-run) verify: /api/health and /copilot/api/health via Caddy"; return 0; fi
  site=$(sed -n 's/^SITE_ADDRESS=//p' deploy/.env | tail -n 1 | tr -d '\r')
  for probe in /api/health /copilot/api/health; do
    case "$site" in
      '' | :*) code=$(curl -s -o /dev/null -w '%{http_code}' "http://localhost$site$probe") || code=000 ;;
      *) code=$(curl -s -o /dev/null -w '%{http_code}' --resolve "$site:443:127.0.0.1" "https://$site$probe") || code=000 ;;
    esac
    [ "$code" = 200 ] || die "post-deploy verify: $probe via Caddy returned $code"
    log "verify: $probe via Caddy → 200"
  done
}

# ── modes ──────────────────────────────────────────────────────────────────

if [ "${1:-}" = "--rollback" ]; then
  [ -f "$HISTORY_FILE" ] || die "no deploy history to roll back to"
  prev=$(tail -n 2 "$HISTORY_FILE" | head -n 1)
  cur=$(tail -n 1 "$HISTORY_FILE")
  [ -n "$prev" ] && [ "$prev" != "$cur" ] || die "no previous version recorded before $cur"

  log "rolling back $cur → $prev (migrations are NOT reverted — see MIGRATIONS_AR.md)"
  [ "$DRY" = 1 ] || docker image inspect "npi-erp-api:$prev" >/dev/null 2>&1 || die "image npi-erp-api:$prev is gone"
  run docker tag "npi-erp-api:$prev" npi-erp-api
  run docker tag "npi-erp-web:$prev" npi-erp-web
  # The copilot joined the stack in T-41: a previous version deployed before
  # it has no copilot image under its tag, and the copilot then stays as it
  # is (its database is never reverted either — the same rule).
  if [ "$DRY" = 1 ] || docker image inspect "npi-erp-copilot:$prev" >/dev/null 2>&1; then
    run docker tag "npi-erp-copilot:$prev" npi-erp-copilot
    copilot_rollback=1
  else
    log "copilot: no image tagged $prev (deployed before the copilot existed) — the copilot keeps running the current version"
    copilot_rollback=0
  fi

  swap api
  swap web
  if [ "$copilot_rollback" = 1 ]; then swap copilot; fi
  verify
  [ "$DRY" = 1 ] || echo "$prev" >> "$HISTORY_FILE"
  log "rollback complete: $prev is serving"
  exit 0
fi

sha=$(git rev-parse --short HEAD 2>/dev/null || date +%Y%m%d%H%M%S)
log "deploying $sha"

log "build: api + web + copilot images"
if [ "$DRY" = 1 ]; then log "(dry-run) $COMPOSE build api web copilot"; else $COMPOSE build api web copilot >/dev/null; fi

# Archive under the commit tag — this is what rollback redeploys.
run docker tag npi-erp-api "npi-erp-api:$sha"
run docker tag npi-erp-web "npi-erp-web:$sha"
run docker tag npi-erp-copilot "npi-erp-copilot:$sha"

# Migrate BEFORE swapping, while the old code is still serving. The
# expand/contract rule is what makes this window safe; a failed migration
# stops here with the old version untouched.
log "migrate: prisma migrate deploy (old version still serving)"
run $COMPOSE run --rm --no-deps api \
  npx prisma migrate deploy --schema packages/db/prisma/schema.prisma \
  || die "migration failed — nothing was swapped, the old version is still serving"

# The copilot's own database (npi_copilot) under the same rule, with the
# Prisma CLI the copilot image carries (apps/copilot/Dockerfile). On a first
# install this creates the database. The container also runs this on boot;
# here it runs first so that a failing migration stops the deploy before any
# swap, exactly as NPI's does.
log "migrate: copilot prisma migrate deploy on npi_copilot (old version still serving)"
run $COMPOSE run --rm --no-deps copilot \
  node node_modules/prisma/build/index.js migrate deploy --schema apps/copilot/prisma/schema.prisma \
  || die "copilot migration failed — nothing was swapped, the old version is still serving"

swap api
swap web
swap_or_start copilot
reload_caddy
verify

[ "$DRY" = 1 ] || echo "$sha" >> "$HISTORY_FILE"
log "deploy complete: $sha is serving"
