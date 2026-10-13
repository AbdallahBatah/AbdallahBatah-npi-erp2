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
import { latestNpiFactAt, refreshNpiMemory, shouldRefreshNpiMemory, SOURCES_OF_FLOW } from '../memory/extract-npi';
import { createAnthropicProvider } from '../llm/providers/anthropic';
import { createNpiClient } from '../npi/client';
import { FLOW_REQUIRED_MODULE, FLOW_TYPES } from '../onboarding/profile.schema';
import { handoverGuidanceAr } from '../positions/handover';
import { loadPersona } from '../positions/persona';
import { activeHandoverFor } from '../positions/reassign';
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

// ─── Memory from NPI data (T-29, F-12, D-T29-3) ─────────────────────────────
// Facts derived from NPI (payment terms, lead times, recurring items, active
// projects) are refreshed at most once a day per organization, by the first
// chat turn that finds them stale, as that turn's user — sources the user
// cannot read are skipped and the next eligible user retries an hour later.
// Best effort: a failure here never fails the turn.

/** Last refresh attempt per organization in this process (ms since epoch). */
const npiMemoryAttempts = new Map<string, number>();

type MemoryDb = Parameters<typeof refreshNpiMemory>[0]['db'];
type MemoryNpi = Parameters<typeof refreshNpiMemory>[0]['npi'];

async function refreshNpiMemoryIfStale(
  db: MemoryDb,
  npi: MemoryNpi,
  user: { npiOrgId: string; permissions: readonly string[] },
): Promise<void> {
  const now = new Date();
  let lastNpiFactAt: Date | null;
  try {
    lastNpiFactAt = await latestNpiFactAt(db, user.npiOrgId);
  } catch (err) {
    console.warn('[copilot] npi memory: could not read the last refresh time', err instanceof Error ? err.message : err);
    return;
  }
  const attempt = npiMemoryAttempts.get(user.npiOrgId);
  const lastAttemptAt = attempt === undefined ? null : new Date(attempt);
  if (!shouldRefreshNpiMemory({ lastNpiFactAt, lastAttemptAt, now })) return;
  npiMemoryAttempts.set(user.npiOrgId, now.getTime());
  try {
    await refreshNpiMemory({ db, npi }, { npiOrgId: user.npiOrgId, permissions: user.permissions });
  } catch (err) {
    console.warn('[copilot] npi memory refresh failed', err instanceof Error ? err.message : err);
  }
}

/** After a successful execution (T-27), the sources that flow wrote to are
 *  re-read so the new contract's terms or the new receipt's lead time are in
 *  memory at once (02 §5.8 item 8). Best effort: never changes the outcome. */
async function refreshNpiMemoryAfterExecution(
  db: MemoryDb,
  npi: MemoryNpi,
  user: { npiOrgId: string; permissions: readonly string[] },
  flow: keyof typeof SOURCES_OF_FLOW,
): Promise<void> {
  const only = SOURCES_OF_FLOW[flow];
  if (only.length === 0) return;
  try {
    await refreshNpiMemory({ db, npi }, { npiOrgId: user.npiOrgId, permissions: user.permissions }, { only });
  } catch (err) {
    console.warn('[copilot] npi memory refresh after execution failed', err instanceof Error ? err.message : err);
  }
}

// ─── Handover guidance (T-30, F-13, 01 §3 scenario 5: «إرشاد 7 أيام») ────────
// For seven days after a user took over a position, their chat's system
// prompt carries an excerpt of the handover document (open NPI tasks, vendors,
// routines, the narrative). Best effort: a failure here never fails the turn.

async function handoverGuidanceIfRecent(
  db: Parameters<typeof activeHandoverFor>[0],
  user: { npiUserId: string; positionId: string | null },
  now: Date,
): Promise<string | null> {
  if (user.positionId === null) return null;
  try {
    const body = await activeHandoverFor(db, { npiUserId: user.npiUserId, positionId: user.positionId }, now);
    return body ? handoverGuidanceAr(body) : null;
  } catch (err) {
    console.warn('[copilot] handover guidance unavailable', err instanceof Error ? err.message : err);
    return null;
  }
}

/** The flows this firm switched on (D-T26-9): a flow is offered when the module
 *  it belongs to is among the firm's visible modules. A flow with no module
 *  (the administrative `user_permissions`, D-26) is always offered here; NPI's
 *  own permission decides whether the user may run it. A firm that has not run
 *  the setup yet has no row, and sees every flow. */
export function visibleFlowsOf(visibleModulesJson: unknown): FlowType[] {
  if (!Array.isArray(visibleModulesJson)) return [...FLOW_TYPES];
  const modules = new Set(visibleModulesJson.filter((m): m is string => typeof m === 'string'));
  return FLOW_TYPES.filter((flow) => {
    const required = FLOW_REQUIRED_MODULE[flow];
    return required === null || modules.has(required);
  });
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
    handoverAr: await handoverGuidanceIfRecent(
      db,
      { npiUserId: session.user.npiUserId, positionId: session.user.positionId },
      new Date(),
    ),
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
  // Before the turn, so its retrieval already sees today's facts (D-T29-3a).
  await refreshNpiMemoryIfStale(db, npi, { npiOrgId: user.npiOrgId, permissions: user.permissions });
  return { deps, user };
}

/** What the intake endpoint needs to act on a job as the logged-in user: the
 *  database, the audited model client, NPI under the user's token, the
 *  pseudonymizer's dictionary and the document store. */
export function buildEditDeps(session: {
  npiToken: string;
  user: { npiUserId: string; npiOrgId: string; nameAr: string; permissions: string[] };
}): EditDeps {
  const db = getDb();
  const npi = createNpiClient({ token: session.npiToken });
  const storage = createFsStorage(docsRoot());
  return {
    db,
    llm: createLlmClient({ provider, db }),
    npi,
    storage,
    execute: async (job, plan) => {
      const executed = await executeJob({ db, npi, storage, now: undefined }, { npiOrgId: session.user.npiOrgId, npiUserId: session.user.npiUserId }, job, plan);
      if (executed.status === 'done') {
        await refreshNpiMemoryAfterExecution(db, npi, { npiOrgId: session.user.npiOrgId, permissions: session.user.permissions }, job.flowType);
      }
      return executed;
    },
    dictionary: () =>
      buildDictionary(npi, {
        npiOrgId: session.user.npiOrgId,
        npiUserId: session.user.npiUserId,
        nameAr: session.user.nameAr,
      }),
  };
}
