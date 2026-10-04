'use client';

import { useState } from 'react';
import { t, type ArKey } from '@/i18n/ar';
import { formatNumber } from '@/i18n/format';
import { Button } from '@/components/ui/Button';
import { Badge } from '@/components/ui/Badge';
import { formatBand } from '@/onboarding/gaps';
import type { StepDefaults } from '@/onboarding/machine';
import { APPROVAL_DOCUMENT_LABEL_AR } from '@/onboarding/plan';
import { APPROVAL_DOCUMENT_TYPES, ITEM_CATEGORIES, TERM_KEYS, type ApprovalDocumentType, type ItemCategory, type TermKey } from '@/onboarding/profile.schema';
import type { ApprovalRule, ItemTemplate } from './SetupWizard';

// ─── Step 3: approval rules ─────────────────────────────────────────────────

export type AcceptedDocType = Extract<StepDefaults, { step: 4 }>['acceptedDocTypes'][number];

export interface ApprovalRulesEditorProps {
  approvalRules: ApprovalRule[];
  /** Every role the pack declares, key → Arabic name (`Step3Defaults.
   *  roleNamesAr`): the pool «أضف دوراً» and the new-rule form pick from,
   *  shown by name with the key as the tooltip. */
  roleNamesAr: Record<string, string>;
  onChange: (next: ApprovalRule[]) => void;
}

export function ApprovalRulesEditor({ approvalRules, roleNamesAr, onChange }: ApprovalRulesEditorProps) {
  const roleKeyPool = Object.keys(roleNamesAr);
  const roleName = (key: string) => roleNamesAr[key] ?? key;
  const [newDocType, setNewDocType] = useState<ApprovalDocumentType>(APPROVAL_DOCUMENT_TYPES[0]);
  const [newMin, setNewMin] = useState('0');
  const [newRole, setNewRole] = useState(roleKeyPool[0] ?? '');

  function updateRule(index: number, patch: Partial<ApprovalRule>) {
    onChange(approvalRules.map((r, i) => (i === index ? { ...r, ...patch } : r)));
  }

  function removeRule(index: number) {
    onChange(approvalRules.filter((_, i) => i !== index));
  }

  function removeRole(index: number, roleKey: string) {
    const rule = approvalRules[index];
    if (rule.steps.length <= 1) return;
    updateRule(index, { steps: rule.steps.filter((k) => k !== roleKey) });
  }

  function addRole(index: number, roleKey: string) {
    if (!roleKey) return;
    const rule = approvalRules[index];
    if (rule.steps.includes(roleKey)) return;
    updateRule(index, { steps: [...rule.steps, roleKey] });
  }

  function addRule() {
    const minAmount = Number(newMin);
    if (!Number.isInteger(minAmount) || minAmount < 0 || !newRole) return;
    onChange([...approvalRules, { docType: newDocType, minAmount, maxAmount: null, steps: [newRole] }]);
    setNewMin('0');
  }

  return (
    <div className="flex flex-col gap-3">
      {approvalRules.map((rule, i) => (
        <div key={rule.docType + i} data-testid="setup-rule" className="flex flex-col gap-2 rounded-lg border border-slate-200 p-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-sm font-semibold text-slate-900">
              {t('setup.rule.doc')}: {APPROVAL_DOCUMENT_LABEL_AR[rule.docType]}
            </p>
            <Button type="button" variant="secondary" size="sm" onClick={() => removeRule(i)}>
              {t('setup.remove')}
            </Button>
          </div>
          <div className="flex flex-wrap gap-3">
            <label className="flex flex-col gap-1 text-xs text-slate-500">
              {t('setup.rule.min')}
              <input
                type="number"
                inputMode="numeric"
                min={0}
                value={rule.minAmount}
                onChange={(e) => updateRule(i, { minAmount: Number(e.target.value) })}
                className="h-11 w-36 rounded-lg border border-slate-300 px-3 text-sm text-slate-900 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
              />
              <span aria-hidden="true">{formatNumber(rule.minAmount)}</span>
            </label>
            <label className="flex flex-col gap-1 text-xs text-slate-500">
              {t('setup.rule.max')}
              <input
                type="number"
                inputMode="numeric"
                min={0}
                value={rule.maxAmount ?? ''}
                onChange={(e) => updateRule(i, { maxAmount: e.target.value === '' ? null : Number(e.target.value) })}
                className="h-11 w-36 rounded-lg border border-slate-300 px-3 text-sm text-slate-900 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
              />
              <span aria-hidden="true">{formatBand(rule.minAmount, rule.maxAmount ?? null)}</span>
            </label>
          </div>

          <div className="flex flex-col gap-1.5">
            <p className="text-xs font-semibold text-slate-600">{t('setup.rule.chain')}</p>
            <ol className="flex flex-wrap items-center gap-2">
              {rule.steps.map((roleKey, stepIndex) => (
                <li key={roleKey} className="flex items-center gap-1">
                  {stepIndex > 0 ? <span aria-hidden="true" className="text-slate-400">←</span> : null}
                  <span title={roleKey} className="rounded bg-slate-100 px-2 py-1 text-xs text-slate-700">
                    {roleName(roleKey)}
                  </span>
                  <button
                    type="button"
                    disabled={rule.steps.length <= 1}
                    onClick={() => removeRole(i, roleKey)}
                    aria-label={`${t('setup.remove')} ${roleName(roleKey)}`}
                    className="text-xs text-danger-600 underline-offset-2 hover:underline disabled:cursor-not-allowed disabled:text-slate-300"
                  >
                    {t('setup.remove')}
                  </button>
                </li>
              ))}
            </ol>
            <select
              aria-label={t('setup.rule.add_role')}
              value=""
              onChange={(e) => addRole(i, e.target.value)}
              className="h-11 w-48 rounded-lg border border-slate-300 px-3 text-sm text-slate-900 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
            >
              <option value="">{t('setup.rule.add_role')}</option>
              {roleKeyPool.filter((k) => !rule.steps.includes(k)).map((k) => (
                <option key={k} value={k}>
                  {roleName(k)}
                </option>
              ))}
            </select>
          </div>
        </div>
      ))}

      <div className="flex flex-wrap items-end gap-3 rounded-lg border border-dashed border-slate-300 p-3">
        <label className="flex flex-col gap-1 text-xs text-slate-500">
          {t('setup.rule.doc')}
          <select
            value={newDocType}
            onChange={(e) => setNewDocType(e.target.value as ApprovalDocumentType)}
            className="h-11 w-48 rounded-lg border border-slate-300 px-3 text-sm text-slate-900 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
          >
            {APPROVAL_DOCUMENT_TYPES.map((docType) => (
              <option key={docType} value={docType}>
                {APPROVAL_DOCUMENT_LABEL_AR[docType]}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-xs text-slate-500">
          {t('setup.rule.min')}
          <input
            type="number"
            inputMode="numeric"
            min={0}
            value={newMin}
            onChange={(e) => setNewMin(e.target.value)}
            className="h-11 w-36 rounded-lg border border-slate-300 px-3 text-sm text-slate-900 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
          />
        </label>
        <label className="flex flex-col gap-1 text-xs text-slate-500">
          {t('setup.rule.chain')}
          <select
            value={newRole}
            onChange={(e) => setNewRole(e.target.value)}
            className="h-11 w-48 rounded-lg border border-slate-300 px-3 text-sm text-slate-900 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
          >
            {roleKeyPool.map((k) => (
              <option key={k} value={k}>
                {roleName(k)}
              </option>
            ))}
          </select>
        </label>
        <Button type="button" variant="secondary" onClick={addRule}>
          {t('setup.add')}
        </Button>
      </div>
    </div>
  );
}

// ─── Step 4: accepted document types ────────────────────────────────────────

export interface DocTypesEditorProps {
  candidates: AcceptedDocType[];
  selectedKeys: string[];
  onChange: (next: string[]) => void;
}

export function DocTypesEditor({ candidates, selectedKeys, onChange }: DocTypesEditorProps) {
  function toggle(key: string, checked: boolean) {
    if (checked) {
      onChange([...selectedKeys, key]);
    } else {
      onChange(selectedKeys.filter((k) => k !== key));
    }
  }

  return (
    <div className="flex flex-col gap-2">
      {candidates.map((docType) => {
        const checked = selectedKeys.includes(docType.key);
        const isLastChecked = checked && selectedKeys.length === 1;
        return (
          <label
            key={docType.key}
            className="flex min-h-11 items-center justify-between gap-3 rounded-lg border border-slate-200 px-3 py-2"
          >
            <span className="flex items-center gap-2 text-sm text-slate-900">
              <input
                type="checkbox"
                checked={checked}
                disabled={isLastChecked}
                onChange={(e) => toggle(docType.key, e.target.checked)}
                className="h-4 w-4 rounded border-slate-300 text-brand-600 focus-visible:ring-2 focus-visible:ring-brand-500"
              />
              {docType.labelAr}
            </span>
            <Badge tone={docType.flow !== null ? 'brand' : 'neutral'}>
              {docType.flow !== null ? t(`flow.${docType.flow}` as ArKey) : t('setup.doc.no_flow')}
            </Badge>
          </label>
        );
      })}
    </div>
  );
}

// ─── Step 5: item templates ──────────────────────────────────────────────────

export interface ItemsEditorProps {
  items: ItemTemplate[];
  onChange: (next: ItemTemplate[]) => void;
}

const SKU_RE = /^[A-Z0-9][A-Z0-9_-]{1,29}$/;

export function ItemsEditor({ items, onChange }: ItemsEditorProps) {
  const [sku, setSku] = useState('');
  const [nameAr, setNameAr] = useState('');
  const [nameEn, setNameEn] = useState('');
  const [category, setCategory] = useState<ItemCategory>(ITEM_CATEGORIES[0]);
  const [uom, setUom] = useState('');
  const [serialised, setSerialised] = useState(false);

  function updateItem(index: number, patch: Partial<ItemTemplate>) {
    onChange(items.map((item, i) => (i === index ? { ...item, ...patch } : item)));
  }

  function removeItem(index: number) {
    onChange(items.filter((_, i) => i !== index));
  }

  function addItem() {
    const code = sku.trim().toUpperCase();
    if (!SKU_RE.test(code) || nameAr.trim().length === 0 || nameEn.trim().length === 0) return;
    onChange([
      ...items,
      {
        sku: code,
        nameAr: nameAr.trim(),
        nameEn: nameEn.trim(),
        itemCategory: category,
        uom: uom.trim() === '' ? undefined : uom.trim(),
        isSerialised: serialised,
      },
    ]);
    setSku('');
    setNameAr('');
    setNameEn('');
    setUom('');
    setSerialised(false);
  }

  return (
    <div className="flex flex-col gap-3">
      {items.map((item, i) => (
        <div key={item.sku} className="flex flex-col gap-2 rounded-lg border border-slate-200 p-3 sm:flex-row sm:items-center sm:gap-3">
          <code className="rounded bg-slate-100 px-2 py-1.5 text-sm text-slate-700">{item.sku}</code>
          <label className="flex flex-1 flex-col gap-1 text-xs text-slate-500">
            {t('setup.item.name')}
            <input
              type="text"
              value={item.nameAr}
              onChange={(e) => updateItem(i, { nameAr: e.target.value })}
              className="h-11 rounded-lg border border-slate-300 px-3 text-sm text-slate-900 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
            />
          </label>
          <Button type="button" variant="secondary" size="sm" onClick={() => removeItem(i)}>
            {t('setup.remove')}
          </Button>
        </div>
      ))}

      <div className="flex flex-wrap items-end gap-3 rounded-lg border border-dashed border-slate-300 p-3">
        <label className="flex flex-col gap-1 text-xs text-slate-500">
          {t('setup.item.sku')}
          <input
            type="text"
            value={sku}
            onChange={(e) => setSku(e.target.value)}
            onBlur={() => setSku((v) => v.trim().toUpperCase())}
            className="h-11 w-32 rounded-lg border border-slate-300 px-3 text-sm uppercase text-slate-900 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
          />
        </label>
        <label className="flex flex-col gap-1 text-xs text-slate-500">
          {t('setup.item.name')}
          <input
            type="text"
            value={nameAr}
            onChange={(e) => setNameAr(e.target.value)}
            className="h-11 rounded-lg border border-slate-300 px-3 text-sm text-slate-900 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
          />
        </label>
        <label className="flex flex-col gap-1 text-xs text-slate-500">
          {t('setup.item.name_en')}
          <input
            type="text"
            value={nameEn}
            onChange={(e) => setNameEn(e.target.value)}
            className="h-11 rounded-lg border border-slate-300 px-3 text-sm text-slate-900 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
          />
        </label>
        <label className="flex flex-col gap-1 text-xs text-slate-500">
          {t('setup.item.category')}
          <select
            value={category}
            onChange={(e) => setCategory(e.target.value as ItemCategory)}
            className="h-11 rounded-lg border border-slate-300 px-3 text-sm text-slate-900 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
          >
            {ITEM_CATEGORIES.map((cat) => (
              <option key={cat} value={cat}>
                {t(`setup.item.category.${cat}` as ArKey)}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-xs text-slate-500">
          {t('setup.item.uom')}
          <input
            type="text"
            value={uom}
            onChange={(e) => setUom(e.target.value)}
            className="h-11 w-24 rounded-lg border border-slate-300 px-3 text-sm text-slate-900 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
          />
        </label>
        <label className="flex min-h-11 items-center gap-1.5 text-xs text-slate-500">
          <input
            type="checkbox"
            checked={serialised}
            onChange={(e) => setSerialised(e.target.checked)}
            className="h-4 w-4 rounded border-slate-300 text-brand-600 focus-visible:ring-2 focus-visible:ring-brand-500"
          />
          {t('setup.item.serialised')}
        </label>
        <Button type="button" variant="secondary" onClick={addItem}>
          {t('setup.add')}
        </Button>
      </div>
    </div>
  );
}

// ─── Step 6: terminology ─────────────────────────────────────────────────────

export interface TerminologyEditorProps {
  terminology: Partial<Record<TermKey, string>>;
  onChange: (next: Partial<Record<TermKey, string>>) => void;
}

export function TerminologyEditor({ terminology, onChange }: TerminologyEditorProps) {
  function update(key: TermKey, value: string) {
    onChange({ ...terminology, [key]: value });
  }

  return (
    <div className="flex flex-col gap-3">
      <p className="text-sm text-slate-500">{t('setup.terms.hint')}</p>
      {TERM_KEYS.map((key) => (
        <label key={key} className="flex flex-col gap-1 text-xs text-slate-500 sm:flex-row sm:items-center sm:gap-3">
          <span className="sm:w-40">{t(`setup.term.${key}` as ArKey)}</span>
          <input
            type="text"
            value={terminology[key] ?? ''}
            onChange={(e) => update(key, e.target.value)}
            className="h-11 flex-1 rounded-lg border border-slate-300 px-3 text-sm text-slate-900 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
          />
        </label>
      ))}
    </div>
  );
}
