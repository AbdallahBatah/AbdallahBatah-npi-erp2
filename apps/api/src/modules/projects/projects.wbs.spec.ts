/**
 * Package 4 · P4-1 (ADR-04 §4-1) — a project opened from a lump-sum budget gets
 * one WBS element per budget line, in the work-item list order, at the cost
 * the general manager approved.
 */
import { wbsPerBudgetLine } from './projects.service';

const wi = (code: string, sortOrder: number, uom = 'kW') => ({
  id: `w-${code}`,
  code,
  nameAr: `بند ${code}`,
  nameEn: `Item ${code}`,
  uom,
  sortOrder,
});

describe('wbsPerBudgetLine', () => {
  it('orders by the work-item list, budgets at qty × the recorded cost, keeps qty and unit', () => {
    const out = wbsPerBudgetLine([
      { qty: '300', unitCost: '55', uom: null, description: null, item: null, workItem: wi('WI-05', 5) },
      { qty: '546', unitCost: '410.5', uom: null, description: 'ألواح 655 واط', item: { nameAr: 'لوح', nameEn: 'Panel', uom: 'panel' }, workItem: wi('WI-01', 1, 'panel') },
    ]);
    expect(out.map((e) => e.code)).toEqual(['WI-01', 'WI-05']);
    expect(out[0]).toMatchObject({ nameAr: 'ألواح 655 واط', workItemId: 'w-WI-01', qty: 546, uom: 'panel', budgetAmount: 224133 });
    expect(out[1]).toMatchObject({ nameAr: 'بند WI-05', qty: 300, uom: 'kW', budgetAmount: 16500 });
  });

  it('a work item used twice gets -2 on its second code (codes are unique per project)', () => {
    const out = wbsPerBudgetLine([
      { qty: 1, unitCost: 10, uom: null, description: 'أ', item: null, workItem: wi('WI-07', 7) },
      { qty: 2, unitCost: 10, uom: null, description: 'ب', item: null, workItem: wi('WI-07', 7) },
    ]);
    expect(out.map((e) => e.code)).toEqual(['WI-07', 'WI-07-2']);
  });

  it('a line without a work item (an old stock-item line) still gets an element', () => {
    const out = wbsPerBudgetLine([
      { qty: 4, unitCost: 22000, uom: null, description: null, item: { nameAr: 'عاكس', nameEn: 'Inverter', uom: 'unit' }, workItem: null },
    ]);
    expect(out[0]).toMatchObject({ code: 'L01', nameAr: 'عاكس', workItemId: null, uom: 'unit', budgetAmount: 88000 });
  });
});
