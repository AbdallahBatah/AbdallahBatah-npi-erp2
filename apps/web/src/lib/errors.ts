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
    if (e.status === 403)
      return ar ? 'لا تملك صلاحية لتنفيذ هذا الإجراء' : 'You do not have permission for this action';
    if (e.status === 404)
      return ar ? 'السجل المطلوب غير موجود' : 'The requested record was not found';
    const checklistMiss = e.message.match(/^Mandatory checklist item not done: (.+)$/i);
    if (checklistMiss)
      return ar
        ? `البند الإلزامي «${checklistMiss[1]}» لم يُنجز بعد`
        : e.message;
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
