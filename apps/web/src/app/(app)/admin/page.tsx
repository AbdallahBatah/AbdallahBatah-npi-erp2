'use client';

/**
 * User & role administration — the screen that lets a real customer run the
 * system without touching the seed. Two tabs: users (create/edit/deactivate/
 * set password, primary + additional roles) and roles (a screens x actions
 * grid built from the server catalog, plus a "special permissions" section).
 * The API enforces the lockout guards; the UI just avoids offering footguns
 * (no deactivate button on yourself).
 */
import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { useI18n } from '@/lib/i18n';
import { useAct } from '@/lib/useAct';
import { translateError } from '@/lib/errors';
import { formatDate } from '@/lib/format';
import { PageHeader, LoadError, Modal, Field, StatusBadge, useConfirm, Btn, Tabs, PageSkeleton } from '@/components/ui';
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
  action: PermAction;
}
const GRID_COLUMNS = ['view', 'write', 'approve'] as const;
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
  const { user: me, can } = useAuth();
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

  // The role editor grid: per sidebar group, one row per screen with up to
  // three cells (view / create & edit / approve). A cell with no key is empty.
  const { gridGroups, specials } = useMemo(() => {
    const groupMap = new Map<string, Map<string, { name: string; cells: Partial<Record<PermAction, PermMeta>> }>>();
    const special: PermMeta[] = [];
    for (const p of catalog) {
      if (p.action === 'special') {
        special.push(p);
        continue;
      }
      const g = ar ? p.groupAr : p.groupEn;
      const rows = groupMap.get(g) ?? new Map();
      const row = rows.get(p.screenEn) ?? { name: ar ? p.screenAr : p.screenEn, cells: {} };
      row.cells[p.action] = p;
      rows.set(p.screenEn, row);
      groupMap.set(g, rows);
    }
    return {
      gridGroups: [...groupMap.entries()].map(([g, rows]) => [g, [...rows.values()]] as const),
      specials: special,
    };
  }, [catalog, ar]);

  function openCreateUser() {
    setUEdit(null);
    setUNameAr('');
    setUNameEn('');
    setUEmail('');
    setUPassword('');
    setURoleId(roles?.[0]?.id ?? '');
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
    setROpen(true);
  }
  function openEditRole(r: RoleRow) {
    setREdit(r);
    setRNameAr(r.nameAr);
    setRNameEn(r.nameEn);
    setRKey(r.key);
    setRPerms(new Set(r.permissions));
    setROpen(true);
  }
  async function submitRole() {
    const nameAr = rNameAr.trim() || rNameEn.trim();
    const nameEn = rNameEn.trim() || rNameAr.trim();
    const permissions = [...rPerms];
    const ok = rEdit
      ? await act('role', () => api.patch(`/admin/roles/${rEdit.id}`, { nameAr, nameEn, permissions }))
      : await act('role', () => api.post('/admin/roles', { key: rKey.trim(), nameAr, nameEn, permissions }));
    if (ok) {
      setROpen(false);
      load();
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
            submitUser();
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
            <select
              className="input"
              required
              value={uRoleId}
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
            submitSetPassword();
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
        title={rEdit ? t('adm.role.edit') : t('adm.role.new')}
        onClose={() => setROpen(false)}
      >
        <form
          className="grid gap-4"
          onSubmit={(ev) => {
            ev.preventDefault();
            submitRole();
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

          <div>
            <div className="mb-2 flex items-center justify-between">
              <span className="text-sm font-semibold text-slate-700">{t('adm.role.perms')}</span>
              <div className="flex gap-2 text-xs">
                <button type="button" className="text-brand-600 hover:underline" onClick={() => setRPerms(new Set(catalog.map((p) => p.key)))}>
                  {t('adm.role.selectAll')}
                </button>
                <button type="button" className="text-slate-500 hover:underline" onClick={() => setRPerms(new Set())}>
                  {t('adm.role.clearAll')}
                </button>
              </div>
            </div>
            <p className="mb-2 text-xs text-slate-500">{t('adm.role.gridHint')}</p>
            <div className="max-h-[50vh] space-y-4 overflow-y-auto rounded-lg border border-slate-200 p-3 [scrollbar-width:thin]">
              {gridGroups.map(([group, rows]) => {
                const groupKeys = rows.flatMap((r) => GRID_COLUMNS.map((c) => r.cells[c]?.key).filter((k): k is string => !!k));
                return (
                  <div key={group}>
                    <label className="mb-1.5 flex items-center gap-2 text-xs font-bold text-slate-500">
                      <input
                        type="checkbox"
                        checked={groupKeys.length > 0 && groupKeys.every((k) => rPerms.has(k))}
                        onChange={(e) => {
                          const next = new Set(rPerms);
                          groupKeys.forEach((k) => (e.target.checked ? next.add(k) : next.delete(k)));
                          setRPerms(next);
                        }}
                      />
                      {group}
                    </label>
                    <table className="w-full text-xs">
                      <thead>
                        <tr className="text-slate-600">
                          <th scope="col" className="py-1 text-start font-semibold">{t('adm.role.grid.screen')}</th>
                          {GRID_COLUMNS.map((c) => (
                            <th key={c} scope="col" className="w-24 py-1 text-center font-semibold">
                              {t(`adm.role.grid.${c}`)}
                            </th>
                          ))}
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-100">
                        {rows.map((row) => (
                          <tr key={row.name} className="hover:bg-slate-50">
                            <th scope="row" className="py-1.5 text-start font-normal text-slate-700">{row.name}</th>
                            {GRID_COLUMNS.map((c) => {
                              const p = row.cells[c];
                              return (
                                <td key={c} className="py-1.5 text-center">
                                  {p ? (
                                    <input
                                      type="checkbox"
                                      aria-label={`${row.name} — ${t(`adm.role.grid.${c}`)}`}
                                      title={ar ? p.labelAr : p.labelEn}
                                      checked={rPerms.has(p.key)}
                                      onChange={(e) => {
                                        const next = new Set(rPerms);
                                        if (e.target.checked) next.add(p.key);
                                        else next.delete(p.key);
                                        setRPerms(next);
                                      }}
                                    />
                                  ) : null}
                                </td>
                              );
                            })}
                          </tr>
                        ))}
                      </tbody>
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
                          onChange={(e) => {
                            const next = new Set(rPerms);
                            if (e.target.checked) next.add(p.key);
                            else next.delete(p.key);
                            setRPerms(next);
                          }}
                        />
                        {ar ? p.labelAr : p.labelEn}
                      </label>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </div>

          <div className="flex justify-end gap-2">
            <Btn onClick={() => setROpen(false)}>{t('common.cancel')}</Btn>
            <Btn type="submit" variant="primary" busy={busy('role')} disabled={busy() || rPerms.size === 0}>
              {rEdit ? t('common.save') : t('common.create')}
            </Btn>
          </div>
        </form>
      </Modal>

      {confirmNode}
    </div>
  );
}
