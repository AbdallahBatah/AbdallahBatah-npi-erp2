# الخطوة 5 — سجل التواصل ومهام المتابعة: تقرير الوكيل المنفّذ

> الحالة: كل شيء في شجرة العمل غير ملتزَم (لا commit ولا push ولا stash). مجلد العمل `C:\dev\npi-erp-crm` على `feature/crm-phase-1` (HEAD e2d79c8). القاعدة المحلية كانت متاحة طوال الجلسة. المستخدمون المزروعون: `sales@npi.sa / Sales@123`، `ceo@npi.sa / Ceo@12345`، `admin@npi.sa / Admin@123`. لم يُلمس `C:\dev\npi-erp`.

## 1. ملخص التنفيذ

نُفِّذ العقد بأقسامه 0–9 كاملة: كُتبت الاختبارات أولاً (ثمانية ملفات وحدة جديدة أو ممتدة، وملف تكامل جديد، وامتداد لعزل المنشآت) وسُجِّل فشلها لأسباب متوقعة (عشرة ملفات/مجموعات حمراء)، ثم الترحيلان `0028_crm_activities` (جدولان `Activity` و`FollowUpTask`، enum `ActivityType` و`FollowUpTaskStatus`، وقيمة `ACTIVITY` على `AttachmentEntity`) و`0029_crm_activities_backfill` (إعدادا التذكير وتسلسل `TSK` لكل منشأة) مع `down.sql` لكلٍّ منهما. في المشترك: `ACTIVITY_TYPES` و`FOLLOWUP_TASK_STATUSES` وملف نقي `follow-up-dates.ts`. في النواة: `NotificationService.notifyUser/notifyUserBestEffort` ومفتاحا الإعدادات `crm.task.reminderDaysBefore` و`crm.task.reminderHour` القابلان للتعديل. في الـAPI: `ActivitiesService/Controller` و`FollowUpTasksService/Controller` و`FollowUpReminderScheduler` (ساعي) ومساعدا `crm-scope.ts` (فحص الروابط) و`crm-rows.ts` (أشكال الصفوف المشتركة مع `overview`)، ونقل القيود والمهام عند الدمج وعدّها في `duplicates()`، و`ACTIVITY` في المرفقات، ومصدر `FOLLOWUP` في الصندوق الموحّد، و`activityTypes/followUpTaskStatuses` و`myTasksDueToday/myTasksOverdue` في المرجع. في الواجهة: تبويبا «سجل التواصل» و«المهام» في صفحتي العميل والفرصة (مكوّنان مشتركان `activity-timeline.tsx` و`follow-up-tasks.tsx`)، وصفحة `/tasks` (مهامي/الفريق، فلاتر، `?focus=`)، وصف `FOLLOWUP` في `/inbox`، وبطاقة «مهام المتابعة» في لوحة القيادة، وبطاقة «إعدادات المتابعة» في `/admin`. في البذرة: التسلسل والإعدادان ومثالان على «مصنع الرياض للصناعات».

النتائج: وحدة 434 ← 563 (+129)، تكامل 113 ← 137 (+24)، typecheck وlint وبذرة وبناء الويب نظيفة، ودورة `down.sql` (0029 ثم 0028 ثم إعادة الترحيل) تعمل مع رفض متعمَّد موثَّق. الانحرافات عن العقد في §5 (أهمها: امتداد تأكيدين في اختبار موجود، ومفتاحا `Activity/FollowUpTask` في `movedJson` لا يظهران إلا إن وُجد ما يُنقل، وبناء الويب جرى على نسخة من المجلد).

## 2. الملفات

### db
- `packages/db/prisma/schema.prisma`: enum `ActivityType {NOTE,CALL,MEETING}` و`FollowUpTaskStatus {OPEN,DONE,CANCELLED}`؛ `AttachmentEntity.ACTIVITY`؛ نموذجا `Activity` و`FollowUpTask` بالحقول والفهارس حرفياً كما في §2 من العقد (العميل `Restrict`، الفرصة/المشروع/جهة الاتصال `SetNull`، المكلَّف `Restrict`)؛ علاقات عكسية على `Organization` و`Customer` و`CustomerContact` و`Opportunity` و`Project` و`User` (أربع علاقات). إضافة فقط، 112 سطراً. (لم يُشغَّل `prisma format` لأنه يعيد تنسيق الملف كله؛ جُرِّب مرة ثم أُعيد الملف من HEAD وأُعيد التعديل بسكربت، فالفرق إضافات فقط.)
- `packages/db/prisma/migrations/0028_crm_activities/migration.sql` (جديد): الـenumان، `ALTER TYPE "AttachmentEntity" ADD VALUE IF NOT EXISTS 'ACTIVITY'` (لا يُستعمل داخل الملف)، الجدولان، الفهارس الثمانية، المفاتيح الأجنبية. مولَّد من `prisma migrate diff` ثم مراجَع يدوياً (استُبعد فرقان قديمان لا علاقة لهما: `GoodsReceiptLine.serials` default وتسمية فهرس `ApprovalRule`).
- `0028_crm_activities/down.sql` (جديد): يحذف مرفقات `ACTIVITY` ثم الجدولين ثم الـenumين؛ رأس يشرح ما يُفقد صراحة وأن `AttachmentEntity.ACTIVITY` تبقى (عرف 0024/0026).
- `0029_crm_activities_backfill/migration.sql` (جديد): لكل منشأة قائمة، idempotent: إعدادا `crm.task.reminderDaysBefore=1` و`crm.task.reminderHour=8` (`ON CONFLICT DO NOTHING`) وصف `NumberingSequence {FOLLOWUP_TASK, TSK, 1, سنة الآن, 5}` (`WHERE NOT EXISTS` لأي سنة، لأن `NumberingService` يرفض نوعاً بلا صف).
- `0029_crm_activities_backfill/down.sql` (جديد): يفشل عمداً (`RAISE EXCEPTION`) إن وُجدت مهمة (لئلا تُعاد أرقام `TSK-`)، وإلا يحذف التسلسل والإعدادين.
- `packages/db/prisma/seed.ts`: `FOLLOWUP_TASK/TSK` في `seqDefs`؛ الإعدادان (`update: {}`)؛ مثالان على `CUS-00001`: قيد مكالمة بتاريخ أمس بنص عربي واقعي، ومهمة مفتوحة «إرسال العرض الفني المبدئي لمصنع الرياض» تستحق بعد 3 أيام مكلَّف بها `sales@npi.sa` (تذكيرها 08:00 الرياض اليوم السابق) — كلاهما يُنشأ فقط إن غاب بالنص/العنوان (شُغِّلت البذرة ثلاث مرات: 1 قيد و1 مهمة في كل مرة)، والرمز من الزيادة الذرية نفسها التي يستعملها `NumberingService`.

### shared
- `packages/shared/src/follow-up-dates.ts` (جديد، مُصدَّر من `index.ts`): `defaultRemindAt(dueDay, daysBefore, hourRiyadh)`، `taskDueState(dueAt, now)` (`OVERDUE|TODAY|UPCOMING`)، `daysOverdue(dueAt, now)`، وأضفت `isBeforeToday(dueAt, now)` (قاعدة «لا استحقاق في الماضي»). كلها تقرأ يوم الرياض للمُدخل فتعطي الجواب نفسه للصيغة المخزَّنة (UTC منتصف ليل التاريخ) ولصيغة منتصف الليل بالرياض، عبر `riyadhDateKey/riyadhDayStart` القائمتين.
- `packages/shared/src/enums.ts`: `ACTIVITY_TYPES` (ملاحظة/مكالمة/اجتماع) و`FOLLOWUP_TASK_STATUSES` (مفتوحة/منجزة/ملغاة).
- (لا تغيير في `permissions.ts`؛ بُني `packages/shared/dist` بـ`npm run build -w @npi/shared` لأن `main` يشير إليه.)

### api
- `common/notification.service.ts`: `notifyUser(input, tx?)` (صف واحد؛ مستخدم غير نشط أو من منشأة أخرى ← 0 بلا كتابة) و`notifyUserBestEffort`. `notify` القائمة لم تُمسّ.
- `common/org-settings.service.ts`: `TASK_REMINDER_DAYS_BEFORE` (0..30) و`TASK_REMINDER_HOUR` (0..23) في المفاتيح والافتراضيات و`ORG_SETTING_EDITABLE` (فيلتقطهما `GET/PATCH /admin/settings` تلقائياً).
- `modules/crm/crm-scope.ts` (جديد): `resolveScope` يفحص العميل (404/409 `Customer already merged`) والفرصة (404، أو 400 `Opportunity does not belong to this customer`) والمشروع (404) وجهة الاتصال (400 `Contact does not belong to this customer`) كلها داخل المنشأة؛ و`assertContactOf`.
- `modules/crm/crm-rows.ts` (جديد): `ACTIVITY_INCLUDE` و`TASK_INCLUDE` و`withAttachmentCounts` (استعلام مجمَّع واحد) و`withDueState` — يشترك فيها الـservices و`overview` فلا يتباعد الشكلان.
- `modules/crm/follow-up-notifications.ts` (جديد): نصوص الإشعارات الثلاثة (`TASK_ASSIGNED/REMINDER/OVERDUE`) بالعربية والإنجليزية بالعنوان والرمز واسم العميل ورابط `/tasks?focus=<id>`.
- `modules/crm/follow-up-tasks.service.ts` + `follow-up-tasks.controller.ts` (جديدان): `list/get/create/createInTx/update/complete/cancel` وفق §5؛ المسارات `GET /tasks` و`GET /tasks/:id` و`POST /tasks` و`PATCH /tasks/:id` و`POST /tasks/:id/complete` و`POST /tasks/:id/cancel` بـ`crm.customer.read/write` فقط.
- `modules/crm/activities.service.ts` + `activities.controller.ts` (جديدان): `GET /activities` (بـ`customerId` أو `opportunityId`، keyset بـ`cursor`، `take` 50/200، يعيد `{items, nextCursor}`)، `POST /activities` (قيد + مهمة اختيارية في المعاملة نفسها عبر `createInTx`، يعيد `{activity, task?}`)، `PATCH /activities/:id` (الكاتب فقط 403، الحقول الأربعة فقط). لا مسار حذف.
- `modules/crm/follow-up-reminder.scheduler.ts` (جديد): `@Cron(EVERY_HOUR, {name:'remind-follow-up-tasks', timeZone:'Asia/Riyadh'})` + `sweep(now) → {reminded, overdue}`؛ «مرة واحدة» = وسم بـ`UPDATE ... WHERE reminderSentAt/overdueNotifiedAt IS NULL AND status='OPEN'` في معاملة الإشعار نفسها (فلا يتكرر الإشعار ولا يصدر عن مهمة أُغلقت بين القراءة والكتابة)؛ كل مهمة في try/catch.
- `modules/crm/crm.module.ts`: تسجيل المتحكمين والخدمتين والمجدول (لا تغيير في `exports`).
- `modules/crm/dto.ts`: `CreateActivityDto`, `ActivityFollowUpDto`, `UpdateActivityDto`, `CreateTaskDto`, `UpdateTaskDto`, `CancelTaskDto` (class-validator، `ValidateNested` للمتابعة).
- `modules/crm/customers.service.ts` (`overview`): `activities` (أحدث 20)، `tasks` (المفتوحة بترتيب الاستحقاق، حد 50)، `counts.activities` (الكل) و`counts.tasks` (المفتوحة). القوائم القائمة لم تُمسّ، ولم يُغيَّر constructor (فلا تتأثر الاختبارات القائمة).
- `modules/crm/customer-merge.service.ts`: نقل `Activity` و`FollowUpTask` إلى الباقي (مرفقات القيد تتبع القيد فلا تُنقل)، وعدّهما في `duplicates()` و`totalDocuments`، وفي `movedJson` وحدث `customer.merged` حين يوجد ما يُنقل.
- `modules/platform/attachments.service.ts`: `ACTIVITY: 'crm.customer.read'` في خريطة العرض، و`assertEntityExists` للقيد، وقاعدة كتابة إضافية `ENTITY_WRITE_PERMISSION = {ACTIVITY: 'crm.customer.write'}` على الرفع والحذف (انظر §5).
- `modules/inbox/inbox.service.ts`: مصدر `source: 'FOLLOWUP'` (مهام المستخدم نفسه المفتوحة وتستحق اليوم أو قبله، استعلام واحد، `stateAr` «مستحقة اليوم»/«متأخرة يوم/يومين/n أيام/n يوماً»)؛ يدخل `GET /inbox/count` تلقائياً.
- `modules/reference/reference.controller.ts`: `activityTypes` و`followUpTaskStatuses` في `/reference/enums`، و`myTasksDueToday`/`myTasksOverdue` في `/reference/dashboard` (0 لمن لا يحمل `crm.customer.read`).

### web
- `components/activity-timeline.tsx` (جديد): المحرِّر (أزرار النوع، تاريخ ووقت، جهة الاتصال، الفرصة، النص، مربع مهمة المتابعة بالعنوان والاستحقاق والمكلَّف)، والخط الزمني مجموعاً باليوم («اليوم/أمس/التاريخ») بأيقونة النوع والوقت والكاتب وجهة الاتصال وشارة الفرصة برابط وعدد المرفقات، وتوسيع القيد لـ`AttachmentsCard entityType="ACTIVITY"`، و«تعديل» للكاتب فقط، و«تحميل المزيد» بالـcursor.
- `components/follow-up-tasks.tsx` (جديد): `DueBadge` (أحمر «متأخرة n يوم»، كهرماني «اليوم»، عادي) و`TaskStatusBadge` المحلية (لأن `OPEN` في `StatusBadge` مذكَّرة «مفتوح» ولا `DONE`) و`TaskFormModal` (إنشاء/تعديل) و`TaskActions` («تم»، «إلغاء» بنافذة سبب إلزامي، «تعديل») و`FollowUpTasksPanel` (جدول المفتوحة + «+ مهمة» + قسم مطوي «المنجزة والملغاة» أحدث 20) و`useAssignees`.
- `app/(app)/tasks/page.tsx` (جديد): «مهامي/مهام الفريق» وفلاتر متأخرة/اليوم/هذا الأسبوع/الكل؛ الأعمدة الاستحقاق والرمز والعنوان والعميل برابط والفرصة والمكلَّف والأزرار؛ `?focus=<id>` يميّز الصف ويمرّر إليه، ومهمة مغلقة أو خارج النطاق تظهر في بطاقة خاصة.
- `app/(app)/customers/[id]/page.tsx`: تبويبان بعد «جهات الاتصال» (العدّادان من `counts`)، وقراءة `?tab=` عند التحميل. `app/(app)/opportunities/[id]/page.tsx`: التبويبان نفسهما (يجلبان عند الفتح، المحرِّر يثبّت الفرصة والعميل).
- `app/(app)/inbox/page.tsx` (أيقونة `square-check` للمصدر الجديد، ونص التلميح)، `app/(app)/dashboard/page.tsx` (بطاقة «مهام المتابعة: مستحقة اليوم n — متأخرة m» برابط `/tasks`)، `app/(app)/admin/page.tsx` + `components/task-settings.tsx` (جديد، «إعدادات المتابعة»).
- `components/attachments.tsx` (`ACTIVITY` في الاتحاد، و`onChange`، ورفع المرفق لقيد يستلزم `crm.customer.write` في الواجهة)، `components/audit-log.tsx` (`Activity: 'قيد تواصل'`, `FollowUpTask: 'مهمة متابعة'`, `REASSIGN: 'إعادة إسناد'`)، `components/icons.tsx` (`phone`, `sticky-note`)، `components/customer-merge.tsx` (عمودان للعدّين الجديدين)، `lib/nav.ts` (`/tasks` بعد الفرص، `crm.customer.read`)، `lib/useEnums.ts`.
- `lib/messages.ts`: ~100 مفتاحاً بالعربية والإنجليزية (`activities.*`, `tasks.*`, `cust.tab.activities/tasks`, `opps.tab.activities/tasks`, `nav.tasks`, `dash.myTasks*`, `adm.settings.tasks.*`, `cust.merge.c.activities/followUpTasks`)؛ `lib/errors.ts`: نمط عربي/إنجليزي لكل رسالة خادم جديدة (400/409) ونمط 403 `Only the author can edit this entry`.

### tests
- وحدة (جديدة): `common/follow-up-dates.spec.ts` (15)، `common/notification.service.spec.ts` (6)، `modules/crm/activities.service.spec.ts` (31)، `modules/crm/follow-up-tasks.service.spec.ts` (45)، `modules/crm/follow-up-reminder.scheduler.spec.ts` (13)، `modules/inbox/inbox.service.spec.ts` (7).
- وحدة (ممتدة): `modules/crm/customer-merge.service.spec.ts` 5 ← 9 (نقل القيود والمهام وعدّها)، `common/org-settings.service.spec.ts` 15 ← 23 (الإعدادان الجديدان؛ وتأكيدان قائمان وُسِّعا، §5).
- تكامل: `test/activities-tasks.int-spec.ts` (جديد، 16) و`test/tenant-isolation.int-spec.ts` (+8، ويُنظِّف الآن مهمته وقيده من منشأة الجارة).

### seed
- `scripts/seed-demo.js`: لا تغيير (التسلسل التجاري لا يمر بالمهام) كما في العقد.

## 3. البوابات

من جذر المستودع، بعد دورة `down.sql` الأخيرة وإعادة الترحيل:

| الأمر | النتيجة |
|---|---|
| `npm run typecheck` | db / shared / api / web: `tsc --noEmit` بلا أخطاء |
| `npm run lint` | `eslint .` بلا مخرجات (نظيف) |
| `npm test` | `Test Suites: 42 passed, 42 total` / `Tests: 563 passed, 563 total` (الأساس 434، +129: تواريخ 15، إشعار المستخدم 6، القيود 31، المهام 45، المجدول 13، الصندوق 7، الدمج +4، الإعدادات +8) |
| `npx prisma migrate deploy --schema packages/db/prisma/schema.prisma` | `Applying migration 0028_crm_activities` / `0029_crm_activities_backfill` / `All migrations have been successfully applied.` (مرتان: الأولى، وبعد دورة down) |
| `npm run db:seed` | `✅ Seed complete.` (idempotent؛ ثلاث مرات؛ بعدها قيد واحد ومهمة واحدة في كل مرة) |
| `npm run test:int` | `Test Suites: 8 passed, 8 total` / `Tests: 137 passed, 137 total` (الأساس 113، +24: `activities-tasks` 16 و`tenant-isolation` +8)؛ لم يُحذف أو يُضعَّف أي اختبار تكامل |
| `npm run build -w @npi/web` | `✓ Compiled successfully` / `✓ Generating static pages (33/33)`؛ `/tasks` (1.93 kB) و`/customers/[id]` (4.24 kB) و`/opportunities/[id]` (4.71 kB) و`/admin` مبنية. **نُفِّذ على نسخة مؤقتة من `apps/web`** لا في المكان، لأن `next build` يكتب في `.next` نفسه الذي يخدمه `next dev` (المطلوب ألا يُوقف) فيفسده؛ حُذفت النسخة بعد البناء (انظر §5) |
| `prisma migrate diff` (القاعدة ← المخطط) | لا فروق تخص هذه الخطوة؛ يبقى الفرقان القديمان غير المتعلقين بها (`GoodsReceiptLine.serials` default وتسمية فهرس `ApprovalRule`) كما في الخطوتين 3 و4 |

**دورة `down.sql` (قاعدة محلية):**
1. `down.sql` لـ0029 مع وجود مهمة: `Error: ERROR: Rollback of 0029 refused: follow-up tasks exist, and their TSK- codes must not be reissued. Remove or archive them first (see the header of down.sql).` — ولم يتغير شيء.
2. بعد حذف المهام والقيود التجريبية (ومعها إشعارات `TASK_*`): down 0029 ← `Script executed successfully.`، ثم down 0028 ← `Script executed successfully.`
3. `DELETE FROM "_prisma_migrations" WHERE migration_name IN ('0029_crm_activities_backfill','0028_crm_activities')` (كما في رأس 0024/0026) ثم `migrate deploy`: طُبِّق الترحيلان من جديد (`ADD VALUE IF NOT EXISTS 'ACTIVITY'` مرّ لأن القيمة تبقى).
4. إعادة تشغيل `0029/migration.sql` مباشرة بعد التطبيق: عدّادات `OrgSetting` (69 + 69) و`NumberingSequence FOLLOWUP_TASK` (69) لـ69 منشأة لم تتغير (idempotent)؛ ثم `db:seed` أعاد القيد والمهمة.
5. **تنبيه للمراجع:** تجارب التكامل تترك صفوفاً في منشآت تجريبية جديدة لا يمكن حذفها (التدقيق append-only)؛ لذلك صارت الملفات تحذف قيودها ومهامها في `afterAll` (وإلا منعت `down.sql` لـ0029 لاحقاً). وبعد التشغيل الأخير أعدتُ `nextValue` لتسلسل المنشأة المزروعة إلى 2 (التجارب تستهلك أرقام `TSK` ولا تعيدها) فالمهمة التالية الحقيقية `TSK-00002`.

**تجربة API/واجهة دخانية** (على الخادمين الجاريين من هذا الـworktree؛ لقطات الشاشة لم تعمل لأن نافذة المتصفح مخفية، فقُرئ النص والشبكة): `POST /api/activities` ← 201 من محرِّر صفحة العميل (قيد + مهمة تستحق اليوم) → `TSK-00014` بـ`dueState: TODAY` و`reminderSentAt` مملوءة فوراً؛ صفحة `/tasks?focus=<id>` تعرض الصفين مع «تم/تعديل/إلغاء»؛ `/inbox` يعرض «مهمة متابعة: … — مصنع الرياض للصناعات» بحالة «مستحقة اليوم»؛ بطاقة لوحة القيادة موجودة؛ تبويب «سجل التواصل» في `OPP-00121` يعرض المحرِّر وجهة اتصال العميل. حُذفت بيانات التجربة بعدها.

## 4. الأدلة قبل/بعد

**قبل (قبل أي كود):** `npx jest follow-up-dates notification.service activities.service follow-up-tasks follow-up-reminder inbox.service customer-merge org-settings` ← `Test Suites: 8 failed, 8 total` / `Tests: 10 failed, 6 passed`:
- `follow-up-dates.spec.ts`: `Module '"@npi/shared"' has no exported member 'daysOverdue'` / `'defaultRemindAt'` / `'isBeforeToday'` / `'taskDueState'` / `'ACTIVITY_TYPES'` / `'FOLLOWUP_TASK_STATUSES'`.
- `notification.service.spec.ts`: `Property 'notifyUser' does not exist on type 'NotificationService'` و`Property 'notifyUserBestEffort' does not exist ... Did you mean 'notifyBestEffort'?`.
- `org-settings.service.spec.ts`: `Property 'TASK_REMINDER_DAYS_BEFORE' does not exist on type '{ readonly CUSTOMER_SIMILARITY_THRESHOLD: ...'` (و`TASK_REMINDER_HOUR`).
- `activities.service.spec.ts` / `follow-up-tasks.service.spec.ts` / `follow-up-reminder.scheduler.spec.ts`: `Cannot find module './activities.service'` / `'./follow-up-tasks.service'` / `'./follow-up-reminder.scheduler'`.
- `inbox.service.spec.ts`: 7 اختبارات حمراء (لا مصدر `FOLLOWUP`، لا استعلام عن `followUpTask`). `customer-merge.service.spec.ts`: 3 حمراء (`tx.activity.updateMany` لم يُستدعَ، وعدّان بلا مفتاحَي `activities/followUpTasks`).
- التكامل (بإخفاء ملفات الخدمات الخمسة مؤقتاً ثم إعادتها): `FAIL test/activities-tasks.int-spec.ts` و`FAIL test/tenant-isolation.int-spec.ts` — 7 أخطاء تجميع `TS2307: Cannot find module '../src/modules/crm/activities.service'` (مرتان) / `follow-up-tasks.service` (مرتان) / `follow-up-tasks.controller` / `follow-up-reminder.scheduler` / `activities.controller`؛ `Tests: 0 total`. (أُخذ هذا الدليل بعد الكتابة الأولى للتنفيذ لا قبلها؛ كُتب ملف التكامل قبل الكود لكن أول تشغيل له كان بعده، فأعدتُ الحالة الحمراء بهذه الطريقة بدل ادعاء تشغيل لم يحدث.)

**بعد:**
- ملفات الوحدة الثمانية معاً: `Tests: 149 passed` (تواريخ 15، إشعار 6، إعدادات 23، صندوق 7، دمج 9، مهام 45، قيود 31، مجدول 13).
- `activities-tasks.int-spec.ts` (16 اختباراً، مستخدمون مزروعون حقيقيون): المندوب ينشئ قيد اجتماع على `CUS-00001` مع مهمة لنفسه تستحق غداً ← `TSK-` من خمسة أرقام، `assigneeId` = المندوب، `dueAt` = `YYYY-MM-DDT00:00:00.000Z` لغد الرياض، `remindAt` = 05:00 UTC اليوم (08:00 الرياض) وإن مضت الساعة فالتذكير فوري ومعه إشعار `TASK_REMINDER` واحد، ولا `TASK_ASSIGNED`؛ القيد يظهر في الخط الزمني بكاتبه و`attachmentsCount: 0`؛ التنفيذي يُرفض في التعديل (`Only the author can edit this entry`)، وتدقيق `Activity` = `CREATE` ثم `UPDATE` فقط؛ `customers.overview` يعيد `activities` و`tasks` و`counts.activities/tasks`؛ إكمال ثم إكمال ثانٍ ← 409 (والإلغاء بعد الإكمال ← 409)؛ مهمة للمدير تستحق بعد 5 أيام ← `TASK_ASSIGNED` واحد للمدير ولا شيء للمندوب ولا تذكير بعد؛ أرقام متتالية؛ إرجاع الاستحقاق إلى أمس عبر Prisma ثم `sweep` ← `TASK_OVERDUE` واحد للمدير وواحد للمنشئ، و`sweep` ثانٍ لا يزيد؛ الصف في `inbox.tasks` للمدير بـ`overdue: true` و`مهمة متأخرة يوم` ورابط `/tasks?focus=<id>`، ولا يظهر للتنفيذي ولا للمندوب؛ مهمة تستحق اليوم ← في الصندوق «مستحقة اليوم» و`overdue: false` ولا يُرسَل لها إشعار تأخر، ومهمة غداً لا تظهر؛ مهمة ملغاة لا تُمسح ولا تظهر؛ تمديد الاستحقاق يصفّر `overdueNotifiedAt` ويصير `dueState: UPCOMING`؛ مفاتيح الصلاحية على المتحكمين (`Reflect.getMetadata`) = `crm.customer.read/write` فقط؛ دمج عميل في منشأة مستقلة ينقل قيدين ومهمة (`movedJson` يحمل `Activity: 2, FollowUpTask: 1`) ثم القيد والمهمة على المدمَج ← 409 `Customer already merged`.
- `tenant-isolation.int-spec.ts` +8: قائمة القيود (بعميل أو بفرصة) والمهام (كل الحالات) من منشأة أخرى ← فارغة، و`get/complete/cancel/update/reassign` على مهمتها ← 404 لا 403 وتبقى `OPEN` بعنوانها، و`update` على قيدها ← 404، والكتابة على عميلها/فرصتها ← 404، وجهة اتصال منشأة أخرى ← 400 (لا تُكشف)، وإسناد مهمة لمستخدم منشأة أخرى ← 400 `Assignee not found`، ورفع ملف لقيدها ← 404.
- باقي ملفات التكامل كما كانت (`opportunity-stages` 20/20 إلخ).

## 5. الانحرافات عن العقد

1. **تأكيدان قائمان في `org-settings.service.spec.ts` وُسِّعا (لا حُذفا ولا ضُعِّفا).** «lists exactly the three editable keys» صار خمسة، و`getEditable` يتوقع الآن المفتاحين الجديدين. نتيجة مباشرة لـ§4 الذي يضيف مفتاحين قابلين للتعديل؛ لا يمكن للاختبار الأصلي أن يبقى كما هو والعقد منفَّذ.
2. **`movedJson.Activity/FollowUpTask` لا يظهران إلا إذا وُجد ما يُنقل (عدد > 0).** السبب: `customer-merge.int-spec.ts:290` يتوقع `moved` بـ`toEqual` على ستة مفاتيح بالضبط، وإضافة مفتاحين بصفر تكسره. العقد قال «`movedJson.Activity/FollowUpTask`» دون تفصيل؛ الشكل القديم محفوظ لكل دمج لا يحمل قيوداً. (`duplicates()` يعيد العدّين دائماً.)
3. **صيغة تخزين `dueAt`:** العقد يقول «UTC-منتصف-ليل يومه بالرياض (`riyadhDayStart`، نفس عرف `validUntil`)» والعبارتان متعارضتان ظاهراً (`riyadhDayStart` تعيد لحظة منتصف الليل بالرياض أي 21:00 UTC). اتبعتُ «نفس عرف `validUntil`» أي `normalizeValidUntil` (UTC منتصف ليل تاريخ الرياض)، واستعملتُ `riyadhDayStart` في المقارنات كما تفعل `proposal-expiry.scheduler` (`dueAt < riyadhDayStart(now)` ← متأخرة؛ `dueAt < riyadhDayStart(now)+يوم` ← اليوم أو قبله). دوال `follow-up-dates.ts` تعطي الجواب نفسه للصيغتين.
4. **دالة رابعة في `follow-up-dates.ts`: `isBeforeToday`** (العقد سمّى ثلاثاً) — لئلا تكتب الخدمة منطق تاريخ خارج الملف كما اشترط §3.
5. **صلاحية كتابة المرفق للقيد:** العقد: «للعرض `crm.customer.read` وللرفع `crm.customer.write` — نفس مرفقات العميل». الكود القائم يحرس الرفع والحذف بمفتاح القراءة وحده (`ENTITY_READ_PERMISSION`) فمرفقات العميل نفسها لا تطلب `write`. نفّذتُ ما كتبه العقد حرفياً للقيد بقاعدة إضافية `ENTITY_WRITE_PERMISSION` على الرفع والحذف (تبقى مرفقات العميل كما هي). الأثر: رفع ملف لقيد يلزمه `platform.attachment.write` و`crm.customer.write` معاً.
6. **قائمة المكلَّفين:** العقد سمح بالرجوع إلى `GET /admin/users` للمدير فقط و«أنا» لغيره. لا يوجد في النظام مسار آخر يعرض المستخدمين لحامل `crm.customer.*` (`/admin/users` و`/admin/departments/directory` و`/delegations/directory` كلها بمفاتيح إدارية). لذا المندوب لا يستطيع من الواجهة إسناد مهمة لزميل (ينجح عبر الـAPI، وأثبته اختبار التكامل بتمرير `assigneeId`). موثَّق في الواجهة بتلميح، وفي §8.
7. **إضافات صغيرة لم ينص عليها العقد (حماية لا ميزة):** 400 `Reminder cannot be after the due date` لتذكير بعد يوم الاستحقاق؛ 400 `Title is required` و`Body is required` (النص المحذوف الفراغات) وحدّا الطول 200/4000 في الخدمة (إضافةً إلى الـDTO، لأن `createInTx` تُستدعى من الخدمة الأخرى)؛ ذكر يوم الاستحقاق نفسه في `PATCH` لمهمة متأخرة لا يُعدّ تغييراً ولا يُرفض (وإلا ما أمكن تعديل عنوان مهمة متأخرة من النموذج)؛ تمديد الاستحقاق إلى ما بعد القديم يصفّر `overdueNotifiedAt` أيضاً (إلى جانب `reminderSentAt` الذي ذكره العقد) ليُنبَّه من جديد إن تأخرت ثانية؛ `GET /tasks?take=` (200 افتراضياً، 500 حداً)؛ ترتيب `status=ALL` (المفتوحة بالاستحقاق ثم المغلقة بالأحدث).
8. **`dueState`/`daysOverdue` للمهمة غير المفتوحة:** `null`/`0` (العقد قال «من `taskDueState`» دون تحديد)، فلا تظهر مهمة منجزة «متأخرة».
9. **ردّ `GET /activities`:** `{items, nextCursor}` (العقد لم يحدد الشكل)؛ و`overview.activities` مصفوفة مباشرة، وتُبنى «تحميل المزيد» من مجموع `counts.activities` وآخر id.
10. **الخادم والـprisma generate:** `prisma generate` رُفض بـ`EPERM` كما توقّع العقد، فأوقفتُ عملية `node ...\apps\api\dist\main` وحدها (PID 19748) وشغّلتُ `npm run db:generate`. لم أشغّل `npm run dev:api`: مراقب `nest start --watch` (PID 10016) ظلّ حياً وأعاد تشغيل الخادم بنفسه عند أول تعديل (PID 10772، المنفذ 4000)؛ تحققتُ بـ`curl` أن المسارات الجديدة تعمل. خادم الويب (3000) لم يُمسّ.
11. **بناء الويب على نسخة:** انظر §3 — `npm run build -w @npi/web` في المكان يفسد `.next` الخاص بـ`next dev` الجاري (والعقد يمنع إيقافه)، فبنيتُ نسخة من `apps/web` (بلا `.next`) داخل `apps/web_buildcheck` وحذفتها؛ النتيجة نفسها ما دام المصدر نفسه. قد يفضّل المراجع إعادة الأمر في المكان بعد إيقاف `next dev`.
12. **اللمسات خارج قائمة العقد حرفياً:** عمودان في شاشة الدمج للعدّين الجديدين (وإلا يقترح الدمج «الباقي» بمجموع لا يطابق الأعمدة الظاهرة)؛ `REASSIGN` في تسميات التدقيق؛ إعادة صياغة جملة `Setting value out of range` العربية/الإنجليزية في `errors.ts` (كانت «من 1 إلى 365» وصارت عامة لأن للإعدادين الجديدين مدى آخر).
13. **لا يوجد انحراف** في: الجدولين وأعمدتهما وفهارسهما، والترحيلين و`down.sql` لكل منهما، والصلاحيات (لا مفتاح جديد)، والتدقيق (`CREATE|UPDATE|COMPLETE|CANCEL|REASSIGN` داخل المعاملة)، والترقيم عبر `NumberingService.next(org,'FOLLOWUP_TASK',tx)`، وعدم وجود حذف، و`search.service.ts`، و`scripts/seed-demo.js`.

## 6. سلوك ملحوظ

- **التذكير الفوري مع مكلَّف آخر:** مهمة تستحق اليوم أو غداً (والساعة بعد 08:00) لزميل تُرسِل له إشعارين في اللحظة نفسها: `TASK_ASSIGNED` و`TASK_REMINDER`، لأن العقد قال إن التذكير يُرسل فوراً حين يكون وقته قد مضى وإن التكليف يُرسل حين يختلف المكلَّف عن الفاعل. لم أدمجهما (انظر §8).
- **تمديد الاستحقاق بعد تذكير أُرسل:** يصفّر `reminderSentAt` ويعيد حساب `remindAt`؛ فإن كان الوقت الجديد قد مضى أيضاً (مهمة لليوم مُدِّدت لغد) أُرسل تذكير جديد فوراً بدل انتظار المسح التالي.
- **`remindAt` صريح:** مقبول من الـAPI (لا من الواجهة)، ولا يُقبل بعد يوم الاستحقاق.
- **المسح كل ساعة** عند رأس الساعة بتوقيت الرياض؛ لو توقف الخادم ساعات جاء الإشعار عند أول مسح بعد عودته (وبـ«متأخرة n يوم» محسوبة وقتها).
- **الإكمال/الإلغاء:** `UPDATE ... WHERE status='OPEN'` فيخسر الطلب الثاني المتزامن بـ409 `Task is not open`.
- **القيد بتاريخ الغد:** مرفوض فوق 5 دقائق (تسامح ساعة المتصفح)؛ ومحرِّر الواجهة يمنع `max` بالوقت الحالي.
- **التسمية:** `GET /activities` لعميل منشأة أخرى يعيد `{items: [], nextCursor: null}` لا 404 (العقد: «404/قائمة فارغة»).

## 7. الحدود المعروفة

- **لا بريد:** التذكير والتأخر إشعاران داخل النظام فقط؛ البريد اليومي الموجز (§11) خارج الخطوة كما قرر العقد.
- **الصندوق الموحّد شخصي لهذا المصدر وحده** (التباين مع فلسفة الأدوار موثَّق في كود `InboxService` وفي العقد)؛ ومن غادر الشركة تبقى مهامه ظاهرة في `/tasks` (مهام الفريق) لإعادة إسنادها، لكن لا مسح يبلّغ أحداً بأن مكلَّفاً غير نشط يحمل مهاماً.
- **إسناد مهمة لزميل من الواجهة** يحتاج صلاحية إدارة المستخدمين (§5-6).
- **بطاقة لوحة القيادة** تعتمد على `GET /reference/dashboard` المحروس بـ`crm.lead.read` (كما في العقد)، فدور يحمل `crm.customer.read` بلا `crm.lead.read` (المحاسب، مدير المشاريع) لا يراها ولا يرى أرقامها، مع أن `/tasks` يعمل له.
- **«تحميل المزيد»** بعد إضافة قيد جديد يعيد الصفحة الأولى فقط (ما حُمِّل بعدها يُفقد من العرض حتى يضغط المستخدم ثانية)؛ وقسم «المنجزة والملغاة» يجلب حتى 200 مهمة ويعرض أحدث 20.
- **الحذف الوحيد الممكن لأثر قيد:** مرفقاته (`DELETE /attachments/:id`) لمن يحمل `platform.attachment.write` و`crm.customer.write`، كمرفقات العميل؛ نص القيد نفسه لا يُحذف.
- **اختبارات التكامل تستهلك أرقام `TSK-`** من تسلسل المنشأة المزروعة (الأرقام لا تُعاد)؛ أعدتُ التسلسل في قاعدتي المحلية إلى 2 بعد آخر تشغيل. وتترك منشآت تجريبية فارغة من القيود والمهام (التدقيق append-only كبقية الملفات).
- **لا تعدّد لغات في نص الإشعار المخزَّن إلا بزوج `titleAr/titleEn` و`bodyAr/bodyEn`** (عرف الجدول)؛ نص الإشعار لا يتغير لو غُيِّر اسم العميل بعده.
- **المهام لا تُبحث** في البحث الشامل (`search.service.ts` لم يُمسّ كما في العقد). **لا إعادة فتح** لمهمة منجزة/ملغاة (يُنشأ جديد).
- `projectId` يُقبل في الـAPI ولا تعرضه الواجهة (المشاريع خارج المرحلة).

## 8. ما يحتاج قرار المراجع

1. **قائمة المكلَّفين لحامل `crm.customer.write`:** الأمل أن يُسند المندوب لزميل؛ المتاح اليوم «أنا» فقط لغير مديري المستخدمين. الحل الأنظف مسار صغير `GET /tasks/assignees` (مستخدمون نشطون: `id, nameAr, nameEn`) بـ`crm.customer.write`؛ لم أضفه لأنه خارج §5 ويكشف أسماء الزملاء لدور لا يراها اليوم. هل يُضاف في هذه الخطوة؟
2. **تكرار الإشعار عند الإسناد لزميل بوقت تذكير ماضٍ** (§6): `TASK_ASSIGNED` ثم `TASK_REMINDER` في اللحظة نفسها. التوصية: يكفي `TASK_ASSIGNED` ويُوسَم `reminderSentAt` دون إشعار ثانٍ. لم أطبقها لأنها تخالف حرف §1-5. أطبّقها؟
3. **`movedJson` بلا صفر** (§5-2): مقبول، أم يُعدَّل `customer-merge.int-spec.ts:290` ليتوقع `Activity: 0, FollowUpTask: 0`؟ (أبقيتُ الاختبار القديم كما هو.)
4. **رفع/حذف مرفق القيد بمفتاحين** (§5-5): هل يُطبَّق المبدأ نفسه على مرفقات العميل والفرصة (يطلب `crm.customer.write`/`crm.opportunity.write`) في خطوة لاحقة؟ اليوم يكفي فيها مفتاح القراءة.
5. **بطاقة لوحة القيادة لمن لا يحمل `crm.lead.read`:** نقل `myTasks*` إلى مسار بمفتاح `crm.customer.read`، أم نترك العقد كما هو؟
6. **بناء الويب:** أُعيد `npm run build -w @npi/web` في المكان بعد إيقاف `next dev` مؤقتاً (قرارك)، أم تكفي النسخة؟
7. **المراجعة الحية §10:** لم أنفّذها (ولا لقطات `screenshots/step-5-*`)؛ نافذة المتصفح مخفية فلم تعمل اللقطات. خطوات (1)–(5) جاهزة: المثالان مزروعان، و`UPDATE "FollowUpTask" SET "dueAt"` ثم `sweep` يعمل (جرّبته عبر اختبار التكامل بـPrisma)، لكن الاستدعاء اليدوي لـ`sweep` من خارج الاختبار يحتاج انتظار الساعة التالية أو سكربت صغير كالمستعمل في الاختبار.

## git status --short

```
 M apps/api/src/common/notification.service.ts
 M apps/api/src/common/org-settings.service.spec.ts
 M apps/api/src/common/org-settings.service.ts
 M apps/api/src/modules/crm/crm.module.ts
 M apps/api/src/modules/crm/customer-merge.service.spec.ts
 M apps/api/src/modules/crm/customer-merge.service.ts
 M apps/api/src/modules/crm/customers.service.ts
 M apps/api/src/modules/crm/dto.ts
 M apps/api/src/modules/inbox/inbox.service.ts
 M apps/api/src/modules/platform/attachments.service.ts
 M apps/api/src/modules/reference/reference.controller.ts
 M apps/api/test/tenant-isolation.int-spec.ts
 M apps/web/src/app/(app)/admin/page.tsx
 M apps/web/src/app/(app)/customers/[id]/page.tsx
 M apps/web/src/app/(app)/dashboard/page.tsx
 M apps/web/src/app/(app)/inbox/page.tsx
 M apps/web/src/app/(app)/opportunities/[id]/page.tsx
 M apps/web/src/components/attachments.tsx
 M apps/web/src/components/audit-log.tsx
 M apps/web/src/components/customer-merge.tsx
 M apps/web/src/components/icons.tsx
 M apps/web/src/lib/errors.ts
 M apps/web/src/lib/messages.ts
 M apps/web/src/lib/nav.ts
 M apps/web/src/lib/useEnums.ts
 M packages/db/prisma/schema.prisma
 M packages/db/prisma/seed.ts
 M packages/shared/src/enums.ts
 M packages/shared/src/index.ts
?? apps/api/src/common/follow-up-dates.spec.ts
?? apps/api/src/common/notification.service.spec.ts
?? apps/api/src/modules/crm/activities.controller.ts
?? apps/api/src/modules/crm/activities.service.spec.ts
?? apps/api/src/modules/crm/activities.service.ts
?? apps/api/src/modules/crm/crm-rows.ts
?? apps/api/src/modules/crm/crm-scope.ts
?? apps/api/src/modules/crm/follow-up-notifications.ts
?? apps/api/src/modules/crm/follow-up-reminder.scheduler.spec.ts
?? apps/api/src/modules/crm/follow-up-reminder.scheduler.ts
?? apps/api/src/modules/crm/follow-up-tasks.controller.ts
?? apps/api/src/modules/crm/follow-up-tasks.service.spec.ts
?? apps/api/src/modules/crm/follow-up-tasks.service.ts
?? apps/api/src/modules/inbox/inbox.service.spec.ts
?? apps/api/test/activities-tasks.int-spec.ts
?? apps/web/src/app/(app)/tasks/
?? apps/web/src/components/activity-timeline.tsx
?? apps/web/src/components/follow-up-tasks.tsx
?? apps/web/src/components/task-settings.tsx
?? docs/crm-phase-1/step-5-activities-contract.md
?? docs/crm-phase-1/step-5-agent-report.md
?? packages/db/prisma/migrations/0028_crm_activities/
?? packages/db/prisma/migrations/0029_crm_activities_backfill/
?? packages/shared/src/follow-up-dates.ts
```
