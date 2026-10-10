// Fixtures for e2e/setup-live.spec.ts (T-20): reads the scratch-org admin
// credentials `packages/db/prisma/madar-scratch-orgs.ts` seeds (never
// hardcoded, never printed), logs in against the local NPI API the same way
// `e2e/setup.spec.ts`'s `npiOrgId` does, and reads NPI's admin state through
// the onboarding's own readers (`src/npi/admin.ts`, `src/npi/directory.ts`) —
// never NPI's database. The copilot-side helpers use the copilot's own
// Prisma client, same discipline as `setup-db.ts`/`settings-db.ts` (08 §E.10:
// the copilot never touches NPI's database).
import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { APIRequestContext } from '@playwright/test';
import '../../tests/helpers/load-env';
import { PrismaClient, type FirmConfig } from '../../src/generated/prisma';
import {
  readApprovalRules,
  readItems,
  readRoles,
  type NpiApprovalRule,
  type NpiItem,
  type NpiRole,
} from '../../src/npi/admin';
import { readDepartments, type NpiDepartment } from '../../src/npi/directory';

// ─── Scratch credentials ────────────────────────────────────────────────────

const SCRATCH_ORGS_PATH = path.resolve(__dirname, '..', '..', '..', '..', 'packages', 'db', 'prisma', 'madar-scratch-orgs.ts');

let cachedFile: string | undefined;
function fileContents(): string {
  if (cachedFile === undefined) cachedFile = readFileSync(SCRATCH_ORGS_PATH, 'utf8');
  return cachedFile;
}

/** Reads `SCRATCH_PASSWORD` from `madar-scratch-orgs.ts` by regex — the same
 *  "never hardcoded, never printed" discipline `accounts.ts` applies to
 *  `seed.ts`'s admin password. */
export function readScratchPassword(): string {
  const contents = fileContents();
  const match = contents.match(/const SCRATCH_PASSWORD = '([^']+)';/);
  if (!match) {
    throw new Error("packages/db/prisma/madar-scratch-orgs.ts: could not find the SCRATCH_PASSWORD line");
  }
  return match[1];
}

export type ScratchRole = 'admin' | 'sales' | 'accountant' | 'pm' | 'site_engineer';

// Mirrors madar-scratch-orgs.ts's USER_DEFS: `emailLocal` differs from the
// role key only for `site_engineer` ("engineer").
const EMAIL_LOCAL_BY_ROLE: Record<ScratchRole, string> = {
  admin: 'admin',
  sales: 'sales',
  accountant: 'accountant',
  pm: 'pm',
  site_engineer: 'engineer',
};

// Mirrors madar-scratch-orgs.ts's USER_DEFS `nameAr` per role.
const NAME_AR_BY_ROLE: Record<ScratchRole, string> = {
  admin: 'مدير النظام',
  sales: 'مندوب المبيعات',
  accountant: 'أمين الحسابات',
  pm: 'مدير المشاريع',
  site_engineer: 'مهندس الموقع',
};

export interface ScratchAccount {
  email: string;
  password: string;
  nameAr: string;
}

/** The seeded account for `role` (default `admin`) in the scratch org of
 *  profile `key` (e.g. `scratchAccount('epc')` -> `admin@epc.scratch.madar.test`,
 *  `scratchAccount('om_provider')` -> `admin@om-provider.scratch.madar.test`).
 *  The e-mail domain label replaces `_` with `-`: NPI's `LoginDto` (`@IsEmail()`)
 *  and the login form's `type="email"` both reject an underscore in a domain
 *  label, so the scratch seed (`madar-scratch-orgs.ts`) derives its users'
 *  domains the same way — never hardcoded here. */
export function scratchAccount(key: string, role: ScratchRole = 'admin'): ScratchAccount {
  const local = EMAIL_LOCAL_BY_ROLE[role];
  const domainKey = key.replace(/_/g, '-');
  return {
    email: `${local}@${domainKey}.scratch.madar.test`,
    password: readScratchPassword(),
    nameAr: NAME_AR_BY_ROLE[role],
  };
}

// ─── NPI (read-only reads here; writes happen through the copilot's own
//     setup wizard under test, never directly) ─────────────────────────────

const API_PORT = process.env.COPILOT_E2E_API_PORT ?? '4077';
const API_BASE = `http://localhost:${API_PORT}/api`;

export interface NpiSession {
  token: string;
  orgId: string;
  userId: string;
}

/** `POST /auth/login`: same endpoint and response shape `setup.spec.ts`'s
 *  `npiOrgId` reads (`apps/api/src/modules/auth/auth.service.ts`'s `login`
 *  returns `{ accessToken, user: { id, organization: { id }, ... } }`). */
export async function npiLogin(request: APIRequestContext, account: ScratchAccount): Promise<NpiSession> {
  const res = await request.post(`${API_BASE}/auth/login`, { data: { email: account.email, password: account.password } });
  if (!res.ok()) {
    throw new Error(`NPI login failed for ${account.email}: HTTP ${res.status()}`);
  }
  const body = (await res.json()) as { accessToken: string; user: { id: string; organization: { id: string } } };
  return { token: body.accessToken, orgId: body.user.organization.id, userId: body.user.id };
}

export async function npiGet(request: APIRequestContext, token: string, apiPath: string): Promise<unknown> {
  const res = await request.get(`${API_BASE}${apiPath}`, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok()) {
    throw new Error(`NPI GET ${apiPath} failed: HTTP ${res.status()}`);
  }
  return res.json();
}

export interface NpiState {
  departments: NpiDepartment[];
  roles: NpiRole[];
  rules: NpiApprovalRule[];
  items: NpiItem[];
}

/** Reads the four admin slots the onboarding plan itself reads
 *  (`src/onboarding/apply.ts`'s `loadNpiSnapshot`), through the same pure
 *  readers, so a live apply's effect on NPI is asserted with the exact same
 *  parsing the application uses — never a second, hand-rolled parse. */
export async function readNpiState(request: APIRequestContext, token: string): Promise<NpiState> {
  const [departments, roles, rules, items] = await Promise.all([
    npiGet(request, token, '/admin/departments'),
    npiGet(request, token, '/admin/roles'),
    npiGet(request, token, '/approvals/rules'),
    npiGet(request, token, '/items'),
  ]);
  return {
    departments: readDepartments(departments),
    roles: readRoles(roles),
    rules: readApprovalRules(rules),
    items: readItems(items),
  };
}

// ─── Copilot DB ─────────────────────────────────────────────────────────────

let client: PrismaClient | undefined;
function getClient(): PrismaClient {
  if (!client) client = new PrismaClient();
  return client;
}

export async function readFirmConfig(npiOrgId: string): Promise<FirmConfig | null> {
  return getClient().firmConfig.findUnique({ where: { npiOrgId } });
}

export interface OnboardingSessionRow {
  npiOrgId: string;
  startedAt: Date;
  completedAt: Date | null;
  profileChosen: string | null;
}

export async function readOnboardingSessions(npiOrgId: string): Promise<OnboardingSessionRow[]> {
  return getClient().onboardingSession.findMany({
    where: { npiOrgId },
    select: { npiOrgId: true, startedAt: true, completedAt: true, profileChosen: true },
    orderBy: { startedAt: 'asc' },
  });
}

export interface EvalRunWrite {
  kind: string;
  startedAt: Date;
  finishedAt: Date;
  score: number;
  passed: boolean;
  detailsJson: unknown;
}

export async function writeEvalRun(write: EvalRunWrite): Promise<void> {
  await getClient().evalRun.create({
    data: {
      kind: write.kind,
      startedAt: write.startedAt,
      finishedAt: write.finishedAt,
      score: write.score,
      passed: write.passed,
      detailsJson: write.detailsJson as object,
    },
  });
}

/** Closes the fixture's own Prisma connection — call once, from `afterAll`. */
export async function disconnectScratchDb(): Promise<void> {
  if (client) {
    await client.$disconnect();
    client = undefined;
  }
}
