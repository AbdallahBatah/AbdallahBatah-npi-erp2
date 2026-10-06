import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import { Observable, map } from 'rxjs';
import { COST_FIELDS, PERMISSIONS } from '@npi/shared';
import type { AuthUser } from './auth-user';

const COST_KEYS: ReadonlySet<string> = new Set(COST_FIELDS);

/** Only plain objects and arrays are walked; Decimal, Date, Buffer, streams pass through. */
const isPlainObject = (v: unknown): v is Record<string, unknown> => {
  if (v === null || typeof v !== 'object') return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
};

/**
 * Returns a copy of `value` in which every key listed in `fields` holds `null`,
 * at any depth. Keys are kept (never deleted) so clients that destructure them
 * keep working. Anything that is not a plain object or an array is returned
 * as-is. Nothing is mutated — the caller's value may be shared (a cached row).
 */
export function redactCostFields(value: unknown, fields: ReadonlySet<string> = COST_KEYS): unknown {
  if (Array.isArray(value)) return value.map((v) => redactCostFields(v, fields));
  if (!isPlainObject(value)) return value;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) {
    out[k] = fields.has(k) ? null : redactCostFields(v, fields);
  }
  return out;
}

/**
 * The server-side half of "hide costs and margins". A user whose permission set
 * lacks `finance.costs.view` receives `null` in every COST_FIELDS key of every
 * JSON response — whatever endpoint produced it — so a new endpoint that
 * returns an `unitCost` is covered without anyone remembering to redact it.
 * The UI also hides the columns, but this is the guard that cannot be bypassed
 * by calling the API directly.
 *
 * Fail-closed: a request with no authenticated user (a public route) is
 * redacted too. `subtotal` / `amount` are not in COST_FIELDS: an invoice is a
 * sale, not a cost.
 */
@Injectable()
export class CostRedactionInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType() !== 'http') return next.handle();
    const user = context.switchToHttp().getRequest<{ user?: AuthUser }>().user;
    if (user?.permissions.includes(PERMISSIONS.COSTS_VIEW)) return next.handle();
    return next.handle().pipe(map((body) => redactCostFields(body)));
  }
}
