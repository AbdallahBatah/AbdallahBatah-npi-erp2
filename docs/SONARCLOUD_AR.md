# SonarCloud في خط الجودة — دليل المالك

**المشروع على SonarQube Cloud:** `eyad62689-lab_npi-erp` (المنظمة `eyad62689-lab`).
**لوحة المشروع:** <https://sonarcloud.io/project/overview?id=eyad62689-lab_npi-erp>

## ما الذي تغيّر (2026-10-11)

كان المشروع مربوطاً بـ«التحليل التلقائي» (Automatic Analysis) من داخل SonarCloud، وكان يفشل على كل
التزام وكل طلب دمج منذ البداية (فحص `SonarCloud Code Analysis` ملغى، لا قياسات، بوابة الجودة
بلا حالة). استُبدل به **تحليل من خط CI**:

- `sonar-project.properties` في الجذر: المستودع كله مشروع واحد — `apps/api`، `apps/web`،
  `apps/copilot`، `packages/shared`، `packages/db` — مع استثناء المولَّد (`src/generated`)،
  والهجرات، و`openapi.json`، والاختبارات معرَّفة اختبارات لا مصدراً.
- `.github/workflows/sonarcloud.yml`: يشغّل اختبارات jest للـapi (568) وللكوبايلوت (2451) مع
  تغطية lcov ثم يرفع تحليلاً واحداً. يعمل عند الدفع إلى `main` و`feat/**` و`feature/**`،
  وعلى كل طلب دمج، ويدوياً (`workflow_dispatch`).
- **غير مُلزِم بعد:** لم يُضَف إلى `ci-gate`، فبوابة الجودة معلومة لا مانعاً للدمج حتى تقرر.

## السبب الحقيقي للفشل المتكرر (اكتُشف 2026-10-11)

ليس في الكود ولا في الإعداد: **حصة الأسطر في المنظمة**. رسالة خادم SonarCloud عند معالجة أول
تحليل من CI (المهمة `AaEpXkDwuoMz_oCESuzL`):

> This analysis will make your organization 'eyad62689-lab' reach the maximum allowed lines
> limit of 100000. Current LOC usage is: 90200. LOC count in this analysis: 72222.

أي أن المنظمة تستهلك 90,200 من 100,000 سطر في مشاريعها الأخرى، و`npi-erp` يحتاج نحو 66,000
بعد استثناء الملف المولَّد `apps/copilot/src/npi/types.ts` (6,400 سطر). التحليلات التلقائية
السابقة كلها فشلت للسبب نفسه. الخيارات (قرار المالك):

| الخيار | الأثر |
|---|---|
| حذف مشاريع قديمة من المنظمة حتى تتوفر ≈ 66,000 سطر (مثلاً priva-pdf 20,026 + learnenglishv 19,344 + hr-assistant 14,962 + estraha 12,061 = 66,393) | مجاني؛ يُزيل تاريخ تحليل تلك المشاريع فقط، الكود يبقى في GitHub |
| رفع خطة المنظمة إلى شريحة أسطر أعلى | مدفوع؛ لا حذف |
| تحليل جزء من المستودع فقط | غير مجدٍ: الكوبايلوت وحده ≈ 26,700 سطر، والمتبقي 9,800 |

استهلاك المشاريع الأخرى (ncloc): learnenglishv 19,344 · priva-pdf 20,026 · hr-assistant 14,962 ·
estraha 12,061 · visit-alahsa 11,042 · npi-website 10,442 · Alpha_CIA_Platform 1,740 ·
trustscan 799 · solar-calculator-api 583 · npi-legal 0.

حجم npi-erp التقريبي بعد الاستثناءات: api 16,300 · web 20,500 · copilot 26,700 · shared 850 ·
prisma 1,100.

**الرمز**: `github-actions-npi-erp` بلا انتهاء ما دام يُستخدم، ويسقط إن بقي بلا استخدام 60 يوماً
(أي إن توقف الورك فلو شهرين يلزم رمز جديد وتحديث السرّ `SONAR_TOKEN`).

## خطوات لمرة واحدة (أُنجزت 2026-10-11: الرمز، السرّ، إيقاف التحليل التلقائي)

1. **رمز الوصول:** في SonarCloud: My Account → Security → Generate Token (اسم مثل
   `github-actions-npi-erp`، نوع Global أو Project Analysis). انسخ القيمة.
2. **سرّ GitHub:** في PowerShell على جهازك (لا تلصق الرمز في المحادثة):

   ```powershell
   gh secret set SONAR_TOKEN --repo eyad62689-lab/npi-erp
   ```

   سيطلب القيمة في الطرفية؛ الصقها هناك.
3. **إيقاف التحليل التلقائي:** في SonarCloud: المشروع → Administration → Analysis Method →
   أوقف **Automatic Analysis**. بدون هذه الخطوة يرفض الماسح العمل برسالة «CI analysis while
   Automatic Analysis is enabled».
4. أخبرني «تم» فأشغّل التحليل على `feat/copilot` وأقرأ النتيجة لك.

## تشغيل يدوي لاحقاً

```powershell
gh workflow run sonarcloud.yml --repo eyad62689-lab/npi-erp --ref feat/copilot
```

## ما ستراه في اللوحة

- **Overall code:** الحالة الكاملة للمستودع (آلاف الأسطر؛ الملاحظات القديمة تُراجَع تدريجياً).
- **New code:** ما تغيّر منذ آخر إصدار/فرع مرجعي؛ هذا ما تنظر إليه بوابة الجودة الافتراضية
  «Sonar way» (صفر مشاكل جديدة، تغطية الجديد ≥ 80٪، تكرار ≤ 3٪).
- التغطية الحالية محلياً: api ≈ 75٪ أسطر، الكوبايلوت ≈ 95٪ أسطر. `apps/web` بلا اختبارات وحدة
  فاستُثني من حساب التغطية (لا من الفحص).

## لجعلها مانعة للدمج لاحقاً

أضف خطوة `SonarSource/sonarqube-quality-gate-action` بعد الماسح في الورك فلو، ثم اربط الفحص
`SonarCloud` بحماية الفرع `main` (أو أضفه إلى `ci-gate`). يُنصح بذلك بعد معالجة ملاحظات
الكود القديم أو ضبط بوابة جودة خاصة تركّز على «الجديد» فقط.
