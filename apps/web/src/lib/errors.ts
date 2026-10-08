import { ApiError } from './api';
import type { Locale } from './messages';

/**
 * Maps known backend (English) error messages to novice-friendly localized
 * text. Unknown messages fall back to a generic sentence per HTTP status,
 * with the original text appended for troubleshooting.
 */
const PATTERNS: Array<{ re: RegExp; ar: string; en?: string }> = [
  // procurement / inventory
  { re: /exceeds remaining/i, ar: 'الكمية المدخلة تتجاوز الكمية المتبقية في أمر الشراء' },
  { re: /serial numbers required, got/i, ar: 'عدد الأرقام التسلسلية المدخلة لا يطابق الكمية المستلمة' },
  { re: /duplicate serial/i, ar: 'يوجد رقم تسلسلي مكرر — تحقق من القائمة' },
  { re: /already exists for item/i, ar: 'أحد الأرقام التسلسلية مسجل مسبقاً في النظام' },
  { re: /insufficient stock/i, ar: 'المخزون في الموقع المصدر غير كافٍ للكمية المطلوبة' },
  { re: /source equals destination/i, ar: 'موقعا النقل متطابقان — اختر موقعاً مختلفاً' },
  { re: /only IN_STOCK/i, ar: 'هذه العملية متاحة فقط للوحدات الموجودة في المخزون' },
  { re: /serialised items are replaced via the RMA/i, ar: 'الأصناف المتسلسلة تُستبدل عبر مطالبة ضمان من صفحة الأصول، لا كقطع غيار' },
  { re: /no PLANT asset yet/i, ar: 'لا توجد محطة مسجلة للمشروع بعد — ركّب وحدة تسلسلية أولاً' },
  // documents / lifecycle
  {
    re: /requires an accepted proposal revision/i,
    ar: 'لا يمكن إنشاء عقد إلا من مراجعة عرض مقبولة — اقبل المراجعة أولاً',
  },
  {
    re: /must be a Saudi VAT number/i,
    ar: 'الرقم الضريبي غير صحيح — 15 رقماً يبدأ وينتهي بالرقم 3',
  },
  { re: /only draft/i, ar: 'هذه العملية متاحة للمسودات فقط' },
  { re: /only in-progress/i, ar: 'أمر العمل ليس قيد التنفيذ' },
  { re: /already converted/i, ar: 'تم تحويل هذا العميل المحتمل مسبقاً' },
  // Server-enforced project lifecycle: forward one stage at a time.
  {
    re: /cannot move a project from/i,
    ar: 'لا يمكن القفز بين مراحل المشروع — انتقل إلى المرحلة التالية مباشرة',
  },
  { re: /cannot cancel: parts/i, ar: 'لا يمكن الإلغاء بعد صرف قطع غيار — أكمل أمر العمل وأغلقه' },
  { re: /mandatory checklist item not done/i, ar: 'يوجد بند إلزامي في قائمة الفحص لم يُنجز بعد' },
  // finance
  { re: /payment exceeds outstanding/i, ar: 'المبلغ المدخل يتجاوز الرصيد المتبقي للفاتورة' },
  { re: /period overlaps/i, ar: 'الفترة المحددة تتداخل مع تسوية سابقة' },
  { re: /no telemetry readings/i, ar: 'لا توجد قراءات إنتاج في الفترة المحددة' },
  { re: /nothing to recognize/i, ar: 'لا يوجد فرق مستحق للترحيل' },
  { re: /retention (is )?already released/i, ar: 'تم الإفراج عن المحتجزات مسبقاً' },
  { re: /withheld no retention/i, ar: 'لا توجد محتجزات على هذا المستخلص' },
  { re: /cannot release retention on a/i, ar: 'حالة المستخلص لا تسمح بالإفراج عن المحتجز' },
  {
    re: /missing GL account|re-run the seed|missing posting rule/i,
    ar: 'خطأ في إعدادات دليل الحسابات — راجع مسؤول النظام',
  },
  {
    re: /missing standard VAT tax code/i,
    ar: 'لم تُضبط نسبة ضريبة القيمة المضافة — راجع مسؤول النظام',
  },
  // payables
  { re: /exceeds its outstanding balance/i, ar: 'المبلغ المدخل يتجاوز المتبقي على هذا المستند' },
  // credit notes
  { re: /credit amount exceeds the remaining/i, ar: 'مبلغ الإشعار يتجاوز المتبقي من الفاتورة' },
  { re: /already fully credited/i, ar: 'صدرت إشعارات دائنة بكامل قيمة الفاتورة' },
  { re: /credit note cannot itself be credited/i, ar: 'لا يمكن إصدار إشعار دائن على إشعار دائن' },
  { re: /only a reported invoice can be credited/i, ar: 'الإشعار الدائن يُصدر على فاتورة مُبلَّغة فقط' },
  {
    re: /retention on a cancelled invoice/i,
    ar: 'الفاتورة ملغاة بإشعار دائن — لا يمكن الإفراج عن محتجزاتها',
  },
  { re: /is not an open payable/i, ar: 'هذا المستند ليس ضمن المستحقات القائمة لهذا المورد' },
  { re: /needs at least one allocation/i, ar: 'حدّد مستنداً واحداً على الأقل للسداد' },
  // fiscal calendar
  {
    re: /accounting period .* is closed/i,
    ar: 'الفترة المحاسبية لهذا التاريخ مقفلة — أعد فتحها أولاً',
  },
  { re: /fiscal year .* already exists/i, ar: 'السنة المالية مفتوحة مسبقاً' },
  { re: /fiscal year is already closed/i, ar: 'السنة المالية مقفلة مسبقاً' },
  { re: /fiscal year is already open/i, ar: 'السنة المالية مفتوحة مسبقاً' },
  { re: /the fiscal year is closed/i, ar: 'السنة المالية مقفلة — أعد فتح السنة أولاً' },
  { re: /period is already (closed|open)/i, ar: 'الفترة بالفعل في هذه الحالة' },
  { re: /journal not balanced/i, ar: 'قيد محاسبي غير متوازن — راجع مسؤول النظام' },
  { re: /invalid from\/to date/i, ar: 'تاريخ غير صالح — اختر التاريخ من التقويم' },
  { re: /period end is before/i, ar: 'تاريخ نهاية الفترة أسبق من تاريخ بدايتها' },
  { re: /account not found/i, ar: 'الحساب غير موجود في دليل الحسابات' },
  // attachments
  { re: /no file uploaded/i, ar: 'لم يُحدد ملف — اختر ملفاً أولاً' },
  { re: /exceeds the 10 MB limit|file too large/i, ar: 'حجم الملف يتجاوز الحد الأقصى 10MB' },
  { re: /file type .* is not allowed/i, ar: 'نوع الملف غير مسموح — الأنواع المتاحة: PDF، صور، Excel، Word، CSV، ZIP، DWG' },
  { re: /stored file is missing/i, ar: 'ملف المرفق مفقود من الخادم — راجع مسؤول النظام' },
  { re: /attachment not found/i, ar: 'المرفق غير موجود' },
  { re: /unknown attachment entity/i, ar: 'نوع السجل غير مدعوم للمرفقات' },
  // users & roles administration
  { re: /email already in use/i, ar: 'البريد الإلكتروني مستخدم مسبقاً' },
  { re: /cannot deactivate your own account/i, ar: 'لا يمكنك إيقاف حسابك أنت — اطلب من مسؤول آخر' },
  { re: /last active administrator/i, ar: 'لا يمكن إزالة آخر مسؤول نشط — عيّن مسؤولاً آخر أولاً' },
  { re: /last administrator role/i, ar: 'لا يمكن سحب إدارة المستخدمين من دور المسؤول الأخير' },
  { re: /primary role cannot also be an extra role/i, ar: 'الدور الأساسي لا يُضاف كدور إضافي — اختر أدواراً إضافية مختلفة' },
  { re: /extra roles must not contain duplicates/i, ar: 'الأدوار الإضافية تحتوي على تكرار — اختر كل دور مرة واحدة' },
  { re: /role still has users assigned/i, ar: 'الدور مسند إلى مستخدمين — انقلهم إلى دور آخر أولاً' },
  { re: /role key already in use/i, ar: 'المعرّف التقني مستخدم مسبقاً — اختر معرّفاً آخر' },
  { re: /key must be a lowercase slug/i, ar: 'المعرّف التقني: حروف إنجليزية صغيرة وأرقام و _ فقط' },
  { re: /unknown permission key/i, ar: 'صلاحية غير معروفة — حدّث الصفحة وحاول مجدداً' },
  { re: /current password is incorrect/i, ar: 'كلمة المرور الحالية غير صحيحة' },
  { re: /must differ from the current/i, ar: 'كلمة المرور الجديدة مطابقة للحالية — اختر كلمة مختلفة' },
  { re: /newPassword must be longer|password must be longer/i, ar: 'كلمة المرور قصيرة — 8 أحرف على الأقل' },
  // departments
  { re: /department code already in use/i, ar: 'رمز القسم مستخدم مسبقاً — اختر رمزاً آخر' },
  {
    re: /code must be an uppercase slug/i,
    ar: 'رمز القسم: حروف إنجليزية كبيرة وأرقام و _ و - فقط، مثل ENG',
  },
  { re: /cannot be its own parent/i, ar: 'لا يمكن أن يكون القسم تابعاً لنفسه' },
  {
    re: /hierarchy would form a cycle/i,
    ar: 'القسم المختار يقع تحت هذا القسم — الربط يُنشئ حلقة مغلقة في الهيكل',
  },
  {
    re: /deactivated user cannot manage a department/i,
    ar: 'المستخدم موقوف — لا يمكن تعيينه مديراً لقسم',
  },
  // temporary delegations
  { re: /cannot delegate to themselves/i, ar: 'لا يمكن تفويض المستخدم لنفسه' },
  { re: /endsAt must be after startsAt/i, ar: 'تاريخ نهاية التفويض يجب أن يكون بعد تاريخ بدايته' },
  {
    re: /delegation window has already passed/i,
    ar: 'النافذة الزمنية المحددة انتهت بالفعل — اختر تاريخ نهاية في المستقبل',
  },
  { re: /invalid startsAt\/endsAt date/i, ar: 'تاريخ غير صالح — اختر التاريخ من التقويم' },
  {
    re: /cannot give or receive a delegation/i,
    ar: 'لا يمكن التفويض من مستخدم موقوف ولا إليه',
  },
  {
    re: /already covers part of this period/i,
    ar: 'يوجد تفويض ساري بين الشخصين نفسيهما يتقاطع مع هذه الفترة',
  },
  { re: /delegation is already revoked/i, ar: 'هذا التفويض مُنهى بالفعل' },
  // unified customer record (CRM Step 2). The specific "Duplicate customer
  // key" sentence, which names the existing record, is built in translateError;
  // this pattern is only the fallback when the message cannot be parsed.
  {
    re: /duplicate customer key/i,
    ar: 'يوجد عميل آخر بنفس السجل التجاري أو الرقم الضريبي أو الجوال',
    en: 'Another customer already has the same CR number, VAT number or mobile',
  },
  {
    re: /customer already merged/i,
    ar: 'هذا العميل دُمج في سجل آخر — استخدم السجل الباقي',
    en: 'This customer was merged into another record — use the surviving record',
  },
  {
    re: /requires a CR number or a VAT number/i,
    ar: 'المنشأة تتطلب سجلاً تجارياً أو رقماً ضريبياً — أدخل أحدهما على الأقل',
    en: 'A company needs a CR number or a VAT number — enter at least one',
  },
  {
    re: /individual customer requires a mobile/i,
    ar: 'الفرد يتطلب رقم جوال',
    en: 'An individual needs a mobile number',
  },
  {
    re: /mobile must be a Saudi mobile/i,
    ar: 'رقم الجوال غير صحيح — مثال: 0501234567 أو +966501234567',
    en: 'The mobile number is not valid — e.g. 0501234567 or +966501234567',
  },
  {
    re: /backupRef/i,
    ar: 'اكتب اسم ملف النسخة الاحتياطية (8 أحرف على الأقل) قبل الدمج',
    en: 'Enter the backup file name (at least 8 characters) before merging',
  },
  {
    re: /cannot also be merged into itself/i,
    ar: 'لا يمكن دمج السجل الباقي في نفسه',
    en: 'The surviving record cannot be merged into itself',
  },
  // opportunities and the sales funnel (CRM Step 3). "Invalid stage transition"
  // is translated per reason in translateError (it needs the response body);
  // this pattern is only the fallback.
  {
    re: /invalid stage transition/i,
    ar: 'لا يمكن نقل الفرصة إلى هذه المرحلة — حدّث الصفحة وحاول مجدداً',
    en: 'The opportunity cannot be moved to that stage - refresh the page and try again',
  },
  {
    re: /loss reason is required/i,
    ar: 'سبب الخسارة إلزامي — اختر سبباً من القائمة',
    en: 'A loss reason is required - pick one from the list',
  },
  {
    re: /tender close date is required/i,
    ar: 'تاريخ إقفال المناقصة إلزامي للفرصة من نوع مناقصة',
    en: 'The tender close date is required for a tender opportunity',
  },
  {
    re: /opportunity is closed/i,
    ar: 'الفرصة مقفلة (رابحة أو خاسرة) — لا تقبل تعديلاً ولا عروضاً جديدة؛ أنشئ فرصة جديدة',
    en: 'The opportunity is closed (won or lost) - it takes no edits or new proposals; create a new opportunity',
  },
  {
    re: /stage changes go through/i,
    ar: 'تُغيَّر المرحلة من شريط المراحل في صفحة الفرصة',
    en: 'Change the stage from the stepper on the opportunity page',
  },
  {
    re: /loss reason name already in use/i,
    ar: 'اسم السبب موجود في القائمة مسبقاً',
    en: 'A loss reason with that name already exists',
  },
  {
    re: /must be a valid date/i,
    ar: 'تاريخ غير صالح — اختر التاريخ من التقويم',
    en: 'Not a valid date - pick it from the calendar',
  },
  // proposals, their revisions and their approval (CRM Step 4)
  {
    re: /cost override reason is required/i,
    ar: 'تعديل التكلفة يلزمه سبب — اكتب سبب التغيير في خانة «سبب التعديل»',
    en: 'A changed cost needs a reason - write it in the "Reason for the change" field',
  },
  {
    re: /validity date must be in the future/i,
    ar: 'تاريخ صلاحية العرض يجب أن يكون بعد اليوم',
    en: 'The proposal validity date must be after today',
  },
  {
    re: /validity date must be a valid date/i,
    ar: 'تاريخ الصلاحية غير صالح — اختر التاريخ من التقويم',
    en: 'The validity date is not valid - pick it from the calendar',
  },
  {
    re: /selling price is required/i,
    ar: 'أدخل سعر البيع لكل بند',
    en: 'Enter the selling price of every line',
  },
  {
    re: /previous revision is awaiting approval/i,
    ar: 'النسخة الحالية بانتظار الاعتماد — لا تُضاف نسخة جديدة ولا يُعدَّل العرض حتى يُبتّ فيه',
    en: 'The current revision is awaiting approval - it cannot be changed or replaced until it is decided',
  },
  {
    re: /proposal is accepted/i,
    ar: 'العرض مقبول — لا يُعدَّل إلا بأمر تغيير',
    en: 'The proposal is accepted - it can only be changed by a change order',
  },
  {
    re: /still a draft/i,
    ar: 'النسخة الحالية ما زالت مسودة — عدّلها مباشرة بدل إنشاء نسخة جديدة',
    en: 'The current revision is still a draft - edit it instead of adding a new one',
  },
  {
    re: /only a draft revision can be edited/i,
    ar: 'تُعدَّل المسودة فقط — أنشئ نسخة جديدة لتغيير نسخة أُرسلت أو اعتُمدت',
    en: 'Only a draft can be edited - add a new revision to change one that was approved or sent',
  },
  {
    re: /only a draft revision can be submitted/i,
    ar: 'يُرفع للاعتماد المسودة فقط',
    en: 'Only a draft can be submitted for approval',
  },
  {
    re: /proposal needs at least one line/i,
    ar: 'أضف بنداً واحداً على الأقل قبل رفع العرض للاعتماد',
    en: 'Add at least one line before submitting the proposal',
  },
  {
    re: /no other approver is available/i,
    ar: 'لا يوجد معتمِد آخر غيرك لهذا العرض — لا يعتمد أحد عرضاً رفعه بنفسه. يلزم حامل آخر لدور الإدارة العليا، أو تفويض مؤقت من غيرك',
    en: 'There is no other approver for this proposal - nobody approves what they raised themselves. Another holder of the executive role, or a temporary delegation from someone else, is needed',
  },
  {
    re: /proposal revision has expired/i,
    ar: 'انتهت صلاحية هذه النسخة — أنشئ نسخة جديدة بتاريخ صلاحية جديد',
    en: 'This revision has expired - add a new revision with a new validity date',
  },
  {
    re: /only an approved revision can be sent/i,
    ar: 'يُرسل للعميل العرض المعتمد فقط',
    en: 'Only an approved revision can be sent to the customer',
  },
  {
    re: /only the current sent revision can be accepted/i,
    ar: 'يُسجَّل قبول العميل للنسخة الحالية المُرسَلة فقط — حدّث الصفحة',
    en: 'Only the current, sent revision can be accepted - refresh the page',
  },
  {
    re: /only a sent revision can be rejected/i,
    ar: 'يُسجَّل رفض العميل للنسخة المُرسَلة فقط',
    en: 'Only a sent revision can be rejected by the customer',
  },
  {
    re: /rejection reason is required/i,
    ar: 'سبب رفض العميل إلزامي',
    en: 'The customer\'s reason for refusing is required',
  },
  {
    re: /another revision was added at the same moment/i,
    ar: 'أضاف مستخدم آخر نسخة في اللحظة نفسها — حدّث الصفحة وحاول مجدداً',
    en: 'Another user added a revision at the same moment - refresh and try again',
  },
  {
    re: /is not a legal action on/i,
    ar: 'هذا الإجراء غير متاح في الحالة الحالية للمستند — حدّث الصفحة',
    en: 'That action is not available in the document\'s current state - refresh the page',
  },
  {
    re: /already awaiting approval/i,
    ar: 'المستند بانتظار الاعتماد بالفعل',
    en: 'The document is already awaiting approval',
  },
  {
    re: /moved while this action was in flight/i,
    ar: 'تغيّرت حالة المستند أثناء التنفيذ — حدّث الصفحة وحاول مجدداً',
    en: 'The document changed state while this was happening - refresh and try again',
  },
  {
    re: /does not meet the condition/i,
    ar: 'المستند لا يستوفي شرط هذا الإجراء — تأكد أن الإجمالي أكبر من صفر',
    en: 'The document does not meet the condition for this action - check that the total is above zero',
  },
  {
    re: /unknown setting key/i,
    ar: 'إعداد غير معروف',
    en: 'Unknown setting',
  },
  {
    re: /setting value out of range/i,
    ar: 'القيمة خارج المدى المسموح — أدخل عدداً صحيحاً ضمن الحدود المبيَّنة بجوار الحقل',
    en: 'The value is out of range - enter a whole number within the limits shown beside the field',
  },
  // the communication log and the follow-up tasks (CRM Step 5)
  {
    re: /opportunity does not belong to this customer/i,
    ar: 'هذه الفرصة تخص عميلاً آخر — اختر فرصة من فرص هذا العميل',
    en: "That opportunity belongs to another customer - pick one of this customer's opportunities",
  },
  {
    re: /contact does not belong to this customer/i,
    ar: 'جهة الاتصال هذه ليست من جهات اتصال هذا العميل',
    en: "That contact is not one of this customer's contacts",
  },
  {
    re: /activity date cannot be in the future/i,
    ar: 'تاريخ التواصل لا يمكن أن يكون في المستقبل',
    en: 'The date of a communication cannot be in the future',
  },
  {
    re: /^body is required|^body must be at most/i,
    ar: 'نص القيد إلزامي (حتى 4000 حرف)',
    en: 'The entry text is required (up to 4000 characters)',
  },
  {
    re: /^title is required|^title must be at most/i,
    ar: 'عنوان المهمة إلزامي (حتى 200 حرف)',
    en: 'The task title is required (up to 200 characters)',
  },
  {
    re: /due date cannot be in the past/i,
    ar: 'تاريخ الاستحقاق لا يمكن أن يسبق اليوم',
    en: 'The due date cannot be before today',
  },
  {
    re: /(dueAt|occurredAt|remindAt) must be a valid date/i,
    ar: 'التاريخ غير صالح — اختره من التقويم',
    en: 'The date is not valid - pick it from the calendar',
  },
  {
    re: /reminder cannot be after the due date/i,
    ar: 'وقت التذكير لا يمكن أن يقع بعد يوم الاستحقاق',
    en: 'The reminder cannot be after the due date',
  },
  {
    re: /assignee not found/i,
    ar: 'المكلَّف غير موجود أو غير نشط — اختر مستخدماً نشطاً',
    en: 'The assignee was not found or is inactive - pick an active user',
  },
  {
    re: /task is not open/i,
    ar: 'المهمة لم تعد مفتوحة (أُنجزت أو أُلغيت) — حدّث الصفحة',
    en: 'The task is no longer open (done or cancelled) - refresh the page',
  },
  {
    re: /cancellation reason is required/i,
    ar: 'سبب الإلغاء إلزامي — اكتب سبباً',
    en: 'A cancellation reason is required',
  },
];

// 403s that deserve a specific sentence instead of the generic "no permission".
const FORBIDDEN_PATTERNS: Array<{ re: RegExp; ar: string; en: string }> = [
  {
    re: /only the author can edit this entry/i,
    ar: 'لا يعدّل القيد إلا كاتبه — أضف قيداً جديداً إن لزم',
    en: 'Only the author can edit an entry - add a new entry if needed',
  },
  {
    re: /customer merge is disabled/i,
    ar: 'الدمج معطَّل حتى اعتماد قائمة المكررات من المالك',
    en: 'Merging is disabled until the owner approves the list of duplicates',
  },
  {
    re: /cost and margin fields/i,
    ar: 'لا يحق لدورك تحديد التكلفة أو الهامش أو مخطط التسعير — احذف هذه الحقول أو اطلب صلاحية «عرض التكاليف والهوامش»',
    en: 'Your role may not set costs, margins or pricing schemes — remove those fields or ask for the "View costs & margins" permission',
  },
  {
    re: /requires the approve permission/i,
    ar: 'هذا المستند لا تنطبق عليه مصفوفة اعتماد، واعتماده يحتاج صلاحية «اعتماد» لا يملكها دورك — اطلب من مدير النظام إضافة قاعدة اعتماد أو منح الصلاحية',
    en: 'No approval rule routes this document, and approving it needs an "approve" permission your role lacks — ask the administrator to add an approval rule or grant the permission',
  },
];

export function translateError(e: unknown, locale: Locale): string {
  const ar = locale === 'ar';
  if (e instanceof ApiError) {
    if (e.status === 0)
      return ar
        ? 'تعذّر الاتصال بالخادم — تحقق من اتصال الشبكة وحاول مجدداً'
        : 'Could not reach the server — check your connection and try again';
    if (e.status === 401)
      return ar ? 'انتهت الجلسة — سجّل الدخول مجدداً' : 'Session expired — please sign in again';
    if (e.status === 403) {
      const specific = FORBIDDEN_PATTERNS.find((p) => p.re.test(e.message));
      if (specific) return ar ? specific.ar : specific.en;
    }
    if (e.status === 403)
      return ar ? 'لا تملك صلاحية لتنفيذ هذا الإجراء' : 'You do not have permission for this action';
    if (e.status === 404)
      return ar ? 'السجل المطلوب غير موجود' : 'The requested record was not found';
    const checklistMiss = e.message.match(/^Mandatory checklist item not done: (.+)$/i);
    if (checklistMiss)
      return ar
        ? `البند الإلزامي «${checklistMiss[1]}» لم يُنجز بعد`
        : e.message;
    // A refused duplicate key names the record that already has it.
    const dup = e.message.match(
      /^Duplicate customer key: (crNumber|vatNumber|mobile) already used by (\S+) \(([\s\S]*)\)$/,
    );
    if (dup) {
      const field = {
        crNumber: ar ? 'السجل التجاري' : 'CR number',
        vatNumber: ar ? 'الرقم الضريبي' : 'VAT number',
        mobile: ar ? 'الجوال' : 'mobile number',
      }[dup[1] as 'crNumber' | 'vatNumber' | 'mobile'];
      return ar
        ? `يوجد عميل بنفس ${field}: ${dup[2]} — ${dup[3]}`
        : `A customer with the same ${field} already exists: ${dup[2]} — ${dup[3]}`;
    }
    // A refused stage move says WHY in the body (TERMINAL / SKIP / CONCURRENT).
    if (e.status === 409 && /^Invalid stage transition/i.test(e.message)) {
      const reason = e.body?.reason as string | undefined;
      if (reason === 'TERMINAL')
        return ar
          ? 'الفرصة مقفلة (رابحة أو خاسرة) ولا يمكن إعادة فتحها — أنشئ فرصة جديدة'
          : 'The opportunity is closed (won or lost) and cannot be reopened - create a new opportunity';
      if (reason === 'SKIP')
        return ar
          ? 'لا يمكن القفز فوق مرحلة — انتقل إلى المرحلة التالية مباشرة'
          : 'A stage cannot be skipped - move to the next stage';
      if (reason === 'CONCURRENT')
        return ar
          ? 'غيّر مستخدم آخر مرحلة هذه الفرصة قبل لحظات — حدّث الصفحة'
          : 'Another user just changed this opportunity - refresh the page';
    }
    for (const p of PATTERNS)
      if (p.re.test(e.message)) return ar ? p.ar : (p.en ?? e.message);
    if (e.status >= 500)
      return ar
        ? 'حدث خطأ في الخادم — حاول مرة أخرى، وإن تكرر راجع مسؤول النظام'
        : 'A server error occurred — try again, and contact your administrator if it persists';
    // Unknown 4xx: generic sentence + original detail for troubleshooting.
    return ar ? `تعذّر تنفيذ العملية (${e.message})` : `The action could not be completed (${e.message})`;
  }
  return ar ? 'حدث خطأ غير متوقع' : 'An unexpected error occurred';
}
