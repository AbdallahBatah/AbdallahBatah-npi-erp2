# تقرير وكيل الخطوة 5-ب — قائمة المكلَّفين وبطاقة «مهام المتابعة»

نُفِّذ §1 من العقد كاملاً بعد كتابة الاختبارات أولاً (سُجِّل فشل ملف الوحدة بخطأ TS لغياب `assignees` و`mySummary`). لا commit، لا ترحيلات، لا تغيير مخطط، لا مفاتيح صلاحية جديدة، ولم يُحتَج `prisma generate`.

## التحقق من §0
كل الحقائق صحيحة كما كُتبت (أرقام الأسطر انزاحت قليلاً فقط). ملاحظة: مسارات الـAPI تحت البادئة العامة `/api` (`main.ts: setGlobalPrefix('api')`).

## الملفات
**API**
- `modules/crm/follow-up-tasks.service.ts`: `assignees(user)` (نشطون في منشأة المستدعي، `select` من ثلاثة حقول، `orderBy nameAr`) و`mySummary(user)` (منطق الرياض نفسه منقولاً).
- `modules/crm/follow-up-tasks.controller.ts`: `@Get('assignees')` بـ`CUSTOMER_WRITE` و`@Get('summary')` بـ`CUSTOMER_READ`، مُعلنان قبل `@Get(':id')`.
- `modules/reference/reference.controller.ts`: أُزيلت `myTasksDueToday/myTasksOverdue` و`canSeeTasks` و`today/mine`، مع تعليق السبب، وحُذف استيراد `normalizeValidUntil` الذي لم يعد مستعملاً.

**الواجهة**
- `components/follow-up-tasks.tsx`: `useAssignees()` يستدعي `/tasks/assignees` حين `can('crm.customer.write')`، ويُبقي استبعاد المستخدم نفسه؛ حُذف الاعتماد على `/admin/users` وتعليق «documented limit».
- `lib/messages.ts`: التلميح `tasks.field.assigneeHint` بالنصين المطلوبين حرفياً.
- `app/(app)/dashboard/page.tsx`: `canTasks = can('crm.customer.read')` يجلب `/tasks/summary` إلى `tasksSum`، والبطاقة تُرسم منه بغض النظر عن `canCrm`؛ أُزيل الحقلان من `Summary`.

**الاختبارات والأدوات**
- `follow-up-tasks.service.spec.ts` (+5): `assignees` (where/orderBy/select)، `mySummary` (where الاثنين)، مفاتيح `PERMISSIONS_KEY` للمسارين، وترتيب التصريح قبل `:id`.
- `test/activities-tasks.int-spec.ts` (+6 اختبارات جديدة وتوسيع اختبار المفاتيح): المندوب يرى المدير بثلاثة حقول فقط، مستخدم معطَّل (أُنشئ ثم يُحذف في `afterAll`) غير ظاهر، الترتيب = ترتيب قاعدة البيانات، الرئيس التنفيذي بلا مفتاح الكتابة وله مفتاح القراءة، `mySummary` (اليوم ← أمس ← منجزة)، ومهمة مسندة لغيره لا تُعدّ.
- `test/tenant-isolation.int-spec.ts` (+2): قائمة المكلَّفين لا تحوي مستخدم الجار؛ `mySummary` لا يعدّ مهمته. **عدّلتُ بذرة الاختبار:** مهمة الجار صارت `dueAt = 2020-01-01` بدل 2099 (لتكون متأخرة فيثبت الاختبار أن العدّ يعمل لصاحبها ويصفر عبر المنشآت)؛ لا اختبار آخر يعتمد على 2099.
- `.claude/skills/npi-erp-testing/scripts/api-smoke.mjs`: أُضيفت الصفوف الأربعة فقط (`/tasks`، `/tasks/summary`، `/tasks/assignees`، `/reference/dashboard`).

## البوابات
| البوابة | النتيجة |
|---|---|
| `npm run typecheck` | 4 حزم خضراء |
| `npm run lint` | نظيف |
| `npm test` | 42 مجموعة، **568 ناجحاً** (كان 563) |
| `npm run test:int` | 8 مجموعات، **145 ناجحاً** (كان 137) |
| `npm run build -w @npi/web` | ناجح (`/tasks` و`/dashboard` ضمن المخرجات) |

## التحقق الحي (Node fetch، API على 4000)
- `sales@npi.sa` → `GET /api/tasks/assignees` **200**، سبعة مستخدمين نشطين بينهم «مدير النظام»، حقول `id,nameAr,nameEn` فقط.
- `ceo@npi.sa` → `/tasks/assignees` **403**؛ و`/tasks/summary` 200 (`{"dueToday":0,"overdue":0}`).
- `accountant@npi.sa` → `/tasks/summary` **200**، و`/reference/dashboard` **403**.
- `admin@npi.sa` → `/reference/dashboard` 200 بخمسة مفاتيح فقط (`openLeads, openOpportunities, totalContracts, activeContracts, pipelineValue`)، لا أثر لـ`myTasks*`.
- `GET /tasks/<معرّف>` ما زال يصل إلى `:id` (404 لمعرّف غير موجود) فالمسارات الثابتة لم تكسره.
- لم أتحقق بصرياً من واجهة لوحة القيادة (انظر المشكلة أدناه)؛ التحقق من الواجهة بالنوع والبناء فقط.

## مشكلة تحتاج إجراءً منك: خادم الويب التطويري تعطّل
تشغيل `npm run build -w @npi/web` (المطلوب في §2) كتب أصول الإنتاج فوق `apps/web/.next` الذي يستعمله `next dev -p 3000` الجاري، فصار `/dashboard` و`/tasks` يعيدان 500 بالخطأ `Cannot find module './3135.js'` (`/login` ما زال 200). حاولتُ إيقاف خادم الويب (PID 22736/25768) وحذف `.next` ثم إعادة تشغيله فرفض مصنِّف الصلاحيات ذلك (والعقد يمنع إيقاف الخوادم)، ولم أتحايل على الرفض. **الإصلاح:** أوقف عملية `next dev` على 3000، احذف `C:\dev\npi-erp-crm\apps\web\.next`، ثم `npm run dev -w @npi/web`. خادم الـAPI سليم. للمستقبل: لا يُشغَّل `build` والخادم التطويري على المجلد نفسه (تُحسَن إضافة `distDir` منفصل للبناء أو إيقاف الخادم قبله).

## انحرافات وأسئلة
- لا انحراف عن §1 سوى حذف استيراد غير مستعمل، وتغيير تاريخ مهمة الجار في بذرة العزل (مذكور أعلاه).
- ملفان غير متعقَّبين لم أنشئهما: `scripts/crm-phase-1-acceptance.mjs` و`scripts/crm-phase-1-ui-acceptance.mjs` (ظهرا في `git status` أثناء عملي، بتوقيت 22:16–22:17) — أظنهما من جلسة أخرى؛ لم ألمسهما ولا يجب أن يدخلا في الـcommit إن لم يكونا مقصودين.
- `useAssignees()` يُرجع كل المستخدمين النشطين بمن فيهم أدوارهم التي لا تحمل مفتاح الكتابة (مثل الرئيس التنفيذي)، كما حدّد العقد: قد يُسنَد لهم مهام لا يستطيعون إنجازها. قرار للمراجع إن أُريد ترشيحهم بالصلاحية.
