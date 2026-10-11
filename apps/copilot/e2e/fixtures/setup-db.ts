// Database fixture for e2e/setup.spec.ts (T-18): deletes any open (never
// completed) onboarding session for an organization before each test, so
// every test starts the wizard at step 1 regardless of what an earlier run
// — or a developer poking at /setup locally — left behind.
//
// T-47a: a fresh session is no longer "step 1" on its own — the wizard reads
// NPI and opens on the summary. The tests that walk the steps one by one
// therefore get a session marked `manual` (the default here); the tests of
// the automatic setup ask for none (`{ manual: false }`) and let the page
// seed it.
//
// Uses the copilot's own Prisma client (never NPI's database — the copilot
// has no access to `npi`, 08 §E.10) and the same `.env` loading
// `tests/helpers/load-env.ts` already does for Jest, so `COPILOT_DATABASE_URL`
// is populated the same way in both runners. Never logs the URL.
import '../../tests/helpers/load-env';
import { PrismaClient } from '../../src/generated/prisma';

let client: PrismaClient | undefined;

function getClient(): PrismaClient {
  if (!client) client = new PrismaClient();
  return client;
}

/** Deletes every `onboarding_sessions` row for `npiOrgId` that was never
 *  completed (`completedAt IS NULL`) — the row `getSetupState`/
 *  `handleSetupAction` would otherwise resume from — and, unless
 *  `manual: false`, opens a fresh one at step 1 that the wizard must not
 *  replace with a reading of NPI. */
export async function resetOpenSetupSessions(npiOrgId: string, options: { manual?: boolean } = {}): Promise<void> {
  const prisma = getClient();
  await prisma.onboardingSession.deleteMany({ where: { npiOrgId, completedAt: null } });
  if (options.manual ?? true) {
    await prisma.onboardingSession.create({
      data: { npiOrgId, npiUserId: 'e2e-fixture', stepsJson: { step: 1, answers: {}, completedSteps: [], manual: true } },
    });
  }
}

/** Closes the fixture's own Prisma connection — call once, from `afterAll`. */
export async function disconnectSetupDb(): Promise<void> {
  if (client) {
    await client.$disconnect();
    client = undefined;
  }
}
