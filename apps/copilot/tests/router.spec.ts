import { route, matchFlowByRules, type ClassifierVerdict, type FlowType } from '../src/agents/router';

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
