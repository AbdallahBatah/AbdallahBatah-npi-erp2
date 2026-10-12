'use client';

/**
 * The per-user override editor (ADR-02 §3-1, §3-6, task 8): the role editor's
 * grid with the user's EFFECTIVE value in every cell, the sidebar preview of
 * what they will see, and the separation-of-duties warning, over
 * GET / PUT /admin/users/:id/permissions.
 *
 * The cell model. The draft is a map key → GRANT | DENY, loaded from the
 * user's stored overrides. Every cell shows `effectivePermissions(roles,
 * draft)` — the function the server enforces with — so a cell reads one of:
 *   - from the role: no override for the key (plain);
 *   - «added»: a GRANT of a key no role of theirs holds;
 *   - «withheld»: a DENY of a key a role of theirs holds;
 *   - no effect at present: a GRANT of a key a role already holds, or a DENY
 *     of one no role holds (the role changed after the save). Kept, and
 *     listed under «no effect at present» with a remove button rather than
 *     dropped (ADR-02 §7).
 * Clicking a cell sets the key's effective value: the value the roles give
 * needs no override, any other is a GRANT (on) or a DENY (off); «back to the
 * role» deletes the key from the draft. Saving PUTs the whole draft as
 * `{ overrides: [{ permission, effect, reason }] }` (the endpoint replaces the
 * set): an override kept as it was keeps its stored reason, one written in
 * this save (new, or its effect flipped) carries the save's one reason.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { effectivePermissions, type PermissionEffect } from '@npi/shared';
import { api, ApiError } from '@/lib/api';
import { useI18n } from '@/lib/i18n';
import { useAct } from '@/lib/useAct';
import { translateError } from '@/lib/errors';
import { formatDate } from '@/lib/format';
import { Modal, Field, Btn, LoadError } from '@/components/ui';
import { Icon } from '@/components/icons';
import {
  PermissionGrid,
  SidebarPreview,
  SodWarning,
  usePermissionGrid,
  useSodAck,
  type PermMeta,
} from '@/components/permission-grid';

interface RoleSource {
  id: string;
  key: string;
  nameAr: string;
  nameEn: string;
  permissions: string[];
}
interface StoredOverride {
  permission: string;
  effect: PermissionEffect;
  reason: string | null;
  createdAt: string;
  createdBy: { id: string; nameAr: string; nameEn: string } | null;
}
/** GET /admin/users/:id/permissions. */
interface UserPermissions {
  roles: RoleSource[];
  overrides: StoredOverride[];
  effective: string[];
}
/** How one key reads for the user under the draft (see the file comment). */
type CellState = 'role' | 'granted' | 'denied' | 'idle';

/**
 * Mounted per opening (the caller keys it by user), so every opening starts
 * from the stored set with a clean reason and acknowledgement.
 */
export function UserPermissionsDialog({
  target,
  catalog,
  onClose,
  onSaved,
}: {
  target: { id: string; nameAr: string; nameEn: string };
  catalog: PermMeta[];
  onClose: () => void;
  /** After a successful save: the caller reloads its list (and the session, for the signed-in user). */
  onSaved: (userId: string) => void;
}) {
  const { t, locale } = useI18n();
  const ar = locale === 'ar';
  const { act, busy } = useAct();
  const { gridGroups, specials } = usePermissionGrid(catalog);
  const [data, setData] = useState<UserPermissions | null>(null);
  const [loadErr, setLoadErr] = useState('');
  const [draft, setDraft] = useState<Map<string, PermissionEffect>>(new Map());
  const [reason, setReason] = useState('');
  // The lockout refusal (hard rule 4), kept in the dialog after the toast has gone.
  const [saveErr, setSaveErr] = useState('');

  const load = useCallback(() => {
    setLoadErr('');
    api
      .get<UserPermissions>(`/admin/users/${target.id}/permissions`)
      .then((d) => {
        setData(d);
        setDraft(new Map(d.overrides.map((o) => [o.permission, o.effect])));
      })
      .catch((e) => setLoadErr(translateError(e, locale)));
  }, [target.id, locale]);
  useEffect(load, [load]);

  const roleHeld = useMemo(() => new Set(data?.roles.flatMap((r) => r.permissions) ?? []), [data]);
  const stored = useMemo(() => new Map((data?.overrides ?? []).map((o) => [o.permission, o])), [data]);
  const effective = useMemo(
    () =>
      data
        ? effectivePermissions(
            data.roles.map((r) => r.permissions),
            [...draft].map(([permission, effect]) => ({ permission, effect })),
          )
        : [],
    [data, draft],
  );
  const effectiveSet = useMemo(() => new Set(effective), [effective]);
  // The server neither records nor refuses a user override over a
  // separation-of-duties pair (P1-9 added that for role saves only;
  // SetUserPermissionsDto has no such field), so here the warning and its
  // acknowledgement are client-side gating only: the tick enables Save and
  // is sent nowhere.
  const sod = useSodAck(effective);
  const metaByKey = useMemo(() => new Map(catalog.map((p) => [p.key, p])), [catalog]);
  const label = (key: string) => {
    const p = metaByKey.get(key);
    return p ? (ar ? p.labelAr : p.labelEn) : key;
  };

  const changed = draft.size !== stored.size || [...draft].some(([k, e]) => stored.get(k)?.effect !== e);

  const stateOf = (key: string): CellState => {
    const effect = draft.get(key);
    if (!effect) return 'role';
    if (effect === 'GRANT') return roleHeld.has(key) ? 'idle' : 'granted';
    return roleHeld.has(key) ? 'denied' : 'idle';
  };
  const idle = [...draft.keys()].filter((k) => stateOf(k) === 'idle').sort((a, b) => a.localeCompare(b, 'en'));

  /**
   * One click sets the key's effective value. Unlike the role editor, turning
   * a view off does not take the rest of its row with it: an override is an
   * exception for one key, and the row's other keys stay what the roles give
   * until the administrator changes them too.
   */
  function toggle(key: string, on: boolean) {
    setDraft((prev) => {
      const next = new Map(prev);
      if (on === roleHeld.has(key)) next.delete(key);
      else next.set(key, on ? 'GRANT' : 'DENY');
      return next;
    });
    setSaveErr('');
  }
  function backToRole(key: string) {
    setDraft((prev) => {
      const next = new Map(prev);
      next.delete(key);
      return next;
    });
    setSaveErr('');
  }

  /** Who saved a stored override, when, and why — the tag's tooltip. */
  const savedTitle = (o: StoredOverride) =>
    [
      `${t('adm.ovr.savedBy')} ${o.createdBy ? (ar ? o.createdBy.nameAr : o.createdBy.nameEn) : '—'} · ${formatDate(o.createdAt, locale)}`,
      o.reason ? `${t('adm.ovr.reason')}: ${o.reason}` : '',
    ]
      .filter(Boolean)
      .join('\n');

  /** The «added» / «withheld» tag and the back-to-the-role button after an overridden key's box. */
  const mark = (key: string) => {
    const s = stateOf(key);
    if (s !== 'granted' && s !== 'denied') return null;
    const o = stored.get(key);
    const saved = o && o.effect === draft.get(key) ? o : null;
    return (
      <span className="inline-flex items-center gap-0.5">
        <span
          className={`rounded px-1 text-xs font-semibold ${
            s === 'granted' ? 'bg-success-50 text-success-700' : 'bg-danger-50 text-danger-700'
          }`}
          title={saved ? savedTitle(saved) : undefined}
          data-override={s}
        >
          {t(s === 'granted' ? 'adm.ovr.granted' : 'adm.ovr.denied')}
        </span>
        <button
          type="button"
          className="rounded p-0.5 text-slate-500 hover:bg-slate-100 hover:text-slate-800"
          title={t('adm.ovr.backToRole')}
          aria-label={`${t('adm.ovr.backToRole')} — ${label(key)}`}
          onClick={() => backToRole(key)}
        >
          <Icon name="undo" className="h-3 w-3" />
        </button>
      </span>
    );
  };

  async function save() {
    if (!data) return;
    const why = reason.trim() || null;
    const overrides = [...draft].map(([permission, effect]) => {
      const was = stored.get(permission);
      return { permission, effect, reason: was && was.effect === effect ? was.reason : why };
    });
    setSaveErr('');
    const put = async () => {
      try {
        await api.put(`/admin/users/${target.id}/permissions`, { overrides });
      } catch (e) {
        if (e instanceof ApiError && e.status === 400) setSaveErr(translateError(e, locale));
        throw e;
      }
    };
    if (await act('overrides', put)) onSaved(target.id);
  }

  return (
    <Modal
      open
      wide
      title={`${t('adm.ovr.title')} — ${ar ? target.nameAr : target.nameEn}`}
      onClose={onClose}
      dirty={changed || reason.trim() !== ''}
    >
      <form
        className="grid gap-4"
        onSubmit={(ev) => {
          ev.preventDefault();
          void save();
        }}
      >
        {loadErr ? (
          <LoadError message={loadErr} onRetry={load} />
        ) : !data ? (
          <div className="space-y-3" aria-hidden>
            <div className="skeleton h-3 w-32" />
            <div className="skeleton h-9 w-full" />
            <div className="skeleton h-9 w-full" />
          </div>
        ) : (
          <>
            <div className="flex flex-wrap items-center gap-1.5 text-xs text-slate-600">
              <span className="font-semibold">{t('adm.user.roles')}:</span>
              {data.roles.map((r, i) => (
                <span
                  key={r.id}
                  className={`badge ${i === 0 ? 'bg-brand-50 text-brand-700' : 'bg-slate-100 text-slate-700'}`}
                  title={i === 0 ? t('adm.user.primaryRole') : t('adm.user.extraRoles')}
                >
                  {ar ? r.nameAr : r.nameEn}
                </span>
              ))}
            </div>

            <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1fr)_15rem]">
              <div className="min-w-0">
                <p className="mb-2 text-xs leading-5 text-slate-500">{t('adm.ovr.gridHint')}</p>
                <PermissionGrid
                  gridGroups={gridGroups}
                  specials={specials}
                  has={(k) => effectiveSet.has(k)}
                  onToggle={(k, on) => toggle(k, on)}
                  mark={mark}
                />
              </div>
              <SidebarPreview permissions={effective} hint={t('adm.ovr.preview.hint')} testId="user-preview" />
            </div>

            {idle.length > 0 && (
              <div className="rounded-xl border border-slate-200 bg-slate-50/60 p-4 text-sm" data-testid="override-idle">
                <p className="font-semibold text-slate-700">{t('adm.ovr.noEffect.title')}</p>
                <p className="mt-1 text-xs leading-5 text-slate-500">{t('adm.ovr.noEffect.hint')}</p>
                <ul className="mt-2 space-y-1.5">
                  {idle.map((k) => (
                    <li key={k} className="flex flex-wrap items-center justify-between gap-2">
                      <span className="text-slate-700">
                        {label(k)}
                        <span className="ms-2 text-xs text-slate-500">
                          {t(draft.get(k) === 'GRANT' ? 'adm.ovr.noEffect.grant' : 'adm.ovr.noEffect.deny')}
                        </span>
                      </span>
                      <Btn sm icon="x" onClick={() => backToRole(k)}>
                        {t('adm.ovr.remove')}
                      </Btn>
                    </li>
                  ))}
                </ul>
              </div>
            )}

            <Field label={t('adm.ovr.reason')} hint={t('adm.ovr.reasonHint')}>
              <input className="input" maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} />
            </Field>

            <SodWarning
              conflicts={sod.conflicts}
              acked={sod.acked}
              onAck={sod.setAcked}
              hint={t('adm.ovr.sod.hint')}
            />

            {saveErr && (
              <p role="alert" className="rounded-xl border border-danger-200 bg-danger-50/50 p-4 text-sm font-medium text-danger-700">
                {saveErr}
              </p>
            )}
          </>
        )}

        <div className="flex justify-end gap-2">
          <Btn onClick={onClose}>{t('common.cancel')}</Btn>
          <Btn
            type="submit"
            variant="primary"
            busy={busy('overrides')}
            disabled={busy() || !data || !changed || (sod.conflicts.length > 0 && !sod.acked)}
          >
            {t('common.save')}
          </Btn>
        </div>
      </form>
    </Modal>
  );
}
