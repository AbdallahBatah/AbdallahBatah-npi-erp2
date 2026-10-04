// Database fixture for e2e/setup.spec.ts (T-18): deletes any open (never
// completed) onboarding session for an organization before each test, so
// every test starts the wizard at step 1 regardless of what an earlier run
// — or a developer poking at /setup locally — left behind.
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
 *  `handleSetupAction` would otherwise resume from. */
export async function resetOpenSetupSessions(npiOrgId: string): Promise<void> {
  await getClient().onboardingSession.deleteMany({ where: { npiOrgId, completedAt: null } });
}

/** Closes the fixture's own Prisma connection — call once, from `afterAll`. */
export async function disconnectSetupDb(): Promise<void> {
  if (client) {
    await client.$disconnect();
    client = undefined;
  }
}
