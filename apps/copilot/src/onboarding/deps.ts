// The dependencies of the setup service's READ path (`getSetupState`) for one
// request, as the logged-in user: the copilot's database and NPI under the
// user's own token — no model client and no pseudonymizer, which only the
// answer/preview/apply actions need (and whose dictionary costs four NPI
// reads). Shared by the setup route's GET (`src/app/api/setup/route.ts`) and
// the setup page (`src/app/setup/page.tsx`), which since T-39b (D-23) reads
// the same view on the server and hands it to the wizard.
import { getDb } from '@/db';
import { createNpiClient } from '@/npi/client';
import type { SetupReadDeps } from './service';

export function buildSetupReadDeps(npiToken: string): SetupReadDeps {
  const db = getDb();
  return {
    // Same cast as the route's own `buildDeps`: the generated client types
    // `stepsJson` as its own strict `InputJsonValue`; at runtime it accepts
    // any JSON-serializable value.
    db: db as unknown as SetupReadDeps['db'],
    npi: createNpiClient({ token: npiToken }),
  };
}
