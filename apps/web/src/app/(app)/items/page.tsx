'use client';

import { FormEvent, useCallback, useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { useI18n } from '@/lib/i18n';
import { useAct } from '@/lib/useAct';
import { translateError } from '@/lib/errors';
import { useEnums, optionLabel } from '@/lib/useEnums';
import { formatMoney } from '@/lib/format';
import { PageHeader, Modal, Field, EmptyRow, LoadError } from '@/components/ui';

interface Item {
  id: string;
  sku: string;
  nameAr: string;
  nameEn: string;
  itemCategory: string;
  uom: string;
  unitCost: string;
  isSerialised: boolean;
}

export default function ItemsPage() {
  const { t, locale, pick } = useI18n();
  const enums = useEnums();
  const [items, setItems] = useState<Item[]>([]);
  const [loading, setLoading] = useState(true);
  const [open, setOpen] = useState(false);
  const [loadErr, setLoadErr] = useState('');
  const { act, busy } = useAct();

  const load = useCallback(() => {
    setLoading(true);
    setLoadErr('');
    api
      .get<Item[]>('/items')
      .then(setItems)
      .catch((e) => setLoadErr(translateError(e, locale)))
      .finally(() => setLoading(false));
  }, [locale]);

  useEffect(load, [load]);

  async function create(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const ok = await act(
      'create',
      () =>
        api.post('/items', {
          sku: f.get('sku'),
          nameAr: String(f.get('nameAr') || '').trim() || String(f.get('nameEn') || '').trim(),
          nameEn: String(f.get('nameEn') || '').trim() || String(f.get('nameAr') || '').trim(),
          itemCategory: f.get('itemCategory'),
          uom: f.get('uom') || 'unit',
          unitCost: Number(f.get('unitCost') || 0),
          isSerialised: f.get('isSerialised') === 'on',
        }),
      { success: t('common.created') },
    );
    if (ok) {
      setOpen(false);
      load();
    }
  }

  return (
    <div>
      <PageHeader
        title={t('items.title')}
        action={
          <button className="btn-primary" onClick={() => setOpen(true)}>
            + {t('items.new')}
          </button>
        }
      />
      {loadErr && !loading ? <div className="mb-6"><LoadError message={loadErr} onRetry={load} /></div> : null}

      <div className="card overflow-hidden">
        <table className="min-w-full divide-y divide-slate-200">
          <thead className="bg-slate-50">
            <tr>
              <th className="th">{t('items.sku')}</th>
              <th className="th">{t('common.name')}</th>
              <th className="th">{t('items.category')}</th>
              <th className="th">{t('items.uom')}</th>
              <th className="th">{t('items.unitCost')}</th>
              <th className="th">{t('items.serialised')}</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {loading ? (
              <EmptyRow colSpan={6} text={t('common.loading')} />
            ) : items.length === 0 ? (
              <EmptyRow colSpan={6} text={t('common.none')} />
            ) : (
              items.map((it) => (
                <tr key={it.id} className="hover:bg-slate-50">
                  <td className="td font-mono text-xs">{it.sku}</td>
                  <td className="td font-medium">{pick(it, 'name')}</td>
                  <td className="td">{optionLabel(enums?.itemCategories, it.itemCategory, locale)}</td>
                  <td className="td">{it.uom}</td>
                  <td className="td">{formatMoney(it.unitCost, locale)}</td>
                  <td className="td">{it.isSerialised ? '✓' : '—'}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      <Modal open={open} title={t('items.new')} onClose={() => setOpen(false)}>
        <form onSubmit={create} className="grid grid-cols-2 gap-4">
          <Field label={t('items.sku')}>
            <input name="sku" className="input" required />
          </Field>
          <Field label={t('items.category')}>
            <select name="itemCategory" className="input" defaultValue="MODULE">
              {enums?.itemCategories.map((o) => (
                <option key={o.value} value={o.value}>
                  {locale === 'ar' ? o.labelAr : o.labelEn}
                </option>
              ))}
            </select>
          </Field>
          <Field label={`${t('common.name')} (ع)`}>
            <input name="nameAr" className="input" required />
          </Field>
          <Field label={`${t('common.name')} (EN — ${t('common.optional')})`}>
            <input name="nameEn" className="input" dir="ltr" />
          </Field>
          <Field label={t('items.uom')}>
            <input name="uom" className="input" defaultValue="unit" />
          </Field>
          <Field label={t('items.unitCost')}>
            <input name="unitCost" type="number" step="0.01" className="input" defaultValue="0" />
          </Field>
          <label className="col-span-2 flex items-center gap-2 text-sm text-slate-600">
            <input name="isSerialised" type="checkbox" />
            {t('items.serialised')}
          </label>
          <div className="col-span-2 flex justify-end gap-2">
            <button type="button" className="btn-ghost" onClick={() => setOpen(false)}>
              {t('common.cancel')}
            </button>
            <button type="submit" className="btn-primary" disabled={busy()}>
              {busy('create') ? t('common.loading') : t('common.create')}
            </button>
          </div>
        </form>
      </Modal>
    </div>
  );
}
