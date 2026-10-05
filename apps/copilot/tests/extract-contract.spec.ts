// T-23: customer-contract extraction — schema, runner, assessment, resolution.
import type { LlmContext } from '../src/llm/client';
import { LlmError } from '../src/llm/client';
import type { ModelResponse, RedactedBlock, RedactedRequest } from '../src/llm/provider';
import { Pseudonymizer } from '../src/privacy/pseudonymizer';
import type { ConsentedBase64 } from '../src/llm/provider';
import {
  FLOWS,
  flattenFields,
  parseModelJson,
  repairPdfText,
  repairPdfTextWithFlags,
  runExtraction,
  type ExtractDeps,
  type ExtractFailure,
  type ExtractionResult,
} from '../src/extract/run';
import {
  assessCustomerContract,
  contractDtoFrom,
  customerDtoFrom,
  CustomerContractOutputSchema,
  parseNumber,
  type CustomerContractOutput,
  type CustomerContractValues,
} from '../src/extract/schemas/customer_contract';
import { assessField, CONFIRMED_MIN_CONFIDENCE } from '../src/extract/schemas/field';
import {
  codeKey,
  itemsFromNpi,
  nameKey,
  partiesFromNpi,
  projectsFromNpi,
  purchaseOrdersFromNpi,
  resolveCustomer,
  resolveItem,
  resolveProject,
  resolvePurchaseOrder,
  trigramSimilarity,
} from '../src/extract/resolve';

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

/** A complete, valid model output; override pieces per test. */
function output(overrides: Partial<CustomerContractOutput> = {}, customer: Partial<CustomerContractOutput['customer']> = {}): CustomerContractOutput {
  return {
    customer: {
      nameAr: f('شركة النخيل للمقاولات'),
      nameEn: f('Al Nakheel Contracting'),
      customerType: f('CI'),
      vatNumber: f('310123456700003'),
      crNumber: f('1010567890'),
      phone: f('0501234567'),
      email: f('info@nakheel.sa'),
      ...customer,
    },
    contractType: f('EPC'),
    startDate: f('2026-11-01'),
    endDate: f('2027-04-30'),
    totalValue: f(850000),
    retentionPct: f(10),
    advancePct: none(),
    milestones: [
      { sequence: f(1), descriptionAr: f('دفعة مقدمة عند التوقيع'), descriptionEn: none(), amount: f(255000), percent: f(30), dueDate: none(), triggerType: f('EVENT') },
      { sequence: f(2), descriptionAr: f('عند اكتمال التوريد'), descriptionEn: none(), amount: f(340000), percent: f(40), dueDate: none(), triggerType: f('EVENT') },
      { sequence: f(3), descriptionAr: f('عند التشغيل والتسليم'), descriptionEn: none(), amount: f(255000), percent: f(30), dueDate: none(), triggerType: f('EVENT') },
    ],
    ...overrides,
  };
}

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

const CONTRACT_TEXT = `عقد توريد وتركيب نظام طاقة شمسية
الطرف الأول: شركة النخيل للمقاولات، الرقم الضريبي 310123456700003، السجل التجاري 1010567890.
الطرف الثاني: شركة NPI للطاقة الشمسية.
قيمة العقد الإجمالية: 850,000 ريال سعودي غير شاملة ضريبة القيمة المضافة.
تاريخ البدء: 2026-11-01، تاريخ الانتهاء: 2027-04-30. نسبة المحتجزات: 10%.`;

function outboundText(req: RedactedRequest): string {
  const content = req.messages[0].content;
  return typeof content === 'string' ? content : JSON.stringify(content);
}

async function okRun(result: ExtractionResult | ExtractFailure): Promise<ExtractionResult<'customer_contract'>> {
  if (!result.ok) throw new Error(`expected ok, got ${result.reason}: ${result.detail}`);
  return result as ExtractionResult<'customer_contract'>;
}

// ─── schema ─────────────────────────────────────────────────────────────────

describe('customer_contract schema', () => {
  const schema = FLOWS.customer_contract.jsonSchema;
  const text = JSON.stringify(schema);

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

  it('describes the enum values and date format the model must use', () => {
    expect(text).toContain('EPC | PPA | OM | LEASE');
    expect(text).toContain('DATE | PROGRESS | EVENT');
    expect(text).toContain('RESIDENTIAL | CI | UTILITY | GOVERNMENT');
    expect(text).toContain('YYYY-MM-DD');
  });

  it('accepts a complete output and rejects a missing field', () => {
    expect(CustomerContractOutputSchema.safeParse(output()).success).toBe(true);
    const broken = output() as unknown as Record<string, unknown>;
    delete broken.milestones;
    expect(CustomerContractOutputSchema.safeParse(broken).success).toBe(false);
  });
});

// ─── field assessment ───────────────────────────────────────────────────────

describe('assessField', () => {
  it('confirms a value at or above the threshold with no warnings', () => {
    expect(assessField(f('x', CONFIRMED_MIN_CONFIDENCE)).status).toBe('confirmed');
  });
  it('is unconfirmed below the threshold, when null, or with a warning', () => {
    expect(assessField(f('x', 0.79)).warnings).toEqual(['extract.warn.low_confidence']);
    expect(assessField({ value: null, confidence: 0, evidence: null, page: null }).warnings).toEqual(['extract.warn.missing']);
    expect(assessField(f('x'), ['extract.warn.vat_format']).status).toBe('unconfirmed');
  });
});

describe('assessCustomerContract', () => {
  it('confirms every field of a clean contract and yields plain values', () => {
    const { assessed, values } = assessCustomerContract(output());
    const leaves = Object.values(flattenFields(assessed));
    const unconfirmed = leaves.filter((l) => l.status === 'unconfirmed');
    // Only the fields the document did not state.
    expect(unconfirmed.every((l) => l.warnings.length === 1 && l.warnings[0] === 'extract.warn.missing')).toBe(true);
    expect(values).not.toBeNull();
    expect(values!.customer.vatNumber).toBe('310123456700003');
    expect(values!.milestones.map((m) => m.amount)).toEqual([255000, 340000, 255000]);
  });

  it('normalizes identifiers to ASCII digits and flags an off-format VAT (02 §5.5)', () => {
    const { assessed } = assessCustomerContract(output({}, { vatNumber: f('٣١٠ ١٢٣٤٥٦٧ ٠٠٠٠٣'), crNumber: f('10105678') }));
    expect(assessed.customer.vatNumber.value).toBe('310123456700003');
    expect(assessed.customer.vatNumber.status).toBe('confirmed');
    expect(assessed.customer.crNumber.warnings).toEqual(['extract.warn.cr_format']);

    const bad = assessCustomerContract(output({}, { vatNumber: f('31012345670003') }));
    expect(bad.assessed.customer.vatNumber.status).toBe('unconfirmed');
    expect(bad.assessed.customer.vatNumber.warnings).toEqual(['extract.warn.vat_format']);
    // Still carried into the values: the card shows it, the DTO builder drops it.
    expect(bad.values!.customer.vatNumber).toBe('31012345670003');
  });

  it('flags a bad email and keeps a good one', () => {
    expect(assessCustomerContract(output({}, { email: f('not-an-email') })).assessed.customer.email.warnings).toEqual(['extract.warn.email_format']);
    expect(assessCustomerContract(output()).assessed.customer.email.status).toBe('confirmed');
  });

  it('validates dates: format, calendar, and order', () => {
    const { assessed } = assessCustomerContract(output({ startDate: f('2026/11/01'), endDate: f('2026-02-30') }));
    expect(assessed.startDate.value).toBe('2026-11-01');
    expect(assessed.endDate.warnings).toEqual(['extract.warn.date_format']);

    const reversed = assessCustomerContract(output({ startDate: f('2027-01-01'), endDate: f('2026-01-01') }));
    expect(reversed.assessed.endDate.warnings).toEqual(['extract.warn.date_order']);
    expect(reversed.assessed.startDate.status).toBe('confirmed');
  });

  it('maps enum spellings and refuses unknown ones without failing the document', () => {
    const { assessed, values } = assessCustomerContract(output({ contractType: f('o&m') }, { customerType: f('government') }));
    expect(assessed.contractType.value).toBe('OM');
    expect(assessed.customer.customerType.value).toBe('GOVERNMENT');
    expect(values!.contractType).toBe('OM');

    const unknown = assessCustomerContract(output({ contractType: f('SERVICE') }));
    expect(unknown.assessed.contractType.value).toBeNull();
    expect(unknown.assessed.contractType.warnings).toEqual(['extract.warn.enum']);
    // No contract type → nothing NPI could create.
    expect(unknown.values).toBeNull();
  });

  it('marks the total and every amount unconfirmed when the milestones do not add up (06 §3 case 11)', () => {
    const out = output();
    out.milestones[1].amount = f(300000);
    const { assessed } = assessCustomerContract(out);
    expect(assessed.totalValue.status).toBe('unconfirmed');
    expect(assessed.totalValue.warnings).toContain('extract.warn.milestones_sum');
    expect(assessed.milestones.every((m) => m.amount.warnings.includes('extract.warn.milestones_sum'))).toBe(true);
    // The amount that disagrees with its own percentage is also flagged on its own.
    expect(assessed.milestones[1].amount.warnings).toContain('extract.warn.amount');
  });

  it('derives an amount from a percentage-only milestone and leaves it unconfirmed', () => {
    const out = output();
    for (const m of out.milestones) m.amount = none();
    out.milestones[0].percent = f(30, 0.9);
    const { assessed, values } = assessCustomerContract(out);
    expect(assessed.milestones.map((m) => m.amount.value)).toEqual([255000, 340000, 255000]);
    expect(assessed.milestones[0].amount.confidence).toBe(0.9);
    expect(assessed.milestones[0].amount.warnings).toEqual(['extract.warn.derived']);
    expect(assessed.milestones[0].amount.status).toBe('unconfirmed');
    expect(values!.milestones[0].amount).toBe(255000);
    expect(assessed.totalValue.status).toBe('confirmed');
  });

  it('flags percentages that do not sum to 100 and sequences that skip', () => {
    const out = output();
    out.milestones[2].percent = f(20);
    out.milestones[2].amount = none();
    out.milestones[2].sequence = f(4);
    const { assessed } = assessCustomerContract(out);
    expect(assessed.milestones.every((m) => m.percent.warnings.includes('extract.warn.milestones_sum'))).toBe(true);
    expect(assessed.milestones.every((m) => m.sequence.warnings.includes('extract.warn.milestones_sequence'))).toBe(true);
    expect(assessed.retentionPct.status).toBe('confirmed');
  });

  it('rejects out-of-range percentages and negative amounts', () => {
    const { assessed } = assessCustomerContract(output({ retentionPct: f(150), totalValue: f(-5) }));
    expect(assessed.retentionPct.warnings).toEqual(['extract.warn.percent']);
    expect(assessed.totalValue.warnings).toContain('extract.warn.amount');
  });

  it('never stores a placeholder the model altered', () => {
    const { assessed } = assessCustomerContract(output({}, { nameAr: f('⟦جهة_9⟧ وشركاه') }));
    expect(assessed.customer.nameAr.status).toBe('unconfirmed');
    expect(assessed.customer.nameAr.warnings).toEqual(['extract.warn.placeholder']);
  });

  it('keeps a name with a word-internal «ال» unconfirmed only when the page showed the ligature artifact', () => {
    const suspect = assessCustomerContract(output({}, { nameAr: f('شركة النخيل للمقاوالت') }), { ligatureSuspect: true });
    expect(suspect.assessed.customer.nameAr.status).toBe('unconfirmed');
    expect(suspect.assessed.customer.nameAr.warnings).toEqual(['extract.warn.ligature']);
    expect(suspect.values!.customer.nameAr).toBe('شركة النخيل للمقاوالت');
    const clean = assessCustomerContract(output({}, { nameAr: f('شركة النخيل للمقاوالت') }), { ligatureSuspect: false });
    expect(clean.assessed.customer.nameAr.status).toBe('confirmed');
    // «ال» at the start of a word is the article, never the artifact.
    const article = assessCustomerContract(output({}, { nameAr: f('مصنع الرياض للصناعات') }), { ligatureSuspect: true });
    expect(article.assessed.customer.nameAr.status).toBe('confirmed');
  });

  it('low-confidence values are unconfirmed even when valid', () => {
    const { assessed } = assessCustomerContract(output({ totalValue: f(850000, 0.6) }));
    expect(assessed.totalValue.status).toBe('unconfirmed');
    expect(assessed.totalValue.warnings).toEqual(['extract.warn.low_confidence']);
  });
});

// ─── DTO builders (ADR-28 mirror) ───────────────────────────────────────────

describe('NPI DTO builders', () => {
  const values = assessCustomerContract(output()).values as CustomerContractValues;

  it('builds CreateCustomerDto with the enum as a plain string and no undefined members', () => {
    const dto = customerDtoFrom(values.customer) as Record<string, unknown>;
    expect(dto).toEqual({
      nameAr: 'شركة النخيل للمقاولات',
      nameEn: 'Al Nakheel Contracting',
      customerType: 'CI',
      vatNumber: '310123456700003',
      crNumber: '1010567890',
      phone: '0501234567',
      email: 'info@nakheel.sa',
    });
  });

  it('falls back to the Arabic name for nameEn and drops an off-format VAT', () => {
    const dto = customerDtoFrom({ ...values.customer, nameEn: null, vatNumber: '12345', customerType: null }) as Record<string, unknown>;
    expect(dto.nameEn).toBe('شركة النخيل للمقاولات');
    expect('vatNumber' in dto).toBe(false);
    expect('customerType' in dto).toBe(false);
  });

  it('builds CreateContractDto with inline milestones', () => {
    const dto = contractDtoFrom(values, 'cust-1') as Record<string, unknown>;
    expect(dto.customerId).toBe('cust-1');
    expect(dto.contractType).toBe('EPC');
    expect(dto.totalValue).toBe(850000);
    expect(dto.retentionPct).toBe(10);
    expect('advancePct' in dto).toBe(false);
    const milestones = dto.milestones as Record<string, unknown>[];
    expect(milestones).toHaveLength(3);
    expect(milestones[0]).toEqual({ sequence: 1, descriptionAr: 'دفعة مقدمة عند التوقيع', descriptionEn: 'دفعة مقدمة عند التوقيع', amount: 255000, triggerType: 'EVENT' });
  });
});

// ─── text repair ────────────────────────────────────────────────────────────

describe('repairPdfText', () => {
  it('repairs what pdf.js makes of a Word-exported PDF', () => {
    const raw = 'الطرف األول: شركة\tالنخيل،\tالرقم الضريبي\t310123456700003\t.\nتاريخ البدء:\t2026\t-\t11\t-\t01\t، تاريخ االنتهاء:\t2027\t-\t04\t-\t30\t.';
    expect(repairPdfTextWithFlags(raw).flags.ligatureSuspect).toBe(true);
    expect(repairPdfTextWithFlags('نص سليم بلا عيوب').flags.ligatureSuspect).toBe(false);
    const fixed = repairPdfText(raw);
    expect(fixed).toContain('الطرف الأول: شركة النخيل، الرقم الضريبي 310123456700003');
    expect(fixed).toContain('تاريخ البدء: 2026-11-01');
    expect(fixed).toContain('تاريخ الانتهاء: 2027-04-30');
  });
  it('leaves genuine «ال» and «ألف» alone', () => {
    expect(repairPdfText('ثمانمائة وخمسون ألف ريال للمالك')).toBe('ثمانمائة وخمسون ألف ريال للمالك');
  });
  it('repairs a lam before a reversed ligature only on a page that showed the artifact (T-24, po-01)', () => {
    // «للألواح» and «للاستشارات» come back as «لأللواح» and «لالستشارات»;
    // the page also shows «األسعار», which is what flags it.
    const raw = 'من: شركة الخليج لأللواح الشمسية ومكتب النور لالستشارات. األسعار بالريال.';
    const fixed = repairPdfText(raw);
    expect(fixed).toContain('شركة الخليج للألواح الشمسية');
    expect(fixed).toContain('مكتب النور للاستشارات');
    expect(fixed).toContain('الأسعار بالريال');
    // Genuine «لألف» on a clean page is not touched.
    expect(repairPdfText('غرامة لألف ريال عن كل يوم')).toBe('غرامة لألف ريال عن كل يوم');
    // A genuine «الألواح» on an artifact page survives both rules.
    expect(repairPdfText('توريد األلواح الشمسية')).toBe('توريد الألواح الشمسية');
  });
});

describe('parseNumber', () => {
  it('reads the ways a Saudi contract writes a number', () => {
    expect(parseNumber('850,000')).toBe(850000);
    expect(parseNumber('٤٨٠٬٠٠٠ ريال')).toBe(480000);
    expect(parseNumber('1.150.000')).toBe(1150000);
    expect(parseNumber('30%')).toBe(30);
    expect(parseNumber('0.19')).toBe(0.19);
    expect(parseNumber('٢٫٥')).toBe(2.5);
    expect(parseNumber('-5')).toBe(-5);
    expect(parseNumber('ريال')).toBeNull();
    expect(parseNumber('')).toBeNull();
  });
});

describe('parseModelJson', () => {
  it('reads bare and fenced JSON and refuses prose', () => {
    expect(parseModelJson('{"a":1}')).toEqual({ a: 1 });
    expect(parseModelJson('```json\n{"a":1}\n```')).toEqual({ a: 1 });
    expect(parseModelJson('Here you go: {"a":1}')).toBeUndefined();
  });
});

// ─── runner ─────────────────────────────────────────────────────────────────

describe('runExtraction (customer_contract)', () => {
  it('sends the redacted pages on the advanced tier with the JSON schema and rehydrates the answer', async () => {
    const llm = new FakeLlm((req) => {
      const sent = outboundText(req);
      // The model only ever sees placeholders for the customer and its numbers.
      expect(sent).not.toContain('النخيل');
      expect(sent).not.toContain('310123456700003');
      const org = /⟦جهة_\d+⟧/.exec(sent)![0];
      const vat = /⟦رقم_ضريبي_\d+⟧/.exec(sent)![0];
      // The CR number is not always a placeholder (a trailing «.» keeps the
      // pseudonymizer's identifier rule from firing — noted for T-32); the
      // model then copies the digits as printed.
      const cr = /⟦رقم_تعريفي_\d+⟧/.exec(sent)?.[0] ?? '1010567890';
      return reply(JSON.stringify(output({}, { nameAr: f(org), vatNumber: f(vat), crNumber: f(cr), nameEn: none(), phone: none(), email: none() })));
    });
    const result = await okRun(await runExtraction(depsWith(llm), { flow: 'customer_contract', source: { kind: 'text', pages: [{ num: 1, text: CONTRACT_TEXT }] }, userHint: 'عقد جديد', ourPartyNameAr: 'شركة NPI للطاقة الشمسية' }, ctx));

    const req = llm.requests[0];
    expect(req.tier).toBe('advanced');
    expect(req.purpose).toBe('extract_customer_contract');
    expect(req.jsonSchema).toBe(FLOWS.customer_contract.jsonSchema);
    expect(req.system).toContain('محرّك استخراج');
    expect(req.system).toContain('شركة NPI للطاقة الشمسية');
    expect(outboundText(req)).toContain('=== صفحة 1 ===');
    expect(outboundText(req)).toContain('تلميح المستخدم: عقد جديد');

    // Rehydrated: the customer name is exactly the document's span — no
    // trailing label (pseudonymizer boundary fix, T-23).
    expect(result.values!.customer.nameAr).toBe('شركة النخيل للمقاولات');
    expect(result.values!.customer.vatNumber).toBe('310123456700003');
    expect(result.values!.customer.crNumber).toBe('1010567890');
    expect(result.assessed.customer.vatNumber.status).toBe('confirmed');
    expect(result.fields['customer.nameAr'].status).toBe('confirmed');
    expect(result.fields['milestones.1.amount'].value).toBe(340000);
    expect(result.summary.total).toBe(Object.keys(result.fields).length);
    expect(result.summary.confirmed + result.summary.unconfirmed).toBe(result.summary.total);
    expect(result.usage.modelId).toBe('claude-sonnet-5');
  });

  it('passes consented vision blocks through untouched, each image labelled with its page', async () => {
    const data = 'AAAA' as ConsentedBase64;
    const blocks: RedactedBlock[] = [
      { type: 'image', mediaType: 'image/png', data, consentEventId: 'ce-1', sizeBytes: 3 },
      { type: 'image', mediaType: 'image/png', data, consentEventId: 'ce-1', sizeBytes: 3 },
    ];
    const llm = new FakeLlm(() => reply(JSON.stringify(output())));
    const result = await runExtraction(depsWith(llm), { flow: 'customer_contract', source: { kind: 'vision', blocks } }, ctx);
    expect(result.ok).toBe(true);
    const content = llm.requests[0].messages[0].content as RedactedBlock[];
    expect(Array.isArray(content)).toBe(true);
    const types = content.map((b) => b.type);
    expect(types).toEqual(['text', 'text', 'image', 'text', 'image']);
    expect((content[1] as { text: string }).text).toBe('=== صفحة 1 ===');
    expect((content[3] as { text: string }).text).toBe('=== صفحة 2 ===');
    expect(content[2]).toBe(blocks[0]);
  });

  it('tolerates a fenced answer and a milestone-free contract', async () => {
    const llm = new FakeLlm(() => reply('```json\n' + JSON.stringify(output({ milestones: [] })) + '\n```'));
    const result = await okRun(await runExtraction(depsWith(llm), { flow: 'customer_contract', source: { kind: 'text', pages: [{ num: 1, text: 'عقد' }] } }, ctx));
    expect(result.values!.milestones).toEqual([]);
    expect(result.assessed.totalValue.status).toBe('confirmed');
  });

  it('reports a document whose customer name is missing as ok with null values', async () => {
    const llm = new FakeLlm(() => reply(JSON.stringify(output({}, { nameAr: none() }))));
    const result = await okRun(await runExtraction(depsWith(llm), { flow: 'customer_contract', source: { kind: 'text', pages: [{ num: 1, text: 'عقد' }] } }, ctx));
    expect(result.values).toBeNull();
    expect(result.fields['customer.nameAr'].warnings).toEqual(['extract.warn.missing']);
    expect(result.fields['totalValue'].status).toBe('confirmed');
  });

  it.each([
    ['invalid_json', () => reply('لا أستطيع')],
    ['truncated', () => reply('{"customer":', { stopReason: 'max_tokens' })],
    ['refused', () => reply('', { stopReason: 'refusal' })],
    ['schema_mismatch', () => reply(JSON.stringify({ ...output(), milestones: 'none' }))],
  ] as const)('fails with %s', async (reason, impl) => {
    const llm = new FakeLlm(impl);
    const result = await runExtraction(depsWith(llm), { flow: 'customer_contract', source: { kind: 'text', pages: [{ num: 1, text: 'عقد' }] } }, ctx);
    expect(result.ok).toBe(false);
    const failure = result as ExtractFailure;
    expect(failure.reason).toBe(reason);
    expect(failure.messageKey.startsWith('extract.failed.')).toBe(true);
    expect(failure.usage).not.toBeNull();
  });

  it('maps a refusal and other client errors', async () => {
    const refused = await runExtraction(depsWith(new FakeLlm(() => { throw new LlmError('refused'); })), { flow: 'customer_contract', source: { kind: 'text', pages: [{ num: 1, text: 'عقد' }] } }, ctx);
    expect((refused as ExtractFailure).reason).toBe('refused');
    const down = await runExtraction(depsWith(new FakeLlm(() => { throw new LlmError('timeout'); })), { flow: 'customer_contract', source: { kind: 'text', pages: [{ num: 1, text: 'عقد' }] } }, ctx);
    expect((down as ExtractFailure).reason).toBe('model_error');
    expect((down as ExtractFailure).detail).toMatch(/^timeout/);
    expect((down as ExtractFailure).usage).toBeNull();
  });

  it('refuses a flow with no registered spec before calling the model', async () => {
    const llm = new FakeLlm(() => reply('{}'));
    const result = await runExtraction(depsWith(llm), { flow: 'grn', source: { kind: 'text', pages: [] } }, ctx);
    expect((result as ExtractFailure).reason).toBe('unsupported_flow');
    expect(llm.requests).toHaveLength(0);
  });
});

// ─── resolution (02 §5.6, BR-09) ────────────────────────────────────────────

const customers = partiesFromNpi([
  { id: 'c1', code: 'CUS-00001', nameAr: 'مصنع الرياض للصناعات', nameEn: 'Riyadh Industries Factory', vatNumber: '310000000000003' },
  { id: 'c2', code: 'CUS-00002', nameAr: 'شركة النخيل للمقاولات', nameEn: 'Al Nakheel Contracting', vatNumber: null },
  { id: 'c3', code: 'CUS-00003', nameAr: 'شركة النخيل للتجارة', nameEn: null, vatNumber: '311111111111113' },
  { id: 'bad' }, // dropped: no name
]);

describe('resolveCustomer', () => {
  it('reads NPI rows and drops the unreadable', () => {
    expect(customers.map((c) => c.id)).toEqual(['c1', 'c2', 'c3']);
  });
  it('matches by VAT first, whatever the digits look like', () => {
    const r = resolveCustomer({ nameAr: 'اسم مختلف تماماً', vatNumber: '٣١٠ ٠٠٠٠٠٠٠ ٠٠٠٠٣' }, customers);
    expect(r).toMatchObject({ kind: 'matched', by: 'vat', party: { id: 'c1' } });
  });
  it('then by normalized name, ignoring the legal form and letter variants', () => {
    expect(resolveCustomer({ nameAr: 'النخيل للمقاولات' }, customers)).toMatchObject({ kind: 'matched', by: 'name', party: { id: 'c2' } });
    expect(resolveCustomer({ nameEn: 'al nakheel contracting' }, customers)).toMatchObject({ kind: 'matched', by: 'name', party: { id: 'c2' } });
    expect(resolveCustomer({ nameAr: 'مصنع الرياض للصناعـات' }, customers)).toMatchObject({ kind: 'matched', by: 'name', party: { id: 'c1' } });
  });
  it('offers partial matches for choice instead of picking one (BR-09)', () => {
    const r = resolveCustomer({ nameAr: 'شركة النخيل للمقاوالت' }, customers);
    expect(r.kind).toBe('candidates');
    if (r.kind !== 'candidates') return;
    expect(r.candidates[0].entity.id).toBe('c2');
    expect(r.candidates[0].similarity).toBeGreaterThan(0.6);
    expect(r.candidates.map((c) => c.entity.id)).toContain('c3');
  });
  it('says new when nothing is close, and when there is nothing to match on', () => {
    expect(resolveCustomer({ nameAr: 'هيئة تطوير بوابة الدرعية' }, customers)).toEqual({ kind: 'new' });
    expect(resolveCustomer({}, customers)).toEqual({ kind: 'new' });
    expect(resolveCustomer({ nameAr: 'شركة' }, customers)).toEqual({ kind: 'new' });
  });
});

describe('resolveProject / resolvePurchaseOrder', () => {
  const projects = projectsFromNpi([
    { id: 'p1', code: 'PRJ-00012', nameAr: 'محطة الرياض الشمسية', nameEn: 'Riyadh Solar Plant' },
    { id: 'p2', code: 'PRJ-00013', nameAr: 'محطة جدة الشمسية', nameEn: null },
  ]);
  const pos = purchaseOrdersFromNpi([{ id: 'po1', code: 'PO-00007', vendorId: 'v1' }, { id: 'x' }]);

  it('matches a project by code in any spelling, then by name, then offers candidates', () => {
    expect(resolveProject({ code: 'prj 12' }, projects)).toMatchObject({ kind: 'matched', by: 'code', project: { id: 'p1' } });
    expect(resolveProject({ code: 'PRJ-00099', name: 'محطة جدة الشمسية' }, projects)).toMatchObject({ kind: 'matched', by: 'name', project: { id: 'p2' } });
    const r = resolveProject({ name: 'محطة الرياض' }, projects);
    expect(r.kind).toBe('candidates');
    expect(resolveProject({ name: 'مشروع آخر' }, projects)).toEqual({ kind: 'none' });
    expect(resolveProject({}, projects)).toEqual({ kind: 'none' });
  });
  it('matches a purchase order by code numerically', () => {
    expect(resolvePurchaseOrder('PO-7', pos)).toMatchObject({ kind: 'matched', purchaseOrder: { id: 'po1' } });
    expect(resolvePurchaseOrder('po-00007', pos)).toMatchObject({ kind: 'matched' });
    expect(resolvePurchaseOrder('PO-8', pos)).toEqual({ kind: 'none' });
    expect(resolvePurchaseOrder(null, pos)).toEqual({ kind: 'none' });
  });
  it('codeKey splits prefix and number', () => {
    expect(codeKey('PRJ-00012')).toEqual({ prefix: 'PRJ', number: 12 });
    expect(codeKey('ABC')).toEqual({ prefix: 'ABC', number: null });
  });
});

describe('resolveItem and trigram similarity', () => {
  const items = itemsFromNpi([
    { id: 'i1', sku: 'MOD-550', nameAr: 'لوح شمسي 550 واط', nameEn: 'Solar module 550 W' },
    { id: 'i2', sku: 'MOD-600', nameAr: 'لوح شمسي 600 واط', nameEn: 'Solar module 600 W' },
    { id: 'i3', sku: 'INV-100', nameAr: 'عاكس 100 كيلوواط', nameEn: 'Inverter 100 kW' },
  ]);

  it('is 1 for identical text, symmetric, and 0 against nothing', () => {
    expect(trigramSimilarity('لوح شمسي', 'لوح شمسي')).toBe(1);
    expect(trigramSimilarity('لوح شمسي', 'لوح شمسى')).toBe(1);
    expect(trigramSimilarity('abc', 'abd')).toBe(trigramSimilarity('abd', 'abc'));
    expect(trigramSimilarity('abc', '')).toBe(0);
  });
  it('matches by SKU, then by name at ≥ 0.85, otherwise offers candidates or a new item', () => {
    expect(resolveItem({ sku: 'mod-550' }, items)).toMatchObject({ kind: 'matched', by: 'sku', item: { id: 'i1' } });
    expect(resolveItem({ name: 'لوح شمسي 550 واط' }, items)).toMatchObject({ kind: 'matched', by: 'name', item: { id: 'i1' }, similarity: 1 });
    const close = resolveItem({ name: 'لوح شمسي 550' }, items);
    expect(close.kind).toBe('candidates');
    if (close.kind === 'candidates') expect(close.candidates[0].entity.id).toBe('i1');
    expect(resolveItem({ name: 'كابل نحاس 10 مم' }, items)).toEqual({ kind: 'new' });
    expect(resolveItem({}, items)).toEqual({ kind: 'new' });
  });
  it('nameKey strips legal forms and folds letters', () => {
    expect(nameKey('شركة النخيل للمقاولات')).toBe('النخيل للمقاولات');
    expect(nameKey('Al Nakheel Contracting Co.')).toBe('al nakheel contracting');
  });
});
