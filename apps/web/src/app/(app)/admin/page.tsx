'use client';

/**
 * User & role administration — the screen that lets a real customer run the
 * system without touching the seed. Two tabs: users (create/edit/deactivate/
 * set password) and roles (permission checkboxes from the server catalog).
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
import { PageHeader, LoadError, Modal, useConfirm, Btn, Tabs, PageSkeleton } from '@/components/ui';
import { AuditLogCard } from '@/components/audit-log';

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
  role: { id: string; key: string; nameAr: string; nameEn: string };
}
interface PermMeta {
  key: string;
  groupAr: string;
  groupEn: string;
  labelAr: string;
  labelEn: string;
}
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

  const [tab, setTab] = useState<'users' | 'roles' | 'org' | 'audit'>('users');
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

  const groups = useMemo(() => {
    const map = new Map<string, PermMeta[]>();
    for (const p of catalog) {
      const g = ar ? p.groupAr : p.groupEn;
      map.set(g, [...(map.get(g) ?? []), p]);
    }
    return [...map.entries()];
  }, [catalog, ar]);

  function openCreateUser() {
    setUEdit(null);
    setUNameAr('');
    setUNameEn('');
    setUEmail('');
    setUPassword('');
    setURoleId(roles?.[0]?.id ?? '');
    setUOpen(true);
  }
  function openEditUser(u: UserRow) {
    setUEdit(u);
    setUNameAr(u.nameAr);
    setUNameEn(u.nameEn);
    setUEmail(u.email);
    setUPassword('');
    setURoleId(u.role.id);
    setUOpen(true);
  }
  async function submitUser() {
    const nameAr = uNameAr.trim() || uNameEn.trim();
    const nameEn = uNameEn.trim() || uNameAr.trim();
    const ok = uEdit
      ? await act('user', () =>
          api.patch(`/admin/users/${uEdit.id}`, { nameAr, nameEn, roleId: uRoleId }),
        )
      : await act('user', () =>
          api.post('/admin/users', { nameAr, nameEn, email: uEmail.trim(), password: uPassword, roleId: uRoleId }),
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
          ...(orgManage ? ['org' as const] : []),
          ...(auditRead ? ['audit' as const] : []),
        ].map((k) => ({
          key: k,
          label: t(`adm.tab.${k}`),
          count: k === 'users' ? users.length : k === 'roles' ? roles.length : undefined,
        }))}
        value={tab}
        onChange={(k) => setTab(k as 'users' | 'roles' | 'org' | 'audit')}
      />

      {tab === 'audit' ? (
        <AuditLogCard />
      ) : tab === 'org' ? (
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
                  <div className="flex h-16 w-16 items-center justify-center rounded-lg border border-dashed border-slate-300 text-[10px] text-slate-400">
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
                      <Btn sm icon="trash" className="!text-rose-600" onClick={removeLogo}>
                        {t('org.logoRemove')}
                      </Btn>
                    )}
                  </div>
                  <p className="mt-1 text-[11px] text-slate-400">{t('org.logoHint')}</p>
                  {orgLogoErr && <p className="mt-1 text-[11px] text-rose-600">{orgLogoErr}</p>}
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <label className="block">
                  <span className="mb-1 block text-sm text-slate-600">{t('org.legalNameAr')}</span>
                  <input
                    className="input"
                    required
                    value={org.legalNameAr}
                    onChange={(e) => setOrg({ ...org, legalNameAr: e.target.value })}
                  />
                </label>
                <label className="block">
                  <span className="mb-1 block text-sm text-slate-600">{t('org.legalNameEn')}</span>
                  <input
                    className="input"
                    dir="ltr"
                    value={org.legalNameEn}
                    onChange={(e) => setOrg({ ...org, legalNameEn: e.target.value })}
                  />
                </label>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <label className="block">
                  <span className="mb-1 block text-sm text-slate-600">{t('org.vatNumber')}</span>
                  <input
                    className="input font-mono"
                    dir="ltr"
                    value={org.vatNumber ?? ''}
                    onChange={(e) => setOrg({ ...org, vatNumber: e.target.value })}
                  />
                </label>
                <label className="block">
                  <span className="mb-1 block text-sm text-slate-600">{t('org.crNumber')}</span>
                  <input
                    className="input font-mono"
                    dir="ltr"
                    value={org.crNumber ?? ''}
                    onChange={(e) => setOrg({ ...org, crNumber: e.target.value })}
                  />
                </label>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <label className="block">
                  <span className="mb-1 block text-sm text-slate-600">{t('org.addressAr')}</span>
                  <input
                    className="input"
                    value={org.addressAr ?? ''}
                    onChange={(e) => setOrg({ ...org, addressAr: e.target.value })}
                  />
                </label>
                <label className="block">
                  <span className="mb-1 block text-sm text-slate-600">{t('org.addressEn')}</span>
                  <input
                    className="input"
                    dir="ltr"
                    value={org.addressEn ?? ''}
                    onChange={(e) => setOrg({ ...org, addressEn: e.target.value })}
                  />
                </label>
              </div>
              <div className="grid grid-cols-3 gap-3">
                <label className="block">
                  <span className="mb-1 block text-sm text-slate-600">{t('org.phone')}</span>
                  <input
                    className="input"
                    dir="ltr"
                    value={org.phone ?? ''}
                    onChange={(e) => setOrg({ ...org, phone: e.target.value })}
                  />
                </label>
                <label className="block">
                  <span className="mb-1 block text-sm text-slate-600">{t('org.email')}</span>
                  <input
                    type="email"
                    className="input"
                    dir="ltr"
                    value={org.email ?? ''}
                    onChange={(e) => setOrg({ ...org, email: e.target.value })}
                  />
                </label>
                <label className="block">
                  <span className="mb-1 block text-sm text-slate-600">{t('org.website')}</span>
                  <input
                    className="input"
                    dir="ltr"
                    value={org.website ?? ''}
                    onChange={(e) => setOrg({ ...org, website: e.target.value })}
                  />
                </label>
              </div>

              <div className="flex justify-end">
                <Btn type="submit" variant="primary" busy={busy('org')} disabled={busy()}>
                  {t('common.save')}
                </Btn>
              </div>
            </form>
          )}
        </div>
      ) : tab === 'users' ? (
        <div className="card overflow-hidden">
          <table className="min-w-full text-sm">
            <thead className="bg-slate-50">
              <tr>
                <th className="th">{t('adm.user.name')}</th>
                <th className="th">{t('adm.user.email')}</th>
                <th className="th">{t('adm.user.role')}</th>
                <th className="th">{t('adm.user.status')}</th>
                <th className="th">{t('common.date')}</th>
                <th className="th text-end">{t('common.actions')}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {users.map((u) => (
                <tr key={u.id} className={u.isActive ? '' : 'bg-slate-50/60 text-slate-400'}>
                  <td className="td font-semibold text-slate-800">
                    {ar ? u.nameAr : u.nameEn}
                    {u.id === me?.id && <span className="ms-2 text-[10px] font-normal text-brand-600">({ar ? 'أنت' : 'you'})</span>}
                  </td>
                  <td className="td" dir="ltr">{u.email}</td>
                  <td className="td">{roleName(u.role)}</td>
                  <td className="td">
                    <span
                      className={`inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[11px] font-semibold ${
                        u.isActive ? 'bg-emerald-50 text-emerald-700' : 'bg-slate-100 text-slate-500'
                      }`}
                    >
                      <span className={`h-1.5 w-1.5 rounded-full ${u.isActive ? 'bg-emerald-500' : 'bg-slate-400'}`} />
                      {u.isActive ? t('adm.user.active') : t('adm.user.inactive')}
                    </span>
                  </td>
                  <td className="td text-xs">{formatDate(u.createdAt, locale)}</td>
                  <td className="td">
                    <div className="flex justify-end gap-1.5 text-[11px]">
                      <Btn sm onClick={() => openEditUser(u)}>{t('common.edit')}</Btn>
                      <Btn sm icon="key" onClick={() => { setPOpen(u); setPValue(''); }}>
                        {t('adm.user.resetPass')}
                      </Btn>
                      {u.id !== me?.id && (
                        <Btn
                          sm
                          className={u.isActive ? '!text-rose-600' : '!text-emerald-600'}
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
                <th className="th">{t('adm.role.name')}</th>
                <th className="th">{t('adm.role.key')}</th>
                <th className="th">{t('adm.role.users')}</th>
                <th className="th">{t('adm.role.perms')}</th>
                <th className="th text-end">{t('common.actions')}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {roles.map((r) => (
                <tr key={r.id}>
                  <td className="td font-semibold text-slate-800">{roleName(r)}</td>
                  <td className="td font-mono text-xs text-slate-400" dir="ltr">{r.key}</td>
                  <td className="td">{r._count.users}</td>
                  <td className="td text-xs text-slate-500">
                    {r.permissions.length} {t('adm.role.permsCount')}
                  </td>
                  <td className="td">
                    <div className="flex justify-end gap-1.5 text-[11px]">
                      <Btn sm onClick={() => openEditRole(r)}>{t('common.edit')}</Btn>
                      {r._count.users === 0 && (
                        <Btn
                          sm
                          icon="trash"
                          className="!text-rose-600"
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
          <div className="grid grid-cols-2 gap-3">
            <label className="block">
              <span className="mb-1 block text-sm text-slate-600">{t('adm.user.name')} (عربي)</span>
              <input className="input" required={!uNameEn.trim()} value={uNameAr} onChange={(e) => setUNameAr(e.target.value)} />
            </label>
            <label className="block">
              <span className="mb-1 block text-sm text-slate-600">{t('adm.user.name')} (EN — {ar ? 'اختياري' : 'optional'})</span>
              <input className="input" dir="ltr" value={uNameEn} onChange={(e) => setUNameEn(e.target.value)} />
            </label>
          </div>
          <label className="block">
            <span className="mb-1 block text-sm text-slate-600">{t('adm.user.email')}</span>
            <input
              type="email"
              className="input"
              dir="ltr"
              required
              disabled={!!uEdit}
              value={uEmail}
              onChange={(e) => setUEmail(e.target.value)}
            />
          </label>
          {!uEdit && (
            <label className="block">
              <span className="mb-1 block text-sm text-slate-600">{t('adm.user.password')}</span>
              <input
                type="text"
                className="input font-mono"
                dir="ltr"
                required
                minLength={8}
                value={uPassword}
                onChange={(e) => setUPassword(e.target.value)}
              />
              <span className="mt-1 block text-[11px] text-slate-400">{t('adm.user.passwordHint')}</span>
            </label>
          )}
          <label className="block">
            <span className="mb-1 block text-sm text-slate-600">{t('adm.user.role')}</span>
            <select className="input" required value={uRoleId} onChange={(e) => setURoleId(e.target.value)}>
              {roles.map((r) => (
                <option key={r.id} value={r.id}>
                  {roleName(r)}
                </option>
              ))}
            </select>
          </label>
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
          <label className="block">
            <span className="mb-1 block text-sm text-slate-600">{t('adm.user.newPassword')}</span>
            <input
              type="text"
              className="input font-mono"
              dir="ltr"
              required
              minLength={8}
              value={pValue}
              onChange={(e) => setPValue(e.target.value)}
            />
            <span className="mt-1 block text-[11px] text-slate-400">{t('adm.user.passwordHint')}</span>
          </label>
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
          <div className="grid grid-cols-2 gap-3">
            <label className="block">
              <span className="mb-1 block text-sm text-slate-600">{t('adm.role.name')} (عربي)</span>
              <input className="input" required={!rNameEn.trim()} value={rNameAr} onChange={(e) => setRNameAr(e.target.value)} />
            </label>
            <label className="block">
              <span className="mb-1 block text-sm text-slate-600">{t('adm.role.name')} (EN — {ar ? 'اختياري' : 'optional'})</span>
              <input className="input" dir="ltr" value={rNameEn} onChange={(e) => setRNameEn(e.target.value)} />
            </label>
          </div>
          {!rEdit && (
            <label className="block">
              <span className="mb-1 block text-sm text-slate-600">{t('adm.role.key')}</span>
              <input
                className="input font-mono"
                dir="ltr"
                required
                pattern="[a-z][a-z0-9_]{1,39}"
                value={rKey}
                onChange={(e) => setRKey(e.target.value)}
              />
              <span className="mt-1 block text-[11px] text-slate-400">{t('adm.role.keyHint')}</span>
            </label>
          )}

          <div>
            <div className="mb-2 flex items-center justify-between">
              <span className="text-sm font-semibold text-slate-700">{t('adm.role.perms')}</span>
              <div className="flex gap-2 text-[11px]">
                <button type="button" className="text-brand-600 hover:underline" onClick={() => setRPerms(new Set(catalog.map((p) => p.key)))}>
                  {t('adm.role.selectAll')}
                </button>
                <button type="button" className="text-slate-400 hover:underline" onClick={() => setRPerms(new Set())}>
                  {t('adm.role.clearAll')}
                </button>
              </div>
            </div>
            <div className="max-h-[45vh] space-y-4 overflow-y-auto rounded-lg border border-slate-200 p-3 [scrollbar-width:thin]">
              {groups.map(([group, perms]) => (
                <div key={group}>
                  <label className="mb-1.5 flex items-center gap-2 text-xs font-bold text-slate-500">
                    <input
                      type="checkbox"
                      checked={perms.every((p) => rPerms.has(p.key))}
                      onChange={(e) => {
                        const next = new Set(rPerms);
                        perms.forEach((p) => (e.target.checked ? next.add(p.key) : next.delete(p.key)));
                        setRPerms(next);
                      }}
                    />
                    {group}
                  </label>
                  <div className="grid grid-cols-1 gap-1 sm:grid-cols-2">
                    {perms.map((p) => (
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
              ))}
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
