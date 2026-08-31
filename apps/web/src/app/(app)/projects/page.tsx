'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { useI18n } from '@/lib/i18n';
import { useAct } from '@/lib/useAct';
import { translateError } from '@/lib/errors';
import { formatMoney } from '@/lib/format';
import { useEnums } from '@/lib/useEnums';
import { PageHeader, StatusBadge, EmptyRow, Modal, Field, LoadError, Can, Btn, TableSkeleton } from '@/components/ui';

interface Project {
  id: string;
  code: string;
  contractId: string;
  nameAr: string;
  nameEn: string;
  stage: string;
  capacityKwp?: string | null;
  contract?: { code: string; totalValue: string; customer?: { nameAr: string; nameEn: string } };
  _count?: { purchaseOrders: number; serialUnits: number };
}
interface Contract {
  id: string;
  code: string;
  status: string;
  totalValue: string;
  customer?: { nameAr: string; nameEn: string };
}

export default function ProjectsPage() {
  const { t, locale, pick } = useI18n();
  const enums = useEnums();
  const [rows, setRows] = useState<Project[] | null>(null);
  const [stageFilter, setStageFilter] = useState('');
  const [contracts, setContracts] = useState<Contract[]>([]);
  const [open, setOpen] = useState(false);
  const [contractId, setContractId] = useState('');
  const [loadErr, setLoadErr] = useState('');
  const { act, busy } = useAct();
  const { can } = useAuth();

  const load = useCallback(() => {
    setLoadErr('');
    api
      .get<Project[]>('/projects')
      .then((p) => {
        setRows(p);
        // Contracts feed only the create-from-contract picker, and a role that
        // can read projects may not read contracts (the site engineer). Gate
        // the fetch on the permission instead of letting its 403 replace the
        // whole page with a retry card — the /ppa defect class.
        if (can('commercial.contract.read')) {
          api
            .get<Contract[]>('/contracts')
            .then((c) => {
              const taken = new Set(p.map((x) => x.contractId));
              setContracts(c.filter((x) => x.status === 'ACTIVE' && !taken.has(x.id)));
            })
            .catch(() => setContracts([]));
        }
      })
      .catch((e) => {
        setLoadErr(translateError(e, locale));
        // Without this the table stays gated on `!rows` and the skeleton
        // animates forever underneath the retry card.
        setRows([]);
      });
  }, [locale, can]);
  useEffect(load, [load]);

  async function create() {
    if (!contractId) return;
    const ok = await act('create', () => api.post('/projects', { contractId }), {
      success: t('common.created'),
    });
    if (ok) {
      setOpen(false);
      setContractId('');
      load();
    }
  }

  const shown = rows && stageFilter ? rows.filter((r) => r.stage === stageFilter) : rows;

  return (
    <div>
      <PageHeader
        title={t('prj.title')}
        action={
          <Can perm="projects.project.write">
            <Btn variant="primary" icon="plus" onClick={() => setOpen(true)}>
              {t('prj.new')}
            </Btn>
          </Can>
        }
      />
      {loadErr && <div className="mb-6"><LoadError message={loadErr} onRetry={load} /></div>}
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <select
          className="input !w-56"
          aria-label={t('prj.stage')}
          value={stageFilter}
          onChange={(e) => setStageFilter(e.target.value)}
        >
          <option value="">
            {t('prj.stage')}: {t('common.all')}
          </option>
          {enums?.projectStages.map((o) => (
            <option key={o.value} value={o.value}>
              {locale === 'ar' ? o.labelAr : o.labelEn}
            </option>
          ))}
        </select>
      </div>

      <div className="card table-sticky">
        <table className="min-w-full divide-y divide-slate-200 text-sm">
          <thead className="bg-slate-50">
            <tr>
              <th scope="col" className="th">{t('common.code')}</th>
              <th scope="col" className="th">{t('common.name')}</th>
              <th scope="col" className="th">{t('prj.contract')}</th>
              <th scope="col" className="th">{t('prj.stage')}</th>
              <th scope="col" className="th text-end">{t('contracts.value')}</th>
              <th scope="col" className="th text-center">{t('prj.pos')}</th>
              <th scope="col" className="th text-center">{t('prj.serials')}</th>
              <th scope="col" className="th">{t('common.actions')}</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {!rows ? (
              <TableSkeleton cols={8} />
            ) : shown!.length === 0 ? (
              <EmptyRow colSpan={8} text={t('prj.emptyHint')} actionHref="/contracts" actionText={t('nav.contracts')} />
            ) : (
              shown!.map((p) => (
                <tr key={p.id} className="hover:bg-slate-50">
                  <td className="td font-mono text-xs">{p.code}</td>
                  <td className="td">
                    {pick(p, 'name')}
                    <p className="text-xs text-slate-500">
                      {p.contract?.customer ? pick(p.contract.customer, 'name') : ''}
                    </p>
                  </td>
                  <td className="td font-mono text-xs">{p.contract?.code}</td>
                  <td className="td"><StatusBadge status={p.stage} /></td>
                  <td className="td-num">{formatMoney(p.contract?.totalValue, locale)}</td>
                  <td className="td text-center">{p._count?.purchaseOrders ?? 0}</td>
                  <td className="td text-center">{p._count?.serialUnits ?? 0}</td>
                  <td className="td">
                    <Link href={`/projects/${p.id}`} className="btn-ghost btn-sm">
                      {t('common.details')}
                    </Link>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      <Modal open={open} title={t('prj.new')} onClose={() => setOpen(false)}>
        {contracts.length === 0 ? (
          <p className="text-sm text-slate-500">{t('prj.noActiveContracts')}</p>
        ) : (
          <div className="space-y-4">
            <Field label={t('prj.selectContract')}>
              <select className="input" value={contractId} onChange={(e) => setContractId(e.target.value)}>
                <option value="">—</option>
                {contracts.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.code} · {c.customer ? pick(c.customer, 'name') : ''} · {formatMoney(c.totalValue, locale)}
                  </option>
                ))}
              </select>
            </Field>
            <div className="flex justify-end gap-2">
              <Btn sm onClick={() => setOpen(false)}>{t('common.cancel')}</Btn>
              <Btn variant="primary" sm busy={busy('create')} disabled={busy() || !contractId} onClick={create}>
                {t('prj.createFromContract')}
              </Btn>
            </div>
          </div>
        )}
      </Modal>
    </div>
  );
}
