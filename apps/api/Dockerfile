# NPI Solar ERP — API image (NestJS + Prisma, npm-workspaces monorepo).
# Build from the REPO ROOT:  docker build -f apps/api/Dockerfile .

FROM node:20-alpine AS build
RUN apk add --no-cache openssl
WORKDIR /app

# Install with only the manifests first so the layer caches across code edits.
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY packages/db/package.json packages/db/
COPY packages/shared/package.json packages/shared/
RUN npm ci

COPY . .
RUN npm run build -w @npi/shared \
 && npm run build -w @npi/db \
 && npm run build -w @npi/api

# ---- runtime ----
FROM node:20-alpine
RUN apk add --no-cache openssl
WORKDIR /app
ENV NODE_ENV=production

# Full node_modules (keeps prisma CLI + ts-node for migrate/seed in the reset job).
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./
COPY --from=build /app/packages/shared/package.json packages/shared/
COPY --from=build /app/packages/shared/dist packages/shared/dist
COPY --from=build /app/packages/db/package.json packages/db/
COPY --from=build /app/packages/db/dist packages/db/dist
COPY --from=build /app/packages/db/prisma packages/db/prisma
COPY --from=build /app/apps/api/package.json apps/api/
COPY --from=build /app/apps/api/dist apps/api/dist
COPY --from=build /app/scripts ./scripts

EXPOSE 4000
# Migrations run on every boot (no-op when already applied), then the API starts.
CMD ["sh", "-c", "npx prisma migrate deploy --schema packages/db/prisma/schema.prisma && node apps/api/dist/main.js"]
