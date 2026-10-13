import { route, matchFlowByRules, isPermissionChangeRequest, type ClassifierVerdict, type FlowType } from '../src/agents/router';

// spec/madar/02-TECH-SPEC.md §6 and spec/madar/06-ACCEPTANCE-TESTS.md §3.
// Order under test: HR guard -> forced flow -> non-entry intents (chat,
// only without an attachment) -> keyword rules -> classifier fallback ->
// final fallback.

describe('matchFlowByRules — direct unit tests', () => {
  it('matches customer_contract on a bare rule keyword', () => {
    expect(matchFlowByRules('عقد جديد')).toBe('customer_contract');
  });

  it('returns null when no keyword matches anything', () => {
    expect(matchFlowByRules('نص عشوائي بلا كلمات مفتاحية على الإطلاق')).toBeNull();
  });
});

describe('route — each of the five flows by rules, two phrasings each', () => {
  const cases: Array<[string, string, FlowType]> = [
    ['customer_contract phrasing 1', 'عقد جديد مع شركة النخيل', 'customer_contract'],
    ['customer_contract phrasing 2 (تعاقد + اتفاقية)', 'تعاقدنا واتفاقية جديدة مع عميل', 'customer_contract'],
    ['pr phrasing 1 (طلب شراء)', 'طلب شراء أجهزة كمبيوتر للمكتب', 'pr'],
    ['pr phrasing 2 (طلب توريد, need verb نحتاج)', 'نحتاج طلب توريد مواد بناء', 'pr'],
    ['po phrasing 1 (أمر شراء)', 'أمر شراء لتوريد ألواح شمسية', 'po'],
    ['po phrasing 2 (امر الشراء, ال-inflected)', 'امر الشراء رقم 55 يحتاج مراجعة', 'po'],
    ['grn phrasing 1 (استلمنا)', 'استلمنا البضاعة صباح اليوم', 'grn'],
    ['grn phrasing 2 (وصلت الشحنة)', 'وصلت الشحنة الساعة عشرة', 'grn'],
    ['vendor_bill phrasing 1 (فاتورة مورد)', 'فاتورة مورد بمبلغ 15000 ريال', 'vendor_bill'],
    ['vendor_bill phrasing 2 (فاتورة المورد, ال-inflected)', 'فاتورة المورد بانتظار المطابقة', 'vendor_bill'],
  ];

  it.each(cases)('%s: %j -> %s', async (_label, text, expected) => {
    const result = await route({ text, hasAttachment: false });
    expect(result).toEqual({ kind: 'flow', flow: expected, by: 'rules' });
  });

  it('tashkeel/alef-hamza variant of a PO phrase still matches by rules', async () => {
    const result = await route({ text: 'أَمْرُ شِراءٍ لتوريد ألواح شمسية', hasAttachment: false });
    expect(result).toEqual({ kind: 'flow', flow: 'po', by: 'rules' });
  });

  it('إشعار تسليم (hamza-below-alef variant) matches grn by rules', async () => {
    const result = await route({ text: 'إشعار تسليم البضاعة وصل الآن', hasAttachment: false });
    expect(result).toEqual({ kind: 'flow', flow: 'grn', by: 'rules' });
  });
});

describe('route — required specific sentences', () => {
  it('«عقد جديد» alone with no attachment -> customer_contract', async () => {
    const result = await route({ text: 'عقد جديد', hasAttachment: false });
    expect(result).toEqual({ kind: 'flow', flow: 'customer_contract', by: 'rules' });
  });

  it('dialect PR sentence with quantity -> pr by rules (need verb + number)', async () => {
    const result = await route({
      text: 'أبي 40 لوح 550 واط للمشروع PRJ-00012 قبل الخميس',
      hasAttachment: false,
    });
    expect(result).toEqual({ kind: 'flow', flow: 'pr', by: 'rules' });
  });

  it('«سوّ أمر شراء من الطلب PR-00012» -> po by rules', async () => {
    const result = await route({ text: 'سوّ أمر شراء من الطلب PR-00012', hasAttachment: false });
    expect(result).toEqual({ kind: 'flow', flow: 'po', by: 'rules' });
  });
});

describe('route — non-entry intents go to chat (only without an attachment)', () => {
  const nonEntryCases: string[] = [
    'اعتمد الطلب',
    'احذف العقد',
    'وش المهام اللي تنتظرني؟',
    'شروط سداد النخيل؟',
    'كم استهلكنا اليوم؟',
  ];

  it.each(nonEntryCases)('%j -> chat', async (text) => {
    const result = await route({ text, hasAttachment: false });
    expect(result).toEqual({ kind: 'chat' });
  });

  it('the same question WITH an attachment is not forced to chat by step 3 (falls through to rules/fallback)', async () => {
    const withoutAttachment = await route({ text: 'كم استهلكنا اليوم؟', hasAttachment: false });
    expect(withoutAttachment).toEqual({ kind: 'chat' });

    const withAttachment = await route({ text: 'كم استهلكنا اليوم؟', hasAttachment: true });
    expect(withAttachment).not.toEqual({ kind: 'chat' });
    expect(withAttachment).toEqual({ kind: 'choose_flow' });
  });
});

describe('route — HR guard precedence', () => {
  it('HR guard wins over everything else; the injected classifier is never called', async () => {
    const classify = jest.fn(async (): Promise<ClassifierVerdict> => 'pr');
    const result = await route({ text: 'مين أكفأ مهندس عندنا؟', hasAttachment: false }, { classify });
    expect(result).toEqual({ kind: 'hr_refusal' });
    expect(classify).not.toHaveBeenCalled();
  });

  it('HR guard wins even over a forced flow', async () => {
    const result = await route({ text: 'مين أكفأ مهندس عندنا؟', hasAttachment: false, forcedFlow: 'pr' });
    expect(result).toEqual({ kind: 'hr_refusal' });
  });
});

describe('route — forced flow (chip) and visibility', () => {
  it('a forced flow routes directly, by "rules"', async () => {
    const result = await route({ text: 'هذا هو المستند', hasAttachment: false, forcedFlow: 'po' });
    expect(result).toEqual({ kind: 'flow', flow: 'po', by: 'rules' });
  });

  it('a forced flow not in visibleFlows -> flow_unavailable', async () => {
    const result = await route({
      text: 'هذا هو المستند',
      hasAttachment: false,
      forcedFlow: 'po',
      visibleFlows: ['pr', 'grn'],
    });
    expect(result).toEqual({ kind: 'flow_unavailable', flow: 'po' });
  });

  it('a flow decided by rules but excluded by visibleFlows -> flow_unavailable', async () => {
    const result = await route({ text: 'عقد جديد', hasAttachment: false, visibleFlows: ['pr'] });
    expect(result).toEqual({ kind: 'flow_unavailable', flow: 'customer_contract' });
  });
});

describe('route — attachment with no usable text, and classifier fallback', () => {
  it('an attachment with empty text and no classifier -> choose_flow', async () => {
    const result = await route({ text: '', hasAttachment: true });
    expect(result).toEqual({ kind: 'choose_flow' });
  });

  it('classifier verdict is a flow type -> flow, by "classifier"', async () => {
    const classify = jest.fn(async (): Promise<ClassifierVerdict> => 'grn');
    const result = await route({ text: '', hasAttachment: true }, { classify });
    expect(result).toEqual({ kind: 'flow', flow: 'grn', by: 'classifier' });
  });

  it('classifier verdict "chat" -> chat', async () => {
    const classify = jest.fn(async (): Promise<ClassifierVerdict> => 'chat');
    const result = await route({ text: '', hasAttachment: true }, { classify });
    expect(result).toEqual({ kind: 'chat' });
  });

  it('classifier verdict "unknown" with an attachment -> choose_flow', async () => {
    const classify = jest.fn(async (): Promise<ClassifierVerdict> => 'unknown');
    const result = await route({ text: '', hasAttachment: true }, { classify });
    expect(result).toEqual({ kind: 'choose_flow' });
  });

  it('classifier throwing, with an attachment -> choose_flow (treated as unknown)', async () => {
    const classify = jest.fn(async (): Promise<ClassifierVerdict> => {
      throw new Error('model unavailable');
    });
    const result = await route({ text: '', hasAttachment: true }, { classify });
    expect(result).toEqual({ kind: 'choose_flow' });
  });

  it('classifier throwing, no attachment, ambiguous text -> chat (treated as unknown)', async () => {
    const classify = jest.fn(async (): Promise<ClassifierVerdict> => {
      throw new Error('model unavailable');
    });
    const result = await route(
      { text: 'أمر شراء لهذه فاتورة مورد', hasAttachment: false },
      { classify },
    );
    expect(result).toEqual({ kind: 'chat' });
    expect(classify).toHaveBeenCalledTimes(1);
  });
});

describe('route — classifier is only consulted when rules cannot decide', () => {
  it('is NOT called when rules decide unambiguously, even with an attachment', async () => {
    const classify = jest.fn(async (): Promise<ClassifierVerdict> => 'po');
    const result = await route({ text: 'عقد جديد', hasAttachment: true }, { classify });
    expect(result).toEqual({ kind: 'flow', flow: 'customer_contract', by: 'rules' });
    expect(classify).not.toHaveBeenCalled();
  });

  it('IS called on an ambiguous two-flow sentence (أمر شراء + فاتورة مورد both present)', async () => {
    const classify = jest.fn(async (): Promise<ClassifierVerdict> => 'po');
    const text = 'أمر شراء لهذه فاتورة مورد';
    // Sanity check: matchFlowByRules itself sees this as ambiguous (null).
    expect(matchFlowByRules(text)).toBeNull();

    const result = await route({ text, hasAttachment: false }, { classify });
    expect(classify).toHaveBeenCalledWith(text);
    expect(result).toEqual({ kind: 'flow', flow: 'po', by: 'classifier' });
  });
});

describe('route — English input', () => {
  it('English input with no classifier -> chat (reply language is handled elsewhere)', async () => {
    const result = await route({ text: 'create a purchase request for 40 panels', hasAttachment: false });
    expect(result).toEqual({ kind: 'chat' });
  });
});

// Added in review: whole-word matching and never-execute with attachments.
describe('route — review additions', () => {
  it.each([
    ['«معقد» is not «عقد»', 'الموضوع معقد ويحتاج اجتماع'],
    ['«كتابي» is not «أبي»', 'كتابي رقم 5 أرسلته أمس'],
    ['the handover guide is not a goods receipt', 'افتح دليل الاستلام للمحاسب الجديد'],
  ])('%s -> chat', async (_label, text) => {
    await expect(route({ text, hasAttachment: false })).resolves.toEqual({ kind: 'chat' });
  });

  it.each([['احذف العقد'], ['اعتمد الطلب'], ['ارفض فاتورة المورد'], ['ألغِ أمر الشراء']])(
    'a never-execute request goes to chat even with an attachment: %s',
    async (text) => {
      const classify = jest.fn(async () => 'customer_contract' as const);
      await expect(route({ text, hasAttachment: true }, { classify })).resolves.toEqual({ kind: 'chat' });
      expect(classify).not.toHaveBeenCalled();
    },
  );

  it('a polite request written as a question is still an entry', async () => {
    await expect(route({ text: 'ممكن طلب شراء 40 لوح للمشروع PRJ-00012؟', hasAttachment: false })).resolves.toEqual({
      kind: 'flow',
      flow: 'pr',
      by: 'rules',
    });
  });

  it('a particle attached to the keyword still matches', async () => {
    await expect(route({ text: 'بخصوص العقد المرفق مع شركة النخيل', hasAttachment: true })).resolves.toEqual({
      kind: 'flow',
      flow: 'customer_contract',
      by: 'rules',
    });
  });
});

// Added in review: telling of an approval is not asking for one.
describe('route — never-execute words open the request', () => {
  it.each([
    ['المدير وافق، أبي 40 لوح 550 واط للمشروع PRJ-00012', 'pr'],
    ['العميل اعتمد العرض وهذا عقد جديد معه', 'customer_contract'],
  ] as const)('a statement about an approval is still an entry: %s', async (text, flow) => {
    await expect(route({ text, hasAttachment: false })).resolves.toEqual({ kind: 'flow', flow, by: 'rules' });
  });

  it.each([['اعتمد الطلب PR-00012'], ['لو سمحت اعتمد الطلب'], ['يا مدار احذف العقد'], ['من فضلك ألغِ أمر الشراء']])(
    'a request to approve, delete or cancel goes to chat, attachment or not: %s',
    async (text) => {
      await expect(route({ text, hasAttachment: true })).resolves.toEqual({ kind: 'chat' });
      await expect(route({ text, hasAttachment: false })).resolves.toEqual({ kind: 'chat' });
    },
  );
});

// D-26 (T-48b): the administrative flow. A permission noun with a grant or
// revoke verb, without an attachment, is `user_permissions`; a question about
// permissions stays chat (a read tool answers it).
describe('route — the administrative flow', () => {
  const FLOW = { kind: 'flow', flow: 'user_permissions', by: 'rules' } as const;

  it.each([
    ['شيل صلاحية التقارير المالية من أحمد'],
    ['اسحب صلاحية الفواتير من سارة القحطاني'],
    ['احجب صلاحية عرض العقود عن خالد'],
    ['أعطِ أحمد صلاحية التقارير المالية'],
    ['امنح سارة صلاحية اعتماد المشتريات'],
    ['أضف صلاحية الأصناف لخالد'],
    ['احذف صلاحية التقارير المالية من أحمد'],
    ['الغي صلاحيات أحمد المالية'],
    ['وصلاحياته المالية شيلها منه'],
    ['ممكن تشيل صلاحية التقارير من أحمد؟'],
    ['لو سمحت فعّل صلاحية الفواتير لسارة'],
    ['رجّع صلاحية الفواتير لأحمد'],
  ])('a permission change is the administrative flow: %s', async (text) => {
    await expect(route({ text, hasAttachment: false })).resolves.toEqual(FLOW);
  });

  it('wins over a document phrase inside the permission’s name', async () => {
    await expect(route({ text: 'شيل صلاحية طلب الشراء من أحمد', hasAttachment: false })).resolves.toEqual(FLOW);
    await expect(route({ text: 'اسحب صلاحية عرض العقود من أحمد', hasAttachment: false })).resolves.toEqual(FLOW);
  });

  it.each([['ما هي صلاحيات أحمد؟'], ['هل أقدر أشيل صلاحية التقارير من أحمد؟'], ['كم صلاحية عند سارة؟'], ['احذف العقد'], ['اعتمد الطلب']])(
    'a question or a document deletion is chat: %s',
    async (text) => {
      await expect(route({ text, hasAttachment: false })).resolves.toEqual({ kind: 'chat' });
    },
  );

  it('never fires with an attachment: the rules and the classifier decide as for any document', async () => {
    const text = 'شيل صلاحية التقارير المالية من أحمد';
    await expect(route({ text, hasAttachment: true })).resolves.toEqual({ kind: 'choose_flow' });
    const classify = jest.fn(async (): Promise<ClassifierVerdict> => 'pr');
    await expect(route({ text, hasAttachment: true }, { classify })).resolves.toEqual({ kind: 'flow', flow: 'pr', by: 'classifier' });
  });

  it('is unavailable when the flow is not among the visible flows', async () => {
    await expect(
      route({ text: 'شيل صلاحية التقارير من أحمد', hasAttachment: false, visibleFlows: ['pr', 'po'] }),
    ).resolves.toEqual({ kind: 'flow_unavailable', flow: 'user_permissions' });
  });

  it('the classifier is never called for a sentence the rule decided', async () => {
    const classify = jest.fn(async (): Promise<ClassifierVerdict> => 'chat');
    await expect(route({ text: 'شيل صلاحية طلب الشراء من أحمد', hasAttachment: false }, { classify })).resolves.toEqual(FLOW);
    expect(classify).not.toHaveBeenCalled();
  });

  it('the HR guard still comes first', async () => {
    await expect(route({ text: 'قيّم أداء أحمد وشيل صلاحية التقارير منه', hasAttachment: false })).resolves.toEqual({ kind: 'hr_refusal' });
  });

  it('a forced document flow is untouched', async () => {
    await expect(route({ text: 'شيل صلاحية التقارير من أحمد', hasAttachment: true, forcedFlow: 'customer_contract' })).resolves.toEqual({
      kind: 'flow',
      flow: 'customer_contract',
      by: 'rules',
    });
  });

  it('matchFlowByRules still returns document flows only', () => {
    expect(matchFlowByRules('شيل صلاحية التقارير المالية من أحمد')).toBeNull();
  });

  describe('isPermissionChangeRequest', () => {
    it.each([
      ['شيل صلاحية التقارير من أحمد', true],
      ['صلاحية التقارير المالية شيلها', true],
      ['أعطه صلاحيات المشتريات', true],
      ['بصلاحية جديدة وأضف أحمد', true],
      ['شيل التقارير من أحمد', false],
      ['صلاحيات أحمد', false],
      ['أبغى طلب شراء', false],
      ['', false],
    ])('%j -> %s', (text, expected) => {
      expect(isPermissionChangeRequest(text)).toBe(expected);
    });
  });
});
