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
  'login.error.required': 'أدخل البريد الإلكتروني وكلمة المرور.',
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
  'home.tile.no_access': 'لا صلاحية للاطلاع',

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
  'setup.unclear': 'لم أفهم الإجابة؛ اكتبها بصيغة أخرى أو اختر من المقترح.',
  'setup.forbidden': 'الإعداد متاح لمدير النظام فقط.',
  'setup.invalid_answer': 'الإجابة لا تتفق مع بقية الإعداد: {detail}',

  'chat.error.generic': 'تعذر إكمال الطلب. حاول مرة أخرى.',
  'chat.error.too_long': 'الرسالة أطول من الحد المسموح. اختصرها وأعد الإرسال.',
  // Attachments and voice input belong to later milestones (F-02/F-03's
  // intake flows); the composer shows this as the tooltip on their disabled
  // buttons rather than pretending they work.
  'chat.later': 'يُفعَّل في مرحلة لاحقة',
  // Until the intake flows of milestone 3 are built, a message that asks for
  // one is answered with this fixed text instead of a promise the app
  // cannot keep.
  'chat.flow_pending':
    'فهمت أنك تريد إدخال «{flow}». الإدخال بالمحادثة يُفعَّل في مرحلة لاحقة؛ أستطيع الآن الإجابة عن أسئلتك من بيانات NPI.',
  'chat.flow_pending.unknown':
    'إدخال المستندات بالمحادثة يُفعَّل في مرحلة لاحقة؛ أستطيع الآن الإجابة عن أسئلتك من بيانات NPI.',
  'chat.flow_unavailable': 'إدخال «{flow}» غير مفعّل لمنشأتك في إعدادات مَدار.',
  'chat.later_hint': 'إرفاق المستندات والإدخال الصوتي يُفعَّلان في مرحلة لاحقة.',

  'notfound.title': 'الصفحة غير موجودة',
  'notfound.body': 'تحقق من العنوان أو عد إلى الرئيسية.',

  'brand.npi_alt': 'شعار NPI',

  // ── Setup screens (T-18) ────────────────────────────────────────────────
  'setup.step_of': 'الخطوة {n} من {total}',
  'setup.save_step': 'احفظ وتابع',
  'setup.back': 'السابق',
  'setup.free_text': 'أو اكتب التعديل بجملة…',
  'setup.choose_step': 'اختر الخطوة',
  'setup.step.1': 'النشاط',
  'setup.step.2': 'الأقسام والمناصب',
  'setup.step.3': 'سقوف الاعتماد',
  'setup.step.4': 'المستندات',
  'setup.step.5': 'الأصناف',
  'setup.step.6': 'المصطلحات',
  'setup.step.7': 'الملخص',

  'setup.profile.pick': 'اختر نشاط المنشأة',
  'setup.profile.change_warning': 'تغيير النشاط يمسح إجابات الخطوات التالية',

  'setup.departments': 'الأقسام',
  'setup.positions': 'المناصب',
  'setup.dept.code': 'الرمز',
  'setup.dept.name': 'الاسم',
  'setup.dept.code_invalid': 'الرمز: حرف إنجليزي كبير ثم حروف كبيرة أو أرقام أو شرطات',
  'setup.dept.in_use': 'قسم مرتبط بمنصب',
  'setup.add': 'أضف',
  'setup.remove': 'أزل',
  'setup.keep': 'يُضبط',
  'setup.position.title': 'المسمى',
  'setup.position.department': 'القسم',
  'setup.position.no_department': 'بلا قسم',
  'setup.holders': 'شاغلو المنصب من مستخدمي NPI',
  'setup.holders.none': 'لا مستخدم نشط بهذا الدور في NPI',
  'setup.holders.note': 'الاختيار يُحفظ في مَدار فقط ولا يغيّر شيئاً في حسابات NPI',

  'setup.rule.doc': 'المستند',
  'setup.rule.min': 'من مبلغ (ريال)',
  'setup.rule.max': 'إلى أقل من (اختياري)',
  'setup.rule.chain': 'سلسلة الاعتماد',
  'setup.rule.add_role': 'أضف دوراً',
  'setup.doc.no_flow': 'يُدخل من شاشة NPI',

  'setup.item.sku': 'الرمز',
  'setup.item.name': 'الاسم',
  'setup.item.name_en': 'الاسم بالإنجليزية',
  'setup.item.category': 'التصنيف',
  'setup.item.uom': 'الوحدة',
  'setup.item.serialised': 'متسلسل',
  'setup.item.category.MODULE': 'ألواح',
  'setup.item.category.INVERTER': 'عواكس',
  'setup.item.category.MOUNTING': 'هياكل تثبيت',
  'setup.item.category.CABLE': 'كابلات',
  'setup.item.category.BOS': 'ملحقات ومواد',
  'setup.item.category.SPARE': 'قطع غيار',
  'setup.item.category.SERVICE': 'خدمات',

  'setup.term.customer': 'العميل',
  'setup.term.vendor': 'المورد',
  'setup.term.project': 'المشروع',
  'setup.term.contract': 'العقد',
  'setup.term.requisition': 'طلب الشراء',
  'setup.term.purchase_order': 'أمر الشراء',
  'setup.term.receipt': 'الاستلام',
  'setup.term.vendor_bill': 'فاتورة المورد',
  'setup.term.item': 'الصنف',
  'setup.term.department': 'القسم',
  'setup.terms.hint': 'اترك الحقل فارغاً للاحتفاظ بالمصطلح المعتاد',

  'setup.diff.npi': 'ما سيُكتب في NPI',
  'setup.diff.already': 'موجود في NPI أصلاً',
  'setup.diff.copilot': 'سأضبط في المحادثة',
  'setup.diff.blocked': 'لن يُنفَّذ الآن',
  'setup.diff.added': 'صلاحيات ستُضاف',
  'setup.diff.removed': 'صلاحيات ستُسحب',
  'setup.diff.counts': 'إنشاء {create} · تحديث {update} · موجود {skip} · محجوب {blocked}',
  'setup.apply.note': 'سيُكتب في NPI بحسابك وصلاحياتك؛ ما يرفضه NPI يُعرض كما هو',
  'setup.applying': 'أضبط في NPI…',
  'setup.apply.done': 'تم ضبط الإعداد في NPI',
  'setup.preview.loading': 'أحسب الفروق مع NPI…',

  'setup.result.created': 'أُنشئ',
  'setup.result.updated': 'حُدِّث',
  'setup.result.skipped': 'موجود أصلاً',
  'setup.result.blocked': 'محجوب',
  'setup.result.failed': 'رفضه NPI',

  'setup.positions_written': 'المناصب المحفوظة في مَدار: {n}',
  'setup.assignments_written': 'تعيينات شاغلي المناصب: {n}',
  'setup.holder_skipped.position_missing': 'لم يُحفظ التعيين: المنصب بلا قسم في NPI',
  'setup.holder_skipped.unknown_user': 'لم يُحفظ التعيين: المستخدم غير موجود في NPI',
  'setup.holder_skipped.inactive': 'لم يُحفظ التعيين: المستخدم موقوف في NPI',
  'setup.holder_skipped.role_mismatch': 'لم يُحفظ التعيين: دور المستخدم في NPI يختلف عن دور المنصب',
  'setup.holder_skipped.directory_unreadable': 'لم يُحفظ التعيين: تعذر قراءة دليل المستخدمين من NPI',

  // Settings screen (T-19, F-15) — derived under D-7 (package 2.0 absent).
  'settings.intro': 'ما ضبطه التأسيس في مَدار. لتعديل قسم، أعد خطوته في التأسيس',
  'settings.forbidden': 'الإعدادات متاحة لمدير النظام فقط.',
  'settings.no_config': 'لم يُطبَّق التأسيس بعد',
  'settings.go_setup': 'ابدأ التأسيس',
  'settings.open_setup_note': 'توجد جلسة تأسيس مفتوحة؛ ستُستأنف من حيث توقفت',
  'settings.rerun': 'أعد الخطوة',
  'settings.rerun.profile': 'غيّر النشاط',
  'settings.rerun.note': 'ستنتقل إلى التأسيس عند هذه الخطوة بإجاباتك السابقة، ثم تُراجع الفروق وتعتمدها',
  'settings.profile': 'ملف النشاط',
  'settings.profile.completed_at': 'طُبّق في {date}',
  'settings.profile.incomplete': 'آخر تطبيق لم يكتمل',
  'settings.modules': 'الوحدات الظاهرة',
  'settings.modules.hint': 'الوحدة المخفية لا تظهر في المحادثة ولا تُقترح مستنداتها. المالية تبقى ظاهرة دائماً',
  'settings.modules.hides_flows': 'إخفاؤها يوقف: {flows}',
  'settings.modules.save': 'احفظ الوحدات',
  'settings.modules.saved': 'حُفظت الوحدات',
  'settings.modules.invalid': 'اختر وحدة واحدة على الأقل مع المالية',
  'settings.doc_types': 'المستندات المقبولة',
  'settings.doc_types.hidden_module': 'وحدتها مخفية',
  'settings.terminology': 'المصطلحات',
  'settings.terminology.empty': 'لا مصطلحات خاصة؛ تُستخدم المصطلحات المعتادة',
  'settings.positions': 'المناصب',
  'settings.positions.empty': 'لا مناصب محفوظة بعد',
  'settings.positions.no_department': 'بلا قسم',
  'settings.positions.no_holder': 'بلا شاغل',
  'settings.positions.unknown_user': 'مستخدم غير معروف',
  'settings.positions.since': 'منذ {date}',
  'settings.baselines': 'الزمن اليدوي المرجعي',
  'settings.baselines.hint': 'قِس مرة واحدة بساعة إيقاف كم يستغرق إدخال المستند من شاشة NPI، وأدخل الدقائق',
  'settings.baselines.minutes': 'الدقائق',
  'settings.baselines.save': 'احفظ',
  'settings.baselines.saved': 'حُفظ',
  'settings.baselines.none': 'لم يُقَس بعد',
  'settings.baselines.measured': '{minutes} دقيقة، قيس في {date}',
  'settings.baselines.invalid': 'أدخل عدد دقائق صحيحاً بين {min} و{max}',
  'settings.last_apply': 'آخر تطبيق في NPI',
  'settings.last_apply.at': 'في {date}',
  'settings.last_apply.clean': 'كل شيء طُبّق',
  'settings.last_apply.blocked': 'لم يُنفَّذ',
  'settings.last_apply.failed': 'رفضه NPI',
  'settings.last_apply.gaps': 'لا تتيحه واجهة NPI حالياً',
  'settings.last_apply.retry': 'أعد هذه الخطوة',
  'settings.leftover.department': 'قسم {code}',
  'settings.leftover.role': 'دور {name}',
  'settings.leftover.approval_rule': 'سقف {doc} من {min}',
  'settings.leftover.item': 'صنف {sku}',
  'settings.leftover.unknown': 'خطوة {id}',
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
