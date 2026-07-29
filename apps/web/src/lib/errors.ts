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
  { re: /only draft/i, ar: 'هذه العملية متاحة للمسودات فقط' },
  { re: /only in-progress/i, ar: 'أمر العمل ليس قيد التنفيذ' },
  { re: /already converted/i, ar: 'تم تحويل هذا العميل المحتمل مسبقاً' },
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
