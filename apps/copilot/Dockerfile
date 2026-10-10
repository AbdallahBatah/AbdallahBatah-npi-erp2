# Madar copilot — image (Next.js standalone + the copilot's own Prisma schema).
# Build from the REPO ROOT:  docker build -f apps/copilot/Dockerfile .
#
# Node 24 (spec/madar/02 §1): pdf-parse 2.4.5 needs Node ≥ 20.16 / ≥ 22.3, and
# the copilot pins its own runtime instead of inheriting NPI's node:20 images.
# Alpine: @napi-rs/canvas (pdf-parse's page rasterizer) ships a linux-x64-musl
# binary, and Prisma generates its linux-musl-openssl-3.0.x engine here, so the
# generated client under src/generated is rebuilt inside this image, never
# copied from a developer machine (.dockerignore).

FROM node:24-alpine AS build
RUN apk add --no-cache openssl
WORKDIR /app

# Manifests first so the install layer caches across code edits (same shape as
# apps/api/Dockerfile and apps/web/Dockerfile; this image adds the copilot's).
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY apps/copilot/package.json apps/copilot/
COPY packages/db/package.json packages/db/
COPY packages/shared/package.json packages/shared/
RUN npm ci

COPY . .
# `prebuild` runs `prisma generate` (musl engine); `next build` with
# NEXT_OUTPUT=standalone traces the server's node_modules (next.config.js).
# next/font self-hosts the Arabic font at build time — no runtime request.
ENV NEXT_OUTPUT=standalone NEXT_TELEMETRY_DISABLED=1
RUN npm run build -w @npi/copilot

# ---- runtime ----
FROM node:24-alpine
RUN apk add --no-cache openssl
WORKDIR /app
# PORT/HOSTNAME are read by Next's standalone server.js. The port is fixed
# here (COPILOT_PORT is the dev convention of scripts/run-next.mjs); Caddy
# proxies /copilot* to copilot:3100 (deploy/Caddyfile).
ENV NODE_ENV=production PORT=3100 HOSTNAME=0.0.0.0 \
    NEXT_TELEMETRY_DISABLED=1 CHECKPOINT_DISABLE=1 PRISMA_HIDE_UPDATE_MESSAGE=1

# The standalone output keeps the monorepo layout: apps/copilot/server.js plus
# the traced node_modules at the root. server.js chdir()s into apps/copilot, so
# everything the code reads with fs at request time relative to process.cwd()
# must sit under apps/copilot/ here: public/ (brand assets; standalone does
# not bundle it), catalog/ (onboarding profile packs, src/onboarding/catalog.ts)
# and prompts/ (src/prompts/load.ts). config/pricing.json is imported, so it
# is already inside the bundle.
COPY --from=build --chown=node:node /app/apps/copilot/.next/standalone ./
COPY --from=build --chown=node:node /app/apps/copilot/.next/static ./apps/copilot/.next/static
COPY --from=build --chown=node:node /app/apps/copilot/public ./apps/copilot/public
COPY --from=build --chown=node:node /app/apps/copilot/catalog ./apps/copilot/catalog
COPY --from=build --chown=node:node /app/apps/copilot/prompts ./apps/copilot/prompts

# pdf-parse loads @napi-rs/canvas (its page rasterizer for scanned PDFs) with
# a dynamic require that Next's file tracer does not follow, so the standalone
# output arrives without it and rasterizing would fail at runtime with
# «Cannot load "@napi-rs/canvas"». Copied explicitly: the JS wrapper and the
# linux-x64-musl binary npm ci resolved for this platform (the T-21 check).
COPY --from=build /app/node_modules/@napi-rs ./node_modules/@napi-rs

# The Prisma CLI and the copilot's schema + migrations, for `migrate deploy`
# against npi_copilot (on boot below, and from deploy.sh in T-41). Only the
# CLI's own dependency closure is copied — not the build stage's node_modules.
COPY --from=build /app/apps/copilot/prisma ./apps/copilot/prisma
COPY --from=build /app/node_modules/prisma ./node_modules/prisma
COPY --from=build /app/node_modules/@prisma/engines ./node_modules/@prisma/engines
COPY --from=build /app/node_modules/@prisma/engines-version ./node_modules/@prisma/engines-version
COPY --from=build /app/node_modules/@prisma/fetch-engine ./node_modules/@prisma/fetch-engine
COPY --from=build /app/node_modules/@prisma/get-platform ./node_modules/@prisma/get-platform
COPY --from=build /app/node_modules/@prisma/debug ./node_modules/@prisma/debug

# Uploaded documents (COPILOT_DOCS_DIR, spec/madar/02 §11/§12) live on the
# copilot_docs volume mounted here; created now so the volume inherits an
# owner the non-root process can write as.
RUN mkdir -p /data/copilot_docs && chown -R node:node /data /app
USER node

EXPOSE 3100
# Through the app's own probe (src/app/api/health/route.ts): it answers 200
# only when npi_copilot answers — a listening port alone proves nothing.
HEALTHCHECK --interval=10s --timeout=5s --start-period=30s --retries=12 \
  CMD ["node", "-e", "require('http').get('http://127.0.0.1:3100/copilot/api/health',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"]

# Migrations run on every boot (a no-op when already applied — the same rule as
# apps/api/Dockerfile; deploy.sh also runs them before the swap), then the
# server starts. The copilot's schema reads COPILOT_DATABASE_URL only.
CMD ["sh", "-c", "node node_modules/prisma/build/index.js migrate deploy --schema apps/copilot/prisma/schema.prisma && node apps/copilot/server.js"]
