// Re-export the generated Prisma client and all its types so the rest of the
// monorepo imports the database layer from a single package: `@npi/db`.
export * from '@prisma/client';
export { PrismaClient } from '@prisma/client';
