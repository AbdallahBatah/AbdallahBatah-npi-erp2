'use client';

/**
 * The permission grid of ADR-02 §3-6, shared by the two editors of the admin
 * screen: the role editor (a role's own keys) and the per-user override editor
 * (a user's effective keys). One row per sidebar screen from the shared screen
 * registry, in sidebar order, named as the sidebar names it, with view /
 * create-and-edit / approve cells taken from the catalogue's `screen` and
 * `action`; the special keys of a screen sit under its row, the rest in
 * «special permissions». Beside it, the sidebar preview drawn by
 * `visibleGroups` (the real sidebar's own rule, so the preview cannot drift
 * from it) and the separation-of-duties warning. Each editor owns its draft;
 * this file only draws it.
 */
import { useMemo, useState, type ReactNode } from 'react';
import {
  SCREEN_GROUPS,
  SCREENS,
  sodConflicts,
  visibleGroups,
  type Screen,
  type ScreenGroup,
  type SodConflict,
} from '@npi/shared';
import { useI18n } from '@/lib/i18n';
import { NAV_ITEMS } from '@/lib/nav';
import { Icon } from '@/components/icons';

export type PermAction = 'view' | 'write' | 'approve' | 'special';
/** One element of GET /admin/permissions. */
export interface PermMeta {
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
export const GRID_COLUMNS = ['view', 'write', 'approve'] as const;
export type GridColumn = (typeof GRID_COLUMNS)[number];
/** One row of the grid: one sidebar screen (ADR-02 §3-6). */
export interface GridRow {
  screen: Screen;
  /** A General screen: no view key, every user opens it. Shown as a fixed «everyone» row. */
  fixed: boolean;
  cells: Partial<Record<GridColumn, PermMeta>>;
  /** Special keys acted on this screen, listed as a line under the row. */
  specials: PermMeta[];
}
export interface GridGroup {
  group: ScreenGroup;
  rows: GridRow[];
}
/** The write / approve / special keys of a row: what turning its view off turns off in the role editor. */
export const rowDependents = (row: GridRow): string[] => [
  ...(row.cells.write ? [row.cells.write.key] : []),
  ...(row.cells.approve ? [row.cells.approve.key] : []),
  ...row.specials.map((p) => p.key),
];
/** Icon of each screen, the sidebar's own (lib/nav.ts). */
const NAV_ICON = new Map(NAV_ITEMS.map((i) => [i.href, i.icon]));

/**
 * The grid's layout from the catalogue: the screen registry's groups and
 * screens in sidebar order. Cells are the catalogue keys whose `screen` is the
 * row's href, by action; a cell with no key is empty. Special keys of a screen
 * sit under its row; those of no single screen (and any key whose screen the
 * registry lacks, so no key is ever hidden) go to the special-permissions
 * section.
 */
export function usePermissionGrid(catalog: PermMeta[]): { gridGroups: GridGroup[]; specials: PermMeta[] } {
  return useMemo(() => {
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
}

/**
 * The separation-of-duties pairs a draft holds, and whether the editor has
 * acknowledged them. The acknowledgement is kept as a signature of the pairs:
 * a pair added after ticking the box asks again.
 */
export function useSodAck(permissions: readonly string[]) {
  const conflicts = useMemo(() => sodConflicts(permissions), [permissions]);
  const sig = conflicts.map((c) => `${c.a}+${c.b}`).join('|');
  const [ackSig, setAckSig] = useState('');
  return {
    conflicts,
    acked: conflicts.length > 0 && ackSig === sig,
    setAcked: (on: boolean) => setAckSig(on ? sig : ''),
    reset: () => setAckSig(''),
  };
}

/**
 * The grid itself. `has` says whether a key is on in the editor's draft and
 * `onToggle` changes one key (the row is passed for a row's cell, so the
 * editor can apply its own row rule). `onToggleGroup` draws a group's heading
 * as a select-all box (the role editor); without it the heading is plain
 * text. `mark` adds content after a key's box — the override editor's
 * «added» / «withheld» tag and its back-to-the-role button.
 */
export function PermissionGrid({
  gridGroups,
  specials,
  has,
  onToggle,
  onToggleGroup,
  mark,
}: {
  gridGroups: GridGroup[];
  specials: PermMeta[];
  has: (key: string) => boolean;
  onToggle: (key: string, on: boolean, row?: GridRow) => void;
  onToggleGroup?: (keys: string[], on: boolean) => void;
  mark?: (key: string) => ReactNode;
}) {
  const { t, locale } = useI18n();
  const ar = locale === 'ar';
  /**
   * A write / approve / special cell is offered only while its screen's view
   * is on. One already held without the view (a role saved before this
   * editor, or by Madar) stays enabled so it can be cleared.
   */
  const cellDisabled = (row: GridRow, key: string) =>
    !row.fixed && !!row.cells.view && !has(row.cells.view.key) && !has(key);

  return (
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
            {onToggleGroup && groupKeys.length > 0 ? (
              <label className="mb-1.5 flex items-center gap-2 text-xs font-bold text-slate-500">
                <input
                  type="checkbox"
                  checked={groupKeys.every((k) => has(k))}
                  onChange={(e) => onToggleGroup(groupKeys, e.target.checked)}
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
                          <td key={c} className="py-1.5 text-center align-top">
                            {p ? (
                              <div className="flex flex-col items-center gap-0.5">
                                <input
                                  type="checkbox"
                                  aria-label={`${name} — ${t(`adm.role.grid.${c}`)}`}
                                  title={off ? t('adm.role.grid.needsView') : ar ? p.labelAr : p.labelEn}
                                  data-key={p.key}
                                  checked={has(p.key)}
                                  disabled={off}
                                  onChange={(e) => onToggle(p.key, e.target.checked, row)}
                                />
                                {mark?.(p.key)}
                              </div>
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
                                <span key={p.key} className="flex items-center gap-1.5">
                                  <label
                                    className={`flex items-center gap-1.5 ${off ? 'text-slate-400' : 'text-slate-600'}`}
                                    title={off ? t('adm.role.grid.needsView') : undefined}
                                  >
                                    <input
                                      type="checkbox"
                                      data-key={p.key}
                                      checked={has(p.key)}
                                      disabled={off}
                                      onChange={(e) => onToggle(p.key, e.target.checked, row)}
                                    />
                                    {ar ? p.labelAr : p.labelEn}
                                  </label>
                                  {mark?.(p.key)}
                                </span>
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
              <span key={p.key} className="flex items-center gap-1.5 rounded px-1.5 py-1 hover:bg-slate-50">
                <label className="flex items-center gap-2 text-xs text-slate-700">
                  <input
                    type="checkbox"
                    data-key={p.key}
                    checked={has(p.key)}
                    onChange={(e) => onToggle(p.key, e.target.checked)}
                  />
                  {ar ? p.labelAr : p.labelEn}
                </label>
                {mark?.(p.key)}
              </span>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * The sidebar as a holder of `permissions` would see it, drawn from the same
 * registry and by the same rule as the real one, with the «N of 24» count.
 */
export function SidebarPreview({
  permissions,
  hint,
  testId = 'role-preview',
}: {
  permissions: readonly string[];
  hint: string;
  /** Prefix of the title's id and of the count's and the groups' data-testid. */
  testId?: string;
}) {
  const { t, locale } = useI18n();
  const ar = locale === 'ar';
  const preview = useMemo(() => visibleGroups(permissions), [permissions]);
  const count = preview.reduce((n, g) => n + g.screens.length, 0);
  const titleId = `${testId}-title`;
  return (
    <aside aria-labelledby={titleId} className="min-w-0">
      <p id={titleId} className="mb-2 text-sm font-semibold text-slate-700">
        {t('adm.role.preview.title')}
      </p>
      <p className="mb-2 text-xs font-semibold text-brand-700" aria-live="polite" data-testid={`${testId}-count`}>
        {t('adm.role.preview.count').replace('{n}', String(count)).replace('{total}', String(SCREENS.length))}
      </p>
      <div className="max-h-[55vh] space-y-3 overflow-y-auto rounded-lg bg-gradient-to-b from-ink-900 to-ink-950 p-3 [scrollbar-width:thin]">
        {preview.map(({ group, screens }) => (
          <div key={group.key}>
            <p className="mb-1 px-1 text-[11px] font-bold text-slate-400">{ar ? group.labelAr : group.labelEn}</p>
            <ul className="space-y-0.5" data-testid={`${testId}-group`}>
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
      <p className="mt-1.5 text-[11px] leading-5 text-slate-500">{hint}</p>
    </aside>
  );
}

/** The separation-of-duties box: the pairs held, the editor's hint, and the acknowledgement. */
export function SodWarning({
  conflicts,
  acked,
  onAck,
  hint,
}: {
  conflicts: readonly SodConflict[];
  acked: boolean;
  onAck: (on: boolean) => void;
  hint: string;
}) {
  const { t, locale } = useI18n();
  const ar = locale === 'ar';
  if (conflicts.length === 0) return null;
  return (
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
      <p className="mt-2 text-xs leading-5 text-warning-800">{hint}</p>
      <label className="mt-2 flex items-center gap-2 text-sm font-semibold text-warning-900">
        <input type="checkbox" checked={acked} onChange={(e) => onAck(e.target.checked)} />
        {t('adm.role.sod.ack')}
      </label>
    </div>
  );
}
