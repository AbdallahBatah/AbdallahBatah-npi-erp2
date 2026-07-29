'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { api } from '@/lib/api';
import { useI18n } from '@/lib/i18n';
import { useAct } from '@/lib/useAct';
import { translateError } from '@/lib/errors';
import { formatMoney } from '@/lib/format';
import { PageHeader, StatusBadge, EmptyRow, Modal, Field, LoadError } from '@/components/ui';

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
  const [rows, setRows] = useState<Project[] | null>(null);
  const [contracts, setContracts] = useState<Contract[]>([]);
  const [open, setOpen] = useState(false);
  const [contractId, setContractId] = useState('');
  const [loadErr, setLoadErr] = useState('');
  const { act, busy } = useAct();

  const load = useCallback(() => {
    setLoadErr('');
    Promise.all([api.get<Project[]>('/projects'), api.get<Contract[]>('/contracts')])
      .then(([p, c]) => {
        setRows(p);
        const taken = new Set(p.map((x) => x.contractId));
        setContracts(c.filter((x) => x.status === 'ACTIVE' && !taken.has(x.id)));
      })
      .catch((e) => setLoadErr(translateError(e, locale)));
  }, [locale]);
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

  return (
    <div>
      <PageHeader
        title={t('prj.title')}
        action={
          <button className="btn-primary text-xs" onClick={() => setOpen(true)}>
            🏗️ {t('prj.new')}
          </button>
        }
      />
      {loadErr && <div className="mb-6"><LoadError message={loadErr} onRetry={load} /></div>}

      <div className="card overflow-hidden">
        <table className="min-w-full divide-y divide-slate-200 text-sm">
          <thead className="bg-slate-50">
            <tr>
              <th className="th">{t('common.code')}</th>
              <th className="th">{t('common.name')}</th>
              <th className="th">{t('prj.contract')}</th>
              <th className="th">{t('prj.stage')}</th>
              <th className="th text-end">{t('contracts.value')}</th>
              <th className="th text-center">{t('prj.pos')}</th>
              <th className="th text-center">{t('prj.serials')}</th>
              <th className="th">{t('common.actions')}</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {!rows ? (
              <EmptyRow colSpan={8} text={t('common.loading')} />
            ) : rows.length === 0 ? (
              <EmptyRow colSpan={8} text={t('prj.emptyHint')} actionHref="/contracts" actionText={t('nav.contracts')} />
            ) : (
              rows.map((p) => (
                <tr key={p.id} className="hover:bg-slate-50">
                  <td className="td font-mono text-xs">{p.code}</td>
                  <td className="td">
                    {pick(p, 'name')}
                    <p className="text-xs text-slate-400">
                      {p.contract?.customer ? pick(p.contract.customer, 'name') : ''}
                    </p>
                  </td>
                  <td className="td font-mono text-xs">{p.contract?.code}</td>
                  <td className="td"><StatusBadge status={p.stage} /></td>
                  <td className="td text-end">{formatMoney(p.contract?.totalValue, locale)}</td>
                  <td className="td text-center">{p._count?.purchaseOrders ?? 0}</td>
                  <td className="td text-center">{p._count?.serialUnits ?? 0}</td>
                  <td className="td">
                    <Link href={`/projects/${p.id}`} className="btn-ghost !px-3 !py-1 text-xs">
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
          <p className="text-sm text-slate-400">{t('prj.noActiveContracts')}</p>
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
              <button className="btn-ghost text-xs" onClick={() => setOpen(false)}>{t('common.cancel')}</button>
              <button className="btn-primary text-xs" onClick={create} disabled={busy() || !contractId}>
                {busy('create') ? t('common.loading') : t('prj.createFromContract')}
              </button>
            </div>
          </div>
        )}
      </Modal>
    </div>
  );
}
