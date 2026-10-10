import { isHrEvaluationRequest } from '../src/agents/hr-guard';

// BR-06: the assistant must never evaluate, rank, compare or recommend a
// personnel decision about an employee. `isHrEvaluationRequest` is the
// predicate the router checks before anything else (see router.spec.ts for
// the "HR guard wins, zero classifier calls" ordering test).

describe('isHrEvaluationRequest — positive cases (must refuse)', () => {
  const positives: Array<[string, string]> = [
    ['superlative + person noun (MSA)', 'من هو أفضل مهندس عندنا؟'],
    ['superlative + person noun, Gulf dialect', 'مين أكفأ مهندس عندنا؟'],
    ['weakest in a team, Gulf dialect', 'من الأضعف في فريق المبيعات'],
    ['worst accountant', 'من هو أسوأ محاسب في القسم'],
    ['laziest employee', 'مين أكسل موظف عندنا'],
    ['most active supervisor', 'من أنشط مشرف هذا الشهر'],
    ['most skilled colleague', 'من أشطر زميل في الفريق'],
    ['evaluate performance of a named engineer', 'قيّم أداء المهندس أحمد'],
    ['rank the employees', 'رتّب الموظفين حسب الأداء'],
    ['compare two employees', 'قارن بين محمد وخالد كموظفين'],
    ['performance immediately followed by a person noun', 'أداء الموظف ضعيف هذا الربع'],
    ['promotion asked as a question, Gulf dialect', 'وش رأيك نرقي خالد؟'],
    ['who deserves a bonus', 'من يستحق المكافأة هذا الشهر'],
    ['whether to issue a warning', 'هل نعطيه إنذار؟'],
    ['whether someone deserves termination', 'هل فلان يستاهل إنهاء خدمات؟'],
    ['English: who is the best engineer', 'who is the best engineer on the team'],
    ['English: rank the employees', 'please rank the employees by output'],
    ['English: evaluate performance of a named person', "evaluate Ahmed's performance this quarter"],
  ];

  it.each(positives)('%s: %j', (_label, text) => {
    expect(isHrEvaluationRequest(text)).toBe(true);
  });
});

describe('isHrEvaluationRequest — negative cases (must NOT refuse)', () => {
  const negatives: Array<[string, string]> = [
    ['best vendor, not a person', 'أفضل مورد للألواح'],
    ['best price, not a person', 'أبي أفضل سعر لهذا الصنف'],
    ['evaluate a vendor', 'تقييم المورد قبل الترسية'],
    ['project performance, not a person', 'أداء المشروع هذا الشهر ممتاز'],
    ['compare vendor offers', 'قارن عروض الموردين'],
    ['plain mention of an engineer in a business request', 'المهندس أحمد طلب 40 لوح لمشروع PRJ-00012'],
    ['plain mention of an accountant needing a document', 'المحاسب يحتاج فاتورة المورد'],
    ['position administration, not evaluation', 'عيّن محاسباً جديداً بدل الذي استقال'],
    ['handover administration', 'انقل مهام المحاسب السابق للمحاسب الجديد'],
    ['new purchase request, no evaluation', 'أبي 40 لوح 550 واط للمشروع PRJ-00012 قبل الخميس'],
    ['new contract, no evaluation', 'عقد جديد مع شركة النخيل'],
    ['vendor bill, no evaluation', 'استلمنا فاتورة مورد جديدة'],
    ['status lookup, no evaluation', 'وين وصلت حالة طلب الشراء؟'],
    ['best item price question', 'كم أفضل سعر عرضه المورد؟'],
    ['English: best vendor for panels', 'who is the best vendor for solar panels'],
    ['English: evaluate project performance', 'evaluate the project performance this quarter'],
    ['English: compare vendor offers', 'compare the vendor offers we received'],
  ];

  it.each(negatives)('%s: %j', (_label, text) => {
    expect(isHrEvaluationRequest(text)).toBe(false);
  });
});

// Added in review: the guard blocks the whole message, so ordinary business
// sentences that merely contain one of its words must pass.
describe('isHrEvaluationRequest — whole-word matching (review additions)', () => {
  it.each([
    ['best technical offer', 'أفضل عرض فني من الموردين'],
    ['technical specifications', 'قارن المواصفات الفنية للألواح'],
    ['best vendor for the team', 'وش أفضل مورد للفريق في الرياض؟'],
    ['end-of-service bonus as a contract clause', 'مكافأة نهاية الخدمة ضمن بنود العقد'],
    ['"in addition to"', 'علاوة على ذلك، هل الفاتورة متأخرة؟'],
    ['a chapter of the contract', 'هل يوجد فصل في العقد عن المحتجزات؟'],
    ['we itemize the clauses', 'نفصل البنود في الفاتورة حسب أمر الشراء'],
    ['dealing with a vendor', 'كيف التعامل مع المورد المتأخر؟'],
    ['safety factor', 'ما عامل الأمان في تصميم الهيكل؟'],
    ['system performance', 'قيّم أداء النظام الشمسي في محطة الرياض'],
    ['a directorate, not a manager', 'أرسل الخطاب إلى مديرية المياه'],
    ['evaluating offers', 'تقييم العروض الفنية والمالية'],
  ])('does not refuse %s: "%s"', (_label, text) => {
    expect(isHrEvaluationRequest(text)).toBe(false);
  });

  it.each([
    ['best technician', 'مين أفضل فني عندنا؟'],
    ['possessive plural', 'رتّب موظفينا حسب الأداء'],
    ['performance of a named person', 'قيّم أداء خالد هذا الشهر'],
    ['who deserves a bonus', 'من يستحق المكافأة هذا الربع؟'],
    ['dismissal advice', 'وش رأيك نستغني عن المندوب الجديد؟'],
    ['team productivity ranking', 'قارن إنتاجية المهندسين في المشروعين'],
  ])('refuses %s: "%s"', (_label, text) => {
    expect(isHrEvaluationRequest(text)).toBe(true);
  });
});
