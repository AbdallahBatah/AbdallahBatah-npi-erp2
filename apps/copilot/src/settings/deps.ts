// The real dependencies of the settings service for one request, as the
// logged-in user: the copilot's database and NPI under the user's own token.
// Shared by the settings route (`src/app/api/settings/route.ts`) and the
// settings page (`src/app/settings/page.tsx`), which since T-39b (D-23)
// reads the same view on the server and hands it to the panel.
import { getDb } from '@/db';
import { createNpiClient } from '@/npi/client';
import type { SettingsDb, SettingsDeps } from './service';
import type { SyncActionDb } from './sync';
import type { SyncNpi } from '@/onboarding/sync';

export function buildSettingsDeps(npiToken: string): SettingsDeps {
  const db = getDb();
  return {
    // Prisma's generated client types `firmConfig`/`position`/`manualBaseline`
    // more strictly than the structural `SettingsDb` the service is written
    // against — the same friction `api/setup/route.ts` works around with its
    // own `db` cast.
    db: db as unknown as SettingsDb,
    npi: createNpiClient({ token: npiToken }),
  };
}

/** Deps of the manual NPI sync (`POST /api/settings/sync`): the copilot's
 *  database and NPI under the administrator's own token. */
export function buildSyncActionDeps(npiToken: string): { db: SyncActionDb; npi: SyncNpi } {
  return {
    db: getDb() as unknown as SyncActionDb,
    npi: createNpiClient({ token: npiToken }),
  };
}
