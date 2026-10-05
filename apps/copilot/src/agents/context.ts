// Wires one chat turn to the real world: the logged-in user's session, the
// copilot database, NPI as that user, and the model provider. Kept apart
// from `run.ts` so that the turn itself stays testable with fakes.
import { parseKey } from '../crypto/aead';
import { getDb } from '../db';
import { executeJob } from '../execute/run';
import { docsRoot, createFsStorage } from '../intake/upload';
import { startIntake } from '../intake/job';
import type { EditDeps } from '../intake/edit';
import { createLlmClient } from '../llm/client';
import { createAnthropicProvider } from '../llm/providers/anthropic';
import { createNpiClient } from '../npi/client';
import { FLOW_REQUIRED_MODULE, FLOW_TYPES } from '../onboarding/profile.schema';
import { loadPersona } from '../positions/persona';
import { buildDictionary } from '../privacy/dictionary';
import type { FlowType } from './router';
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
    permissions: string[];
    orgNameAr: string | null;
  };
}

// One provider per process: it holds the SDK client.
const provider = createAnthropicProvider();

/** The flows this firm switched on (D-T26-9): a flow is offered when the module
 *  it belongs to is among the firm's visible modules. A firm that has not run
 *  the setup yet has no row, and sees all five. */
export function visibleFlowsOf(visibleModulesJson: unknown): FlowType[] {
  if (!Array.isArray(visibleModulesJson)) return [...FLOW_TYPES];
  const modules = new Set(visibleModulesJson.filter((m): m is string => typeof m === 'string'));
  return FLOW_TYPES.filter((flow) => modules.has(FLOW_REQUIRED_MODULE[flow]));
}

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
    permissions: session.user.permissions,
    orgNameAr: session.user.orgNameAr,
  };

  const firm = await db.firmConfig.findUnique({ where: { npiOrgId: user.npiOrgId }, select: { visibleModulesJson: true } });
  const llm = createLlmClient({ provider, db });
  const dictionary = () =>
    buildDictionary(npi, {
      npiOrgId: user.npiOrgId,
      npiUserId: user.npiUserId,
      nameAr: user.nameAr,
    });

  const deps: TurnDeps = {
    db,
    llm,
    npi,
    key: parseKey(process.env.COPILOT_SESSION_KEY),
    dictionary,
    visibleFlows: firm ? visibleFlowsOf(firm.visibleModulesJson) : undefined,
    intake: {
      start: (caller, input) => startIntake({ db, llm, npi, storage: createFsStorage(docsRoot()), dictionary }, caller, input),
    },
  };
  return { deps, user };
}

/** What the intake endpoint needs to act on a job as the logged-in user: the
 *  database, the audited model client, NPI under the user's token, the
 *  pseudonymizer's dictionary and the document store. */
export function buildEditDeps(session: {
  npiToken: string;
  user: { npiUserId: string; npiOrgId: string; nameAr: string };
}): EditDeps {
  const db = getDb();
  const npi = createNpiClient({ token: session.npiToken });
  const storage = createFsStorage(docsRoot());
  return {
    db,
    llm: createLlmClient({ provider, db }),
    npi,
    storage,
    execute: (job, plan) =>
      executeJob({ db, npi, storage, now: undefined }, { npiOrgId: session.user.npiOrgId, npiUserId: session.user.npiUserId }, job, plan),
    dictionary: () =>
      buildDictionary(npi, {
        npiOrgId: session.user.npiOrgId,
        npiUserId: session.user.npiUserId,
        nameAr: session.user.nameAr,
      }),
  };
}
