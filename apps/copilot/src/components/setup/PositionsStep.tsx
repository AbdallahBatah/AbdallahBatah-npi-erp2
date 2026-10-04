'use client';

import { useState } from 'react';
import { t } from '@/i18n/ar';
import { Button } from '@/components/ui/Button';
import type { StepDefaultsNpiUser } from '@/onboarding/machine';
import type { Department, Position, PositionHolderDraft } from './SetupWizard';

export interface PositionsStepProps {
  departments: Department[];
  positions: Position[];
  /** Index-aligned with `positions` — `holders[i]` names `positions[i]`. */
  holders: PositionHolderDraft[];
  /** Static per-role candidate list from the server's step-2 defaults; never
   *  edited here (T-18 has no "add position" flow — that is the sentence
   *  path, T-19). */
  npiUsersByRole: Record<string, StepDefaultsNpiUser[]>;
  onChange: (next: { departments: Department[]; positions: Position[]; holders: PositionHolderDraft[] }) => void;
}

const DEPARTMENT_CODE_RE = /^[A-Z][A-Z0-9_-]{1,19}$/;

/**
 * Step 2's editor (`03` §2): the department list and the position list, each
 * with a holders picker over NPI's own directory. No "add position" button
 * here on purpose — adding a position goes through the free-text sentence
 * path (T-19), not this screen; this screen only edits/removes positions the
 * profile pack already proposed.
 */
export function PositionsStep({ departments, positions, holders, npiUsersByRole, onChange }: PositionsStepProps) {
  const [newCode, setNewCode] = useState('');
  const [newName, setNewName] = useState('');
  const [codeError, setCodeError] = useState(false);

  function departmentInUse(code: string): boolean {
    return positions.some((p) => p.departmentCode === code);
  }

  function updateDepartment(index: number, nameAr: string) {
    const next = departments.map((d, i) => (i === index ? { ...d, nameAr } : d));
    onChange({ departments: next, positions, holders });
  }

  function removeDepartment(index: number) {
    const next = departments.filter((_, i) => i !== index);
    onChange({ departments: next, positions, holders });
  }

  function addDepartment() {
    const code = newCode.trim().toUpperCase();
    if (!DEPARTMENT_CODE_RE.test(code) || newName.trim().length < 2) {
      setCodeError(true);
      return;
    }
    onChange({ departments: [...departments, { code, nameAr: newName.trim() }], positions, holders });
    setNewCode('');
    setNewName('');
    setCodeError(false);
  }

  function updatePosition(index: number, patch: Partial<Position>) {
    const nextPositions = positions.map((p, i) => (i === index ? { ...p, ...patch } : p));
    const nextHolders = holders.map((h, i) =>
      i === index && patch.departmentCode !== undefined ? { ...h, departmentCode: patch.departmentCode } : h,
    );
    onChange({ departments, positions: nextPositions, holders: nextHolders });
  }

  function removePosition(index: number) {
    if (positions.length <= 1) return;
    onChange({
      departments,
      positions: positions.filter((_, i) => i !== index),
      holders: holders.filter((_, i) => i !== index),
    });
  }

  function toggleHolder(index: number, npiUserId: string, checked: boolean) {
    const nextHolders = holders.map((h, i) => {
      if (i !== index) return h;
      const npiUserIds = checked ? [...h.npiUserIds, npiUserId] : h.npiUserIds.filter((id) => id !== npiUserId);
      return { ...h, npiUserIds };
    });
    onChange({ departments, positions, holders: nextHolders });
  }

  return (
    <div className="flex flex-col gap-6">
      <section className="flex flex-col gap-3">
        <h3 className="text-sm font-bold text-slate-900">{t('setup.departments')}</h3>
        <div className="flex flex-col gap-2">
          {departments.map((dept, i) => {
            const inUse = departmentInUse(dept.code);
            return (
              <div
                key={dept.code}
                data-testid={`setup-dept-${dept.code}`}
                className="flex flex-col gap-2 rounded-lg border border-slate-200 p-3 sm:flex-row sm:items-center sm:gap-3"
              >
                <div className="flex flex-col gap-1 text-xs text-slate-500 sm:w-28">
                  <span id={`dept-code-label-${dept.code}`}>{t('setup.dept.code')}</span>
                  <code
                    aria-labelledby={`dept-code-label-${dept.code}`}
                    className="rounded bg-slate-100 px-2 py-1.5 text-sm text-slate-700"
                  >
                    {dept.code}
                  </code>
                </div>
                <label className="flex flex-1 flex-col gap-1 text-xs text-slate-500">
                  {t('setup.dept.name')}
                  <input
                    type="text"
                    value={dept.nameAr}
                    onChange={(e) => updateDepartment(i, e.target.value)}
                    className="h-11 rounded-lg border border-slate-300 px-3 text-sm text-slate-900 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
                  />
                </label>
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  disabled={inUse}
                  title={inUse ? t('setup.dept.in_use') : undefined}
                  onClick={() => removeDepartment(i)}
                >
                  {t('setup.remove')}
                </Button>
              </div>
            );
          })}
        </div>
        <div className="flex flex-col gap-2 rounded-lg border border-dashed border-slate-300 p-3 sm:flex-row sm:items-end sm:gap-3">
          <label className="flex flex-col gap-1 text-xs text-slate-500 sm:w-32">
            {t('setup.dept.code')}
            <input
              type="text"
              value={newCode}
              onChange={(e) => {
                setNewCode(e.target.value);
                setCodeError(false);
              }}
              onBlur={() => setNewCode((v) => v.trim().toUpperCase())}
              className="h-11 rounded-lg border border-slate-300 px-3 text-sm uppercase text-slate-900 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
            />
          </label>
          <label className="flex flex-1 flex-col gap-1 text-xs text-slate-500">
            {t('setup.dept.name')}
            <input
              type="text"
              value={newName}
              onChange={(e) => {
                setNewName(e.target.value);
                setCodeError(false);
              }}
              className="h-11 rounded-lg border border-slate-300 px-3 text-sm text-slate-900 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
            />
          </label>
          <Button type="button" variant="secondary" onClick={addDepartment}>
            {t('setup.add')}
          </Button>
        </div>
        {codeError ? <p className="text-sm text-danger-700">{t('setup.dept.code_invalid')}</p> : null}
      </section>

      <section className="flex flex-col gap-3">
        <h3 className="text-sm font-bold text-slate-900">{t('setup.positions')}</h3>
        <div className="flex flex-col gap-3">
          {positions.map((position, i) => {
            const users = npiUsersByRole[position.roleKey] ?? [];
            const holder = holders[i];
            return (
              <div
                key={`${position.roleKey}-${i}`}
                data-testid={`setup-position-${position.roleKey}`}
                className="flex flex-col gap-3 rounded-lg border border-slate-200 p-3"
              >
                <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:gap-3">
                  <label className="flex flex-1 flex-col gap-1 text-xs text-slate-500">
                    {t('setup.position.title')}
                    <input
                      type="text"
                      value={position.titleAr}
                      onChange={(e) => updatePosition(i, { titleAr: e.target.value })}
                      className="h-11 rounded-lg border border-slate-300 px-3 text-sm text-slate-900 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
                    />
                  </label>
                  <label className="flex flex-col gap-1 text-xs text-slate-500 sm:w-48">
                    {t('setup.position.department')}
                    <select
                      value={position.departmentCode ?? ''}
                      onChange={(e) => updatePosition(i, { departmentCode: e.target.value === '' ? null : e.target.value })}
                      className="h-11 rounded-lg border border-slate-300 px-3 text-sm text-slate-900 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
                    >
                      <option value="">{t('setup.position.no_department')}</option>
                      {departments.map((d) => (
                        <option key={d.code} value={d.code}>
                          {d.nameAr}
                        </option>
                      ))}
                    </select>
                  </label>
                  <Button
                    type="button"
                    variant="secondary"
                    size="sm"
                    disabled={positions.length <= 1}
                    onClick={() => removePosition(i)}
                  >
                    {t('setup.remove')}
                  </Button>
                </div>

                <div className="flex flex-col gap-1.5">
                  <p className="text-xs font-semibold text-slate-600">{t('setup.holders')}</p>
                  {users.length === 0 ? (
                    <p className="text-sm text-slate-500">{t('setup.holders.none')}</p>
                  ) : (
                    <div className="flex flex-wrap gap-3">
                      {users.map((user) => (
                        <label key={user.id} className="flex min-h-11 items-center gap-1.5 text-sm text-slate-800">
                          <input
                            type="checkbox"
                            checked={holder?.npiUserIds.includes(user.id) ?? false}
                            onChange={(e) => toggleHolder(i, user.id, e.target.checked)}
                            className="h-4 w-4 rounded border-slate-300 text-brand-600 focus-visible:ring-2 focus-visible:ring-brand-500"
                          />
                          {user.nameAr}
                        </label>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </div>
        <p className="text-sm text-slate-500">{t('setup.holders.note')}</p>
      </section>
    </div>
  );
}
