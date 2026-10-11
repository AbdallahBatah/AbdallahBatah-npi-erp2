// The «المزامنة مع NPI» card, the home banner and the two endpoints behind
// them (T-47b). The reconciliation itself is `src/onboarding/sync.ts`; this
// file only reads what it left in `firm_config` and turns it into text, runs
// the manual sync as the signed-in administrator, and records that an
// administrator has looked at the last change.
import { z } from 'zod';
import { t } from '../i18n/ar';
import { formatAgo } from '../i18n/format';
import { SYNC_PERMISSION, syncFromNpi, type SyncDb, type SyncNpi, type SyncOutcome } from '../onboarding/sync';
import type { SettingsSync, SyncActionResult, SyncBannerView } from './types';

/** How many summary lines the home banner shows before «و{n} تغييرات أخرى». */
export const BANNER_LINES = 3;

export interface SyncViewRow {
  lastSyncAt?: Date | null;
  lastSyncDiffJson?: unknown;
  lastSyncSeenAt?: Date | null;
}

const StoredDiffSchema = z.object({
  at: z.string(),
  summaryAr: z.array(z.string()),
});

function readStoredDiff(json: unknown): { at: string; summaryAr: string[] } | null {
  const parsed = StoredDiffSchema.safeParse(json);
  if (!parsed.success || parsed.data.summaryAr.length === 0 || Number.isNaN(Date.parse(parsed.data.at))) return null;
  return { at: parsed.data.at, summaryAr: parsed.data.summaryAr };
}

/** The card's data. `row` is the organization's `firm_config` (null before the
 *  setup), `permissions` the caller's NPI permissions. */
export function buildSyncView(row: SyncViewRow | null, permissions: readonly string[], now: Date): SettingsSync {
  const diff = readStoredDiff(row?.lastSyncDiffJson);
  const lastSyncAt = row?.lastSyncAt ?? null;
  return {
    canSync: permissions.includes(SYNC_PERMISSION) && row !== null,
    lastSyncAt: lastSyncAt ? lastSyncAt.toISOString() : null,
    lastSyncAgoAr: lastSyncAt ? formatAgo(lastSyncAt, now) : null,
    lastDiff: diff ? { at: diff.at, agoAr: formatAgo(diff.at, now), summaryAr: diff.summaryAr } : null,
  };
}

/**
 * The home banner: shown to a holder of `admin.department.manage` while the
 * last NPI change has not been acknowledged. «Acknowledged» is measured
 * against the moment THAT change was found (`lastSyncDiffJson.at`), not against
 * `lastSyncAt`: a later sync that finds nothing bumps `lastSyncAt` and must not
 * bring a change the administrator already dismissed back.
 */
export function buildSyncBanner(row: SyncViewRow | null, permissions: readonly string[]): SyncBannerView | null {
  if (!permissions.includes(SYNC_PERMISSION) || row === null) return null;
  const diff = readStoredDiff(row.lastSyncDiffJson);
  if (diff === null) return null;
  const seen = row.lastSyncSeenAt ?? null;
  if (seen !== null && seen.getTime() >= Date.parse(diff.at)) return null;
  return { lines: diff.summaryAr.slice(0, BANNER_LINES), more: Math.max(0, diff.summaryAr.length - BANNER_LINES) };
}

// ─── Endpoints ──────────────────────────────────────────────────────────────

/** `SyncDb` plus the two extra columns the manual sync reads back for the card. */
export type SyncActionDb = Omit<SyncDb, 'firmConfig'> & {
  firmConfig: Omit<SyncDb['firmConfig'], 'findUnique'> & {
    findUnique(args: { where: { npiOrgId: string } }): Promise<(Awaited<ReturnType<SyncDb['firmConfig']['findUnique']>> & SyncViewRow) | null>;
  };
};

export interface SyncCaller {
  npiOrgId: string;
  npiUserId: string;
  roleKey: string;
  permissions: string[];
}

export class SyncForbiddenError extends Error {
  readonly messageAr = t('settings.forbidden');
  constructor() {
    super('sync refused: admin.department.manage missing');
    this.name = 'SyncForbiddenError';
  }
}

function describeOutcome(outcome: SyncOutcome): Omit<SyncActionResult, 'sync'> {
  if (outcome.skipped === null) {
    return {
      outcome: 'synced',
      changed: outcome.changed,
      summaryAr: outcome.diff.summaryAr,
      messageAr: outcome.changed ? t('sync.done') : t('sync.no_change'),
    };
  }
  if (outcome.skipped === 'permission') {
    return {
      outcome: 'skipped',
      skipped: 'permission',
      missing: outcome.missing,
      messageAr: t('sync.skipped.permission', { permissions: outcome.missing.join('، ') }),
    };
  }
  const key = outcome.skipped === 'throttled' ? 'sync.skipped.throttled' : outcome.skipped === 'not_set_up' ? 'sync.skipped.not_set_up' : 'sync.skipped.unreadable';
  return { outcome: 'skipped', skipped: outcome.skipped, messageAr: t(key) };
}

/** `POST /api/settings/sync`: the «حدّث من NPI» button. Always runs (no
 *  throttle), as the signed-in administrator, with their own token. */
export async function runManualSync(
  deps: { db: SyncActionDb; npi: SyncNpi; now?: () => Date },
  caller: SyncCaller,
): Promise<SyncActionResult> {
  if (!caller.permissions.includes(SYNC_PERMISSION)) throw new SyncForbiddenError();
  const now = deps.now ?? (() => new Date());
  const outcome = await syncFromNpi({
    orgId: caller.npiOrgId,
    npi: deps.npi,
    me: { id: caller.npiUserId, roleKey: caller.roleKey, permissions: caller.permissions },
    reason: 'manual',
    db: deps.db,
    now,
  });
  const row = await deps.db.firmConfig.findUnique({ where: { npiOrgId: caller.npiOrgId } });
  return { ...describeOutcome(outcome), sync: buildSyncView(row, caller.permissions, now()) };
}

export interface SyncSeenDb {
  firmConfig: {
    updateMany(args: { where: { npiOrgId: string }; data: { lastSyncSeenAt: Date } }): Promise<unknown>;
  };
}

/** `POST /api/settings/sync/seen`: the banner's «تم». */
export async function markSyncSeen(deps: { db: SyncSeenDb; now?: () => Date }, caller: SyncCaller): Promise<void> {
  if (!caller.permissions.includes(SYNC_PERMISSION)) throw new SyncForbiddenError();
  await deps.db.firmConfig.updateMany({ where: { npiOrgId: caller.npiOrgId }, data: { lastSyncSeenAt: (deps.now ?? (() => new Date()))() } });
}
