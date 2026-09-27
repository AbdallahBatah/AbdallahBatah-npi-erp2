/**
 * Canonical Arabic UI strings for the copilot app.
 *
 * The block under "Canonical (03 §4)" is transcribed verbatim, character for
 * character, from spec/madar/03-DESIGN-SPEC.md §4 — the design spec's
 * authority for visible strings.
 *
 * The block under "Derived base set (D-7)" is NOT from the spec: package 3.0
 * refers to a "2.0 base set" that does not exist in this repository, so this
 * set was authored to cover the same ground (login, nav, generic states).
 * This is decision D-7 and is logged under Deviations in PROGRESS.md.
 *
 * No visible string in this file may contain a Latin letter, except the
 * allowed tokens NPI / CSV / EPC / PPA and document codes matching
 * `[A-Z]{2,4}-\d+` (see spec/madar/08 §E.8) — enforced by tests/i18n.spec.ts.
 */
export const ar = {
  // ── Canonical (03 §4) ──────────────────────────────────────────────────
  'app.name': 'مَدار — مساعد NPI',
  'nav.back_to_npi': 'العودة إلى NPI',

  'home.tile.inbox': 'مهام بانتظار اعتمادك',
  'home.tile.contracts_draft': 'عقود بانتظار التفعيل',
  'home.tile.pr_pending': 'طلبات شراء معلقة',
  'home.tile.bills_unmatched': 'فواتير موردين بانتظار المطابقة',

  'chat.attach': 'أرفق مستنداً',
  'chat.camera': 'صوّر المستند',
  'chat.suggest.1': 'أرفق عقداً جديداً وسأُدخله',
  'chat.suggest.2': 'طلب شراء: 40 لوح 550 واط للمشروع PRJ-00012',
  'chat.suggest.3': 'وش المهام اللي تنتظرني؟',

  'intake.reading': 'أقرأ المستند… صفحة {n} من {total}',
  'intake.kind.pdf_text': 'ملف نصي',
  'intake.kind.pdf_scanned': 'ممسوح ضوئياً',
  'intake.kind.image': 'صورة',
  'intake.refused_confidential':
    'هذا المستند موسوم «سري» ولن يُرسل إلى أي نموذج خارجي. يمكنك إدخاله من شاشة NPI.',

  'consent.title': 'سيُرسل هذا المستند كصورة إلى مزوّد النماذج',
  'consent.body':
    'لا يمكن إخفاء الأسماء في الصور قبل الإرسال. {policy_line} سيُسجَّل هذا الإرسال في سجل الثقة.',
  'consent.approve': 'اعتمد الإرسال',
  'consent.cancel': 'ألغِ',
  'consent.policy_unverified': '(سياسة المزوّد قيد التحقق)',

  'flow.customer_contract': 'عميل وعقد',
  'flow.pr': 'طلب شراء',
  'flow.po': 'أمر شراء',
  'flow.grn': 'استلام بضاعة',
  'flow.vendor_bill': 'فاتورة مورد',
  'flow.unknown': 'لم أحدد نوع المستند — اختر:',

  'preview.title': 'هذا ما سأُدخله في NPI',
  'preview.confirmed': 'مؤكد',
  'preview.unconfirmed': 'غير مؤكد — أكّده',
  'preview.evidence': 'المصدر: صفحة {page}: «{quote}»',
  'preview.will_execute': 'ما سيُنفَّذ بالترتيب',
  'preview.approve': 'اعتمد',
  'preview.edit': 'عدّل',
  'preview.cancel': 'ألغِ',
  'preview.edit_prompt': 'اكتب التعديل بجملة (مثال: القيمة 850,000 والمحتجزات 10%)',
  'preview.customer_match': 'وجدت عميلاً مطابقاً: {name} — استخدمه؟',
  'preview.customer_new': 'عميل جديد سيُنشأ',
  'preview.item_new': 'صنف جديد سيُقترح إنشاؤه',

  'exec.running': 'أُنفّذ في NPI…',
  'exec.done': 'تم. {entity} برقم {code}',
  'exec.failed': 'توقفت عند الخطوة {n}: NPI رفض: {reason}. ما أُنشئ حتى الآن: {created}',
  'exec.after_matrix': 'سيمر الآن بمصفوفة الاعتمادات كالمعتاد',

  'setup.q1': 'ما نشاط المنشأة وخطوط إيرادها؟',
  'setup.q2': 'ما الأقسام والمناصب؟ ومن يشغلها من مستخدمي NPI؟',
  'setup.q3': 'ما سقوف الاعتماد لكل مستند؟',
  'setup.q4': 'ما المستندات التي ستُدخلها بالمحادثة؟',
  'setup.q5': 'ما الأصناف الشائعة؟',
  'setup.q6': 'هل تفضّل مصطلحات معينة؟',
  'setup.diff': 'سأضبط في NPI',
  'setup.gap': 'لا تتيحه واجهة NPI حالياً',

  'profile.epc': 'مقاول EPC (تصميم وتوريد وتركيب)',
  'profile.om_provider': 'مزوّد تشغيل وصيانة',
  'profile.ppa_operator': 'مشغّل بيع طاقة/تأجير',
  'profile.general_contracting': 'مقاولات عامة',
  'profile.equipment_trading': 'تجارة معدات',
  'profile.engineering_consulting': 'استشارات هندسية',

  'trust.col.image_sent': 'صورة أُرسلت',
  'metrics.a5': 'الإدخال بالمحادثة',
  'metrics.a6': 'التشكّل الذاتي',
  'metrics.baseline': 'الزمن اليدوي المرجعي (يُقاس مرة): {value}',

  'hr.refusal': 'هذا قرار بشري يخص أداء الموظفين، ولا أقدّم فيه تقييماً أو توصية.',

  // ── Derived base set (D-7) — replaces the unavailable 2.0 base set ─────
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

  'chat.error.generic': 'تعذر إكمال الطلب. حاول مرة أخرى.',
  'chat.error.too_long': 'الرسالة أطول من الحد المسموح. اختصرها وأعد الإرسال.',
  // Until the intake flows of milestone 3 are built, a message that asks for
  // one is answered with this fixed text instead of a promise the app
  // cannot keep.
  'chat.flow_pending':
    'فهمت أنك تريد إدخال «{flow}». الإدخال بالمحادثة يُفعَّل في مرحلة لاحقة؛ أستطيع الآن الإجابة عن أسئلتك من بيانات NPI.',
  'chat.flow_pending.unknown':
    'إدخال المستندات بالمحادثة يُفعَّل في مرحلة لاحقة؛ أستطيع الآن الإجابة عن أسئلتك من بيانات NPI.',
  'chat.flow_unavailable': 'إدخال «{flow}» غير مفعّل لمنشأتك في إعدادات مَدار.',
} as const;

export type ArKey = keyof typeof ar;

/**
 * Renders `key`'s value, replacing `{placeholder}` tokens from `vars`.
 * A placeholder with no matching entry in `vars` is left untouched, and this
 * function never throws (a missing key falls back to the key itself so a
 * typo surfaces visibly instead of crashing the UI).
 */
export function t(key: ArKey, vars?: Record<string, string | number>): string {
  const template: string = ar[key] ?? key;
  if (!vars) return template;
  return template.replace(/\{(\w+)\}/g, (match, name: string) => {
    const value = vars[name];
    return value === undefined ? match : String(value);
  });
}
