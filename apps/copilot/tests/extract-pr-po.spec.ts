// T-24: purchase requisition from a sentence (F-06) and purchase order from a
// vendor quote (F-07) — schemas, assessment, DTO builders, runner, resolution.
import type { LlmContext } from '../src/llm/client';
import type { ModelResponse, RedactedRequest } from '../src/llm/provider';
import { Pseudonymizer } from '../src/privacy/pseudonymizer';
import { loadPrompt } from '../src/prompts/load';
import {
  FLOWS,
  runExtraction,
  todayIso,
  type ExtractDeps,
  type ExtractFailure,
  type ExtractionResult,
} from '../src/extract/run';
import {
  assessPr,
  PrOutputSchema,
  requisitionDtoFrom,
  type PrLineOutput,
  type PrOutput,
  type PrResolution,
  type PrValues,
} from '../src/extract/schemas/pr';
import {
  assessPo,
  convertToPoDtoFrom,
  poDtoFrom,
  PoOutputSchema,
  vendorDtoFrom,
  type PoLineOutput,
  type PoOutput,
  type PoResolution,
  type PoValues,
  type VendorOutput,
  type VendorValues,
} from '../src/extract/schemas/po';
import { flattenFields } from '../src/extract/run';
import {
  departmentsFromNpi,
  itemsFromNpi,
  requisitionsFromNpi,
  resolveDepartment,
  resolveRequisition,
  resolveWbs,
  wbsFromProject,
} from '../src/extract/resolve';
import { ar } from '../src/i18n/ar';

// ─── helpers ────────────────────────────────────────────────────────────────

const ctx: LlmContext = { npiOrgId: 'org-1', npiUserId: 'user-1' };

/** A wire field as the model returns it: every member present, «» for absent. */
type W = { value: string; confidence: number; evidence: string; page: number };
const f = (value: string | number | null, confidence = 1, evidence: string | null = 'q', page: number | null = 1): W => ({
  value: value === null ? '' : String(value),
  confidence,
  evidence: evidence ?? '',
  page: page ?? 0,
});
const none = (): W => ({ value: '', confidence: 0, evidence: '', page: 0 });

const TODAY = '2026-10-05'; // a Monday
const FLAGS = { ligatureSuspect: false, referenceDate: TODAY };

// ── PR (F-06) ──

function prLine(overrides: Partial<PrLineOutput> = {}): PrLineOutput {
  return {
    itemName: f('لوح 550 واط'),
    sku: none(),
    qty: f(40),
    unit: none(),
    estimatedUnitPrice: none(),
    wbsCode: none(),
    wbsName: none(),
    notes: none(),
    ...overrides,
  };
}

/** «أبي 40 لوح 550 واط للمشروع PRJ-00012 قبل الخميس» as the model reads it. */
function prOutput(overrides: Partial<PrOutput> = {}): PrOutput {
  return {
    justification: f('استكمال أعمال التركيب في المشروع', 0.9),
    projectCode: f('PRJ-00012'),
    projectName: none(),
    departmentName: none(),
    neededBy: f('2026-10-08', 0.9),
    currency: none(),
    lines: [prLine()],
    ...overrides,
  };
}

// ── PO (F-07) ──

function poLine(overrides: Partial<PoLineOutput> = {}): PoLineOutput {
  return {
    itemName: f('لوح شمسي 550 واط'),
    sku: f('MOD-550'),
    qty: f(40),
    unit: f('قطعة'),
    unitPrice: f(320),
    lineTotal: f(12800),
    wbsCode: none(),
    wbsName: none(),
    ...overrides,
  };
}

function vendorOutput(overrides: Partial<VendorOutput> = {}): VendorOutput {
  return {
    nameAr: f('شركة الخليج للألواح الشمسية'),
    nameEn: f('Gulf Solar Panels Co.'),
    vendorType: f('SUPPLIER'),
    vatNumber: f('311111111111113'),
    crNumber: f('1010111222'),
    phone: f('+966501111111'),
    email: f('sales@gulfsolar.sa'),
    ...overrides,
  };
}

/** Quote Q-2026-117: three lines, 21,460 + 3,219 VAT = 24,679. */
function poOutput(overrides: Partial<PoOutput> = {}, vendor: Partial<VendorOutput> = {}): PoOutput {
  return {
    vendor: vendorOutput(vendor),
    quoteRef: f('Q-2026-117'),
    quoteDate: f('2026-10-01'),
    validUntil: f('2026-10-31'),
    sourceRequisitionCode: f('PR-00012'),
    projectCode: f('PRJ-00012'),
    projectName: f('محطة الرياض الشمسية'),
    currency: none(),
    subtotal: f(21460),
    vatAmount: f(3219),
    total: f(24679),
    lines: [
      poLine(),
      poLine({ itemName: f('عاكس 50 كيلوواط'), sku: f('INV-50K'), qty: f(1), unitPrice: f(6500), lineTotal: f(6500) }),
      poLine({ itemName: f('قضيب تثبيت'), sku: f('MNT-RAIL'), qty: f(120), unit: f('متر'), unitPrice: f(18), lineTotal: f(2160) }),
    ],
    ...overrides,
  };
}

// ── runner plumbing ──

class FakeLlm {
  requests: RedactedRequest[] = [];
  constructor(private impl: (req: RedactedRequest) => ModelResponse | Promise<ModelResponse>) {}
  async complete(req: RedactedRequest, _ctx: LlmContext): Promise<ModelResponse> {
    this.requests.push(req);
    return this.impl(req);
  }
}

function reply(text: string, overrides: Partial<ModelResponse> = {}): ModelResponse {
  return { text, toolCalls: [], stopReason: 'end_turn', tokensIn: 100, tokensOut: 50, modelId: 'claude-sonnet-5', ...overrides };
}

function depsWith(llm: FakeLlm, pseudonymizer = new Pseudonymizer([])): ExtractDeps {
  return { llm, pseudonymizer };
}

function outboundText(req: RedactedRequest): string {
  const content = req.messages[0].content;
  return typeof content === 'string' ? content : JSON.stringify(content);
}

async function okRun<K extends 'pr' | 'po'>(result: ExtractionResult | ExtractFailure): Promise<ExtractionResult<K>> {
  if (!result.ok) throw new Error(`expected ok, got ${result.reason}: ${result.detail}`);
  return result as ExtractionResult<K>;
}

const SENTENCE = 'أبي 40 لوح 550 واط للمشروع PRJ-00012 قبل الخميس';

const QUOTE_TEXT = `عرض سعر رقم Q-2026-117 بتاريخ 2026-10-01
من: شركة الخليج للألواح الشمسية، الرقم الضريبي 311111111111113، السجل التجاري 1010111222.
إلى: شركة NPI للطاقة الشمسية.
بالإشارة إلى طلب الشراء رقم PR-00012 للمشروع PRJ-00012.
لوح شمسي 550 واط (MOD-550) 40 قطعة × 320 ريال = 12,800 ريال
المجموع قبل الضريبة: 12,800 ريال، ضريبة القيمة المضافة 15%: 1,920 ريال، الإجمالي: 14,720 ريال.`;

// ─── schemas ────────────────────────────────────────────────────────────────

describe.each([
  ['pr', FLOWS.pr, 'PRJ-00012'],
  ['po', FLOWS.po, 'PR-00012'],
] as const)('%s model-facing schema', (name, spec, code) => {
  const schema = spec.jsonSchema;
  const text = JSON.stringify(schema);

  it('is registered with its prompt file and audit purpose', () => {
    expect(spec.flow).toBe(name);
    expect(spec.promptFile).toBe(`extract/${name}.md`);
    expect(spec.purpose).toBe(`extract_${name}`);
  });

  it('carries no keyword structured output rejects, no unions, and every object is strict', () => {
    for (const keyword of ['"minimum"', '"maximum"', '"pattern"', '"minLength"', '"maxLength"', '"multipleOf"', '"anyOf"', '"oneOf"', '"null"']) {
      expect(text).not.toContain(keyword);
    }
    const walk = (node: unknown) => {
      if (Array.isArray(node)) return node.forEach(walk);
      if (typeof node !== 'object' || node === null) return;
      const obj = node as Record<string, unknown>;
      if (obj.type === 'object') {
        expect(obj.additionalProperties).toBe(false);
        expect(Object.keys(obj.properties as object).sort()).toEqual([...(obj.required as string[])].sort());
      }
      Object.values(obj).forEach(walk);
    };
    walk(schema);
  });

  it('hoists the repeated field shape into $defs', () => {
    const defs = (schema as { $defs?: Record<string, { properties: Record<string, unknown> }> }).$defs;
    expect(defs).toBeDefined();
    const shapes = Object.values(defs!);
    expect(shapes.length).toBeGreaterThanOrEqual(1);
    expect(shapes.some((s) => ['value', 'confidence', 'evidence', 'page'].every((k) => k in s.properties))).toBe(true);
  });

  it('describes the date format and an example code the model must follow', () => {
    expect(text).toContain('YYYY-MM-DD');
    expect(text).toContain(code);
  });
});

describe('po schema enum description', () => {
  it('names the vendor types', () => {
    expect(JSON.stringify(FLOWS.po.jsonSchema)).toContain('SUPPLIER | SUBCONTRACTOR | OEM | SERVICE');
  });
});

describe('PrOutputSchema / PoOutputSchema', () => {
  it('accept a complete output and reject a missing lines array', () => {
    expect(PrOutputSchema.safeParse(prOutput()).success).toBe(true);
    const brokenPr = prOutput() as unknown as Record<string, unknown>;
    delete brokenPr.lines;
    expect(PrOutputSchema.safeParse(brokenPr).success).toBe(false);

    expect(PoOutputSchema.safeParse(poOutput()).success).toBe(true);
    const brokenPo = poOutput() as unknown as Record<string, unknown>;
    delete brokenPo.lines;
    expect(PoOutputSchema.safeParse(brokenPo).success).toBe(false);
  });

  it('reject a line with a missing member and a vendor with a missing member', () => {
    const line = prLine() as unknown as Record<string, unknown>;
    delete line.qty;
    expect(PrOutputSchema.safeParse(prOutput({ lines: [line as unknown as PrLineOutput] })).success).toBe(false);

    const vendor = vendorOutput() as unknown as Record<string, unknown>;
    delete vendor.vatNumber;
    expect(PoOutputSchema.safeParse({ ...poOutput(), vendor }).success).toBe(false);
  });
});

describe('prompt templates', () => {
  it('each carries {{today}} exactly once; the PO prompt also takes the firm hint', () => {
    const count = (text: string, token: string) => text.split(token).length - 1;
    expect(count(loadPrompt('extract/pr.md'), '{{today}}')).toBe(1);
    const po = loadPrompt('extract/po.md');
    expect(count(po, '{{today}}')).toBe(1);
    expect(po).toContain('{{our_party_hint}}');
  });
});

// ─── assessPr ───────────────────────────────────────────────────────────────

describe('assessPr', () => {
  it('confirms every stated field of a clean sentence and yields plain values', () => {
    const { assessed, values } = assessPr(prOutput(), FLAGS);
    expect(assessed.justification.status).toBe('confirmed');
    expect(assessed.projectCode.status).toBe('confirmed');
    expect(assessed.neededBy.status).toBe('confirmed');
    expect(assessed.lines[0].itemName.status).toBe('confirmed');
    expect(assessed.lines[0].qty.status).toBe('confirmed');

    // Only what the sentence did not state is unconfirmed, and only as «missing».
    const leaves = Object.values(flattenFields(assessed));
    const unconfirmed = leaves.filter((l) => l.status === 'unconfirmed');
    expect(unconfirmed.length).toBeGreaterThan(0);
    expect(unconfirmed.every((l) => l.warnings.length === 1 && l.warnings[0] === 'extract.warn.missing')).toBe(true);

    expect(values).toEqual({
      justification: 'استكمال أعمال التركيب في المشروع',
      projectCode: 'PRJ-00012',
      projectName: null,
      departmentName: null,
      neededBy: '2026-10-08',
      currency: null,
      lines: [{ itemName: 'لوح 550 واط', sku: null, qty: 40, unit: null, estimatedUnitPrice: null, wbsCode: null, wbsName: null, notes: null }],
    });
  });

  it('reads Arabic-Indic digits, lowercases in and uppercases out the SKU, and keeps stated optional fields', () => {
    const { assessed, values } = assessPr(
      prOutput({
        departmentName: f('التنفيذ'),
        projectName: f('محطة الدمام'),
        lines: [prLine({ qty: f('٢٠٠'), sku: f('mod-550'), unit: f('متر'), estimatedUnitPrice: f('١٨'), notes: f('اللون أحمر'), wbsCode: f('WBS-02'), wbsName: f('الأعمال الكهربائية') })],
      }),
      FLAGS,
    );
    expect(assessed.lines[0].qty.value).toBe(200);
    expect(assessed.lines[0].sku.value).toBe('MOD-550');
    expect(assessed.lines[0].wbsCode.warnings).toEqual([]);
    expect(assessed.lines[0].wbsCode.status).toBe('confirmed');
    expect(values!.departmentName).toBe('التنفيذ');
    expect(values!.lines[0]).toEqual({ itemName: 'لوح 550 واط', sku: 'MOD-550', qty: 200, unit: 'متر', estimatedUnitPrice: 18, wbsCode: 'WBS-02', wbsName: 'الأعمال الكهربائية', notes: 'اللون أحمر' });
  });

  it.each([['0'], ['-3'], ['abc'], ['1.2345']])('flags quantity «%s» and drops the only line, so values are null', (qty) => {
    const { assessed, values } = assessPr(prOutput({ lines: [prLine({ qty: f(qty) })] }), FLAGS);
    expect(assessed.lines[0].qty.warnings).toEqual(['extract.warn.quantity']);
    expect(assessed.lines[0].qty.status).toBe('unconfirmed');
    expect(assessed.lines).toHaveLength(1);
    expect(values).toBeNull();
  });

  it('accepts up to three decimals', () => {
    const { assessed, values } = assessPr(prOutput({ lines: [prLine({ qty: f('2.5'), unit: f('طن') })] }), FLAGS);
    expect(assessed.lines[0].qty.warnings).toEqual([]);
    expect(values!.lines[0].qty).toBe(2.5);
  });

  it('drops only the unusable lines and keeps the order of the rest', () => {
    const { assessed, values } = assessPr(
      prOutput({
        lines: [
          prLine({ itemName: f('عاكس 50 كيلوواط'), qty: f(3) }),
          prLine({ itemName: f('كابل DC 6مم'), qty: f(0) }),
          prLine({ itemName: none(), qty: f(5) }),
          prLine({ itemName: f('قضيب تثبيت'), qty: f(100), unit: f('متر') }),
        ],
      }),
      FLAGS,
    );
    expect(assessed.lines).toHaveLength(4);
    expect(assessed.lines[2].itemName.warnings).toEqual(['extract.warn.missing']);
    expect(values!.lines.map((l) => l.itemName)).toEqual(['عاكس 50 كيلوواط', 'قضيب تثبيت']);
    expect(values!.lines.map((l) => l.qty)).toEqual([3, 100]);
  });

  it('values are null when the sentence yielded no lines at all', () => {
    expect(assessPr(prOutput({ lines: [] }), FLAGS).values).toBeNull();
  });

  it('treats a justification shorter than 3 characters as absent', () => {
    const { assessed, values } = assessPr(prOutput({ justification: f('ص') }), FLAGS);
    expect(assessed.justification.value).toBeNull();
    expect(assessed.justification.warnings).toEqual(['extract.warn.missing']);
    expect(assessed.justification.status).toBe('unconfirmed');
    // The lines are usable, so the card still has values; justification is what the user must add.
    expect(values).not.toBeNull();
    expect(values!.justification).toBeNull();
  });

  it('keeps a composed justification (confidence 0.6) as a value but unconfirmed', () => {
    const composed = 'توريد 40 لوح 550 واط لمشروع PRJ-00012';
    const { assessed, values } = assessPr(prOutput({ justification: f(composed, 0.6) }), FLAGS);
    expect(assessed.justification.value).toBe(composed);
    expect(assessed.justification.warnings).toEqual(['extract.warn.low_confidence']);
    expect(assessed.justification.status).toBe('unconfirmed');
    expect(values!.justification).toBe(composed);
  });

  it('flags a needed-by date before the reference date and keeps the value', () => {
    const { assessed, values } = assessPr(prOutput({ neededBy: f('2026-09-01') }), FLAGS);
    expect(assessed.neededBy.warnings).toEqual(['extract.warn.date_past']);
    expect(assessed.neededBy.status).toBe('unconfirmed');
    expect(assessed.neededBy.value).toBe('2026-09-01');
    expect(values!.neededBy).toBe('2026-09-01');
  });

  it('does not flag today or a later date, nor any date when no reference date is given', () => {
    expect(assessPr(prOutput({ neededBy: f(TODAY) }), FLAGS).assessed.neededBy.warnings).toEqual([]);
    expect(assessPr(prOutput({ neededBy: f('2026-10-06') }), FLAGS).assessed.neededBy.status).toBe('confirmed');
    expect(assessPr(prOutput({ neededBy: f('2020-01-01') })).assessed.neededBy.warnings).toEqual([]);
  });

  it('flags an unreadable date as date_format, not date_past', () => {
    const { assessed } = assessPr(prOutput({ neededBy: f('قبل الخميس') }), FLAGS);
    expect(assessed.neededBy.warnings).toEqual(['extract.warn.date_format']);
    expect(assessed.neededBy.value).toBeNull();
  });

  it('accepts a three-letter currency in any case and refuses a word', () => {
    const usd = assessPr(prOutput({ currency: f('usd') }), FLAGS);
    expect(usd.assessed.currency.value).toBe('USD');
    expect(usd.assessed.currency.status).toBe('confirmed');
    expect(usd.values!.currency).toBe('USD');

    const word = assessPr(prOutput({ currency: f('دولار') }), FLAGS);
    expect(word.assessed.currency.value).toBeNull();
    expect(word.assessed.currency.warnings).toEqual(['extract.warn.currency']);
    expect(word.values!.currency).toBeNull();
  });

  it('validates document codes by shape but keeps what was written', () => {
    const ok = assessPr(prOutput({ projectCode: f('PRJ-00012') }), FLAGS);
    expect(ok.assessed.projectCode.warnings).toEqual([]);
    expect(ok.assessed.projectCode.status).toBe('confirmed');

    const arabicDigits = assessPr(prOutput({ projectCode: f('prj-٠٠٠١٢') }), FLAGS);
    expect(arabicDigits.assessed.projectCode.value).toBe('PRJ-00012');
    expect(arabicDigits.assessed.projectCode.warnings).toEqual([]);

    const off = assessPr(prOutput({ projectCode: f('مشروع الرياض') }), FLAGS);
    expect(off.assessed.projectCode.warnings).toEqual(['extract.warn.code_format']);
    expect(off.assessed.projectCode.status).toBe('unconfirmed');
    expect(off.assessed.projectCode.value).toBe('مشروع الرياض');
    expect(off.values!.projectCode).toBe('مشروع الرياض');

    const wbs = assessPr(prOutput({ lines: [prLine({ wbsCode: f('البند الأول') })] }), FLAGS);
    expect(wbs.assessed.lines[0].wbsCode.warnings).toEqual(['extract.warn.code_format']);
  });

  it('flags a negative estimated price and never stores an altered placeholder', () => {
    const price = assessPr(prOutput({ lines: [prLine({ estimatedUnitPrice: f(-18) })] }), FLAGS);
    expect(price.assessed.lines[0].estimatedUnitPrice.warnings).toContain('extract.warn.amount');

    const name = assessPr(prOutput({ projectName: f('⟦جهة_9⟧ الشمسية') }), FLAGS);
    expect(name.assessed.projectName.warnings).toEqual(['extract.warn.placeholder']);
    expect(name.assessed.projectName.status).toBe('unconfirmed');
  });
});

// ─── requisitionDtoFrom ─────────────────────────────────────────────────────

describe('requisitionDtoFrom', () => {
  const twoLines = assessPr(
    prOutput({
      departmentName: f('التنفيذ'),
      lines: [
        prLine({ itemName: f('لوح شمسي 550 واط'), sku: f('MOD-550'), qty: f(40), estimatedUnitPrice: f(300) }),
        prLine({ itemName: f('كابل DC 6مم'), sku: f('CAB-DC6'), qty: f(200), unit: f('متر'), notes: f('اللون أحمر') }),
      ],
    }),
    FLAGS,
  ).values as PrValues;
  const resolved = (overrides: Partial<PrResolution> = {}): PrResolution => ({
    projectId: 'prj-1',
    departmentId: 'dep-1',
    lines: [
      { itemId: 'item-1', wbsElementId: null, estimatedUnitPrice: null },
      { itemId: 'item-2', wbsElementId: null, estimatedUnitPrice: null },
    ],
    ...overrides,
  });

  it('builds CreateRequisitionDto with the resolved ids and no undefined members', () => {
    const dto = requisitionDtoFrom(twoLines, resolved()) as Record<string, unknown>;
    expect(dto).toEqual({
      justification: 'استكمال أعمال التركيب في المشروع',
      projectId: 'prj-1',
      departmentId: 'dep-1',
      neededBy: '2026-10-08',
      lines: [
        { itemId: 'item-1', qty: 40, estimatedUnitPrice: 300 },
        { itemId: 'item-2', qty: 200, notes: 'اللون أحمر' },
      ],
    });
    expect(Object.keys(dto).sort()).toEqual(['departmentId', 'justification', 'lines', 'neededBy', 'projectId']);
    const lines = dto.lines as Record<string, unknown>[];
    expect(Object.keys(lines[0]).sort()).toEqual(['estimatedUnitPrice', 'itemId', 'qty']);
    expect(Object.keys(lines[1]).sort()).toEqual(['itemId', 'notes', 'qty']);
    expect(lines[1].notes).toBe('اللون أحمر');
  });

  it('omits projectId, departmentId, neededBy and currency when null', () => {
    const bare: PrValues = { ...twoLines, projectCode: null, neededBy: null, currency: null, departmentName: null };
    const dto = requisitionDtoFrom(bare, resolved({ projectId: null, departmentId: null })) as Record<string, unknown>;
    expect(Object.keys(dto).sort()).toEqual(['justification', 'lines']);
  });

  it('carries the currency in upper case', () => {
    const dto = requisitionDtoFrom({ ...twoLines, currency: 'usd' }, resolved()) as Record<string, unknown>;
    expect(dto.currency).toBe('USD');
  });

  it('prefers the estimated price from the resolved item, rounds to 2 decimals, and falls back to the extracted one', () => {
    const dto = requisitionDtoFrom(
      twoLines,
      resolved({
        lines: [
          { itemId: 'item-1', wbsElementId: null, estimatedUnitPrice: 320.456 },
          { itemId: 'item-2', wbsElementId: null, estimatedUnitPrice: 3.8 },
        ],
      }),
    ) as { lines: Record<string, unknown>[] };
    expect(dto.lines[0].estimatedUnitPrice).toBe(320.46);
    expect(dto.lines[1].estimatedUnitPrice).toBe(3.8);

    const fallback = requisitionDtoFrom({ ...twoLines, lines: [{ ...twoLines.lines[0], estimatedUnitPrice: 17.999 }, twoLines.lines[1]] }, resolved()) as { lines: Record<string, unknown>[] };
    expect(fallback.lines[0].estimatedUnitPrice).toBe(18);
    expect('estimatedUnitPrice' in fallback.lines[1]).toBe(false);
  });

  it('slices notes to 500 characters and sets wbsElementId only when resolved', () => {
    const long: PrValues = { ...twoLines, lines: [{ ...twoLines.lines[0], notes: 'ا'.repeat(600) }, twoLines.lines[1]] };
    const dto = requisitionDtoFrom(
      long,
      resolved({
        lines: [
          { itemId: 'item-1', wbsElementId: 'wbs-9', estimatedUnitPrice: null },
          { itemId: 'item-2', wbsElementId: null, estimatedUnitPrice: null },
        ],
      }),
    ) as { lines: Record<string, unknown>[] };
    expect((dto.lines[0].notes as string).length).toBe(500);
    expect(dto.lines[0].wbsElementId).toBe('wbs-9');
    expect('wbsElementId' in dto.lines[1]).toBe(false);
  });

  it('truncates the justification to 1000 and accepts an override from the user', () => {
    const dto = requisitionDtoFrom(twoLines, resolved(), 'س'.repeat(1200)) as Record<string, unknown>;
    expect((dto.justification as string).length).toBe(1000);
    const edited = requisitionDtoFrom({ ...twoLines, justification: null }, resolved(), 'تعويض ألواح متضررة') as Record<string, unknown>;
    expect(edited.justification).toBe('تعويض ألواح متضررة');
  });

  it('throws without a justification NPI would accept', () => {
    expect(() => requisitionDtoFrom({ ...twoLines, justification: null }, resolved())).toThrow('requisitionDtoFrom: justification is required by NPI');
    expect(() => requisitionDtoFrom(twoLines, resolved(), null)).toThrow('requisitionDtoFrom: justification is required by NPI');
    expect(() => requisitionDtoFrom(twoLines, resolved(), 'ab')).toThrow('requisitionDtoFrom: justification is required by NPI');
  });

  it('throws when the resolution is not aligned with the lines', () => {
    expect(() => requisitionDtoFrom(twoLines, resolved({ lines: [{ itemId: 'item-1', wbsElementId: null, estimatedUnitPrice: null }] }))).toThrow();
    expect(() => requisitionDtoFrom(twoLines, resolved({ lines: [] }))).toThrow();
  });
});

// ─── assessPo ───────────────────────────────────────────────────────────────

describe('assessPo', () => {
  it('confirms every stated field of a clean quote and yields plain values', () => {
    const { assessed, values } = assessPo(poOutput(), FLAGS);
    const leaves = Object.values(flattenFields(assessed));
    const unconfirmed = leaves.filter((l) => l.status === 'unconfirmed');
    expect(unconfirmed.length).toBeGreaterThan(0);
    expect(unconfirmed.every((l) => l.warnings.length === 1 && l.warnings[0] === 'extract.warn.missing')).toBe(true);
    expect(assessed.vendor.vatNumber.status).toBe('confirmed');
    expect(assessed.subtotal.status).toBe('confirmed');
    expect(assessed.total.status).toBe('confirmed');
    expect(assessed.lines.every((l) => l.unitPrice.status === 'confirmed' && l.lineTotal.status === 'confirmed')).toBe(true);

    expect(values).not.toBeNull();
    expect(values!.vendor).toEqual({
      nameAr: 'شركة الخليج للألواح الشمسية',
      nameEn: 'Gulf Solar Panels Co.',
      vendorType: 'SUPPLIER',
      vatNumber: '311111111111113',
      crNumber: '1010111222',
      phone: '+966501111111',
      email: 'sales@gulfsolar.sa',
    });
    expect(values).toMatchObject({ quoteRef: 'Q-2026-117', quoteDate: '2026-10-01', validUntil: '2026-10-31', sourceRequisitionCode: 'PR-00012', projectCode: 'PRJ-00012', currency: null, subtotal: 21460, vatAmount: 3219, total: 24679 });
    expect(values!.lines.map((l) => [l.itemName, l.sku, l.qty, l.unit, l.unitPrice, l.lineTotal])).toEqual([
      ['لوح شمسي 550 واط', 'MOD-550', 40, 'قطعة', 320, 12800],
      ['عاكس 50 كيلوواط', 'INV-50K', 1, 'قطعة', 6500, 6500],
      ['قضيب تثبيت', 'MNT-RAIL', 120, 'متر', 18, 2160],
    ]);
  });

  it('reads a quote written in Arabic-Indic digits', () => {
    const { assessed, values } = assessPo(
      poOutput(
        {
          subtotal: f('٣٬٥٠٠'),
          vatAmount: f('٥٢٥'),
          total: f('٤٬٠٢٥'),
          sourceRequisitionCode: none(),
          projectCode: none(),
          projectName: none(),
          lines: [
            poLine({ itemName: f('كابل DC 6مم'), sku: f('CAB-DC6'), qty: f('٢٠٠'), unit: f('متر'), unitPrice: f('٤'), lineTotal: f('٨٠٠') }),
            poLine({ itemName: f('طقم مكونات مساعدة'), sku: f('BOS-KIT'), qty: f('٣'), unit: f('طقم'), unitPrice: f('٩٠٠'), lineTotal: f('٢٬٧٠٠') }),
          ],
        },
        { nameAr: f('مؤسسة النور للكابلات'), nameEn: none(), vatNumber: f('٣٠٠٩٨٧٦٥٤٣٠٠٠٠٣'), crNumber: f('٤٠٣٠١٢٣٤٥٦') },
      ),
      FLAGS,
    );
    expect(assessed.vendor.vatNumber.value).toBe('300987654300003');
    expect(assessed.vendor.vatNumber.status).toBe('confirmed');
    expect(assessed.vendor.crNumber.value).toBe('4030123456');
    expect(values!.subtotal).toBe(3500);
    expect(values!.total).toBe(4025);
    expect(values!.lines.map((l) => l.lineTotal)).toEqual([800, 2700]);
    expect(assessed.subtotal.warnings).toEqual([]);
    expect(assessed.total.warnings).toEqual([]);
  });

  it('derives a missing unit price from the line total and leaves it unconfirmed', () => {
    const out = poOutput();
    out.lines[0] = poLine({ qty: f(40, 0.95), unitPrice: none(), lineTotal: f(12800, 0.9) });
    const { assessed, values } = assessPo(out, FLAGS);
    const price = assessed.lines[0].unitPrice;
    expect(price.value).toBe(320);
    expect(price.warnings).toEqual(['extract.warn.derived']);
    expect(price.status).toBe('unconfirmed');
    expect(price.confidence).toBe(0.9);
    expect(values!.lines[0].unitPrice).toBe(320);
    // The derived price still adds up, so the totals stay confirmed.
    expect(assessed.subtotal.status).toBe('confirmed');
    expect(assessed.lines[1].unitPrice.status).toBe('confirmed');
  });

  it('rounds a derived unit price to 2 decimals', () => {
    const { assessed } = assessPo(
      poOutput({ subtotal: none(), vatAmount: none(), total: none(), lines: [poLine({ qty: f(3), unitPrice: none(), lineTotal: f(1000) })] }),
      FLAGS,
    );
    expect(assessed.lines[0].unitPrice.value).toBe(333.33);
    expect(assessed.lines[0].unitPrice.warnings).toEqual(['extract.warn.derived']);
    expect(assessed.lines[0].lineTotal.warnings).toEqual([]);
  });

  it('flags qty × price ≠ line total on both fields, and only on that line', () => {
    const out = poOutput();
    out.lines[0].lineTotal = f(12000);
    const { assessed } = assessPo(out, FLAGS);
    expect(assessed.lines[0].lineTotal.warnings).toContain('extract.warn.line_total');
    expect(assessed.lines[0].unitPrice.warnings).toContain('extract.warn.line_total');
    expect(assessed.lines[0].lineTotal.status).toBe('unconfirmed');
    expect(assessed.lines[0].unitPrice.status).toBe('unconfirmed');
    expect(assessed.lines[1].unitPrice.warnings).toEqual([]);
    expect(assessed.lines[1].lineTotal.warnings).toEqual([]);
    // The quantities and prices still add up to the subtotal.
    expect(assessed.subtotal.warnings).toEqual([]);
  });

  it('tolerates rounding noise in a line total', () => {
    const out = poOutput();
    out.lines[0].lineTotal = f(12801);
    const { assessed } = assessPo(out, FLAGS);
    expect(assessed.lines[0].lineTotal.warnings).toEqual([]);
    expect(assessed.lines[0].unitPrice.warnings).toEqual([]);
  });

  it('flags a subtotal the lines do not add up to, on the subtotal and every unit price', () => {
    // 25,000 + 3,750 = 28,750: the VAT arithmetic is consistent, only the lines disagree.
    const { assessed } = assessPo(poOutput({ subtotal: f(25000), vatAmount: f(3750), total: f(28750) }), FLAGS);
    expect(assessed.subtotal.warnings).toContain('extract.warn.lines_sum');
    expect(assessed.subtotal.status).toBe('unconfirmed');
    expect(assessed.lines.every((l) => l.unitPrice.warnings.includes('extract.warn.lines_sum'))).toBe(true);
    expect(assessed.total.warnings).toEqual([]);
    expect(assessed.vatAmount.warnings).toEqual([]);
    // Line totals are consistent with qty × price on their own.
    expect(assessed.lines.every((l) => l.lineTotal.warnings.length === 0)).toBe(true);
  });

  it('skips the sum check when a usable line has no unit price at all', () => {
    const out = poOutput({ subtotal: f(25000), vatAmount: f(3750), total: f(28750) });
    out.lines[2] = poLine({ itemName: f('قضيب تثبيت'), qty: f(120), unitPrice: none(), lineTotal: none() });
    const { assessed, values } = assessPo(out, FLAGS);
    expect(assessed.subtotal.warnings).toEqual([]);
    expect(assessed.lines.some((l) => l.unitPrice.warnings.includes('extract.warn.lines_sum'))).toBe(false);
    expect(values!.lines[2].unitPrice).toBeNull();
  });

  it('flags a total that is not subtotal + VAT, on the total and the stated VAT', () => {
    const { assessed } = assessPo(poOutput({ total: f(26000) }), FLAGS);
    expect(assessed.total.warnings).toContain('extract.warn.vat_total');
    expect(assessed.total.status).toBe('unconfirmed');
    expect(assessed.vatAmount.warnings).toContain('extract.warn.vat_total');
    expect(assessed.subtotal.warnings).toEqual([]);
  });

  it('computes the expected VAT at 15 % when the quote states none', () => {
    const ok = assessPo(poOutput({ vatAmount: none() }), FLAGS);
    expect(ok.assessed.total.warnings).toEqual([]);
    expect(ok.assessed.total.status).toBe('confirmed');

    const bad = assessPo(poOutput({ vatAmount: none(), total: f(26000) }), FLAGS);
    expect(bad.assessed.total.warnings).toContain('extract.warn.vat_total');
    // Nothing was stated for the VAT, so it stays «missing» rather than «vat_total».
    expect(bad.assessed.vatAmount.warnings).toEqual(['extract.warn.missing']);
  });

  it('does not check VAT when only an inclusive total was printed', () => {
    const { assessed } = assessPo(poOutput({ subtotal: none(), vatAmount: none(), total: f(24679) }), FLAGS);
    expect(assessed.total.warnings).toEqual([]);
    expect(assessed.subtotal.warnings).toEqual(['extract.warn.missing']);
    expect(assessed.lines.every((l) => l.unitPrice.status === 'confirmed')).toBe(true);
  });

  it('flags a 14-digit VAT number but still carries it into the values', () => {
    const { assessed, values } = assessPo(poOutput({}, { vatNumber: f('31123456780003') }), FLAGS);
    expect(assessed.vendor.vatNumber.warnings).toEqual(['extract.warn.vat_format']);
    expect(assessed.vendor.vatNumber.status).toBe('unconfirmed');
    expect(values!.vendor!.vatNumber).toBe('31123456780003');
  });

  it('flags a CR that is not 10 digits and a bad email, and normalizes the phone digits', () => {
    const { assessed } = assessPo(poOutput({}, { crNumber: f('10105678'), email: f('sales.gulfsolar'), phone: f('٠٥٠١٢٣٤٥٦٧') }), FLAGS);
    expect(assessed.vendor.crNumber.warnings).toEqual(['extract.warn.cr_format']);
    expect(assessed.vendor.email.warnings).toEqual(['extract.warn.email_format']);
    expect(assessed.vendor.phone.value).toBe('0501234567');
    expect(assessed.vendor.phone.status).toBe('confirmed');
  });

  it('maps vendor type spellings and refuses an Arabic word without failing the quote', () => {
    const oem = assessPo(poOutput({}, { vendorType: f('oem') }), FLAGS);
    expect(oem.assessed.vendor.vendorType.value).toBe('OEM');
    expect(oem.assessed.vendor.vendorType.status).toBe('confirmed');
    expect(oem.values!.vendor!.vendorType).toBe('OEM');

    const word = assessPo(poOutput({}, { vendorType: f('مصنع') }), FLAGS);
    expect(word.assessed.vendor.vendorType.value).toBeNull();
    expect(word.assessed.vendor.vendorType.warnings).toEqual(['extract.warn.enum']);
    expect(word.values!.vendor!.vendorType).toBeNull();
    expect(word.values).not.toBeNull();
  });

  it('flags a validity date in the past, but not the quote date', () => {
    const expired = assessPo(poOutput({ validUntil: f('2026-09-30'), quoteDate: f('2026-09-15') }), FLAGS);
    expect(expired.assessed.validUntil.warnings).toEqual(['extract.warn.date_past']);
    expect(expired.assessed.validUntil.status).toBe('unconfirmed');
    expect(expired.assessed.quoteDate.warnings).toEqual([]);
    expect(expired.values!.validUntil).toBe('2026-09-30');

    const today = assessPo(poOutput({ validUntil: f(TODAY) }), FLAGS);
    expect(today.assessed.validUntil.warnings).toEqual([]);
  });

  it('accepts a requisition code by shape and flags a sentence-shaped one', () => {
    const ok = assessPo(poOutput({ sourceRequisitionCode: f('pr-00012') }), FLAGS);
    expect(ok.assessed.sourceRequisitionCode.value).toBe('PR-00012');
    expect(ok.assessed.sourceRequisitionCode.status).toBe('confirmed');

    const arabicDigits = assessPo(poOutput({ sourceRequisitionCode: f('PR-٠٠٠١٢') }), FLAGS);
    expect(arabicDigits.assessed.sourceRequisitionCode.value).toBe('PR-00012');

    const off = assessPo(poOutput({ sourceRequisitionCode: f('الطلب رقم 12') }), FLAGS);
    expect(off.assessed.sourceRequisitionCode.warnings).toEqual(['extract.warn.code_format']);
    expect(off.assessed.sourceRequisitionCode.status).toBe('unconfirmed');
    expect(off.values!.sourceRequisitionCode).toBe('الطلب رقم 12');
  });

  it('accepts a currency code and refuses a word', () => {
    expect(assessPo(poOutput({ currency: f('usd') }), FLAGS).assessed.currency.value).toBe('USD');
    expect(assessPo(poOutput({ currency: f('دولار أمريكي') }), FLAGS).assessed.currency.warnings).toEqual(['extract.warn.currency']);
  });

  it('values are null with no usable line and no requisition code', () => {
    expect(assessPo(poOutput({ lines: [], sourceRequisitionCode: none() }), FLAGS).values).toBeNull();
    const zero = assessPo(poOutput({ lines: [poLine({ qty: f(0) })], sourceRequisitionCode: none() }), FLAGS);
    expect(zero.assessed.lines[0].qty.warnings).toEqual(['extract.warn.quantity']);
    expect(zero.values).toBeNull();
  });

  it('keeps values for a requisition code alone — «سوّ أمر شراء من الطلب PR-00012 على شركة الخليج»', () => {
    const sentence = poOutput({
      lines: [],
      quoteRef: none(),
      quoteDate: none(),
      validUntil: none(),
      projectCode: none(),
      projectName: none(),
      subtotal: none(),
      vatAmount: none(),
      total: none(),
    }, { nameEn: none(), vendorType: none(), vatNumber: none(), crNumber: none(), phone: none(), email: none() });
    const { values } = assessPo(sentence, FLAGS);
    expect(values).not.toBeNull();
    expect(values!.sourceRequisitionCode).toBe('PR-00012');
    expect(values!.vendor!.nameAr).toBe('شركة الخليج للألواح الشمسية');
    expect(values!.lines).toEqual([]);
    expect(values!.subtotal).toBeNull();
    expect(values!.quoteRef).toBeNull();

    const noVendor = assessPo({ ...sentence, vendor: vendorOutput({ nameAr: none() }) }, FLAGS);
    expect(noVendor.values).not.toBeNull();
    expect(noVendor.values!.vendor).toBeNull();
    expect(noVendor.assessed.vendor.nameAr.warnings).toEqual(['extract.warn.missing']);
  });

  it('keeps a vendor name with a word-internal «ال» unconfirmed only when the page showed the ligature artifact', () => {
    const name = 'شركة الأفق للمقاوالت الكهربائية';
    const suspect = assessPo(poOutput({}, { nameAr: f(name) }), { ...FLAGS, ligatureSuspect: true });
    expect(suspect.assessed.vendor.nameAr.status).toBe('unconfirmed');
    expect(suspect.assessed.vendor.nameAr.warnings).toEqual(['extract.warn.ligature']);
    expect(suspect.values!.vendor!.nameAr).toBe(name);
    const clean = assessPo(poOutput({}, { nameAr: f(name) }), FLAGS);
    expect(clean.assessed.vendor.nameAr.status).toBe('confirmed');
    // The seed vendor has no word-internal «ال».
    const seed = assessPo(poOutput(), { ...FLAGS, ligatureSuspect: true });
    expect(seed.assessed.vendor.nameAr.status).toBe('confirmed');
  });

  it('never stores a vendor placeholder the model altered', () => {
    const { assessed } = assessPo(poOutput({}, { nameAr: f('⟦جهة_9⟧ وشركاه') }), FLAGS);
    expect(assessed.vendor.nameAr.warnings).toEqual(['extract.warn.placeholder']);
    expect(assessed.vendor.nameAr.status).toBe('unconfirmed');
  });
});

// ─── PO DTO builders ────────────────────────────────────────────────────────

describe('poDtoFrom / vendorDtoFrom / convertToPoDtoFrom', () => {
  const values = assessPo(poOutput(), FLAGS).values as PoValues;
  const vendor = values.vendor as VendorValues;
  const resolved = (overrides: Partial<PoResolution> = {}): PoResolution => ({
    vendorId: 'ven-1',
    projectId: 'prj-1',
    lines: [
      { itemId: 'item-1', wbsElementId: null },
      { itemId: 'item-2', wbsElementId: null },
      { itemId: 'item-3', wbsElementId: null },
    ],
    ...overrides,
  });

  it('builds CreatePoDto with the resolved ids, whole-number quantities and prices, and no undefined members', () => {
    const dto = poDtoFrom(values, resolved()) as Record<string, unknown>;
    expect(dto).toEqual({
      vendorId: 'ven-1',
      projectId: 'prj-1',
      lines: [
        { itemId: 'item-1', qty: 40, unitPrice: 320 },
        { itemId: 'item-2', qty: 1, unitPrice: 6500 },
        { itemId: 'item-3', qty: 120, unitPrice: 18 },
      ],
    });
    expect(Object.keys(dto).sort()).toEqual(['lines', 'projectId', 'vendorId']);
    for (const line of dto.lines as Record<string, unknown>[]) expect(Object.keys(line).sort()).toEqual(['itemId', 'qty', 'unitPrice']);
  });

  it('omits projectId when null, uppercases the currency, rounds prices to 2 decimals, sets wbsElementId when resolved', () => {
    const odd: PoValues = { ...values, currency: 'usd', lines: [{ ...values.lines[0], unitPrice: 4200.456 }, values.lines[1], values.lines[2]] };
    const dto = poDtoFrom(odd, resolved({ projectId: null, lines: [{ itemId: 'item-1', wbsElementId: 'wbs-1' }, { itemId: 'item-2', wbsElementId: null }, { itemId: 'item-3', wbsElementId: null }] })) as {
      projectId?: string;
      currency?: string;
      lines: Record<string, unknown>[];
    };
    expect('projectId' in dto).toBe(false);
    expect(dto.currency).toBe('USD');
    expect(dto.lines[0].unitPrice).toBe(4200.46);
    expect(dto.lines[0].wbsElementId).toBe('wbs-1');
    expect('wbsElementId' in dto.lines[1]).toBe(false);
  });

  it('throws on a line without a unit price and on misaligned lines', () => {
    const noPrice: PoValues = { ...values, lines: [{ ...values.lines[0], unitPrice: null }, values.lines[1], values.lines[2]] };
    expect(() => poDtoFrom(noPrice, resolved())).toThrow('unit price is required by NPI');
    expect(() => poDtoFrom(values, resolved({ lines: [{ itemId: 'item-1', wbsElementId: null }] }))).toThrow();
  });

  it('builds CreateVendorDto with the enum as a plain string and no undefined members', () => {
    const dto = vendorDtoFrom(vendor) as Record<string, unknown>;
    expect(dto).toEqual({
      nameAr: 'شركة الخليج للألواح الشمسية',
      nameEn: 'Gulf Solar Panels Co.',
      vendorType: 'SUPPLIER',
      vatNumber: '311111111111113',
      crNumber: '1010111222',
      phone: '+966501111111',
      email: 'sales@gulfsolar.sa',
    });
    expect(typeof dto.vendorType).toBe('string');
  });

  it('falls back to the Arabic name for nameEn, drops an off-format VAT and an unknown vendor type', () => {
    const dto = vendorDtoFrom({ ...vendor, nameEn: null, vatNumber: '31123456780003', vendorType: null, crNumber: null, phone: null, email: null }) as Record<string, unknown>;
    expect(dto.nameEn).toBe('شركة الخليج للألواح الشمسية');
    expect('vatNumber' in dto).toBe(false);
    expect('vendorType' in dto).toBe(false);
    expect(Object.keys(dto).sort()).toEqual(['nameAr', 'nameEn']);
  });

  it('builds ConvertToPoDto with and without prices', () => {
    const withPrices = convertToPoDtoFrom('ven-1', [{ requisitionLineId: 'rl-1', unitPrice: 320 }, { requisitionLineId: 'rl-2', unitPrice: 6500 }], 'USD') as Record<string, unknown>;
    expect(withPrices).toEqual({
      vendorId: 'ven-1',
      currency: 'USD',
      prices: [
        { requisitionLineId: 'rl-1', unitPrice: 320 },
        { requisitionLineId: 'rl-2', unitPrice: 6500 },
      ],
    });

    const bare = convertToPoDtoFrom('ven-1', []) as Record<string, unknown>;
    expect(Object.keys(bare)).toEqual(['vendorId']);
    const noCurrency = convertToPoDtoFrom('ven-1', [{ requisitionLineId: 'rl-1', unitPrice: 320 }]) as Record<string, unknown>;
    expect('currency' in noCurrency).toBe(false);
    expect(noCurrency.prices).toEqual([{ requisitionLineId: 'rl-1', unitPrice: 320 }]);
  });
});

// ─── runner ─────────────────────────────────────────────────────────────────

describe('runExtraction (pr)', () => {
  const sentenceOutput = () =>
    prOutput({
      justification: f('توريد 40 لوح 550 واط لمشروع PRJ-00012', 0.6),
      lines: [prLine({ itemName: f('لوح 550 واط'), qty: f(40) })],
    });

  it('sends a sentence-only input on the advanced tier with the pr schema and today pinned in the system prompt', async () => {
    const llm = new FakeLlm((req) => {
      const sent = outboundText(req);
      expect(sent).toContain('PRJ-00012');
      return reply(JSON.stringify(sentenceOutput()));
    });
    const result = await okRun<'pr'>(
      await runExtraction(depsWith(llm), { flow: 'pr', source: { kind: 'text', pages: [] }, userHint: SENTENCE, referenceDate: TODAY, ourPartyNameAr: 'شركة NPI للطاقة الشمسية' }, ctx),
    );

    expect(llm.requests).toHaveLength(1);
    const req = llm.requests[0];
    expect(req.tier).toBe('advanced');
    expect(req.purpose).toBe('extract_pr');
    expect(req.jsonSchema).toBe(FLOWS.pr.jsonSchema);
    expect(outboundText(req)).toContain('تلميح المستخدم:');
    expect(outboundText(req)).toContain(SENTENCE);
    expect(outboundText(req)).not.toContain('=== صفحة');
    expect(req.system).toContain(TODAY);
    expect(req.system).not.toContain('{{today}}');

    expect(result.values!.lines).toHaveLength(1);
    expect(result.values!.lines[0]).toMatchObject({ itemName: 'لوح 550 واط', qty: 40 });
    expect(result.values!.projectCode).toBe('PRJ-00012');
    expect(result.values!.neededBy).toBe('2026-10-08');
    expect(result.fields['projectCode'].status).toBe('confirmed');
    expect(result.fields['justification'].status).toBe('unconfirmed');
    expect(result.fields['justification'].warnings).toEqual(['extract.warn.low_confidence']);
    expect(result.fields['lines.0.qty']).toMatchObject({ value: 40, status: 'confirmed' });
    expect(result.summary.total).toBe(Object.keys(result.fields).length);
    expect(result.summary.confirmed + result.summary.unconfirmed).toBe(result.summary.total);
  });

  it('checks the needed-by date against the pinned reference date', async () => {
    const llm = new FakeLlm(() => reply(JSON.stringify(prOutput({ neededBy: f('2026-09-01') }))));
    const result = await okRun<'pr'>(await runExtraction(depsWith(llm), { flow: 'pr', source: { kind: 'text', pages: [] }, userHint: 'أبغى 40 لوح 550 واط للمشروع PRJ-00012 قبل 2026-09-01', referenceDate: TODAY }, ctx));
    expect(result.fields['neededBy'].warnings).toEqual(['extract.warn.date_past']);
    expect(result.fields['neededBy'].status).toBe('unconfirmed');
  });

  it('exposes the lines under dotted indices', async () => {
    const llm = new FakeLlm(() =>
      reply(
        JSON.stringify(
          prOutput({
            lines: [prLine({ itemName: f('عاكس 50 كيلوواط'), qty: f(3) }), prLine({ itemName: f('كابل DC 6مم'), qty: f(200), unit: f('متر') })],
          }),
        ),
      ),
    );
    const result = await okRun<'pr'>(
      await runExtraction(depsWith(llm), { flow: 'pr', source: { kind: 'text', pages: [] }, userHint: 'نحتاج 3 عاكس 50 كيلوواط و200 متر كابل DC 6مم', referenceDate: TODAY }, ctx),
    );
    expect(Object.keys(result.fields)).toEqual(expect.arrayContaining(['lines.0.itemName', 'lines.0.qty', 'lines.1.itemName', 'lines.1.qty', 'lines.1.unit']));
    expect(result.fields['lines.1.qty'].value).toBe(200);
    expect(result.fields['lines.1.unit'].value).toBe('متر');
    expect(result.fields['lines.2.qty']).toBeUndefined();
  });

  it('labels document pages when pages are given, and sends no hint line without a hint', async () => {
    const llm = new FakeLlm(() => reply(JSON.stringify(prOutput())));
    await okRun<'pr'>(
      await runExtraction(depsWith(llm), { flow: 'pr', source: { kind: 'text', pages: [{ num: 1, text: 'مذكرة طلب مواد\nلوح شمسي 550 واط MOD-550 120 قطعة' }] }, referenceDate: TODAY }, ctx),
    );
    expect(outboundText(llm.requests[0])).toContain('=== صفحة 1 ===');
    expect(outboundText(llm.requests[0])).not.toContain('تلميح المستخدم:');
  });

  it('defaults the reference date to the local date today', async () => {
    const llm = new FakeLlm(() => reply(JSON.stringify(prOutput())));
    await okRun<'pr'>(await runExtraction(depsWith(llm), { flow: 'pr', source: { kind: 'text', pages: [] }, userHint: SENTENCE }, ctx));
    const system = llm.requests[0].system as string;
    expect(todayIso()).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(system).toContain(todayIso());
    expect(system).not.toContain('{{today}}');
  });

  it('formats todayIso from the local calendar day, not UTC', async () => {
    jest.useFakeTimers({
      now: new Date(2026, 9, 6, 0, 30, 0),
      doNotFake: ['nextTick', 'setImmediate', 'clearImmediate', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'queueMicrotask', 'performance', 'hrtime'],
    });
    try {
      expect(todayIso()).toBe('2026-10-06');
      const llm = new FakeLlm(() => reply(JSON.stringify(prOutput())));
      await okRun<'pr'>(await runExtraction(depsWith(llm), { flow: 'pr', source: { kind: 'text', pages: [] }, userHint: SENTENCE }, ctx));
      expect(llm.requests[0].system).toContain('2026-10-06');
    } finally {
      jest.useRealTimers();
    }
  });

  it('refuses an empty input before calling the model', async () => {
    for (const input of [
      { flow: 'pr' as const, source: { kind: 'text' as const, pages: [] } },
      { flow: 'pr' as const, source: { kind: 'text' as const, pages: [] }, userHint: '   ' },
      { flow: 'po' as const, source: { kind: 'text' as const, pages: [] } },
    ]) {
      const llm = new FakeLlm(() => reply('{}'));
      const result = await runExtraction(depsWith(llm), input, ctx);
      expect(result.ok).toBe(false);
      const failed = result as ExtractFailure;
      expect(failed.reason).toBe('empty_input');
      expect(failed.messageKey).toBe('extract.failed.empty_input');
      expect(failed.usage).toBeNull();
      expect(llm.requests).toHaveLength(0);
    }
  });

  it('fails with schema_mismatch when lines is missing, mapped to the invalid_json message', async () => {
    const broken = prOutput() as unknown as Record<string, unknown>;
    delete broken.lines;
    const llm = new FakeLlm(() => reply(JSON.stringify(broken)));
    const result = await runExtraction(depsWith(llm), { flow: 'pr', source: { kind: 'text', pages: [] }, userHint: SENTENCE, referenceDate: TODAY }, ctx);
    expect(result.ok).toBe(false);
    expect((result as ExtractFailure).reason).toBe('schema_mismatch');
    expect((result as ExtractFailure).messageKey).toBe('extract.failed.invalid_json');
  });
});

describe('runExtraction (po)', () => {
  it('shows the model placeholders for the vendor and its VAT number, and rehydrates the answer', async () => {
    const llm = new FakeLlm((req) => {
      const sent = outboundText(req);
      expect(sent).not.toContain('الخليج للألواح');
      expect(sent).not.toContain('311111111111113');
      const org = /⟦جهة_\d+⟧/.exec(sent)![0];
      const vat = /⟦رقم_ضريبي_\d+⟧/.exec(sent)![0];
      return reply(
        JSON.stringify(
          poOutput(
            {
              subtotal: f(12800),
              vatAmount: f(1920),
              total: f(14720),
              lines: [poLine()],
            },
            { nameAr: f(org), vatNumber: f(vat), nameEn: none(), crNumber: f('1010111222'), phone: none(), email: none() },
          ),
        ),
      );
    });
    const result = await okRun<'po'>(
      await runExtraction(
        depsWith(llm),
        { flow: 'po', source: { kind: 'text', pages: [{ num: 1, text: QUOTE_TEXT }] }, userHint: 'عرض سعر جديد', referenceDate: TODAY, ourPartyNameAr: 'شركة NPI للطاقة الشمسية' },
        ctx,
      ),
    );

    const req = llm.requests[0];
    expect(req.tier).toBe('advanced');
    expect(req.purpose).toBe('extract_po');
    expect(req.jsonSchema).toBe(FLOWS.po.jsonSchema);
    expect(req.system).toContain('شركة NPI للطاقة الشمسية');
    expect(req.system).not.toContain('{{our_party_hint}}');
    expect(req.system).toContain(TODAY);
    expect(req.system).not.toContain('{{today}}');
    expect(outboundText(req)).toContain('=== صفحة 1 ===');
    expect(outboundText(req)).toContain('تلميح المستخدم: عرض سعر جديد');
    // Document codes and numbers are not pseudonymized.
    expect(outboundText(req)).toContain('Q-2026-117');
    expect(outboundText(req)).toContain('PR-00012');

    expect(result.values!.vendor!.nameAr).toBe('شركة الخليج للألواح الشمسية');
    expect(result.values!.vendor!.vatNumber).toBe('311111111111113');
    expect(result.fields['vendor.nameAr'].status).toBe('confirmed');
    expect(result.fields['vendor.vatNumber'].status).toBe('confirmed');
    expect(result.fields['lines.0.unitPrice'].value).toBe(320);
    expect(result.fields['subtotal'].value).toBe(12800);
    expect(result.fields['total'].status).toBe('confirmed');
    expect(result.values!.sourceRequisitionCode).toBe('PR-00012');
    expect(result.summary.total).toBe(Object.keys(result.fields).length);
  });

  it('reads a sentence naming an approved requisition as ok with the code and no lines', async () => {
    const llm = new FakeLlm((req) => {
      const org = /⟦جهة_\d+⟧/.exec(outboundText(req))![0];
      return reply(
        JSON.stringify(
          poOutput(
            { lines: [], quoteRef: none(), quoteDate: none(), validUntil: none(), projectCode: none(), projectName: none(), subtotal: none(), vatAmount: none(), total: none() },
            { nameAr: f(org), nameEn: none(), vendorType: none(), vatNumber: none(), crNumber: none(), phone: none(), email: none() },
          ),
        ),
      );
    });
    const result = await okRun<'po'>(
      await runExtraction(depsWith(llm), { flow: 'po', source: { kind: 'text', pages: [] }, userHint: 'سوّ أمر شراء من الطلب PR-00012 على شركة الخليج للألواح الشمسية', referenceDate: TODAY }, ctx),
    );
    expect(outboundText(llm.requests[0])).not.toContain('=== صفحة');
    expect(result.values).not.toBeNull();
    expect(result.values!.sourceRequisitionCode).toBe('PR-00012');
    expect(result.values!.vendor!.nameAr).toBe('شركة الخليج للألواح الشمسية');
    expect(result.values!.lines).toEqual([]);
    expect(Object.keys(result.fields).some((k) => k.startsWith('lines.'))).toBe(false);
  });

  it('exposes every quote line under dotted indices', async () => {
    const llm = new FakeLlm(() => reply(JSON.stringify(poOutput())));
    const result = await okRun<'po'>(await runExtraction(depsWith(llm), { flow: 'po', source: { kind: 'text', pages: [{ num: 1, text: 'عرض سعر' }] }, referenceDate: TODAY }, ctx));
    expect(result.fields['lines.2.unitPrice'].value).toBe(18);
    expect(result.fields['lines.2.sku'].value).toBe('MNT-RAIL');
    expect(result.fields['lines.3.qty']).toBeUndefined();
  });

  it('marks the totals unconfirmed end to end when the quote does not add up', async () => {
    const llm = new FakeLlm(() => reply(JSON.stringify(poOutput({ total: f(26000) }))));
    const result = await okRun<'po'>(await runExtraction(depsWith(llm), { flow: 'po', source: { kind: 'text', pages: [{ num: 1, text: 'عرض سعر' }] }, referenceDate: TODAY }, ctx));
    expect(result.fields['total'].warnings).toContain('extract.warn.vat_total');
    expect(result.fields['total'].status).toBe('unconfirmed');
    expect(result.values).not.toBeNull();
  });
});

// ─── resolution ─────────────────────────────────────────────────────────────

describe('resolveDepartment', () => {
  const departments = departmentsFromNpi([
    { id: 'd1', code: 'DEP-01', nameAr: 'التنفيذ', nameEn: 'Execution' },
    { id: 'd2', code: 'DEP-02', nameAr: 'المالية', nameEn: 'Finance' },
    { id: 'd3', code: 'DEP-03', nameAr: 'الهندسة والتصميم', nameEn: null },
    { id: 'bad' }, // dropped: no name
  ]);

  it('reads NPI rows and drops the unreadable', () => {
    expect(departments.map((d) => d.id)).toEqual(['d1', 'd2', 'd3']);
    expect(departments[0]).toEqual({ id: 'd1', code: 'DEP-01', nameAr: 'التنفيذ', nameEn: 'Execution' });
    expect(departments[2].nameEn).toBeNull();
  });

  it('matches by code in any spelling, ahead of the name', () => {
    expect(resolveDepartment({ code: 'dep-1' }, departments)).toMatchObject({ kind: 'matched', by: 'code', department: { id: 'd1' } });
    expect(resolveDepartment({ code: 'DEP-02', name: 'التنفيذ' }, departments)).toMatchObject({ kind: 'matched', by: 'code', department: { id: 'd2' } });
  });

  it('matches by name with or without the word «قسم», and by the English name', () => {
    expect(resolveDepartment({ name: 'التنفيذ' }, departments)).toMatchObject({ kind: 'matched', by: 'name', department: { id: 'd1' } });
    expect(resolveDepartment({ name: 'قسم التنفيذ' }, departments)).toMatchObject({ kind: 'matched', by: 'name', department: { id: 'd1' } });
    expect(resolveDepartment({ name: 'قسم المالية' }, departments)).toMatchObject({ kind: 'matched', by: 'name', department: { id: 'd2' } });
    expect(resolveDepartment({ name: 'execution' }, departments)).toMatchObject({ kind: 'matched', by: 'name', department: { id: 'd1' } });
    expect(resolveDepartment({ code: 'DEP-99', name: 'المالية' }, departments)).toMatchObject({ kind: 'matched', by: 'name', department: { id: 'd2' } });
  });

  it('offers partial matches for choice instead of picking one', () => {
    const r = resolveDepartment({ name: 'الهندسة' }, departments);
    expect(r.kind).toBe('candidates');
    if (r.kind !== 'candidates') return;
    expect(r.candidates[0].entity.id).toBe('d3');
    expect(r.candidates[0].similarity).toBeGreaterThanOrEqual(0.3);
  });

  it('says none when nothing is close or there is nothing to match on', () => {
    expect(resolveDepartment({ name: 'الموارد البشرية' }, departments)).toEqual({ kind: 'none' });
    expect(resolveDepartment({}, departments)).toEqual({ kind: 'none' });
    expect(resolveDepartment({ code: null, name: '  ' }, departments)).toEqual({ kind: 'none' });
    expect(resolveDepartment({ name: 'التنفيذ' }, [])).toEqual({ kind: 'none' });
  });
});

describe('resolveRequisition', () => {
  const requisitions = requisitionsFromNpi([
    { id: 'r1', code: 'PR-00012', status: 'APPROVED' },
    { id: 'r2', code: 'PR-00013' },
    { id: 'x' }, // dropped: no code
  ]);

  it('reads NPI rows and drops the unreadable', () => {
    expect(requisitions).toEqual([
      { id: 'r1', code: 'PR-00012', status: 'APPROVED' },
      { id: 'r2', code: 'PR-00013', status: null },
    ]);
  });

  it('matches by code numerically, so «PR-12» finds PR-00012', () => {
    expect(resolveRequisition('PR-12', requisitions)).toMatchObject({ kind: 'matched', requisition: { id: 'r1', status: 'APPROVED' } });
    expect(resolveRequisition('pr-00013', requisitions)).toMatchObject({ kind: 'matched', requisition: { id: 'r2' } });
    expect(resolveRequisition('PR-٠٠٠١٢', requisitions)).toMatchObject({ kind: 'matched', requisition: { id: 'r1' } });
    expect(resolveRequisition('PR-99', requisitions)).toEqual({ kind: 'none' });
    expect(resolveRequisition('PO-12', requisitions)).toEqual({ kind: 'none' });
    expect(resolveRequisition(null, requisitions)).toEqual({ kind: 'none' });
    expect(resolveRequisition('', requisitions)).toEqual({ kind: 'none' });
  });
});

describe('wbsFromProject / resolveWbs', () => {
  const project = {
    id: 'p1',
    code: 'PRJ-00012',
    nameAr: 'محطة الرياض الشمسية',
    wbsElements: [
      { id: 'w1', code: 'WBS-01', nameAr: 'الأعمال الميكانيكية', nameEn: 'Mechanical works' },
      { id: 'w2', code: 'WBS-02', nameAr: 'الأعمال الكهربائية', nameEn: null },
      { id: 'bad' },
    ],
  };
  const wbs = wbsFromProject(project);

  it('reads wbsElements off a project body and returns [] otherwise', () => {
    expect(wbs).toEqual([
      { id: 'w1', code: 'WBS-01', nameAr: 'الأعمال الميكانيكية', nameEn: 'Mechanical works' },
      { id: 'w2', code: 'WBS-02', nameAr: 'الأعمال الكهربائية', nameEn: null },
    ]);
    expect(wbsFromProject({ id: 'p2', code: 'PRJ-00013' })).toEqual([]);
    expect(wbsFromProject({ id: 'p2', wbsElements: 'none' })).toEqual([]);
    expect(wbsFromProject(null)).toEqual([]);
    expect(wbsFromProject('PRJ-00012')).toEqual([]);
  });

  it('matches by code in any spelling, then by name, then offers candidates, then none', () => {
    expect(resolveWbs({ code: 'wbs-2' }, wbs)).toMatchObject({ kind: 'matched', by: 'code', wbs: { id: 'w2' } });
    expect(resolveWbs({ code: 'WBS-09', name: 'الأعمال الكهربائية' }, wbs)).toMatchObject({ kind: 'matched', by: 'name', wbs: { id: 'w2' } });
    expect(resolveWbs({ name: 'mechanical works' }, wbs)).toMatchObject({ kind: 'matched', by: 'name', wbs: { id: 'w1' } });

    const partial = resolveWbs({ name: 'الأعمال' }, wbs);
    expect(partial.kind).toBe('candidates');
    if (partial.kind === 'candidates') expect(partial.candidates.map((c) => c.entity.id).sort()).toEqual(['w1', 'w2']);

    expect(resolveWbs({ name: 'أنظمة المراقبة' }, wbs)).toEqual({ kind: 'none' });
    expect(resolveWbs({}, wbs)).toEqual({ kind: 'none' });
    expect(resolveWbs({ code: 'WBS-01' }, [])).toEqual({ kind: 'none' });
  });
});

describe('itemsFromNpi (unitCost)', () => {
  const items = itemsFromNpi([
    { id: 'i1', sku: 'MOD-550', nameAr: 'لوح شمسي 550 واط', nameEn: 'Solar module 550 W', unitCost: 320 },
    { id: 'i2', sku: 'INV-50K', nameAr: 'عاكس 50 كيلوواط', nameEn: null, unitCost: '6500.50' },
    { id: 'i3', sku: 'MNT-RAIL', nameAr: 'قضيب تثبيت', nameEn: null },
    { id: 'i4', sku: 'CAB-DC6', nameAr: 'كابل DC 6مم', nameEn: null, unitCost: 'abc' },
    { id: 'i5', sku: 'BOS-KIT', nameAr: 'طقم مكونات مساعدة', nameEn: null, unitCost: null },
  ]);

  it('reads unitCost as a number or a numeric string, and null when absent or unreadable', () => {
    expect(items.map((i) => i.unitCost)).toEqual([320, 6500.5, null, null, null]);
    expect(items[0]).toMatchObject({ id: 'i1', sku: 'MOD-550', nameAr: 'لوح شمسي 550 واط', nameEn: 'Solar module 550 W' });
  });
});

// ─── i18n ───────────────────────────────────────────────────────────────────

describe('Arabic strings for the new flows', () => {
  const keys = [
    'extract.warn.quantity',
    'extract.warn.currency',
    'extract.warn.code_format',
    'extract.warn.line_total',
    'extract.warn.lines_sum',
    'extract.warn.vat_total',
    'extract.warn.date_past',
    'extract.incomplete.pr',
    'extract.incomplete.po',
    'extract.failed.empty_input',
  ];

  it.each(keys)('has a non-empty entry for %s', (key) => {
    const value = (ar as Record<string, unknown>)[key];
    expect(typeof value).toBe('string');
    expect((value as string).trim().length).toBeGreaterThan(0);
  });

  it('every warning the schemas can raise has an entry', () => {
    const raised = [
      'extract.warn.missing',
      'extract.warn.low_confidence',
      'extract.warn.placeholder',
      'extract.warn.vat_format',
      'extract.warn.cr_format',
      'extract.warn.date_format',
      'extract.warn.amount',
      'extract.warn.derived',
      'extract.warn.enum',
      'extract.warn.email_format',
      'extract.warn.ligature',
      ...keys.filter((k) => k.startsWith('extract.warn.')),
    ];
    for (const key of raised) expect(Object.keys(ar)).toContain(key);
  });

  it('keeps the document-code example in the incomplete messages', () => {
    expect((ar as Record<string, string>)['extract.incomplete.pr']).toContain('PRJ-00012');
    expect((ar as Record<string, string>)['extract.warn.code_format']).toContain('PR-00012');
  });
});
