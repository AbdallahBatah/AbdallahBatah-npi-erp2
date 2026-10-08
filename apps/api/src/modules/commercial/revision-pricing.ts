import { ForbiddenException } from '@nestjs/common';
import { PERMISSIONS } from '@npi/shared';
import type { AuthUser } from '../../common/auth-user';

/** Does this caller hold finance.costs.view (costs, margins, pricing build-up)? */
export const canViewCosts = (user: AuthUser): boolean =>
  user.permissions.includes(PERMISSIONS.COSTS_VIEW);

/**
 * Write-side twin of the redaction interceptor: a caller who cannot SEE costs
 * and margins must not be able to SET them either. The message names the
 * *field class*, not the permission key, so the web app can translate it
 * (errors.ts matches /cost and margin fields/) without enumerating the model.
 */
export const COST_WRITE_DENIED = 'Setting cost and margin fields is not permitted for your role';

export function assertCanSetCosts(user: AuthUser): void {
  if (!canViewCosts(user)) throw new ForbiddenException(COST_WRITE_DENIED);
}

interface RevisionLike {
  validUntil?: unknown;
  subtotal?: unknown;
  marginAmount?: unknown;
  pricingScheme?: unknown;
  bomLines?: Array<Record<string, unknown>>;
}

/** Every BOM-line field that reveals what an item cost us (CRM Step 4). */
const LINE_COST_KEYS = [
  'unitCost',
  'originalUnitCost',
  'costSource',
  'costDate',
  'costAgeDays',
  'costOverrideReason',
  'costOverriddenAt',
  'costOverriddenById',
] as const;

/**
 * Was this revision written by Step 4 or later? From then on the BOM line keeps the
 * COST (`unitCost`) and its `unitPrice` / `lineTotal` are the SELLING price; before
 * it, `unitPrice` was the cost base. A revision made since carries a validity date
 * (mandatory) and costed lines; either is enough to tell.
 */
export function isCostBasedRevision(rev: RevisionLike): boolean {
  if (rev.validUntil !== undefined && rev.validUntil !== null) return true;
  return Array.isArray(rev.bomLines) && rev.bomLines.some((l) => l.unitCost !== undefined && l.unitCost !== null);
}

/**
 * Hides a proposal revision's cost build-up from a caller without
 * finance.costs.view; `totalAmount` — the selling price — is deliberately left
 * visible, and so is everything that is the selling price.
 *
 *  · Revision made before Step 4 (`unitPrice` is the cost base): `subtotal`,
 *    `pricingScheme`, and each BOM line's `unitPrice` / `lineTotal` become null
 *    (keys kept) — the old rule, unchanged. The margin is gone either way (it is a
 *    COST_FIELDS key), and with `subtotal` hidden it cannot be re-derived as
 *    totalAmount - subtotal.
 *  · Revision made since: the line's `unitPrice` / `lineTotal` ARE the price and
 *    stay; what goes is the cost — `subtotal`, `marginAmount`, `pricingScheme` and
 *    on every line the cost, the original cost, its source, date and age, and the
 *    record of a manual change (each of those would reveal the margin).
 */
export function hideRevisionPricing<T extends RevisionLike>(rev: T): T {
  const out: RevisionLike = { ...rev };
  if ('subtotal' in out) out.subtotal = null;
  if ('pricingScheme' in out) out.pricingScheme = null;
  const costBased = isCostBasedRevision(rev);
  if (costBased && 'marginAmount' in out) out.marginAmount = null;
  if (Array.isArray(out.bomLines)) {
    out.bomLines = out.bomLines.map((l) => {
      if (!costBased) return { ...l, unitPrice: null, lineTotal: null };
      const hidden: Record<string, unknown> = { ...l };
      for (const k of LINE_COST_KEYS) if (k in hidden) hidden[k] = null;
      return hidden;
    });
  }
  return out as T;
}
