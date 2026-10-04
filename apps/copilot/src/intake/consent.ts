// Consent for sending an image/scan to the model provider (ADR-27,
// spec/madar/02 §5 item 3, invariant I4). Recording a consent decision is
// intake-side state (the `documents`/`consent_events` tables); this module
// never calls a model and never touches privacy/redaction machinery — a
// model is only ever reached afterwards, through src/llm/vision.ts, which
// is the sole place that can turn a `VerifiedConsent` into bytes sent to a
// provider.
//
// This module must never import from src/llm, src/privacy or src/npi (the
// source guard test in tests/intake.spec.ts covers this file too).
import { t } from '../i18n/ar';
import type { DocumentKind, DocumentRow } from './upload';

/** Shown verbatim in the ConsentCard (03 §4) before any image/scan leaves
 *  the building. */
export const POLICY_LINE_AR = t('consent.policy_line');
/** docs/COPILOT_PHASE0_AR.md §7 — fetched and quoted during Phase 0. */
export const POLICY_SOURCE_URL = 'https://privacy.claude.com/en/articles/7996868-is-my-data-used-for-model-training';
export const POLICY_VERIFIED_ON = '2026-09-21';

/** Only `image` and `pdf_scanned` documents ever need a consent decision —
 *  `pdf_text` goes to the model only as redacted text (ADR-27). */
export function consentNeeded(kind: DocumentKind): boolean {
  return kind === 'image' || kind === 'pdf_scanned';
}

/** Mirrors the Prisma enum `ConsentDecision` (prisma/schema.prisma) as a
 *  plain string union, the same pattern `DocumentKind` already uses in
 *  `src/intake/upload.ts`. */
export type ConsentDecision = 'approved' | 'cancelled';

declare const verifiedBrand: unique symbol;
/** Proof that a document's current consent is an *approved*, matching
 *  decision — constructed only by `requireConsent` below, never by casting
 *  a plain object literal. Consumed exclusively by `src/llm/vision.ts` to
 *  build the bytes that actually leave the building. */
export interface VerifiedConsent {
  readonly [verifiedBrand]: true;
  readonly consentEventId: string;
  readonly documentId: string;
  readonly npiOrgId: string;
  readonly npiUserId: string;
}

export interface ConsentEventRow {
  id: string;
  documentId: string;
  npiOrgId: string;
  npiUserId: string;
  decision: ConsentDecision;
  policyLine: string;
  createdAt: Date;
}

/**
 * The part of the Prisma client `recordConsent`/`requireConsent` call,
 * typed closely enough that the real client satisfies it without a cast
 * (checked in tests/consent-db.spec.ts) and a small in-memory fake does too.
 */
export interface ConsentDb {
  document: {
    findFirst(args: {
      where: { id: string; npiOrgId: string; npiUserId: string };
    }): Promise<DocumentRow | null>;
    update(args: { where: { id: string }; data: { consentEventId: string | null } }): Promise<unknown>;
  };
  consentEvent: {
    create(args: {
      data: {
        documentId: string;
        npiOrgId: string;
        npiUserId: string;
        decision: ConsentDecision;
        policyLine: string;
      };
    }): Promise<ConsentEventRow>;
    findUnique(args: { where: { id: string } }): Promise<ConsentEventRow | null>;
  };
}

export type ConsentOutcome =
  | { status: 'recorded'; consentEventId: string; documentId: string; decision: ConsentDecision; policyLine: string }
  | { status: 'not_found' }
  | { status: 'not_needed' }
  | { status: 'confidential' };

/**
 * Records the caller's decision on sending `input.documentId` as an
 * image/scan. The event is written first and the document's
 * `consentEventId` pointer second — in that order deliberately: a crash
 * between the two leaves an orphaned (but harmless) consent event rather
 * than a pointer to an event that was never written. The pointer always
 * follows the latest decision, whatever it is (approve or cancel): a fresh
 * document that was never decided on keeps a null pointer ('none' from
 * `requireConsent`), while a document that was approved and then cancelled
 * points at the *cancellation* event, so `requireConsent` can tell "never
 * asked" apart from "asked and withdrawn" ('none' vs 'cancelled') from the
 * document row alone. Approving again after a cancel re-enables sending by
 * moving the pointer to the new approval event.
 */
export async function recordConsent(
  db: ConsentDb,
  caller: { npiOrgId: string; npiUserId: string },
  input: { documentId: string; decision: ConsentDecision },
): Promise<ConsentOutcome> {
  const document = await db.document.findFirst({
    where: { id: input.documentId, npiOrgId: caller.npiOrgId, npiUserId: caller.npiUserId },
  });
  if (!document) return { status: 'not_found' };
  if (document.sensitivityFlag) return { status: 'confidential' };
  if (!consentNeeded(document.kind)) return { status: 'not_needed' };

  const event = await db.consentEvent.create({
    data: {
      documentId: document.id,
      npiOrgId: caller.npiOrgId,
      npiUserId: caller.npiUserId,
      decision: input.decision,
      policyLine: POLICY_LINE_AR,
    },
  });

  await db.document.update({
    where: { id: document.id },
    data: { consentEventId: event.id },
  });

  return {
    status: 'recorded',
    consentEventId: event.id,
    documentId: document.id,
    decision: event.decision,
    policyLine: event.policyLine,
  };
}

export class ConsentRequiredError extends Error {
  readonly reason: 'not_found' | 'confidential' | 'none' | 'cancelled';

  constructor(reason: ConsentRequiredError['reason']) {
    super(`ConsentRequiredError: ${reason}`);
    this.name = 'ConsentRequiredError';
    this.reason = reason;
  }
}

/**
 * The single gate between a document and `src/llm/vision.ts`: returns a
 * `VerifiedConsent` only when the document exists for this caller, is not
 * confidential, and its current `consentEventId` points at an *approved*
 * event matching this exact document/org/user. Anything else throws
 * `ConsentRequiredError` with a reason the caller can show in Arabic.
 */
export async function requireConsent(
  db: ConsentDb,
  caller: { npiOrgId: string; npiUserId: string },
  documentId: string,
): Promise<VerifiedConsent> {
  const document = await db.document.findFirst({
    where: { id: documentId, npiOrgId: caller.npiOrgId, npiUserId: caller.npiUserId },
  });
  if (!document) throw new ConsentRequiredError('not_found');
  if (document.sensitivityFlag) throw new ConsentRequiredError('confidential');
  if (!document.consentEventId) throw new ConsentRequiredError('none');

  const event = await db.consentEvent.findUnique({ where: { id: document.consentEventId } });
  // A missing event, or one that no longer matches this exact document/org/
  // user, is treated as "no valid consent" rather than "withdrawn" — it
  // cannot happen through this module's own writes and signals data drift
  // rather than a user's cancel decision.
  if (!event || event.documentId !== document.id || event.npiOrgId !== caller.npiOrgId || event.npiUserId !== caller.npiUserId) {
    throw new ConsentRequiredError('none');
  }
  if (event.decision !== 'approved') {
    throw new ConsentRequiredError('cancelled');
  }

  return {
    consentEventId: event.id,
    documentId: document.id,
    npiOrgId: caller.npiOrgId,
    npiUserId: caller.npiUserId,
  } as VerifiedConsent;
}
