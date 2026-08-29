'use client';

/**
 * Departments — the organisational unit an approval rule can be scoped to.
 * M4 shipped the table and the matrix that reads it, but no way to create one
 * outside SQL, so "مدير القسم" existed only on paper.
 *
 * Two things this screen deliberately does not offer: a delete button (a
 * department is referenced by every document approved under it, so it is
 * deactivated instead), and a code field on edit (the code is the tenant's
 * stable key — renaming it silently would break every export that carries it).
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '@/lib/api';
import { useI18n } from '@/lib/i18n';
import { useAct } from '@/lib/useAct';
import { translateError } from '@/lib/errors';
import {
  Btn,
  EmptyRow,
  Field,
  LoadError,
  Modal,
  PageHeader,
  PageSkeleton,
  useConfirm,
} from '@/components/ui';

interface DirectoryUser {
  id: string;
  nameAr: string;
  nameEn: string;
  email: string;
  isActive: boolean;
  departmentId: string | null;
  role: { id: string; key: string; nameAr: string; nameEn: string };
}

interface Department {
  id: string;
  code: string;
  nameAr: string;
  nameEn: string;
  parentId: string | null;
  managerId: string | null;
  isActive: boolean;
  manager: { id: string; nameAr: string; nameEn: string; isActive: boolean } | null;
  parent: { id: string; code: string; nameAr: string; nameEn: string } | null;
  _count: { members: number; approvalRules: number; children: number };
}

export default function DepartmentsPage() {
  const { t, locale, pick } = useI18n();
  const { act, busy } = useAct();
  const { confirm, confirmNode } = useConfirm();

  const [rows, setRows] = useState<Department[] | null>(null);
  const [people, setPeople] = useState<DirectoryUser[]>([]);
  const [loadErr, setLoadErr] = useState('');

  // create / edit modal
  const [open, setOpen] = useState(false);
  const [edit, setEdit] = useState<Department | null>(null);
  const [code, setCode] = useState('');
  const [nameAr, setNameAr] = useState('');
  const [nameEn, setNameEn] = useState('');
  const [parentId, setParentId] = useState('');
  const [managerId, setManagerId] = useState('');
  const [isActive, setIsActive] = useState(true);

  // membership modal
  const [mOpen, setMOpen] = useState<Department | null>(null);
  const [mIds, setMIds] = useState<Set<string>>(new Set());

  const load = useCallback(() => {
    setLoadErr('');
    Promise.all([
      api.get<Department[]>('/admin/departments'),
      // The department screen cannot borrow /admin/users: that list needs
      // admin.user.manage, which a department administrator need not hold.
      api.get<DirectoryUser[]>('/admin/departments/directory'),
    ])
      .then(([d, u]) => {
        setRows(d);
        setPeople(u);
      })
      .catch((e) => setLoadErr(translateError(e, locale)));
  }, [locale]);
  useEffect(load, [load]);

  const deptById = useMemo(() => new Map((rows ?? []).map((d) => [d.id, d])), [rows]);
  const activePeople = useMemo(() => people.filter((p) => p.isActive), [people]);

  function openCreate() {
    setEdit(null);
    setCode('');
    setNameAr('');
    setNameEn('');
    setParentId('');
    setManagerId('');
    setIsActive(true);
    setOpen(true);
  }

  function openEdit(d: Department) {
    setEdit(d);
    setCode(d.code);
    setNameAr(d.nameAr);
    setNameEn(d.nameEn);
    setParentId(d.parentId ?? '');
    setManagerId(d.managerId ?? '');
    setIsActive(d.isActive);
    setOpen(true);
  }

  async function submit() {
    const ar = nameAr.trim() || nameEn.trim();
    const en = nameEn.trim() || ar;
    const body = {
      nameAr: ar,
      nameEn: en,
      // Empty select → null, which detaches rather than leaving the old value.
      parentId: parentId || null,
      managerId: managerId || null,
      isActive,
    };
    const ok = edit
      ? await act('dept', () => api.patch(`/admin/departments/${edit.id}`, body))
      : await act('dept', () =>
          api.post('/admin/departments', { ...body, code: code.trim().toUpperCase() }),
        );
    if (ok) {
      setOpen(false);
      load();
    }
  }

  async function toggleActive(d: Department) {
    if (d.isActive) {
      const yes = await confirm({
        title: t('dept.deactivateTitle'),
        message: `${t('dept.deactivateMsg')} (${pick(d, 'name')})`,
        danger: true,
      });
      if (!yes) return;
    }
    const ok = await act(`active:${d.id}`, () =>
      api.patch(`/admin/departments/${d.id}`, { isActive: !d.isActive }),
    );
    if (ok) load();
  }

  function openMembers(d: Department) {
    setMIds(new Set(people.filter((p) => p.departmentId === d.id).map((p) => p.id)));
    setMOpen(d);
  }

  async function submitMembers() {
    if (!mOpen) return;
    const ok = await act('members', () =>
      api.put(`/admin/departments/${mOpen.id}/members`, { userIds: [...mIds] }),
    );
    if (ok) {
      setMOpen(null);
      load();
    }
  }

  if (loadErr) return <LoadError message={loadErr} onRetry={load} />;
  if (!rows) return <PageSkeleton stats={0} />;

  /** Any department except this one — the server also refuses a cycle. */
  const parentOptions = rows.filter((d) => !edit || d.id !== edit.id);

  return (
    <div>
      <PageHeader
        title={t('dept.title')}
        action={
          <Btn variant="primary" icon="plus" onClick={openCreate}>
            {t('dept.new')}
          </Btn>
        }
      />
      <p className="-mt-3 mb-5 max-w-3xl text-xs leading-6 text-slate-500">{t('dept.hint')}</p>

      <div className="card overflow-hidden">
        <table className="min-w-full text-sm">
          <thead className="bg-slate-50">
            <tr>
              <th scope="col" className="th">{t('dept.code')}</th>
              <th scope="col" className="th">{t('dept.nameAr')}</th>
              <th scope="col" className="th">{t('dept.parent')}</th>
              <th scope="col" className="th">{t('dept.manager')}</th>
              <th scope="col" className="th">{t('dept.members')}</th>
              <th scope="col" className="th">{t('dept.rules')}</th>
              <th scope="col" className="th">{t('common.status')}</th>
              <th scope="col" className="th text-end">{t('common.actions')}</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {rows.length === 0 ? (
              <EmptyRow colSpan={8} text={t('dept.empty')} />
            ) : (
              rows.map((d) => (
                <tr key={d.id} className={d.isActive ? '' : 'bg-slate-50/60 [&_td]:text-slate-500'}>
                  <td className="td font-mono text-xs" dir="ltr">{d.code}</td>
                  <td className="td font-semibold text-slate-800">{pick(d, 'name')}</td>
                  <td className="td text-xs">
                    {d.parent ? pick(d.parent, 'name') : <span className="text-slate-400">—</span>}
                  </td>
                  <td className="td text-xs">
                    {d.manager ? (
                      <>
                        {pick(d.manager, 'name')}
                        {!d.manager.isActive && (
                          <span className="ms-1.5 text-warning-700">
                            ({t('adm.user.inactive')})
                          </span>
                        )}
                      </>
                    ) : (
                      <span className="text-slate-400">—</span>
                    )}
                  </td>
                  <td className="td">{d._count.members}</td>
                  <td className="td">{d._count.approvalRules}</td>
                  <td className="td">
                    <span
                      className={`badge ${
                        d.isActive
                          ? 'bg-success-50 text-success-700'
                          : 'bg-slate-100 text-slate-500'
                      }`}
                    >
                      <span
                        className={`h-1.5 w-1.5 rounded-full ${
                          d.isActive ? 'bg-success-500' : 'bg-slate-400'
                        }`}
                      />
                      {d.isActive ? t('adm.user.active') : t('adm.user.inactive')}
                    </span>
                  </td>
                  <td className="td">
                    <div className="flex flex-wrap justify-end gap-1.5">
                      <Btn sm onClick={() => openEdit(d)}>{t('common.edit')}</Btn>
                      <Btn sm icon="users" onClick={() => openMembers(d)}>
                        {t('dept.membersEdit')}
                      </Btn>
                      <Btn
                        sm
                        variant={d.isActive ? 'danger' : 'success'}
                        busy={busy(`active:${d.id}`)}
                        disabled={busy()}
                        onClick={() => toggleActive(d)}
                      >
                        {d.isActive ? t('dept.deactivate') : t('dept.activate')}
                      </Btn>
                    </div>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
      <p className="mt-3 text-xs leading-5 text-slate-500">{t('dept.noDelete')}</p>

      {/* create / edit */}
      <Modal
        open={open}
        title={edit ? t('dept.edit') : t('dept.new')}
        onClose={() => setOpen(false)}
        dirty={!edit && (code.trim() !== '' || nameAr.trim() !== '' || nameEn.trim() !== '')}
      >
        <form
          className="grid gap-4"
          onSubmit={(ev) => {
            ev.preventDefault();
            submit();
          }}
        >
          {!edit && (
            <Field label={t('dept.code')} hint={t('dept.codeHint')}>
              <input
                className="input font-mono"
                dir="ltr"
                required
                pattern="[A-Za-z][A-Za-z0-9_-]{1,19}"
                value={code}
                onChange={(e) => setCode(e.target.value.toUpperCase())}
              />
            </Field>
          )}
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Field label={t('dept.nameAr')}>
              <input
                className="input"
                required={!nameEn.trim()}
                value={nameAr}
                onChange={(e) => setNameAr(e.target.value)}
              />
            </Field>
            <Field label={t('dept.nameEn')}>
              <input
                className="input"
                dir="ltr"
                value={nameEn}
                onChange={(e) => setNameEn(e.target.value)}
              />
            </Field>
          </div>

          <Field label={t('dept.parent')} hint={t('dept.parentHint')}>
            <select className="input" value={parentId} onChange={(e) => setParentId(e.target.value)}>
              <option value="">{t('dept.none')}</option>
              {parentOptions.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.code} — {pick(d, 'name')}
                </option>
              ))}
            </select>
          </Field>

          <Field label={t('dept.manager')}>
            <select
              className="input"
              value={managerId}
              onChange={(e) => setManagerId(e.target.value)}
            >
              <option value="">{t('dept.none')}</option>
              {/* Deactivated accounts are omitted: the server refuses them, and
                  a manager who cannot sign in manages nothing. */}
              {activePeople.map((p) => (
                <option key={p.id} value={p.id}>
                  {pick(p, 'name')}
                </option>
              ))}
            </select>
          </Field>

          <label className="flex items-center gap-2 text-sm text-slate-700">
            <input
              type="checkbox"
              checked={isActive}
              onChange={(e) => setIsActive(e.target.checked)}
            />
            {t('adm.user.active')}
          </label>

          <div className="flex justify-end gap-2">
            <Btn onClick={() => setOpen(false)}>{t('common.cancel')}</Btn>
            <Btn type="submit" variant="primary" busy={busy('dept')} disabled={busy()}>
              {edit ? t('common.save') : t('common.create')}
            </Btn>
          </div>
        </form>
      </Modal>

      {/* membership */}
      <Modal
        open={!!mOpen}
        title={`${t('dept.membersTitle')} — ${mOpen ? pick(mOpen, 'name') : ''}`}
        onClose={() => setMOpen(null)}
      >
        <form
          className="grid gap-4"
          onSubmit={(ev) => {
            ev.preventDefault();
            submitMembers();
          }}
        >
          <p className="text-xs leading-5 text-slate-500">{t('dept.membersHint')}</p>
          <div className="max-h-[45vh] space-y-1 overflow-y-auto rounded-lg border border-slate-200 p-3 [scrollbar-width:thin]">
            {activePeople.map((p) => {
              const other =
                p.departmentId && p.departmentId !== mOpen?.id
                  ? deptById.get(p.departmentId)
                  : null;
              return (
                <label
                  key={p.id}
                  className="flex items-center gap-2 rounded px-1.5 py-1.5 text-sm text-slate-700 hover:bg-slate-50"
                >
                  <input
                    type="checkbox"
                    checked={mIds.has(p.id)}
                    onChange={(e) => {
                      const next = new Set(mIds);
                      if (e.target.checked) next.add(p.id);
                      else next.delete(p.id);
                      setMIds(next);
                    }}
                  />
                  <span className="flex-1">{pick(p, 'name')}</span>
                  <span className="text-xs text-slate-400">{pick(p.role, 'name')}</span>
                  {other && (
                    <span className="text-xs text-warning-700">
                      {t('dept.membersOther').replace('{dept}', pick(other, 'name'))}
                    </span>
                  )}
                </label>
              );
            })}
            {activePeople.length === 0 && (
              <p className="py-6 text-center text-sm text-slate-500">{t('common.none')}</p>
            )}
          </div>
          <div className="flex justify-end gap-2">
            <Btn onClick={() => setMOpen(null)}>{t('common.cancel')}</Btn>
            <Btn type="submit" variant="primary" busy={busy('members')} disabled={busy()}>
              {t('common.save')}
            </Btn>
          </div>
        </form>
      </Modal>

      {confirmNode}
    </div>
  );
}
