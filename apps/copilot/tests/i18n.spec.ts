import { ar, t, type ArKey } from '@/i18n/ar';

// Tokens the design spec explicitly allows inside otherwise-Arabic strings
// (spec/madar/08 §E.8): NPI / CSV / EPC / PPA, and document codes shaped
// like PRJ-00012 / INV-1234.
const ALLOWED_WORD_TOKENS = new Set(['NPI', 'CSV', 'EPC', 'PPA']);
const ALLOWED_CODE_RE = /^[A-Z]{2,4}-\d+$/;
const PLACEHOLDER_RE = /\{[^}]+\}/g;
const LATIN_WORD_RE = /[A-Za-z][A-Za-z0-9-]*/g;

describe('ar i18n map', () => {
  it('has every canonical key from 03 §4 with the exact value', () => {
    const expected: Record<string, string> = {
      'app.name': 'مَدار — مساعد NPI',
      'nav.back_to_npi': 'العودة إلى NPI',
      'home.tile.inbox': 'مهام بانتظار اعتمادك',
      'home.tile.contracts_draft': 'عقود بانتظار التفعيل',
      'home.tile.pr_pending': 'طلبات شراء معلقة',
      'home.tile.bills_unmatched': 'فواتير موردين بانتظار المطابقة',
      'chat.attach': 'أرفق مستنداً',
      'chat.suggest.2': 'طلب شراء: 40 لوح 550 واط للمشروع PRJ-00012',
      'intake.reading': 'أقرأ المستند… صفحة {n} من {total}',
      'intake.refused_confidential':
        'هذا المستند موسوم «سري» ولن يُرسل إلى أي نموذج خارجي. يمكنك إدخاله من شاشة NPI.',
      'consent.title': 'سيُرسل هذا المستند كصورة إلى مزوّد النماذج',
      'flow.unknown': 'لم أحدد نوع المستند — اختر:',
      'preview.title': 'هذا ما سأُدخله في NPI',
      'preview.evidence': 'المصدر: صفحة {page}: «{quote}»',
      'exec.failed': 'توقفت عند الخطوة {n}: {reason} ما أُنشئ حتى الآن: {created}',
      'setup.q1': 'ما نشاط المنشأة وخطوط إيرادها؟',
      'profile.epc': 'مقاول EPC (تصميم وتوريد وتركيب)',
      'trust.col.image_sent': 'صورة أُرسلت',
      'metrics.a5': 'الإدخال بالمحادثة',
      'hr.refusal': 'هذا قرار بشري يخص أداء الموظفين، ولا أقدّم فيه تقييماً أو توصية.',
    };
    for (const [key, value] of Object.entries(expected)) {
      expect(ar[key as ArKey]).toBe(value);
    }
    // At least 15 spot-checked above, including the six named by the task.
    expect(Object.keys(expected).length).toBeGreaterThanOrEqual(15);
    for (const mustHave of [
      'app.name',
      'consent.title',
      'preview.title',
      'exec.failed',
      'hr.refusal',
      'intake.refused_confidential',
    ] as const) {
      expect(mustHave in expected).toBe(true);
    }
  });

  it('has every derived base-set key (D-7) with the exact value', () => {
    const expected: Record<string, string> = {
      'login.title': 'تسجيل الدخول',
      'login.subtitle': 'ادخل بحسابك في NPI',
      'login.email': 'البريد الإلكتروني',
      'login.password': 'كلمة المرور',
      'login.submit': 'دخول',
      'login.submitting': 'جارٍ الدخول…',
      'login.error.invalid': 'بيانات الدخول غير صحيحة',
      'login.error.rate_limited': 'محاولات كثيرة. حاول بعد قليل.',
      'login.error.npi_down': 'NPI غير متاح حالياً',
      logout: 'تسجيل الخروج',
      'nav.home': 'الرئيسية',
      'nav.chat': 'المحادثة',
      'nav.settings': 'الإعدادات',
      'nav.trust': 'الثقة',
      'nav.metrics': 'القياس',
      'nav.handover': 'دليل الاستلام',
      'nav.setup': 'التأسيس',
      'nav.main': 'التنقل الرئيسي',
      'home.greeting': 'مرحباً {name}',
      'home.empty': 'ابدأ: أرفق عقداً أو اكتب «طلب شراء…»',
      'home.error.npi': 'تعذر الوصول إلى NPI',
      'action.retry': 'أعد المحاولة',
      'chat.placeholder': 'اكتب رسالتك…',
      'chat.send': 'أرسل',
      'chat.mic': 'إدخال صوتي',
      'chat.waiting': 'أفكّر…',
      'memory.note': 'ملاحظة من الذاكرة',
      'state.loading': 'جارٍ التحميل…',
      'state.empty': 'لا توجد بيانات بعد',
      'state.error': 'حدث خطأ غير متوقع',
      'settings.title': 'الإعدادات',
      'trust.title': 'الثقة',
      'metrics.title': 'القياس',
      'handover.title': 'دليل الاستلام',
      'setup.title': 'لنهيّئ مَدار لمنشأتك',
      'document.error.unreadable': 'تعذر قراءة المستند؛ جرّب صورة أوضح',
      'setup.loading': 'أفهم إجابتك…',
      'setup.error.apply': 'تعذر تطبيق الإعداد في NPI: {reason}',
    };
    for (const [key, value] of Object.entries(expected)) {
      expect(ar[key as ArKey]).toBe(value);
    }
  });

  it('contains no Latin letters beyond the allowed tokens and codes', () => {
    const offenders: string[] = [];
    for (const [key, value] of Object.entries(ar)) {
      const stripped = (value as string).replace(PLACEHOLDER_RE, '');
      const words = stripped.match(LATIN_WORD_RE) ?? [];
      for (const word of words) {
        if (ALLOWED_WORD_TOKENS.has(word)) continue;
        if (ALLOWED_CODE_RE.test(word)) continue;
        offenders.push(`${key}: "${word}"`);
      }
    }
    expect(offenders).toEqual([]);
  });

  describe('t()', () => {
    it('replaces placeholders from vars', () => {
      expect(t('home.greeting', { name: 'إياد' })).toBe('مرحباً إياد');
      expect(t('intake.reading', { n: 2, total: 5 })).toBe('أقرأ المستند… صفحة 2 من 5');
    });

    it('leaves an unknown placeholder untouched', () => {
      expect(t('home.greeting')).toBe('مرحباً {name}');
      expect(t('home.greeting', {})).toBe('مرحباً {name}');
      expect(t('exec.failed', { n: 2 })).toBe(
        'توقفت عند الخطوة 2: {reason} ما أُنشئ حتى الآن: {created}',
      );
    });

    it('never throws, even for a missing key cast through the type', () => {
      expect(() => t('not.a.real.key' as ArKey)).not.toThrow();
      expect(() => t('home.greeting', undefined)).not.toThrow();
    });
  });
});
