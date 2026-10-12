'use client';

/**
 * User & role administration — the screen that lets a real customer run the
 * system without touching the seed. Two tabs: users (create/edit/deactivate/
 * set password, primary + additional roles) and roles (one row per sidebar
 * screen from the shared screen registry, with a live sidebar preview and the
 * separation-of-duties warning, ADR-02 §3-6). The API enforces the lockout
 * and approval-seat guards; the UI just avoids offering
 * footguns (no deactivate button on yourself).
 */
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import {
  SCREEN_GROUPS,
  SCREENS,
  sodConflicts,
  visibleGroups,
  type Screen,
  type ScreenGroup,
} from '@npi/shared';
import { api, ApiError } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { useI18n } from '@/lib/i18n';
import { useAct } from '@/lib/useAct';
import { translateError } from '@/lib/errors';
import { formatDate } from '@/lib/format';
import { NAV_ITEMS } from '@/lib/nav';
import { PageHeader, LoadError, Modal, Field, StatusBadge, useConfirm, Btn, Tabs, PageSkeleton } from '@/components/ui';
import { Icon } from '@/components/icons';
import { AuditLogCard } from '@/components/audit-log';
import { ApprovalMatrixCard } from '@/components/approval-matrix';
import { CustomerMergeCard } from '@/components/customer-merge';
import { LossReasonsCard } from '@/components/loss-reasons';
import { ProposalSettingsCard } from '@/components/proposal-settings';
import { TaskSettingsCard } from '@/components/task-settings';

interface RoleRow {
  id: string;
  key: string;
  nameAr: string;
  nameEn: string;
  permissions: string[];
  _count: { users: number };
}
interface UserRow {
  id: string;
  email: string;
  nameAr: string;
  nameEn: string;
  isActive: boolean;
  createdAt: string;
  role: RoleRef;
  /** Primary role first, then the additional ones. */
  roles?: RoleRef[];
}
interface RoleRef {
  id: string;
  key: string;
  nameAr: string;
  nameEn: string;
}
type PermAction = 'view' | 'write' | 'approve' | 'special';
interface PermMeta {
  key: string;
  groupAr: string;
  groupEn: string;
  labelAr: string;
  labelEn: string;
  screenAr: string;
  screenEn: string;
  /** The registry href of the screen the key belongs to; null = no single screen. */
  screen: string | null;
  action: PermAction;
}
const GRID_COLUMNS = ['view', 'write', 'approve'] as const;
type GridColumn = (typeof GRID_COLUMNS)[number];
/** One row of the role grid: one sidebar screen (ADR-02 §3-6). */
interface GridRow {
  screen: Screen;
  /** A General screen: no view key, every user opens it. Shown as a fixed «everyone» row. */
  fixed: boolean;
  cells: Partial<Record<GridColumn, PermMeta>>;
  /** Special keys acted on this screen, listed as a line under the row. */
  specials: PermMeta[];
}
interface GridGroup {
  group: ScreenGroup;
  rows: GridRow[];
}
/** The write / approve / special keys of a row: what turning its view off turns off. */
const rowDependents = (row: GridRow): string[] => [
  ...(row.cells.write ? [row.cells.write.key] : []),
  ...(row.cells.approve ? [row.cells.approve.key] : []),
  ...row.specials.map((p) => p.key),
];
/** Icon of each screen, the sidebar's own (lib/nav.ts). */
const NAV_ICON = new Map(NAV_ITEMS.map((i) => [i.href, i.icon]));
interface OrgSettings {
  legalNameAr: string;
  legalNameEn: string;
  vatNumber: string | null;
  crNumber: string | null;
  addressAr: string | null;
  addressEn: string | null;
  phone: string | null;
  email: string | null;
  website: string | null;
  logoDataUrl: string | null;
}

export default function AdminPage() {
  const { t, locale } = useI18n();
  const { user: me, can, refresh } = useAuth();
  const { act, busy } = useAct();
  const { confirm, confirmNode } = useConfirm();
  const ar = locale === 'ar';
  const orgManage = can('admin.org.manage');
  const auditRead = can('admin.audit.read');
  const approvalManage = can('admin.approval.manage');
  const customerMerge = can('crm.customer.merge');

  type AdminTab = 'users' | 'roles' | 'matrix' | 'org' | 'audit' | 'merge' | 'lossReasons';
  const ADMIN_TABS: AdminTab[] = ['users', 'roles', 'matrix', 'org', 'audit', 'merge', 'lossReasons'];
  const [tab, setTabState] = useState<AdminTab>('users');

  // The five sections of the densest screen in the product used to live only
  // in component state: the audit log could not be bookmarked or linked to a
  // colleague, and a refresh after saving org settings dumped you back on the
  // user list. The hash carries it without forcing a Suspense boundary the
  // way useSearchParams would.
  useEffect(() => {
    const h = window.location.hash.slice(1) as AdminTab;
    if (ADMIN_TABS.includes(h)) setTabState(h);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const setTab = (k: AdminTab) => {
    setTabState(k);
    window.history.replaceState(null, '', `#${k}`);
  };
  const [users, setUsers] = useState<UserRow[] | null>(null);
  const [roles, setRoles] = useState<RoleRow[] | null>(null);
  const [catalog, setCatalog] = useState<PermMeta[]>([]);
  const [loadErr, setLoadErr] = useState('');

  // organization settings tab
  const [org, setOrg] = useState<OrgSettings | null>(null);
  const [orgErr, setOrgErr] = useState('');
  const [orgLogoErr, setOrgLogoErr] = useState('');

  // user modal state (create + edit share it)
  const [uOpen, setUOpen] = useState(false);
  const [uEdit, setUEdit] = useState<UserRow | null>(null);
  const [uNameAr, setUNameAr] = useState('');
  const [uNameEn, setUNameEn] = useState('');
  const [uEmail, setUEmail] = useState('');
  const [uPassword, setUPassword] = useState('');
  const [uRoleId, setURoleId] = useState('');
  const uRoleRef = useRef<HTMLSelectElement>(null);
  const [uExtra, setUExtra] = useState<Set<string>>(new Set());

  // set-password modal
  const [pOpen, setPOpen] = useState<UserRow | null>(null);
  const [pValue, setPValue] = useState('');

  // role modal state
  const [rOpen, setROpen] = useState(false);
  const [rEdit, setREdit] = useState<RoleRow | null>(null);
  const [rNameAr, setRNameAr] = useState('');
  const [rNameEn, setRNameEn] = useState('');
  const [rKey, setRKey] = useState('');
  const [rPerms, setRPerms] = useState<Set<string>>(new Set());
  // The separation-of-duties pairs acknowledged, as a signature of the pairs:
  // a pair added after ticking the box asks again.
  const [rSodAck, setRSodAck] = useState('');
  // The approval-seat refusal (hard rule 8), kept in the dialog beside the cells.
  const [rSeatErr, setRSeatErr] = useState('');

  const load = useCallback(() => {
    setLoadErr('');
    Promise.all([
      api.get<UserRow[]>('/admin/users'),
      api.get<RoleRow[]>('/admin/roles'),
      api.get<PermMeta[]>('/admin/permissions'),
    ])
      .then(([u, r, c]) => {
        setUsers(u);
        setRoles(r);
        setCatalog(c);
      })
      .catch((e) => setLoadErr(translateError(e, locale)));
  }, [locale]);
  useEffect(load, [load]);

  const loadOrg = useCallback(() => {
    if (!orgManage) return;
    setOrgErr('');
    api
      .get<OrgSettings>('/admin/org')
      .then(setOrg)
      .catch((e) => setOrgErr(translateError(e, locale)));
  }, [locale, orgManage]);
  useEffect(loadOrg, [loadOrg]);

  async function submitOrg(ev: FormEvent) {
    ev.preventDefault();
    if (!org) return;
    const ok = await act('org', () =>
      api.patch<OrgSettings>('/admin/org', {
        legalNameAr: org.legalNameAr,
        legalNameEn: org.legalNameEn,
        vatNumber: org.vatNumber ?? '',
        crNumber: org.crNumber ?? '',
        addressAr: org.addressAr ?? '',
        addressEn: org.addressEn ?? '',
        phone: org.phone ?? '',
        email: org.email ?? '',
        website: org.website ?? '',
      }),
    );
    if (ok) loadOrg();
  }

  function onLogoFile(file: File | null) {
    setOrgLogoErr('');
    if (!file) return;
    if (file.size > 500 * 1024) {
      setOrgLogoErr(t('org.logoTooLarge'));
      return;
    }
    const reader = new FileReader();
    reader.onload = async () => {
      const dataUrl = String(reader.result);
      const ok = await act('orgLogo', () => api.patch<OrgSettings>('/admin/org', { logoDataUrl: dataUrl }));
      if (ok) loadOrg();
    };
    reader.readAsDataURL(file);
  }

  async function removeLogo() {
    if (await act('orgLogo', () => api.patch<OrgSettings>('/admin/org', { logoDataUrl: '' }))) loadOrg();
  }

  // The role editor grid (ADR-02 §3-6): the screen registry's groups and
  // screens in sidebar order, one row per screen named as the sidebar names it.
  // Cells are the catalogue keys whose `screen` is the row's href, by action;
  // a cell with no key is empty. Special keys of a screen sit under its row;
  // those of no single screen (and any key whose screen the registry lacks,
  // so no key is ever hidden) go to the special-permissions section.
  const { gridGroups, specials } = useMemo(() => {
    const hrefs = new Set<string>(SCREENS.map((sc) => sc.href));
    const byScreen = new Map<string, PermMeta[]>();
    const loose: PermMeta[] = [];
    for (const p of catalog) {
      if (p.screen && hrefs.has(p.screen)) byScreen.set(p.screen, [...(byScreen.get(p.screen) ?? []), p]);
      else loose.push(p);
    }
    const groups: GridGroup[] = SCREEN_GROUPS.map((group) => ({
      group,
      rows: SCREENS.filter((sc) => sc.group === group.key).map((screen) => {
        const keys = byScreen.get(screen.href) ?? [];
        const cells: GridRow['cells'] = {};
        for (const p of keys) if (p.action !== 'special') cells[p.action] = p;
        return {
          screen,
          fixed: screen.view === undefined,
          cells,
          specials: keys.filter((p) => p.action === 'special'),
        };
      }),
    })).filter((g) => g.rows.length > 0);
    return { gridGroups: groups, specials: loose };
  }, [catalog]);

  // The draft as the sidebar would show it — visibleGroups is the registry's
  // own rule (a screen with no view key, or whose view key is held), the one
  // the real sidebar applies to the same registry — and the
  // separation-of-duties pairs it holds.
  const draft = useMemo(() => [...rPerms], [rPerms]);
  const preview = useMemo(() => visibleGroups(draft), [draft]);
  const previewCount = preview.reduce((n, g) => n + g.screens.length, 0);
  const conflicts = useMemo(() => sodConflicts(draft), [draft]);
  const conflictSig = conflicts.map((c) => `${c.a}+${c.b}`).join('|');
  const sodAcked = conflicts.length > 0 && rSodAck === conflictSig;

  /**
   * Sets one key of the draft. Turning a screen's view off turns the rest of
   * its row off (ADR-02 §3-6): nothing is created or approved on a screen
   * that does not open.
   */
  function setPerm(key: string, on: boolean, row?: GridRow) {
    const next = new Set(rPerms);
    if (on) next.add(key);
    else next.delete(key);
    if (!on && row && row.cells.view?.key === key) rowDependents(row).forEach((k) => next.delete(k));
    setRPerms(next);
    setRSeatErr('');
  }
  function setPerms(next: Set<string>) {
    setRPerms(next);
    setRSeatErr('');
  }
  /**
   * A write / approve / special cell is offered only while its screen's view
   * is on. One already held without the view (a role saved before this
   * editor, or by Madar) stays enabled so it can be cleared.
   */
  const cellDisabled = (row: GridRow, key: string) =>
    !row.fixed && !!row.cells.view && !rPerms.has(row.cells.view.key) && !rPerms.has(key);

  function openCreateUser() {
    setUEdit(null);
    setUNameAr('');
    setUNameEn('');
    setUEmail('');
    setUPassword('');
    // No preselected role: the first one in the list is usually the
    // administrator, and a new account must not get it just because nobody
    // changed the select. The admin picks one; the form refuses until then.
    setURoleId('');
    setUExtra(new Set());
    setUOpen(true);
  }
  function openEditUser(u: UserRow) {
    setUEdit(u);
    setUNameAr(u.nameAr);
    setUNameEn(u.nameEn);
    setUEmail(u.email);
    setUPassword('');
    setURoleId(u.role.id);
    setUExtra(new Set((u.roles ?? [u.role]).filter((r) => r.id !== u.role.id).map((r) => r.id)));
    setUOpen(true);
  }
  async function submitUser() {
    // The select's `required` normally stops the form first; this keeps the
    // API from ever receiving an empty role and shows the same native message.
    if (!uRoleId) {
      uRoleRef.current?.reportValidity();
      return;
    }
    const nameAr = uNameAr.trim() || uNameEn.trim();
    const nameEn = uNameEn.trim() || uNameAr.trim();
    // The primary role can never also be an additional one.
    const extraRoleIds = [...uExtra].filter((id) => id !== uRoleId);
    const ok = uEdit
      ? await act('user', () =>
          api.patch(`/admin/users/${uEdit.id}`, { nameAr, nameEn, roleId: uRoleId, extraRoleIds }),
        )
      : await act('user', () =>
          api.post('/admin/users', {
            nameAr,
            nameEn,
            email: uEmail.trim(),
            password: uPassword,
            roleId: uRoleId,
            extraRoleIds,
          }),
        );
    if (ok) {
      setUOpen(false);
      load();
    }
  }
  async function toggleActive(u: UserRow) {
    if (u.isActive) {
      const yes = await confirm({
        title: t('adm.user.deactivateTitle'),
        message: `${t('adm.user.deactivateMsg')} (${ar ? u.nameAr : u.nameEn})`,
        danger: true,
      });
      if (!yes) return;
    }
    if (await act('active', () => api.patch(`/admin/users/${u.id}`, { isActive: !u.isActive }))) load();
  }
  async function submitSetPassword() {
    if (!pOpen) return;
    const ok = await act('setPw', () =>
      api.post(`/admin/users/${pOpen.id}/reset-password`, { newPassword: pValue }),
    );
    if (ok) {
      setPOpen(null);
      setPValue('');
    }
  }

  function openCreateRole() {
    setREdit(null);
    setRNameAr('');
    setRNameEn('');
    setRKey('');
    setRPerms(new Set());
    setRSodAck('');
    setRSeatErr('');
    setROpen(true);
  }
  function openEditRole(r: RoleRow) {
    setREdit(r);
    setRNameAr(r.nameAr);
    setRNameEn(r.nameEn);
    setRKey(r.key);
    setRPerms(new Set(r.permissions));
    setRSodAck('');
    setRSeatErr('');
    setROpen(true);
  }
  async function submitRole() {
    const nameAr = rNameAr.trim() || rNameEn.trim();
    const nameEn = rNameEn.trim() || rNameAr.trim();
    const permissions = [...rPerms];
    // Sent only for a set that holds a pair, once the box is ticked (the
    // button is disabled until then); the server records the pairs.
    const acknowledgeSod = sodAcked ? true : undefined;
    setRSeatErr('');
    const save = async () => {
      try {
        if (rEdit) await api.patch(`/admin/roles/${rEdit.id}`, { nameAr, nameEn, permissions, acknowledgeSod });
        else await api.post('/admin/roles', { key: rKey.trim(), nameAr, nameEn, permissions, acknowledgeSod });
      } catch (e) {
        // The approval-seat refusal names the rule: keep it in the dialog too,
        // beside the cells it is about, after the toast has gone.
        if (e instanceof ApiError && e.body?.code === 'APPROVAL_SEAT') setRSeatErr(translateError(e, locale));
        throw e;
      }
    };
    if (await act('role', save)) {
      setROpen(false);
      load();
      // An administrator editing a role they hold sees the effect at once.
      void refresh();
    }
  }
  async function deleteRole(r: RoleRow) {
    const yes = await confirm({
      title: t('adm.role.deleteTitle'),
      message: `${t('adm.role.deleteMsg')} (${ar ? r.nameAr : r.nameEn})`,
      danger: true,
    });
    if (!yes) return;
    if (await act('delRole', () => api.del(`/admin/roles/${r.id}`))) load();
  }

  if (loadErr) return <LoadError message={loadErr} onRetry={load} />;
  if (!users || !roles) return <PageSkeleton stats={2} />;

  const roleName = (r: { nameAr: string; nameEn: string }) => (ar ? r.nameAr : r.nameEn);

  return (
    <div>
      <PageHeader
        title={t('adm.title')}
        action={
          tab === 'users' ? (
            <Btn variant="primary" icon="plus" onClick={openCreateUser}>
              {t('adm.user.new')}
            </Btn>
          ) : tab === 'roles' ? (
            <Btn variant="primary" icon="plus" onClick={openCreateRole}>
              {t('adm.role.new')}
            </Btn>
          ) : undefined
        }
      />
      <p className="-mt-3 mb-5 text-xs text-slate-500">{t('adm.hint')}</p>

      {/* The shared pill row — same component every other tabbed screen uses. */}
      <Tabs
        tabs={[
          'users' as const,
          'roles' as const,
          ...(approvalManage ? ['matrix' as const] : []),
          ...(orgManage ? ['org' as const] : []),
          ...(auditRead ? ['audit' as const] : []),
          ...(customerMerge ? ['merge' as const] : []),
          ...(orgManage ? ['lossReasons' as const] : []),
        ].map((k) => ({
          key: k,
          label: t(`adm.tab.${k}`),
          count: k === 'users' ? users.length : k === 'roles' ? roles.length : undefined,
        }))}
        value={tab}
        onChange={(k) => setTab(k as AdminTab)}
      />

      {tab === 'lossReasons' ? (
        orgManage ? <LossReasonsCard /> : null
      ) : tab === 'merge' ? (
        customerMerge ? <CustomerMergeCard /> : null
      ) : tab === 'audit' ? (
        <AuditLogCard />
      ) : tab === 'matrix' ? (
        // The role list is already loaded here — passing it down keeps the
        // matrix editor from re-fetching what this screen owns.
        <ApprovalMatrixCard roles={roles} />
      ) : tab === 'org' ? (
        <div className="space-y-6">
        <div className="card max-w-2xl p-6">
          {orgErr ? (
            <LoadError message={orgErr} onRetry={loadOrg} />
          ) : !org ? (
            <div className="space-y-3" aria-hidden>
              <div className="skeleton h-3 w-32" />
              <div className="skeleton h-9 w-full" />
              <div className="skeleton h-9 w-full" />
            </div>
          ) : (
            <form className="grid gap-4" onSubmit={submitOrg}>
              <div className="flex items-center gap-4">
                {org.logoDataUrl ? (
                  <img src={org.logoDataUrl} alt="" className="h-16 w-16 rounded-lg border border-slate-200 object-contain" />
                ) : (
                  <div className="flex h-16 w-16 items-center justify-center rounded-lg border border-dashed border-slate-300 text-xs text-slate-500">
                    {t('org.logo')}
                  </div>
                )}
                <div>
                  <div className="flex gap-2">
                    <label className="btn-ghost cursor-pointer text-xs">
                      {t('org.logoUpload')}
                      <input
                        type="file"
                        accept="image/png,image/jpeg,image/webp,image/svg+xml"
                        className="hidden"
                        onChange={(e) => onLogoFile(e.target.files?.[0] ?? null)}
                      />
                    </label>
                    {org.logoDataUrl && (
                      <Btn sm icon="trash" variant="danger" onClick={removeLogo}>
                        {t('org.logoRemove')}
                      </Btn>
                    )}
                  </div>
                  <p className="mt-1 text-xs text-slate-500">{t('org.logoHint')}</p>
                  {orgLogoErr && <p className="mt-1 text-xs text-danger-600">{orgLogoErr}</p>}
                </div>
              </div>

              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <Field label={t('org.legalNameAr')}>
                  <input
                    className="input"
                    required
                    value={org.legalNameAr}
                    onChange={(e) => setOrg({ ...org, legalNameAr: e.target.value })}
                  />
                </Field>
                <Field label={t('org.legalNameEn')}>
                  <input
                    className="input"
                    dir="ltr"
                    value={org.legalNameEn}
                    onChange={(e) => setOrg({ ...org, legalNameEn: e.target.value })}
                  />
                </Field>
              </div>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <Field label={t('org.vatNumber')}>
                  <input
                    className="input font-mono"
                    dir="ltr"
                    value={org.vatNumber ?? ''}
                    onChange={(e) => setOrg({ ...org, vatNumber: e.target.value })}
                  />
                </Field>
                <Field label={t('org.crNumber')}>
                  <input
                    className="input font-mono"
                    dir="ltr"
                    value={org.crNumber ?? ''}
                    onChange={(e) => setOrg({ ...org, crNumber: e.target.value })}
                  />
                </Field>
              </div>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <Field label={t('org.addressAr')}>
                  <input
                    className="input"
                    value={org.addressAr ?? ''}
                    onChange={(e) => setOrg({ ...org, addressAr: e.target.value })}
                  />
                </Field>
                <Field label={t('org.addressEn')}>
                  <input
                    className="input"
                    dir="ltr"
                    value={org.addressEn ?? ''}
                    onChange={(e) => setOrg({ ...org, addressEn: e.target.value })}
                  />
                </Field>
              </div>
              <div className="grid grid-cols-3 gap-3">
                <Field label={t('org.phone')}>
                  <input
                    className="input"
                    dir="ltr"
                    value={org.phone ?? ''}
                    onChange={(e) => setOrg({ ...org, phone: e.target.value })}
                  />
                </Field>
                <Field label={t('org.email')}>
                  <input
                    type="email"
                    className="input"
                    dir="ltr"
                    value={org.email ?? ''}
                    onChange={(e) => setOrg({ ...org, email: e.target.value })}
                  />
                </Field>
                <Field label={t('org.website')}>
                  <input
                    className="input"
                    dir="ltr"
                    value={org.website ?? ''}
                    onChange={(e) => setOrg({ ...org, website: e.target.value })}
                  />
                </Field>
              </div>

              <div className="flex justify-end">
                <Btn type="submit" variant="primary" busy={busy('org')} disabled={busy()}>
                  {t('common.save')}
                </Btn>
              </div>
            </form>
          )}
        </div>
        <ProposalSettingsCard />
        <TaskSettingsCard />
        </div>
      ) : tab === 'users' ? (
        <div className="card overflow-hidden">
          <table className="min-w-full text-sm">
            <thead className="bg-slate-50">
              <tr>
                <th scope="col" className="th">{t('adm.user.name')}</th>
                <th scope="col" className="th">{t('adm.user.email')}</th>
                <th scope="col" className="th">{t('adm.user.roles')}</th>
                <th scope="col" className="th">{t('adm.user.status')}</th>
                <th scope="col" className="th">{t('common.date')}</th>
                <th scope="col" className="th">{t('common.actions')}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {users.map((u) => (
                <tr
                  key={u.id}
                  className={u.isActive ? '' : 'bg-slate-50/60 [&_td]:text-slate-500'}
                >
                  <td className="td font-semibold text-slate-800">
                    {ar ? u.nameAr : u.nameEn}
                    {u.id === me?.id && <span className="ms-2 text-xs font-normal text-brand-600">({ar ? 'أنت' : 'you'})</span>}
                  </td>
                  <td className="td" dir="ltr">{u.email}</td>
                  <td className="td">
                    <div className="flex flex-wrap gap-1">
                      {(u.roles ?? [u.role]).map((r, i) => (
                        <span
                          key={r.id}
                          className={`badge ${i === 0 ? 'bg-brand-50 text-brand-700' : 'bg-slate-100 text-slate-700'}`}
                          title={i === 0 ? t('adm.user.primaryRole') : t('adm.user.extraRoles')}
                        >
                          {roleName(r)}
                        </span>
                      ))}
                    </div>
                  </td>
                  <td className="td">
                    <StatusBadge status={u.isActive ? 'ACTIVE' : 'SUSPENDED'} />
                  </td>
                  <td className="td text-xs">{formatDate(u.createdAt, locale)}</td>
                  <td className="td">
                    <div className="flex flex-wrap gap-1.5">
                      <Btn sm onClick={() => openEditUser(u)}>{t('common.edit')}</Btn>
                      <Btn sm icon="key" onClick={() => { setPOpen(u); setPValue(''); }}>
                        {t('adm.user.resetPass')}
                      </Btn>
                      {u.id !== me?.id && (
                        <Btn
                          sm
                          variant={u.isActive ? 'danger' : 'success'}
                          busy={busy(`active:${u.id}`)}
                          disabled={busy()}
                          onClick={() => toggleActive(u)}
                        >
                          {u.isActive ? t('adm.user.deactivate') : t('adm.user.activate')}
                        </Btn>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="card overflow-hidden">
          <table className="min-w-full text-sm">
            <thead className="bg-slate-50">
              <tr>
                <th scope="col" className="th">{t('adm.role.name')}</th>
                <th scope="col" className="th">{t('adm.role.key')}</th>
                <th scope="col" className="th">{t('adm.role.users')}</th>
                <th scope="col" className="th">{t('adm.role.perms')}</th>
                <th scope="col" className="th">{t('common.actions')}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {roles.map((r) => (
                <tr key={r.id}>
                  <td className="td font-semibold text-slate-800">{roleName(r)}</td>
                  <td className="td font-mono text-xs text-slate-500" dir="ltr">{r.key}</td>
                  <td className="td">{r._count.users}</td>
                  <td className="td text-xs text-slate-500">
                    {r.permissions.length} {t('adm.role.permsCount')}
                  </td>
                  <td className="td">
                    <div className="flex flex-wrap gap-1.5">
                      <Btn sm onClick={() => openEditRole(r)}>{t('common.edit')}</Btn>
                      {r._count.users === 0 && (
                        <Btn
                          sm
                          icon="trash"
                          variant="danger"
                          busy={busy(`delRole:${r.id}`)}
                          disabled={busy()}
                          onClick={() => deleteRole(r)}
                        >
                          {t('adm.role.delete')}
                        </Btn>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* user create/edit modal */}
      <Modal
        open={uOpen}
        title={uEdit ? t('adm.user.edit') : t('adm.user.new')}
        onClose={() => setUOpen(false)}
      >
        <form
          className="grid gap-4"
          onSubmit={(ev) => {
            ev.preventDefault();
            void submitUser();
          }}
        >
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Field label={`${t('adm.user.name')} (عربي)`}>
              <input className="input" required={!uNameEn.trim()} value={uNameAr} onChange={(e) => setUNameAr(e.target.value)} />
            </Field>
            <Field label={`${t('adm.user.name')} (EN — ${ar ? 'اختياري' : 'optional'})`}>
              <input className="input" dir="ltr" value={uNameEn} onChange={(e) => setUNameEn(e.target.value)} />
            </Field>
          </div>
          <Field label={t('adm.user.email')}>
            <input
              type="email"
              className="input"
              dir="ltr"
              required
              disabled={!!uEdit}
              value={uEmail}
              onChange={(e) => setUEmail(e.target.value)}
            />
          </Field>
          {!uEdit && (
            <Field label={t('adm.user.password')} hint={t('adm.user.passwordHint')}>
              <input
                type="text"
                className="input font-mono"
                dir="ltr"
                required
                minLength={8}
                value={uPassword}
                onChange={(e) => setUPassword(e.target.value)}
              />
            </Field>
          )}
          <Field label={t('adm.user.primaryRole')}>
            {/* Native constraint validation, like the fields above. The global
                handler in i18n.tsx would say only "this field is required";
                onInvalid runs after it and names what is missing. */}
            <select
              ref={uRoleRef}
              className="input"
              required
              value={uRoleId}
              onInvalid={(e) => e.currentTarget.setCustomValidity(t('adm.user.roleRequired'))}
              onChange={(e) => {
                setURoleId(e.target.value);
                // Promoting a role to primary removes it from the additional ones.
                setUExtra((prev) => {
                  const next = new Set(prev);
                  next.delete(e.target.value);
                  return next;
                });
              }}
            >
              {!uRoleId && (
                <option value="" disabled>
                  {t('adm.user.rolePlaceholder')}
                </option>
              )}
              {roles.map((r) => (
                <option key={r.id} value={r.id}>
                  {roleName(r)}
                </option>
              ))}
            </select>
          </Field>
          <Field label={t('adm.user.extraRoles')} hint={t('adm.user.extraRolesHint')}>
            <div className="grid max-h-40 grid-cols-1 gap-1 overflow-y-auto rounded-lg border border-slate-200 p-2 sm:grid-cols-2">
              {roles
                .filter((r) => r.id !== uRoleId)
                .map((r) => (
                  <label key={r.id} className="flex items-center gap-2 rounded px-1.5 py-1 text-xs text-slate-700 hover:bg-slate-50">
                    <input
                      type="checkbox"
                      checked={uExtra.has(r.id)}
                      onChange={(e) => {
                        const next = new Set(uExtra);
                        if (e.target.checked) next.add(r.id);
                        else next.delete(r.id);
                        setUExtra(next);
                      }}
                    />
                    {roleName(r)}
                  </label>
                ))}
            </div>
          </Field>
          <div className="flex justify-end gap-2">
            <Btn onClick={() => setUOpen(false)}>{t('common.cancel')}</Btn>
            <Btn type="submit" variant="primary" busy={busy('user')} disabled={busy()}>
              {uEdit ? t('common.save') : t('common.create')}
            </Btn>
          </div>
        </form>
      </Modal>

      {/* set-password modal */}
      <Modal
        open={!!pOpen}
        title={`${t('adm.user.resetPassTitle')} — ${pOpen ? (ar ? pOpen.nameAr : pOpen.nameEn) : ''}`}
        onClose={() => setPOpen(null)}
      >
        <form
          className="grid gap-4"
          onSubmit={(ev) => {
            ev.preventDefault();
            void submitSetPassword();
          }}
        >
          <Field label={t('adm.user.newPassword')} hint={t('adm.user.passwordHint')}>
            <input
              type="text"
              className="input font-mono"
              dir="ltr"
              required
              minLength={8}
              value={pValue}
              onChange={(e) => setPValue(e.target.value)}
            />
          </Field>
          <div className="flex justify-end gap-2">
            <Btn onClick={() => setPOpen(null)}>{t('common.cancel')}</Btn>
            <Btn type="submit" variant="primary" busy={busy('setPw')} disabled={busy()}>
              {t('adm.user.resetPass')}
            </Btn>
          </div>
        </form>
      </Modal>

      {/* role create/edit modal */}
      <Modal
        open={rOpen}
        wide
        title={rEdit ? t('adm.role.edit') : t('adm.role.new')}
        onClose={() => setROpen(false)}
      >
        <form
          className="grid gap-4"
          onSubmit={(ev) => {
            ev.preventDefault();
            void submitRole();
          }}
        >
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Field label={`${t('adm.role.name')} (عربي)`}>
              <input className="input" required={!rNameEn.trim()} value={rNameAr} onChange={(e) => setRNameAr(e.target.value)} />
            </Field>
            <Field label={`${t('adm.role.name')} (EN — ${ar ? 'اختياري' : 'optional'})`}>
              <input className="input" dir="ltr" value={rNameEn} onChange={(e) => setRNameEn(e.target.value)} />
            </Field>
          </div>
          {!rEdit && (
            <Field label={t('adm.role.key')} hint={t('adm.role.keyHint')}>
              <input
                className="input font-mono"
                dir="ltr"
                required
                pattern="[a-z][a-z0-9_]{1,39}"
                value={rKey}
                onChange={(e) => setRKey(e.target.value)}
              />
            </Field>
          )}

          <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1fr)_15rem]">
            <div className="min-w-0">
              <div className="mb-2 flex items-center justify-between">
                <span className="text-sm font-semibold text-slate-700">{t('adm.role.perms')}</span>
                <div className="flex gap-2 text-xs">
                  <button type="button" className="text-brand-600 hover:underline" onClick={() => setPerms(new Set(catalog.map((p) => p.key)))}>
                    {t('adm.role.selectAll')}
                  </button>
                  <button type="button" className="text-slate-500 hover:underline" onClick={() => setPerms(new Set())}>
                    {t('adm.role.clearAll')}
                  </button>
                </div>
              </div>
              <p className="mb-2 text-xs text-slate-500">
                {t('adm.role.gridHint')} {t('adm.role.grid.viewHint')}
              </p>
              <div className="max-h-[55vh] space-y-4 overflow-y-auto rounded-lg border border-slate-200 p-3 [scrollbar-width:thin]">
                {gridGroups.map(({ group, rows }) => {
                  const groupName = ar ? group.labelAr : group.labelEn;
                  const groupKeys = rows
                    .filter((r) => !r.fixed)
                    .flatMap((r) => [
                      ...GRID_COLUMNS.map((c) => r.cells[c]?.key).filter((k): k is string => !!k),
                      ...r.specials.map((p) => p.key),
                    ]);
                  return (
                    <div key={group.key}>
                      {groupKeys.length > 0 ? (
                        <label className="mb-1.5 flex items-center gap-2 text-xs font-bold text-slate-500">
                          <input
                            type="checkbox"
                            checked={groupKeys.every((k) => rPerms.has(k))}
                            onChange={(e) => {
                              const next = new Set(rPerms);
                              groupKeys.forEach((k) => (e.target.checked ? next.add(k) : next.delete(k)));
                              setPerms(next);
                            }}
                          />
                          {groupName}
                        </label>
                      ) : (
                        <div className="mb-1.5 text-xs font-bold text-slate-500">{groupName}</div>
                      )}
                      <table className="w-full text-xs">
                        <thead>
                          <tr className="text-slate-600">
                            <th scope="col" className="py-1 text-start font-semibold">{t('adm.role.grid.screen')}</th>
                            {GRID_COLUMNS.map((c) => (
                              <th key={c} scope="col" className="w-20 py-1 text-center font-semibold">
                                {t(`adm.role.grid.${c}`)}
                              </th>
                            ))}
                          </tr>
                        </thead>
                        {rows.map((row) => {
                          const name = ar ? row.screen.labelAr : row.screen.labelEn;
                          return (
                            <tbody key={row.screen.href} className="border-t border-slate-100">
                              <tr className="hover:bg-slate-50">
                                <th scope="row" className="py-1.5 text-start font-normal text-slate-700">{name}</th>
                                {GRID_COLUMNS.map((c) => {
                                  if (c === 'view' && row.fixed) {
                                    return (
                                      <td key={c} className="py-1.5 text-center text-slate-500">
                                        {t('adm.role.grid.everyone')}
                                      </td>
                                    );
                                  }
                                  const p = row.cells[c];
                                  const off = !!p && c !== 'view' && cellDisabled(row, p.key);
                                  return (
                                    <td key={c} className="py-1.5 text-center">
                                      {p ? (
                                        <input
                                          type="checkbox"
                                          aria-label={`${name} — ${t(`adm.role.grid.${c}`)}`}
                                          title={off ? t('adm.role.grid.needsView') : ar ? p.labelAr : p.labelEn}
                                          checked={rPerms.has(p.key)}
                                          disabled={off}
                                          onChange={(e) => setPerm(p.key, e.target.checked, row)}
                                        />
                                      ) : null}
                                    </td>
                                  );
                                })}
                              </tr>
                              {row.specials.length > 0 && (
                                <tr>
                                  <td colSpan={GRID_COLUMNS.length + 1} className="pb-1.5 ps-4">
                                    <div className="flex flex-wrap gap-x-4 gap-y-1">
                                      {row.specials.map((p) => {
                                        const off = cellDisabled(row, p.key);
                                        return (
                                          <label
                                            key={p.key}
                                            className={`flex items-center gap-1.5 ${off ? 'text-slate-400' : 'text-slate-600'}`}
                                            title={off ? t('adm.role.grid.needsView') : undefined}
                                          >
                                            <input
                                              type="checkbox"
                                              checked={rPerms.has(p.key)}
                                              disabled={off}
                                              onChange={(e) => setPerm(p.key, e.target.checked, row)}
                                            />
                                            {ar ? p.labelAr : p.labelEn}
                                          </label>
                                        );
                                      })}
                                    </div>
                                  </td>
                                </tr>
                              )}
                            </tbody>
                          );
                        })}
                      </table>
                    </div>
                  );
                })}

                {specials.length > 0 && (
                  <div>
                    <div className="mb-0.5 text-xs font-bold text-slate-500">{t('adm.role.special')}</div>
                    <p className="mb-1.5 text-xs text-slate-500">{t('adm.role.specialHint')}</p>
                    <div className="grid grid-cols-1 gap-1 sm:grid-cols-2">
                      {specials.map((p) => (
                        <label key={p.key} className="flex items-center gap-2 rounded px-1.5 py-1 text-xs text-slate-700 hover:bg-slate-50">
                          <input
                            type="checkbox"
                            checked={rPerms.has(p.key)}
                            onChange={(e) => setPerm(p.key, e.target.checked)}
                          />
                          {ar ? p.labelAr : p.labelEn}
                        </label>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            </div>

            {/* The sidebar as a holder of this draft alone would see it,
                drawn from the same registry as the real one. */}
            <aside aria-labelledby="role-preview-title" className="min-w-0">
              <p id="role-preview-title" className="mb-2 text-sm font-semibold text-slate-700">
                {t('adm.role.preview.title')}
              </p>
              <p className="mb-2 text-xs font-semibold text-brand-700" aria-live="polite" data-testid="role-preview-count">
                {t('adm.role.preview.count')
                  .replace('{n}', String(previewCount))
                  .replace('{total}', String(SCREENS.length))}
              </p>
              <div className="max-h-[55vh] space-y-3 overflow-y-auto rounded-lg bg-gradient-to-b from-ink-900 to-ink-950 p-3 [scrollbar-width:thin]">
                {preview.map(({ group, screens }) => (
                  <div key={group.key}>
                    <p className="mb-1 px-1 text-[11px] font-bold text-slate-400">{ar ? group.labelAr : group.labelEn}</p>
                    <ul className="space-y-0.5" data-testid="role-preview-group">
                      {screens.map((sc) => (
                        <li
                          key={sc.href}
                          data-href={sc.href}
                          className="flex items-center gap-2 rounded px-1.5 py-1 text-xs text-slate-300"
                        >
                          <Icon name={NAV_ICON.get(sc.href) ?? 'dashboard'} className="h-3.5 w-3.5 shrink-0 text-slate-500" />
                          <span className="truncate">{ar ? sc.labelAr : sc.labelEn}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                ))}
              </div>
              <p className="mt-1.5 text-[11px] leading-5 text-slate-500">{t('adm.role.preview.hint')}</p>
            </aside>
          </div>

          {conflicts.length > 0 && (
            <div role="status" className="rounded-xl border border-warning-200 bg-warning-50/60 p-4 text-sm">
              <p className="flex items-center gap-2 font-semibold text-warning-900">
                <Icon name="alert-triangle" className="h-4 w-4 shrink-0" />
                {t('adm.role.sod.title')}
              </p>
              <ul className="mt-2 list-disc space-y-0.5 ps-6 text-warning-900">
                {conflicts.map((c) => (
                  <li key={`${c.a}+${c.b}`}>{ar ? c.labelAr : c.labelEn}</li>
                ))}
              </ul>
              <p className="mt-2 text-xs leading-5 text-warning-800">{t('adm.role.sod.hint')}</p>
              <label className="mt-2 flex items-center gap-2 text-sm font-semibold text-warning-900">
                <input
                  type="checkbox"
                  checked={sodAcked}
                  onChange={(e) => setRSodAck(e.target.checked ? conflictSig : '')}
                />
                {t('adm.role.sod.ack')}
              </label>
            </div>
          )}

          {rSeatErr && (
            <p role="alert" className="rounded-xl border border-danger-200 bg-danger-50/50 p-4 text-sm font-medium text-danger-700">
              {rSeatErr}
            </p>
          )}

          <div className="flex justify-end gap-2">
            <Btn onClick={() => setROpen(false)}>{t('common.cancel')}</Btn>
            <Btn
              type="submit"
              variant="primary"
              busy={busy('role')}
              disabled={busy() || rPerms.size === 0 || (conflicts.length > 0 && !sodAcked)}
            >
              {rEdit ? t('common.save') : t('common.create')}
            </Btn>
          </div>
        </form>
      </Modal>

      {confirmNode}
    </div>
  );
}
