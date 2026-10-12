// Seeded demo accounts, read from packages/db/prisma/seed.ts at run time —
// never hardcoded and never printed. Moved here (out of e2e/auth.spec.ts) so
// e2e/chat-ui.spec.ts and e2e/home.spec.ts can share the same reader instead
// of each re-parsing the seed file their own way.
import { readFileSync } from 'node:fs';
import path from 'node:path';

export interface SeededAccount {
  email: string;
  password: string;
  nameAr: string;
}

const SEED_PATH = path.resolve(__dirname, '..', '..', '..', '..', 'packages', 'db', 'prisma', 'seed.ts');

let cachedSeed: string | undefined;

function seedContents(): string {
  if (cachedSeed === undefined) cachedSeed = readFileSync(SEED_PATH, 'utf8');
  return cachedSeed;
}

/**
 * The seeded admin's e-mail, password, and Arabic name — same lines
 * `e2e/auth.spec.ts` originally parsed on its own.
 */
export function readAdminCredentials(): SeededAccount {
  const contents = seedContents();

  // The second group excludes `'` so it doesn't swallow the closing quote of
  // the console.log call that the line lives in.
  const loginLine = contents.match(/Admin login\s*:\s*(\S+)\s*\/\s*([^'\s]+)/);
  if (!loginLine) {
    throw new Error('packages/db/prisma/seed.ts: could not find the "Admin login" summary line');
  }

  const nameMatch = contents.match(/create:\s*\{[^}]*?email:\s*'admin@npi\.sa'[^}]*?nameAr:\s*'([^']+)'/);
  if (!nameMatch) {
    throw new Error("packages/db/prisma/seed.ts: could not find the admin user's nameAr field");
  }

  return { email: loginLine[1], password: loginLine[2], nameAr: nameMatch[1] };
}

/**
 * A seeded account with fewer permissions than the admin — the site
 * engineer, from the `accounts` list in seed.ts (`email: 'engineer@npi.sa'`).
 * Password and Arabic name are read from the same array entry, never
 * hardcoded here.
 */
export function readSiteEngineerCredentials(): SeededAccount {
  const contents = seedContents();

  const match = contents.match(
    /\{\s*email:\s*'engineer@npi\.sa',\s*pass:\s*'([^']+)',\s*nameAr:\s*'([^']+)'/,
  );
  if (!match) {
    throw new Error("packages/db/prisma/seed.ts: could not find the site engineer's account entry");
  }

  return { email: 'engineer@npi.sa', password: match[1], nameAr: match[2] };
}

/**
 * The seeded accounts that sit in `userDefs` in seed.ts, by role key: one per
 * company role since NPI's P1-13 made ROLE_PRESETS the seed's default.
 */
export type SeededRole =
  | 'accountant'
  | 'pm'
  | 'site_engineer'
  | 'executive'
  | 'finance_manager'
  | 'technical_office'
  | 'warehouse_keeper';

/**
 * One of the accounts in seed.ts's `userDefs` array, by role key:
 * `{ email: 'pm@npi.sa', pass: '…', nameAr: '…', nameEn: '…', role: 'pm' }`.
 * E-mail, password and Arabic name are read from that entry, never hardcoded.
 */
export function readSeededAccount(role: SeededRole): SeededAccount {
  const contents = seedContents();

  const match = contents.match(
    new RegExp(
      String.raw`\{\s*email:\s*'([^']+@npi\.sa)',\s*pass:\s*'([^']+)',\s*nameAr:\s*'([^']+)',\s*nameEn:\s*'[^']+',\s*role:\s*'${role}'\s*\}`,
    ),
  );
  if (!match) {
    throw new Error(`packages/db/prisma/seed.ts: could not find the userDefs entry for role "${role}"`);
  }

  return { email: match[1], password: match[2], nameAr: match[3] };
}

/**
 * The seeded sales account (contracts yes, requisitions no): e-mail and
 * password from the "Sales login" summary line, Arabic name from its
 * `create:` block — the same two patterns `readAdminCredentials` uses for the
 * admin.
 */
export function readSalesCredentials(): SeededAccount {
  const contents = seedContents();

  const loginLine = contents.match(/Sales login\s*:\s*(\S+)\s*\/\s*([^'\s]+)/);
  if (!loginLine) {
    throw new Error('packages/db/prisma/seed.ts: could not find the "Sales login" summary line');
  }

  const nameMatch = contents.match(/create:\s*\{[^}]*?email:\s*'sales@npi\.sa'[^}]*?nameAr:\s*'([^']+)'/);
  if (!nameMatch) {
    throw new Error("packages/db/prisma/seed.ts: could not find the sales user's nameAr field");
  }

  return { email: loginLine[1], password: loginLine[2], nameAr: nameMatch[1] };
}
