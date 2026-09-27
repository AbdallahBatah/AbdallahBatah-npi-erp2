// Wires one chat turn to the real world: the logged-in user's session, the
// copilot database, NPI as that user, and the model provider. Kept apart
// from `run.ts` so that the turn itself stays testable with fakes.
import { parseKey } from '../crypto/aead';
import { getDb } from '../db';
import { createLlmClient } from '../llm/client';
import { createAnthropicProvider } from '../llm/providers/anthropic';
import { createNpiClient } from '../npi/client';
import { loadPersona } from '../positions/persona';
import { buildDictionary } from '../privacy/dictionary';
import type { TurnDeps, TurnUser } from './run';

export interface TurnSession {
  npiToken: string;
  user: {
    npiUserId: string;
    npiOrgId: string;
    nameAr: string;
    roleKey: string;
    positionId: string | null;
    positionTitleAr: string | null;
  };
}

// One provider per process: it holds the SDK client.
const provider = createAnthropicProvider();

export async function buildTurn(session: TurnSession): Promise<{ deps: TurnDeps; user: TurnUser }> {
  const db = getDb();
  const npi = createNpiClient({ token: session.npiToken });

  // The stored persona wins: an administrator may have edited it in setup.
  const position = session.user.positionId
    ? await db.position.findUnique({
        where: { id: session.user.positionId },
        select: { personaAr: true, titleAr: true },
      })
    : null;

  const user: TurnUser = {
    npiOrgId: session.user.npiOrgId,
    npiUserId: session.user.npiUserId,
    nameAr: session.user.nameAr,
    positionId: session.user.positionId,
    positionTitleAr: position?.titleAr ?? session.user.positionTitleAr,
    personaAr: position?.personaAr ?? loadPersona(session.user.roleKey),
  };

  const deps: TurnDeps = {
    db,
    llm: createLlmClient({ provider, db }),
    npi,
    key: parseKey(process.env.COPILOT_SESSION_KEY),
    dictionary: () =>
      buildDictionary(npi, {
        npiOrgId: user.npiOrgId,
        npiUserId: user.npiUserId,
        nameAr: user.nameAr,
      }),
  };
  return { deps, user };
}
