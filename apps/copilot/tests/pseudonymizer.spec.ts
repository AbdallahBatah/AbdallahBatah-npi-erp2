import {
  Pseudonymizer,
  joinRedacted,
  staticPrompt,
  fromModelOutput,
  type DictionaryEntry,
} from '../src/privacy/pseudonymizer';

function customer(npiId: string, ...names: string[]): DictionaryEntry {
  return { kind: 'customer', npiId, names };
}
function vendor(npiId: string, ...names: string[]): DictionaryEntry {
  return { kind: 'vendor', npiId, names };
}
function employee(npiId: string, ...names: string[]): DictionaryEntry {
  return { kind: 'employee', npiId, names };
}

const NAKHEEL_DICTIONARY: DictionaryEntry[] = [
  customer('CUST-1', 'شركة النخيل للمقاولات', 'Al Nakheel Contracting'),
  vendor('VEND-1', 'مصنع الخليج للألواح الشمسية'),
  employee('EMP-1', 'خالد العتيبي'),
];

describe('structured identifiers', () => {
  it('tokenizes an email as بريد', () => {
    const p = new Pseudonymizer([]);
    const out = p.redact('راسلني على ahmad.ali@example.com من فضلك');
    expect(out).toMatch(/⟦بريد_1⟧/);
    expect(out).not.toContain('ahmad.ali@example.com');
  });

  it('tokenizes a Saudi IBAN as آيبان', () => {
    const p = new Pseudonymizer([]);
    const out = p.redact('الآيبان هو SA0380000000608010167519 للتحويل');
    expect(out).toMatch(/⟦آيبان_1⟧/);
    expect(out).not.toContain('SA0380000000608010167519');
  });

  it('tokenizes an IBAN with spaces between groups', () => {
    const p = new Pseudonymizer([]);
    const out = p.redact('الآيبان: SA03 8000 0000 6080 1016 7519 شكراً');
    expect(out).toMatch(/⟦آيبان_1⟧/);
  });

  it('tokenizes a Saudi VAT number as رقم_ضريبي', () => {
    const p = new Pseudonymizer([]);
    const out = p.redact('الرقم الضريبي 312345678900003 مسجل');
    expect(out).toMatch(/⟦رقم_ضريبي_1⟧/);
    expect(out).not.toContain('312345678900003');
  });

  it('tokenizes a VAT number written in Arabic-Indic digits', () => {
    const p = new Pseudonymizer([]);
    const out = p.redact('الرقم الضريبي ٣١٢٣٤٥٦٧٨٩٠٠٠٠٣ مسجل');
    expect(out).toMatch(/⟦رقم_ضريبي_1⟧/);
  });

  it('tokenizes a phone number in +9665XXXXXXXX form', () => {
    const p = new Pseudonymizer([]);
    const out = p.redact('اتصل بي على +966512345678 اليوم');
    expect(out).toMatch(/⟦هاتف_1⟧/);
  });

  it('tokenizes a phone number in 00966 form', () => {
    const p = new Pseudonymizer([]);
    const out = p.redact('اتصل بي على 00966512345678 اليوم');
    expect(out).toMatch(/⟦هاتف_1⟧/);
  });

  it('tokenizes a phone number in local 05 form with dashes', () => {
    const p = new Pseudonymizer([]);
    const out = p.redact('جواله 05-1234-5678 متاح');
    expect(out).toMatch(/⟦هاتف_1⟧/);
  });

  it('tokenizes a 10-digit national id starting with 1', () => {
    const p = new Pseudonymizer([]);
    const out = p.redact('رقم الهوية 1023456789 مسجل');
    expect(out).toMatch(/⟦رقم_تعريفي_1⟧/);
  });

  it('tokenizes a 10-digit iqama number starting with 2', () => {
    const p = new Pseudonymizer([]);
    const out = p.redact('رقم الإقامة 2023456789 مسجل');
    expect(out).toMatch(/⟦رقم_تعريفي_1⟧/);
  });

  it('tokenizes a 10-digit commercial registration starting with 7', () => {
    const p = new Pseudonymizer([]);
    const out = p.redact('السجل التجاري 7023456789 مسجل');
    expect(out).toMatch(/⟦رقم_تعريفي_1⟧/);
  });

  it('does NOT tokenize a document code like PRJ-00012', () => {
    const p = new Pseudonymizer([]);
    const out = p.redact('المشروع PRJ-00012 قيد التنفيذ');
    expect(out).toContain('PRJ-00012');
  });

  it('does NOT tokenize a document code like INV-2026-0001', () => {
    const p = new Pseudonymizer([]);
    const out = p.redact('الفاتورة INV-2026-0001 مستحقة');
    expect(out).toContain('INV-2026-0001');
  });

  it('does NOT tokenize an amount with thousands separators', () => {
    const p = new Pseudonymizer([]);
    const out = p.redact('القيمة الإجمالية 1,234,567.89 ريال');
    expect(out).toContain('1,234,567.89');
  });

  it('does NOT tokenize a 10-digit amount followed by ريال', () => {
    const p = new Pseudonymizer([]);
    const out = p.redact('المبلغ 1234567890 ريال سعودي');
    expect(out).toContain('1234567890');
    expect(out).not.toMatch(/⟦رقم_تعريفي/);
  });

  it('does NOT tokenize a percentage', () => {
    const p = new Pseudonymizer([]);
    const out = p.redact('نسبة الإنجاز 4567890123%');
    expect(out).toContain('4567890123%');
  });

  it('does NOT tokenize a date', () => {
    const p = new Pseudonymizer([]);
    const out = p.redact('بتاريخ 2026-09-27 تم التوقيع');
    expect(out).toContain('2026-09-27');
  });
});

describe('regression: realistic sentences that must pass through unchanged (except real PII)', () => {
  it.each([
    'أبي 40 لوح 550 واط للمشروع PRJ-00012 قبل الخميس',
    'المحتجزات 10% والدفعة المقدمة 20%',
    'فاتورة INV-2026-0001 بمبلغ 12500.75',
    'يوم 2026-09-20',
  ])('passes through unchanged: %s', (sentence) => {
    const p = new Pseudonymizer([]);
    expect(p.redact(sentence)).toBe(sentence);
  });
});

describe('rule A: token identity is the surface form, not the entity', () => {
  it('gives three different surfaces of the same customer three different tokens', () => {
    const p = new Pseudonymizer(NAKHEEL_DICTIONARY);
    const out = p.redact(
      'وقّعنا مع شركة النخيل للمقاولات، وتابعنا مع النخيل لاحقاً، ثم راسلنا Al Nakheel Contracting.',
    );
    expect(out).toMatch(/⟦عميل_1⟧/);
    expect(out).toMatch(/⟦عميل_2⟧/);
    expect(out).toMatch(/⟦عميل_3⟧/);
  });

  it('rehydrates "Contract with Al Nakheel Contracting" to itself, not to the Arabic full name', () => {
    const p = new Pseudonymizer(NAKHEEL_DICTIONARY);
    const redacted = p.redact('Contract with Al Nakheel Contracting');
    const rehydrated = p.rehydrate(redacted);
    expect(rehydrated).toBe('Contract with Al Nakheel Contracting');
  });

  it('exception: two spellings that normalize identically share one token and rehydrate to the first-seen spelling', () => {
    const p = new Pseudonymizer([customer('CUST-1', 'شركة النخيل')]);
    const first = p.redact('تعاقدنا مع شركة النخيل');
    const second = p.redact('راجعنا مع شركه النخيل'); // ة vs ه — normalizes identically
    const tokenMatch = /⟦عميل_1⟧/;
    expect(first).toMatch(tokenMatch);
    expect(second).toMatch(tokenMatch); // same token, no عميل_2
    expect(p.rehydrate(second)).toBe('راجعنا مع شركة النخيل'); // rehydrates to the FIRST-seen spelling
  });

  it('every other round trip remains byte-for-byte exact', () => {
    const p = new Pseudonymizer(NAKHEEL_DICTIONARY);
    const text = 'وقّعنا مع شركة النخيل للمقاولات بخصوص توريد الألواح.';
    const redacted = p.redact(text);
    expect(p.rehydrate(redacted)).toBe(text);
  });
});

describe('rule B: organization core extraction and bare mentions', () => {
  it.each([
    'النخيل طلبوا تمديد الموعد',
    'بخصوص النخيل: فاتورة الشهر الماضي',
    'وش شروط سداد النخيل؟',
  ])('redacts a bare core mention: %s', (sentence) => {
    const p = new Pseudonymizer(NAKHEEL_DICTIONARY);
    const out = p.redact(sentence);
    expect(out).toMatch(/⟦عميل_\d+⟧/);
    expect(out).not.toContain('النخيل');
  });

  it('redacts "وللنخيل أيضاً" keeping the attached (conjunction + preposition) prefix outside the token', () => {
    const p = new Pseudonymizer(NAKHEEL_DICTIONARY);
    const out = p.redact('وللنخيل أيضاً حصة من الدفعة');
    // "وللنخيل" = و (conjunction) + ل (preposition) + النخيل with the alef
    // elided into the doubled lam; both attached letters stay outside.
    expect(out).toMatch(/^ول⟦عميل_\d+⟧/);
  });

  it('derives core «الخليج» from «مصنع الخليج للألواح الشمسية»', () => {
    const p = new Pseudonymizer(NAKHEEL_DICTIONARY);
    const out = p.redact('استلمنا عرض سعر من الخليج أمس');
    expect(out).toMatch(/⟦مورد_\d+⟧/);
    expect(out).not.toContain('الخليج');
  });

  it('handles the «للنخيل» prefix combination', () => {
    const p = new Pseudonymizer(NAKHEEL_DICTIONARY);
    const out = p.redact('التمديد للنخيل موافق عليه');
    expect(out).toMatch(/التمديد ل⟦عميل_\d+⟧ /);
  });

  it('handles the «بالنخيل» prefix combination', () => {
    const p = new Pseudonymizer(NAKHEEL_DICTIONARY);
    const out = p.redact('اتصل بالنخيل غداً');
    expect(out).toMatch(/ب⟦عميل_\d+⟧/);
  });

  it('handles the «والنخيل» prefix combination', () => {
    const p = new Pseudonymizer(NAKHEEL_DICTIONARY);
    const out = p.redact('العميل والنخيل حضرا الاجتماع');
    expect(out).toMatch(/و⟦عميل_\d+⟧/);
  });

  it('handles the «فالنخيل» prefix combination', () => {
    const p = new Pseudonymizer(NAKHEEL_DICTIONARY);
    const out = p.redact('فالنخيل وافق على العرض');
    expect(out).toMatch(/^ف⟦عميل_\d+⟧/);
  });

  it('over-redacting a common core word round-trips exactly (accepted per rule A)', () => {
    const p = new Pseudonymizer(NAKHEEL_DICTIONARY);
    const text = 'استلمنا عرض سعر من الخليج أمس';
    const redacted = p.redact(text);
    expect(p.rehydrate(redacted)).toBe(text);
  });
});

describe('rule C: employee/person name parts, particles, and function-word exclusion', () => {
  it('redacts either name part of a dictionary employee', () => {
    const p = new Pseudonymizer(NAKHEEL_DICTIONARY);
    const out = p.redact('خالد قال إن العتيبي وافق');
    expect(out).not.toContain('خالد');
    expect(out).not.toContain('العتيبي');
    expect((out.match(/⟦موظف_\d+⟧/g) ?? []).length).toBe(2);
  });

  it('does not redact «علي» as a part even for an employee named «علي», since it collides with the function word «على»', () => {
    const p = new Pseudonymizer([employee('EMP-2', 'علي الشهري')]);
    const out = p.redact('الموافقة على الطلب متأخرة');
    expect(out).toBe('الموافقة على الطلب متأخرة');
  });

  it('still redacts the other part («الشهري») of that same employee', () => {
    const p = new Pseudonymizer([employee('EMP-2', 'علي الشهري')]);
    const out = p.redact('راجع الشهري الملف');
    expect(out).toMatch(/⟦موظف_\d+⟧/);
  });
});

describe('rule E: heuristic person after an honorific', () => {
  it('captures a family name in full, with the honorific outside and nothing left over', () => {
    const p = new Pseudonymizer([]);
    const out = p.redact('السيد فهد بن سعد الدوسري');
    expect(out).toBe('السيد ⟦شخص_1⟧');
  });

  it('stops the capture at a stop word', () => {
    const p = new Pseudonymizer([]);
    const out = p.redact('السيد محمد العتيبي من قسم المبيعات');
    expect(out).toMatch(/^السيد ⟦شخص_1⟧ من قسم المبيعات$/);
  });
});

describe('rule F: heuristic person without an honorific (given-names dictionary)', () => {
  it('detects two consecutive given names', () => {
    const p = new Pseudonymizer([]);
    const out = p.redact('أحمد محمد الشهري من طرف العميل');
    expect(out).toMatch(/⟦شخص_1⟧/);
    expect(out).not.toContain('أحمد');
  });

  it('detects a given name followed by a family-name word starting with «ال»', () => {
    const p = new Pseudonymizer([]);
    const out = p.redact('راسلنا خالد الحربي أمس');
    expect(out).toMatch(/⟦شخص_1⟧/);
  });

  it('does not redact a given name standing alone', () => {
    const p = new Pseudonymizer([]);
    const out = p.redact('أمل يحدونا في نجاح المشروع');
    expect(out).toBe('أمل يحدونا في نجاح المشروع');
  });

  it('does not over-capture a greeting that happens to start with a given name', () => {
    const p = new Pseudonymizer([]);
    const out = p.redact('سعيد بلقائك بعد طول غياب');
    expect(out).toBe('سعيد بلقائك بعد طول غياب');
  });

  it('does not over-capture a given name followed by an ordinary verb', () => {
    const p = new Pseudonymizer([]);
    const out = p.redact('بشرى وصلت متأخرة اليوم');
    expect(out).toBe('بشرى وصلت متأخرة اليوم');
  });
});

describe('rule D: session learning across calls and after exportState/restore', () => {
  // Note: per rule A (identity is the SURFACE, not the entity), a learned
  // bare mention is a DIFFERENT surface from the original full phrase it
  // was learned from, so it gets its OWN token (not a reused one) — rule
  // D's promise is that it gets *redacted at all*, not that it shares a
  // token number with the phrase it was learned from.
  it('learns a heuristic organization within one call so a LATER bare mention in the same document is redacted', () => {
    const p = new Pseudonymizer([]);
    const out = p.redact(
      'وقّعنا مع شركة الأمل للمقاولات عقداً جديداً. وأكد الأمل الالتزام بالجدول الزمني.',
    );
    expect(out).not.toContain('الأمل');
    expect((out.match(/⟦جهة_\d+⟧/g) ?? []).length).toBe(2);
  });

  it('learns a heuristic person across two SEPARATE redact() calls on the same instance', () => {
    const p = new Pseudonymizer([]);
    const first = p.redact('السيد ماجد الحربي وافق على الطلب');
    const second = p.redact('راجعنا مع الحربي التفاصيل');
    expect(first).toMatch(/⟦شخص_\d+⟧/);
    expect(second).toMatch(/⟦شخص_\d+⟧/); // learned part "الحربي" now redacted too
    expect(second).not.toContain('الحربي');
  });

  it('survives exportState/restore: a new instance still recognizes the learned bare mention', () => {
    const p1 = new Pseudonymizer([]);
    p1.redact('وقّعنا مع شركة الأمل للمقاولات عقداً جديداً.');
    const state = p1.exportState();

    const p2 = new Pseudonymizer([], state);
    const out = p2.redact('تواصلنا مع الأمل بخصوص الدفعة الثانية.');
    expect(out).toMatch(/⟦جهة_\d+⟧/);
    expect(out).not.toContain('الأمل');
  });
});

describe('rule G: English heuristic names', () => {
  it('detects an honorific + capitalized name', () => {
    const p = new Pseudonymizer([]);
    const out = p.redact('Please contact Mr. John Smith for approval');
    expect(out).toMatch(/⟦شخص_\d+⟧/);
    expect(out).not.toContain('John Smith');
  });

  it('detects a cue word ("Contact") + two capitalized words', () => {
    const p = new Pseudonymizer([]);
    const out = p.redact('Contact Sara Ahmed for the invoice');
    expect(out).toMatch(/⟦شخص_\d+⟧/);
    expect(out).not.toContain('Sara Ahmed');
  });

  it('detects "signed" + a name', () => {
    const p = new Pseudonymizer([]);
    const out = p.redact('signed Khalid Al-Otaibi'.replace('Al-Otaibi', 'Rashid'));
    expect(out).toMatch(/⟦شخص_\d+⟧/);
  });

  it('does not tokenize capitalized words at the start of a sentence without a cue', () => {
    const p = new Pseudonymizer([]);
    const out = p.redact('Solar Panels are on backorder this week');
    expect(out).toBe('Solar Panels are on backorder this week');
  });

  it('never tokenizes the excluded acronyms NPI, CSV, EPC, PPA, SAR, VAT', () => {
    const p = new Pseudonymizer([]);
    const out = p.redact('Contact NPI Support for the VAT report');
    expect(out).not.toMatch(/⟦شخص/);
  });

  it('never tokenizes a document code even after a cue word', () => {
    const p = new Pseudonymizer([]);
    const out = p.redact('Contact PRJ-00012 team for status');
    expect(out).toContain('PRJ-00012');
  });
});

describe('dictionary matching (surface-based identity)', () => {
  it('matches a dictionary customer by full name', () => {
    const p = new Pseudonymizer([customer('CUST-1', 'شركة النخيل')]);
    const out = p.redact('التعاقد مع شركة النخيل جارٍ');
    expect(out).toMatch(/⟦عميل_1⟧/);
    expect(out).not.toContain('النخيل');
  });

  it('matches with tashkeel and alef-variant differences from the stored name', () => {
    const p = new Pseudonymizer([customer('CUST-1', 'شركة النخيل')]);
    const out = p.redact('التعاقد مع شَرِكَةِ النَّخِيل جارٍ');
    expect(out).toMatch(/⟦عميل_\d+⟧/);
  });

  it('matches the "core" name without the legal-form prefix', () => {
    const p = new Pseudonymizer([customer('CUST-1', 'شركة النخيل')]);
    const out = p.redact('راجعنا النخيل أمس');
    expect(out).toMatch(/⟦عميل_\d+⟧/);
  });

  it('matches the core name without a trailing المحدودة suffix', () => {
    const p = new Pseudonymizer([customer('CUST-1', 'شركة الفهد المحدودة')]);
    const out = p.redact('توريد من الفهد القادم');
    expect(out).toMatch(/⟦عميل_\d+⟧/);
  });

  it('does not use a core shorter than 4 letters as a standalone candidate', () => {
    const p = new Pseudonymizer([customer('CUST-1', 'شركة أب')]);
    const out = p.redact('نص عادي لا علاقة له بأي شيء');
    expect(out).not.toMatch(/⟦عميل/);
  });

  it('keeps a one-letter attached prefix (ل) outside the token', () => {
    const p = new Pseudonymizer([customer('CUST-1', 'شركة النخيل')]);
    const out = p.redact('التوريد لشركة النخيل غداً');
    expect(out).toMatch(/ل⟦عميل_\d+⟧/);
  });

  it('keeps a one-letter attached prefix (و) outside the token', () => {
    const p = new Pseudonymizer([customer('CUST-1', 'شركة النخيل')]);
    const out = p.redact('العميل وشركة النخيل حضرا الاجتماع');
    expect(out).toMatch(/و⟦عميل_\d+⟧/);
  });

  it('longest match wins: the full descriptive phrase is captured as one token, nothing leaks', () => {
    const p = new Pseudonymizer([
      customer('CUST-1', 'النخيل'),
      customer('CUST-2', 'شركة النخيل للتجارة العامة'),
    ]);
    const out = p.redact('التعاقد مع شركة النخيل للتجارة العامة اليوم');
    expect(out).toMatch(/⟦عميل_\d+⟧ اليوم$/);
    expect(out).not.toContain('النخيل');
    expect(out).not.toContain('للتجارة');
    expect(out).not.toContain('العامة');
  });

  it('assigns different tokens to two different bare names', () => {
    const p = new Pseudonymizer([customer('CUST-1', 'النخيل'), customer('CUST-2', 'الفهد')]);
    const out = p.redact('تعاملنا مع النخيل ثم مع الفهد');
    expect(out).toMatch(/⟦عميل_1⟧/);
    expect(out).toMatch(/⟦عميل_2⟧/);
  });

  it('assigns the same token to the same surface mentioned twice', () => {
    const p = new Pseudonymizer([customer('CUST-1', 'النخيل')]);
    const out = p.redact('تعاملنا مع النخيل ثم راجعنا النخيل مرة أخرى');
    const matches = out.match(/⟦عميل_1⟧/g) ?? [];
    expect(matches.length).toBe(2);
    expect(out).not.toMatch(/⟦عميل_2⟧/);
  });

  it('distinguishes vendor and customer labels', () => {
    const p = new Pseudonymizer([customer('CUST-1', 'النخيل'), vendor('VEND-1', 'الفهد للحديد')]);
    const out = p.redact('العميل النخيل والمورد الفهد للحديد');
    expect(out).toMatch(/⟦عميل_\d+⟧/);
    expect(out).toMatch(/⟦مورد_\d+⟧/);
  });
});

describe('heuristic organization (not in any dictionary)', () => {
  it('detects a heuristic organization and does not leak the core word', () => {
    const p = new Pseudonymizer([]);
    const out = p.redact('وقّعنا مع شركة النخيل للمقاولات عقداً جديداً');
    expect(out).toMatch(/⟦جهة_1⟧/);
    expect(out).not.toContain('النخيل');
  });

  it('stops the organization capture before a stop word', () => {
    const p = new Pseudonymizer([]);
    const out = p.redact('تعاقدنا مع مؤسسة الأمل في المنطقة الشرقية');
    expect(out).toMatch(/⟦جهة_1⟧ في المنطقة الشرقية/);
  });
});

describe('idempotence and round trip', () => {
  it('redact is idempotent: redact(redact(x)) === redact(x)', () => {
    const p = new Pseudonymizer([customer('CUST-1', 'شركة النخيل')]);
    const once = p.redact('التعاقد مع شركة النخيل والبريد ahmad@example.com');
    const twice = p.redact(once);
    expect(twice).toBe(once);
  });

  it('rehydrate(redact(x)) === x exactly, byte for byte, on a mixed paragraph', () => {
    const p = new Pseudonymizer([
      customer('CUST-1', 'شركة النخيل'),
      vendor('VEND-1', 'الفهد للحديد والصلب'),
    ]);
    const paragraph = [
      'التقينا اليوم مع شركة النخيل لمناقشة العقد الجديد.',
      'راسلنا العميل على البريد ahmad.ali@example.com للمتابعة.',
      'رقم الآيبان الخاص بالتحويل هو SA0380000000608010167519.',
      'الرقم الضريبي للمورد الفهد للحديد والصلب هو 312345678900003.',
      'اتصل بنا خالد الحربي على 0512345678 صباحاً.',
      'طلب الشراء رقم PRJ-00012 لا يزال قيد المراجعة.',
      'القيمة الإجمالية المتوقعة 1,234,567.89 ريال شاملة الضريبة.',
      'موعد التسليم بتاريخ 2026-09-27 كما هو متفق.',
    ].join(' ');

    const redacted = p.redact(paragraph);
    const rehydrated = p.rehydrate(redacted);
    expect(rehydrated).toBe(paragraph);
  });

  it('leaves an unknown token in rehydrate input untouched', () => {
    const p = new Pseudonymizer([]);
    const out = p.rehydrate('راجع الملف ⟦عميل_99⟧ من فضلك');
    expect(out).toBe('راجع الملف ⟦عميل_99⟧ من فضلك');
  });

  it('leaves already-tokenized text as is on a second redact call (no double-wrapping)', () => {
    const p = new Pseudonymizer([customer('CUST-1', 'شركة النخيل')]);
    const once = p.redact('شركة النخيل موجودة');
    const twice = p.redact(once);
    expect(twice).toBe(once);
    expect((twice.match(/⟦عميل_\d+⟧/g) ?? []).length).toBe(1);
  });
});

describe('exportState / continuation', () => {
  it('continues numbering and rehydrates old tokens after reconstruction from exported state', () => {
    const p1 = new Pseudonymizer([customer('CUST-1', 'النخيل')]);
    const redacted1 = p1.redact('تعاملنا مع النخيل');
    const state = p1.exportState();
    expect(state.version).toBe(1);

    const p2 = new Pseudonymizer([customer('CUST-1', 'النخيل'), customer('CUST-2', 'الفهد')], state);
    const redacted2 = p2.redact('ثم تعاملنا مع الفهد');
    expect(redacted2).toMatch(/⟦عميل_2⟧/);

    // p2 can still rehydrate tokens minted by p1.
    expect(p2.rehydrate(redacted1)).toBe('تعاملنا مع النخيل');
  });
});

describe('redactJson / rehydrateJson', () => {
  it('redacts string leaves in a nested object while leaving keys untouched', () => {
    const p = new Pseudonymizer([customer('CUST-1', 'شركة النخيل')]);
    const value = {
      customerName: 'تعامل مع شركة النخيل',
      meta: { count: 3, active: true, notes: ['راسلنا على ahmad@example.com', null] },
    };
    const redactedJsonText = p.redactJson(value);
    const parsed = JSON.parse(redactedJsonText as unknown as string);
    expect(parsed.customerName).toMatch(/⟦عميل_\d+⟧/);
    expect(parsed.meta.count).toBe(3);
    expect(parsed.meta.active).toBe(true);
    expect(parsed.meta.notes[0]).toMatch(/⟦بريد_1⟧/);
    expect(parsed.meta.notes[1]).toBeNull();
  });

  it('rehydrates string leaves in a nested object/array structure', () => {
    const p = new Pseudonymizer([customer('CUST-1', 'شركة النخيل')]);
    const redacted = p.redact('شركة النخيل'); // mint the token first
    const token = redacted.match(/⟦عميل_\d+⟧/)![0];
    const value = {
      a: [`راجع ${token} اليوم`, { b: `${token} موافق` }],
    };
    const result = p.rehydrateJson(value);
    expect(result.a[0]).toBe('راجع شركة النخيل اليوم');
    expect((result.a[1] as { b: string }).b).toBe('شركة النخيل موافق');
  });
});

describe('staticPrompt / fromModelOutput', () => {
  it('staticPrompt returns the same characters unchanged', () => {
    const text = 'You are Madar, a helpful ERP copilot.';
    expect(staticPrompt(text) as unknown as string).toBe(text);
  });

  it('fromModelOutput returns the same characters unchanged', () => {
    const text = 'إليك ملخص العقد الذي طلبته.';
    expect(fromModelOutput(text) as unknown as string).toBe(text);
  });
});

describe('type-level guard', () => {
  it('a plain string is not assignable to RedactedText', () => {
    // @ts-expect-error a bare string must not satisfy the branded RedactedText type
    const _bad: import('../src/privacy/pseudonymizer').RedactedText = 'plain string';
    void _bad;
  });
});



// Added in review: what a name capture may and may not take with it.
describe('Pseudonymizer — review additions', () => {
  const dictionary = [
    { kind: 'customer' as const, npiId: 'c1', names: ['شركة النخيل للمقاولات'] },
    { kind: 'employee' as const, npiId: 'u1', names: ['خالد العتيبي'] },
  ];

  it('stops a captured name at the verb that follows it, and does not learn the verb', () => {
    const p = new Pseudonymizer(dictionary);
    const first = p.redact('السيد ماجد الحربي وافق على الطلب');
    expect(first).toMatch(/^السيد ⟦شخص_\d+⟧ وافق على الطلب$/);
    expect(p.redact('هل وافق المدير على الطلب؟')).toBe('هل وافق المدير على الطلب؟');
  });

  it('does not take an honorific used as an ordinary noun for the start of a name', () => {
    const p = new Pseudonymizer(dictionary);
    expect(p.redact('المهندس طلب 40 لوح للمشروع PRJ-00012')).toBe('المهندس طلب 40 لوح للمشروع PRJ-00012');
    expect(p.redact('طلب شراء جديد')).toBe('طلب شراء جديد');
  });

  it('redacts a single known given name after an honorific', () => {
    const p = new Pseudonymizer([]);
    expect(p.redact('المهندس ماجد في الموقع')).toMatch(/^المهندس ⟦شخص_\d+⟧ في الموقع$/);
  });

  it('redacts a name that carries an attached conjunction and keeps the conjunction', () => {
    const p = new Pseudonymizer([]);
    const out = p.redact('حضر الاجتماع وأحمد محمد الشهري من طرف العميل');
    expect(out).not.toContain('أحمد');
    expect(out).not.toContain('الشهري');
    expect(out).toMatch(/ و⟦شخص_\d+⟧ من طرف العميل$/);
    expect(p.rehydrate(out)).toBe('حضر الاجتماع وأحمد محمد الشهري من طرف العميل');
  });

  it('joinRedacted concatenates parts without changing them', () => {
    const p = new Pseudonymizer(dictionary);
    const joined = joinRedacted([staticPrompt('A\n'), p.redact('شركة النخيل للمقاولات'), staticPrompt('\nB')]);
    expect(joined).toMatch(/^A\n⟦عميل_\d+⟧\nB$/);
  });
});

// Added in review: a value that was given a placeholder stays masked.
describe('Pseudonymizer — values masked in a tool result', () => {
  it('stay masked when the answer comes back as history and when the user types them', () => {
    const p = new Pseudonymizer([]);
    p.redactJson(
      { vendorNameAr: 'الفجر للتوريدات', projects: [{ nameAr: 'توسعة المستودع' }], phone: '0138001234' },
      { vendorNameAr: 'مورد', nameAr: 'مشروع', phone: 'هاتف' },
    );
    const answer = p.rehydrate('المورد ⟦مورد_1⟧ تأخر في مشروع ⟦مشروع_1⟧، هاتفه ⟦هاتف_1⟧');
    expect(answer).toBe('المورد الفجر للتوريدات تأخر في مشروع توسعة المستودع، هاتفه 0138001234');

    const history = p.redact(answer);
    expect(history).toBe('المورد ⟦مورد_1⟧ تأخر في مشروع ⟦مشروع_1⟧، هاتفه ⟦هاتف_1⟧');

    expect(p.redact('وش آخر أخبار الفجر للتوريدات؟')).toBe('وش آخر أخبار ⟦مورد_1⟧؟');
  });

  it('stay masked after the conversation state is saved and restored', () => {
    const p = new Pseudonymizer([]);
    p.redactJson({ vendorNameAr: 'الفجر للتوريدات' }, { vendorNameAr: 'مورد' });
    const restored = new Pseudonymizer([], p.exportState());
    expect(restored.redact('اتصل على الفجر للتوريدات اليوم')).toBe('اتصل على ⟦مورد_1⟧ اليوم');
  });
});
