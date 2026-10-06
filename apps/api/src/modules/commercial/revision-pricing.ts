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
  subtotal?: unknown;
  pricingScheme?: unknown;
  bomLines?: Array<Record<string, unknown>>;
}

/**
 * Hides a proposal revision's price build-up from a caller without
 * finance.costs.view: `subtotal`, `pricingScheme`, and each BOM line's
 * `unitPrice` / `lineTotal` become null (keys kept). `totalAmount` — the selling
 * price — is deliberately left visible. The margin is gone either way (it is a
 * COST_FIELDS key), and with `subtotal` hidden it cannot be re-derived as
 * totalAmount - subtotal.
 */
export function hideRevisionPricing<T extends RevisionLike>(rev: T): T {
  const out: RevisionLike = { ...rev };
  if ('subtotal' in out) out.subtotal = null;
  if ('pricingScheme' in out) out.pricingScheme = null;
  if (Array.isArray(out.bomLines)) {
    out.bomLines = out.bomLines.map((l) => ({ ...l, unitPrice: null, lineTotal: null }));
  }
  return out as T;
}
