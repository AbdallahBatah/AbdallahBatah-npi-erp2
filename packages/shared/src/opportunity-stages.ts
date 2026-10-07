/**
 * CRM Phase 1 · Step 3 — the opportunity funnel's movement rules (§2, §3).
 *
 *   محتمل ← تأهيل ← عرض سعر ← تفاوض ← رابحة | خاسرة
 *   PROSPECTING → QUALIFICATION → PROPOSAL → NEGOTIATION → WON | LOST
 *
 * One pure function decides whether a manual move is allowed; the server calls
 * it (the browser may call it too, to decide which buttons to draw). Nothing
 * here touches the database.
 *
 * The two paths that are NOT manual moves — creating a proposal (carries the
 * opportunity to PROPOSAL) and creating a contract (carries it to WON) — are
 * implemented by the opportunities service, not by this function, because they
 * are allowed to jump forward.
 */

/** The open stages, in funnel order. */
export const OPPORTUNITY_STAGE_FLOW = ['PROSPECTING', 'QUALIFICATION', 'PROPOSAL', 'NEGOTIATION'] as const;

/** The closed stages. Nothing leaves them: reopening means a new opportunity. */
export const OPPORTUNITY_TERMINAL = ['WON', 'LOST'] as const;

export type OpenOpportunityStage = (typeof OPPORTUNITY_STAGE_FLOW)[number];
export type TerminalOpportunityStage = (typeof OPPORTUNITY_TERMINAL)[number];

export type OpportunityTransitionRefusal = 'TERMINAL' | 'SKIP' | 'UNKNOWN';
export type OpportunityTransition = { ok: true } | { ok: false; reason: OpportunityTransitionRefusal };

const FLOW: readonly string[] = OPPORTUNITY_STAGE_FLOW;
const TERMINAL: readonly string[] = OPPORTUNITY_TERMINAL;

/** An opportunity still in play (not won, not lost). Unknown values are not open. */
export function isOpenStage(stage: string): stage is OpenOpportunityStage {
  return FLOW.includes(stage);
}

/**
 * Is a manual move from `from` to `to` allowed?
 *
 * - open → the next open stage: yes; open → any EARLIER open stage: yes (a step
 *   back is allowed and is audited as such — see {@link isBackwardMove});
 * - open → a later open stage that skips one: SKIP;
 * - open → LOST: yes, from any open stage (the loss reason is the caller's rule);
 * - open → WON: only from NEGOTIATION by hand (the contract path wins from any
 *   open stage, but that is not a manual move);
 * - WON / LOST → anything: TERMINAL;
 * - the stage it is already in: SKIP (there is nowhere to move);
 * - a value that is not a stage: UNKNOWN.
 */
export function opportunityTransition(from: string, to: string): OpportunityTransition {
  const known = (s: string) => FLOW.includes(s) || TERMINAL.includes(s);
  if (!known(from) || !known(to)) return { ok: false, reason: 'UNKNOWN' };
  if (TERMINAL.includes(from)) return { ok: false, reason: 'TERMINAL' };

  if (to === 'LOST') return { ok: true };
  if (to === 'WON') return from === 'NEGOTIATION' ? { ok: true } : { ok: false, reason: 'SKIP' };

  const a = FLOW.indexOf(from);
  const b = FLOW.indexOf(to);
  if (b === a) return { ok: false, reason: 'SKIP' };
  if (b < a || b === a + 1) return { ok: true };
  return { ok: false, reason: 'SKIP' };
}

/** True when a move between two OPEN stages goes backwards (recorded in the audit trail). */
export function isBackwardMove(from: string, to: string): boolean {
  const a = FLOW.indexOf(from);
  const b = FLOW.indexOf(to);
  return a >= 0 && b >= 0 && b < a;
}
