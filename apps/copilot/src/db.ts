// Database access guard + lazy singleton for the copilot's own Prisma client.
//
// The copilot has its own PostgreSQL database (npi_copilot), completely
// separate from NPI's database (npi_erp, see packages/db). This module
// refuses to construct a client against anything other than npi_copilot,
// so a misconfigured environment variable can never point the copilot at
// NPI's production data.
// Importing the generated client class only defines the class — it does not
// open a connection or read any env var. The connection itself is only
// opened inside getDb(), after the guard has run.
import { PrismaClient } from './generated/prisma';

const REQUIRED_DATABASE_NAME = 'npi_copilot';

/**
 * Validate a database connection string before it is ever used to open a
 * connection pool. Throws a descriptive English error for every invalid
 * shape. Never include the raw url in a thrown message: it carries a
 * password.
 */
export function assertCopilotDatabaseUrl(url: string | undefined): string {
  if (!url || url.trim().length === 0) {
    throw new Error(
      'COPILOT_DATABASE_URL is missing or empty. Set it in the repository-root .env file.',
    );
  }

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error('COPILOT_DATABASE_URL could not be parsed as a URL.');
  }

  const protocol = parsed.protocol.replace(/:$/, '');
  if (protocol !== 'postgresql' && protocol !== 'postgres') {
    throw new Error(
      `COPILOT_DATABASE_URL must use the postgresql:// or postgres:// protocol, but found protocol "${protocol}".`,
    );
  }

  const databaseName = decodeURIComponent(parsed.pathname.replace(/^\//, ''));
  if (databaseName !== REQUIRED_DATABASE_NAME) {
    throw new Error(
      `COPILOT_DATABASE_URL must point at the "${REQUIRED_DATABASE_NAME}" database, but found database name "${databaseName}". ` +
        'The copilot must never connect to NPI\'s own database (npi_erp) or any other database.',
    );
  }

  return url;
}

declare global {
  var __copilotPrisma: PrismaClient | undefined;
}

/**
 * Lazily construct (and cache on globalThis) the copilot's Prisma client.
 * Nothing constructs a client at import time — the guard only runs the
 * first time getDb() is actually called, and Next's dev hot-reload reuses
 * the cached instance instead of opening a new connection pool each time.
 */
export function getDb(): PrismaClient {
  if (globalThis.__copilotPrisma) {
    return globalThis.__copilotPrisma;
  }

  const url = assertCopilotDatabaseUrl(process.env.COPILOT_DATABASE_URL);

  const client = new PrismaClient({
    datasources: { db: { url } },
  });

  globalThis.__copilotPrisma = client;
  return client;
}
