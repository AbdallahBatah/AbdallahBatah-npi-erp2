# الخطوة 1 — الأدوار والصلاحيات (القسم 3): العقد الملزم للوكيل المنفّذ

> مجلد العمل: `C:\dev\npi-erp-crm` (worktree على فرع `feature/crm-phase-1` من `main` عند 9db91d7). `.env` منسوخ و`npm install` منفّذ.
> القاعدة: إضافة فقط؛ لا حذف ولا تعديل عمود/جدول قائم؛ ترحيل واحد `0021_crm_roles_permissions` مع `down.sql` يدوي (عرف 0019/0020).
> المرجع: `docs/../plan` في `C:\Users\truyr\.claude\plans\c-users-truyr-downloads-npi-erp-docx-c-flickering-storm.md` (قرارات إياد في قسم «قرارات إياد»).

## 1. قاعدة البيانات (`packages/db/prisma/schema.prisma` + migration 0021)
- جدول جديد `UserRole { id cuid, userId, roleId, createdAt }` مع `@@unique([userId, roleId])` وفهرس على `roleId`. علاقات: `User.extraRoles UserRole[]`، `Role.userRoles UserRole[]`. **لا يُمس `User.roleId`** (يبقى الدور الأساسي).
- ترحيل بيانات داخل `migration.sql` يحفظ السلوك الحالي حرفياً (لا يفقد أحد رؤية كان يملكها):
  - أضف `finance.costs.view` لكل دور يحمل أياً من: `commercial.item.read`, `commercial.proposal.read`, `projects.project.read`, `finance.ledger.read`, `fsm.workorder.read`.
  - أضف `scm.procurement.approve` لكل دور يحمل `scm.procurement.write`؛ `projects.project.approve` لكل من يحمل `projects.project.write`؛ `commercial.proposal.approve` لكل من يحمل `commercial.proposal.write`.
  - صيغة: `UPDATE "Role" SET permissions = array_append(permissions, 'K') WHERE NOT ('K' = ANY(permissions)) AND permissions && ARRAY[...]::text[];`
- `down.sql`: `array_remove` للمفاتيح الأربعة ثم `DROP TABLE "UserRole"`، مع تعليق صريح أن إزالة المفاتيح من الأدوار تعيد الحالة السابقة بالضبط.
- بعد الترحيل: `npm run db:generate` ثم `npm run build -w @npi/shared`.

## 2. المشترك (`packages/shared/src/permissions.ts`, `approvals.ts`)
- مفاتيح جديدة: `COSTS_VIEW='finance.costs.view'`, `PROCUREMENT_APPROVE='scm.procurement.approve'`, `PROJECT_APPROVE='projects.project.approve'`, `PROPOSAL_APPROVE='commercial.proposal.approve'`.
- وسّع `PermissionMeta` (إضافة حقول فقط): `screenAr/screenEn` (اسم الشاشة) و`action: 'view'|'write'|'approve'|'special'`. الكتالوج القائم يُعاد تصنيفه: `*.read`→view، `*.write`→write، `*.approve`→approve، الباقي (`manage`, `costs.view`, `attachment.*`) → special. **ملاحظة تُشرح لإياد:** النموذج القائم يجمع «إنشاء» و«تعديل» في مفتاح واحد (`write`)؛ الشبكة تعرض عموداً واحداً «إنشاء وتعديل» — هذا ما اعتمده إياد (توسيع لا إعادة بناء).
- `APPROVAL_DOCUMENTS[].permission`: PR/PO/PROGRESS_CLAIM → `PROCUREMENT_APPROVE`، CHANGE_ORDER → `PROJECT_APPROVE`. أضف `PROPOSAL_APPROVE` للكتالوج الآن (يستعمله عرض السعر في الخطوة 4) دون إضافة نوع مستند PROPOSAL بعد.
- افحص `seed.ts:604-710` وجداول `wf_transitions`: إن كانت الانتقالات تحمل مفتاح صلاحية، فانتقالات APPROVE/REJECT تنتقل إلى مفاتيح `approve` (seed + `UPDATE` في الترحيل + عكسه في down.sql). وثّق ما وجدت في التقرير.

## 3. الهوية (`AuthUser`, `jwt.strategy.ts`, `auth.service.ts`)
- `AuthUser` يكسب `roleIds: string[]` (الأساسي أولاً ثم `extraRoles`)، و`permissions` = اتحاد صلاحيات كل الأدوار (مرتّب، بلا تكرار). `roleId/roleKey` يبقيان = الدور الأساسي.
- `/auth/login` و`/auth/me` يعيدان إضافةً: `roles: [{id,key,nameAr,nameEn}]` (كلها). الواجهة `apps/web/src/lib/auth.tsx` تضيف الحقل اختيارياً.
- `common/approval.service.ts`: السطر 329 `step.roleId !== user.roleId` → `!user.roleIds.includes(step.roleId)`؛ السطر 445 `roleIds = [...user.roleIds, ...delegated]`؛ السطر 467 `via = user.roleIds.includes(current.roleId) ? undefined : byRole.get(...)`. مواضع `assigneeRoleId: user.roleId` في المشتريات ومحرك الحالات **تبقى** (الدور الأساسي كافٍ للعرض).
- كل fixtures الـ`AuthUser` في ملفات `*.spec.ts` تُحدَّث بـ`roleIds: [roleId]` (tsc يكشفها).

## 4. واجهة الإدارة الخلفية (`modules/admin`)
- `USER_SELECT` يضيف `extraRoles: { select: { role: { select: {id,key,nameAr,nameEn} } } }`؛ الاستجابة تُسطَّح إلى `roles: [...]`.
- `CreateUserDto/UpdateUserDto`: `extraRoleIds?: string[]` (كلها مملوكة للمنشأة، لا تتضمن الأساسي، بلا تكرار). التحديث يستبدل المجموعة كاملة داخل `$transaction` (deleteMany ثم createMany) مع حدث تدقيق before/after.
- `deleteRole`: يُحصى أيضاً `userRole.count({roleId})` ويُرفض بالرسالة نفسها «Role still has users assigned».
- حارسا القفل (`assertAnotherManagerExists`, `updateRole`) يعتبران من يحمل `admin.user.manage` عبر دور أساسي **أو** إضافي.
- `GET /admin/permissions` يعيد الكتالوج الموسّع (لا مسار جديد).

## 5. إخفاء التكاليف والهوامش في الخادم (الحارس الحقيقي)
- ثابت مشترك `COST_FIELDS` في `packages/shared/src/permissions.ts` مع تعليق لكل حقل من أين أتى: `unitCost, marginAmount, marginPct, estCost, estMargin, estMarginPct, earnedMargin, actualCost, marginToDate, costBasis, totalCost(WorkOrderPart), budgetAmount(WbsElement)` + ما تجده في `projects.service.ts` (14 موضعاً: اقرأها واذكر كل حقل أضفته).
- `common/cost-redaction.interceptor.ts` مسجَّل `APP_INTERCEPTOR` في `app.module.ts`: إن لم يحمل المستخدم `finance.costs.view` يمشي على JSON الاستجابة ويضع `null` (لا يحذف) في كل مفتاح من `COST_FIELDS`. **لا يلمس** `subtotal`/`amount` العامة (فاتورة المبيعات ليست تكلفة).
- `proposals.service.ts` (list/get) يخفي صراحةً عند غياب الصلاحية: `revisions[].subtotal`, `bomLines[].unitPrice`, `bomLines[].lineTotal`, `pricingScheme` → `null`. `totalAmount` يبقى ظاهراً (سعر البيع).
- جانب الكتابة: `items.service` create/update يرفض `unitCost` بـ403 عند غياب الصلاحية؛ `proposals.addRevision` يرفض `marginPct`/`pricingSchemeId` بـ403 كذلك. رسائل مترجمة في `apps/web/src/lib/errors.ts`.
- اختبار وحدة للمعترض: يُصفّر `unitCost` المتداخل، ولا يمس `subtotal` فاتورة، ويمرّ كاملاً لمن يحمل الصلاحية.

## 6. الواجهة (`apps/web`)
- `/admin` تبويب الأدوار: محرر الدور يصبح **شبكة** صفوفها الشاشات وأعمدتها «عرض | إنشاء وتعديل | اعتماد» (خلية فارغة حيث لا مفتاح)، وتحتها قسم «صلاحيات خاصة» (عرض التكاليف والهوامش، المرفقات، الإدارة). تبقى أزرار تحديد/إلغاء الكل. نفس مكونات `ui.tsx` (Modal, Field, Btn, Tabs).
- تبويب المستخدمين: الدور الأساسي (select كما هو) + «أدوار إضافية» (checkbox list)؛ الجدول يعرض كل الأدوار كشارات.
- `can('finance.costs.view')` يخفي: عمود/حقل تكلفة الوحدة في `/items`؛ الهامش ومخطط التسعير وأسعار البنود والمجموع الفرعي في `/proposals/[id]` (يبقى الإجمالي)؛ أعمدة التكلفة/الهامش في `/finance` (الربحية)؛ عمود تكلفة القطع في `/workorders/[id]`؛ أرقام الموازنة/التكلفة في صفحات المشاريع. في `/procurement` و`/requisitions`: إن كان `unitCost` null اترك السعر فارغاً بدل 0.
- مفاتيح i18n عربية وإنجليزية جديدة في `messages.ts` (مثلاً `adm.role.grid.view/write/approve`, `adm.role.special`, `adm.user.extraRoles`, `perm.costs.view`).

## 7. الزرع (`seed.ts`)
- دور جديد `executive` «الإدارة العليا / Executive management»: كل مفاتيح `read` + كل مفاتيح `approve` + `finance.costs.view` + `admin.audit.read` + `admin.approval.manage`. مستخدم تجريبي `ceo@npi.sa / Ceo@12345`.
- `sales` += `finance.costs.view`؛ `pm` += `finance.costs.view`, `projects.project.approve`, `scm.procurement.approve`؛ `accountant` += `finance.costs.view`, `scm.procurement.approve`؛ `site_engineer` (= «ميداني»): **بلا** costs.view وبلا approve؛ `admin` = ALL (يشمل الجديد تلقائياً عبر `ALL_PERMISSIONS`).
- احذر: `seed.ts` يحتفظ بنسخة محلية من قائمة الصلاحيات (سطر 17-33) — حدّثها لتطابق المشترك.

## 8. القبول قبل تسليم الوكيل
`npm run typecheck && npm run lint && npm test` خضراء؛ `npm run db:migrate` ثم `npm run db:seed` على القاعدة المحلية (`npi_erp` على localhost:5432، تعمل) بلا أخطاء؛ `psql -f down.sql` ثم إعادة الترحيل تعمل (أثبتها). تقرير الوكيل يذكر: كل ملف مُعدَّل، كل حقل في `COST_FIELDS` ومصدره، وما وجده في `wf_transitions`.

## 9. مراجعة النموذج الرئيسي (بعد الوكيل، قبل العرض على إياد)
- تشغيل API وWeb (`npm run dev:api`, `npm run dev:web`) والتحقق بمدخلات حقيقية: دخول `engineer@npi.sa` → `/items` بلا تكلفة و`GET /items` يعيد `unitCost: null`؛ دخول `sales@npi.sa` → التكلفة ظاهرة؛ إنشاء دور «مشرف مخزن» من الشبكة وإسناده كدور إضافي لمستخدم → القوائم تتغير فوراً دون إعادة دخول (الحارس يعيد التحميل كل طلب).
- لقطات شاشة للخطوات الثلاث، ثم العرض على إياد بلغة غير برمجية وانتظار موافقته قبل الخطوة 2.
