# NPI Solar ERP — web image (Next.js standalone).
# Build from the REPO ROOT:  docker build -f apps/web/Dockerfile .

FROM node:20-alpine AS build
WORKDIR /app

COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY packages/db/package.json packages/db/
COPY packages/shared/package.json packages/shared/
RUN npm ci

COPY . .
# Empty NEXT_PUBLIC_API_URL => the browser calls a relative /api, which the
# gateway (Caddy) proxies to the API container — works on any IP or domain.
ARG NEXT_PUBLIC_API_URL=""
ENV NEXT_PUBLIC_API_URL=$NEXT_PUBLIC_API_URL
# Login-page demo-credential prefill. NEXT_PUBLIC_* vars are inlined into the
# client bundle at build time, so this has to be a build arg (a runtime env
# var on the container would have no effect). Defaults to off and stays off
# on every deployed environment, the demo server included; set it to 1 for
# local development only (see deploy/.env.example).
ARG NEXT_PUBLIC_DEMO_PREFILL="0"
ENV NEXT_PUBLIC_DEMO_PREFILL=$NEXT_PUBLIC_DEMO_PREFILL
ENV NEXT_OUTPUT=standalone
RUN npm run build -w @npi/shared && npm run build -w @npi/web

# ---- runtime ----
FROM node:20-alpine
WORKDIR /app
ENV NODE_ENV=production PORT=3000 HOSTNAME=0.0.0.0

COPY --from=build /app/apps/web/.next/standalone ./
COPY --from=build /app/apps/web/.next/static ./apps/web/.next/static
# Next standalone does NOT bundle public/ — it must ride along explicitly,
# or every file under public/ (brand assets, logos) 404s in production.
COPY --from=build /app/apps/web/public ./apps/web/public

EXPOSE 3000
CMD ["node", "apps/web/server.js"]
