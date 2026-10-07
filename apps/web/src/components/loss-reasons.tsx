'use client';

/**
 * Admin → "Loss reasons" (CRM Phase 1 · Step 3).
 *
 * The list a salesperson picks from when marking an opportunity lost. A reason
 * can be added, renamed, re-ordered and switched off — never deleted, because
 * an opportunity lost last year still points at it.
 */
import { FormEvent, useCallback, useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { useI18n } from '@/lib/i18n';
import { useAct } from '@/lib/useAct';
import { translateError } from '@/lib/errors';
import { Btn, EmptyRow, Field, LoadError, Modal, PageSkeleton } from '@/components/ui';

interface Reason {
  id: string;
  nameAr: string;
  nameEn: string;
  sortOrder: number;
  isActive: boolean;
}

export function LossReasonsCard() {
  const { t, locale } = useI18n();
  const { act, busy } = useAct();
  const [rows, setRows] = useState<Reason[] | null>(null);
  const [err, setErr] = useState('');
  const [modal, setModal] = useState<{ open: boolean; row: Reason | null }>({ open: false, row: null });

  const load = useCallback(() => {
    setErr('');
    // `all=1` includes the switched-off reasons (the server honours it for administrators only).
    api
      .get<Reason[]>('/loss-reasons?all=1')
      .then(setRows)
      .catch((e) => setErr(translateError(e, locale)));
  }, [locale]);
  useEffect(load, [load]);

  if (err && !rows) return <LoadError message={err} onRetry={load} />;
  if (!rows) return <PageSkeleton />;

  async function save(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const text = (k: string) => String(f.get(k) ?? '').trim();
    const body = {
      nameAr: text('nameAr'),
      nameEn: text('nameEn') || text('nameAr'),
      sortOrder: text('sortOrder') ? Number(text('sortOrder')) : 0,
    };
    const row = modal.row;
    const ok = await act(
      'save',
      () => (row ? api.patch(`/loss-reasons/${row.id}`, body) : api.post('/loss-reasons', body)),
      { success: row ? t('common.done') : t('common.created') },
    );
    if (ok) {
      setModal({ open: false, row: null });
      load();
    }
  }

  async function toggle(row: Reason) {
    if (await act(`toggle:${row.id}`, () => api.patch(`/loss-reasons/${row.id}`, { isActive: !row.isActive }))) load();
  }

  // New reasons go to the end of the list unless the administrator says otherwise.
  const nextOrder = rows.reduce((m, r) => Math.max(m, r.sortOrder), 0) + 1;

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-base font-bold text-slate-800">{t('lossReasons.title')}</h2>
          <p className="mt-1 max-w-2xl text-xs text-slate-500">{t('lossReasons.hint')}</p>
        </div>
        <Btn variant="primary" icon="plus" onClick={() => setModal({ open: true, row: null })}>
          {t('lossReasons.new')}
        </Btn>
      </div>

      <div className="card overflow-hidden">
        <table className="min-w-full divide-y divide-slate-200">
          <thead className="bg-slate-50">
            <tr>
              <th scope="col" className="th">{t('lossReasons.nameAr')}</th>
              <th scope="col" className="th">{t('lossReasons.nameEn')}</th>
              <th scope="col" className="th">{t('lossReasons.order')}</th>
              <th scope="col" className="th">{t('lossReasons.active')}</th>
              <th scope="col" className="th">{t('common.actions')}</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {rows.length === 0 ? (
              <EmptyRow colSpan={5} text={t('lossReasons.empty')} />
            ) : (
              rows.map((r) => (
                <tr key={r.id} className={`hover:bg-slate-50 ${r.isActive ? '' : 'text-slate-400'}`}>
                  <td className="td font-medium">{r.nameAr}</td>
                  <td className="td" dir="ltr">{r.nameEn}</td>
                  <td className="td tabular-nums">{r.sortOrder}</td>
                  <td className="td">
                    <span className={`badge ${r.isActive ? 'bg-success-50 text-success-700' : 'bg-slate-100 text-slate-500'}`}>
                      {r.isActive ? t('lossReasons.active') : t('lossReasons.inactive')}
                    </span>
                  </td>
                  <td className="td">
                    <span className="flex flex-wrap gap-2">
                      <Btn sm onClick={() => setModal({ open: true, row: r })}>
                        {t('common.edit')}
                      </Btn>
                      <Btn sm busy={busy(`toggle:${r.id}`)} disabled={busy()} onClick={() => toggle(r)}>
                        {r.isActive ? t('lossReasons.disable') : t('lossReasons.enable')}
                      </Btn>
                    </span>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      <Modal
        open={modal.open}
        title={modal.row ? t('lossReasons.edit') : t('lossReasons.new')}
        onClose={() => setModal({ open: false, row: null })}
      >
        {/* keyed so reopening for another reason starts from ITS values */}
        <form key={modal.row?.id ?? 'new'} onSubmit={save} className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field label={t('lossReasons.nameAr')}>
            <input name="nameAr" className="input" required dir="rtl" defaultValue={modal.row?.nameAr ?? ''} />
          </Field>
          <Field label={t('lossReasons.nameEn')}>
            <input name="nameEn" className="input" dir="ltr" defaultValue={modal.row?.nameEn ?? ''} />
          </Field>
          <Field label={t('lossReasons.order')}>
            <input name="sortOrder" type="number" step={1} className="input" dir="ltr" defaultValue={modal.row?.sortOrder ?? nextOrder} />
          </Field>
          <div className="flex items-end justify-end gap-2 sm:col-span-2">
            <Btn onClick={() => setModal({ open: false, row: null })}>{t('common.cancel')}</Btn>
            <Btn type="submit" variant="primary" busy={busy('save')} disabled={busy()}>
              {t('common.save')}
            </Btn>
          </div>
        </form>
      </Modal>
    </div>
  );
}
