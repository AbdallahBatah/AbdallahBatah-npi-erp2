# نشر المرحلة الأولى (CRM) على خادم العرض — دليل التشغيل

التاريخ: 2026-10-08. الفرع: `feature/crm-phase-1` مدموج في `main` عبر طلب الدمج رقم 9.
الخادم: `root@204.168.182.109`، الموقع `https://204-168-182-109.sslip.io`، المجلد `/opt/npi-erp`.

## ما يُنشر وما يُحجب
- الترحيلات **0021 إلى 0029 بلا 0023**. الحزمة تُبنى بـ `deploy\pack.ps1 -ExcludeMigration 0023_crm_customer_unique_keys`
  فلا يرى `prisma migrate deploy` على الخادم الفهارس الفريدة أصلاً. تُشحن 0023 في إصدار لاحق بعد إحصاء
  المكررات (`customer-duplicates-census.sql`) وموافقة إياد على قائمة الدمج ونسخة احتياطية.
- أداة دمج العملاء تُشحن **معطَّلة** (`crm.customer.mergeEnabled = false` تُزرع بالترحيل 0022).
- قائمة المكلَّفين في مهام المتابعة تبقى كما العقد (قرار إياد CRM-S6-a، الملاحظة N-1 في تقرير القبول).
- ملاحظة: مهمة إعادة ضبط العرض الليلية (03:00) تمسح القاعدة وتعيد الترحيلات من الصورة ثم الزرع؛ الصورة مبنية
  من الحزمة نفسها فلا تحتوي 0023 أيضاً، وبيانات القبول تُمسح بها على كل حال.

## الخطوات (من جهاز إياد، PowerShell)

### 1. الحزمة
```powershell
cd C:\dev\npi-erp-crm; powershell -ExecutionPolicy Bypass -File deploy\pack.ps1 -ExcludeMigration 0023_crm_customer_unique_keys
```
يجب أن يطبع `held back: packages/db/prisma/migrations/0023_crm_customer_unique_keys` ثم `OK`.

### 2. النقل
```powershell
scp C:\dev\npi-erp-crm\npi-erp-deploy.tar.gz root@204.168.182.109:/opt/
```

### 3. نسخة احتياطية ثم النشر (أمر واحد عبر SSH)
```powershell
ssh root@204.168.182.109 "cd /opt/npi-erp && sh deploy/backup.sh && tar -xzf /opt/npi-erp-deploy.tar.gz && ls packages/db/prisma/migrations | tail -9 && sh deploy/deploy.sh"
```
المتوقع: سطر `OK: /opt/npi-erp/backups/npi_erp_<طابع>.dump`، قائمة الترحيلات تنتهي بـ 0029 **ولا تحوي 0023**،
ثم `migrate: prisma migrate deploy` يطبّق ثمانية ترحيلات، ثم `swap api` و`swap web` و`verify: /api/health via Caddy → 200`
و`deploy complete`. إن فشل الترحيل يبقى الإصدار السابق يخدم ولا يحدث تبديل.

### 4. تأكيد الترحيلات المطبَّقة
```powershell
ssh root@204.168.182.109 "cd /opt/npi-erp && docker compose -f docker-compose.prod.yml --env-file deploy/.env exec -T postgres psql -U npi -d npi_erp -c \"select migration_name from _prisma_migrations where migration_name >= '0021' order by 1\" && tail -3 deploy/.deploy_history"
```
المتوقع ثمانية أسطر (0021، 0022، 0024 … 0029) وسطر جديد في سجل النشر بعد `20260927144531`.

### 5. القبول عبر API على الخادم (داخل صورة الـAPI لأنه يحتاج القاعدة)
```powershell
ssh root@204.168.182.109 "cd /opt/npi-erp && mkdir -p uat && docker compose -f docker-compose.prod.yml --env-file deploy/.env run --rm --no-deps -v /opt/npi-erp/uat:/out api node scripts/crm-phase-1-acceptance.mjs --base http://api:4000/api --keep --json /out/uat-live.json"
```
المتوقع 60/60. السكربت ينتظر حدّ الدخول (5 في الدقيقة) بنفسه.

### 6. الثوابت والقبول عبر الواجهة (من جهاز إياد ضد الموقع الحي)
```powershell
cd C:\dev\npi-erp-crm; scp root@204.168.182.109:/opt/npi-erp/uat/uat-live.json .\uat-live.json; node .claude\skills\npi-erp-testing\scripts\api-smoke.mjs --base https://204-168-182-109.sslip.io/api --skip-throttle; node scripts\crm-phase-1-ui-acceptance.mjs --data uat-live.json --web https://204-168-182-109.sslip.io --api https://204-168-182-109.sslip.io/api --shot-from 20
```
المتوقع 23/23 ثم 14/14؛ اللقطات تُحفظ باسم `step-6-20…` حتى لا تستبدل لقطات القبول المحلي.

### 7. تنظيف بيانات القبول (اختياري؛ الإعادة الليلية تمسحها على كل حال)
```powershell
ssh root@204.168.182.109 "cd /opt/npi-erp && docker compose -f docker-compose.prod.yml --env-file deploy/.env run --rm --no-deps -v /opt/npi-erp/uat:/out api node scripts/crm-phase-1-acceptance.mjs --base http://api:4000/api --cleanup /out/uat-live.json"
```

## التراجع
```powershell
ssh root@204.168.182.109 "cd /opt/npi-erp && sh deploy/deploy.sh --rollback"
```
يعيد صور الإصدار السابق ولا يعكس الترحيلات (كلها توسعية ومقبولة من الكود السابق، انظر `deploy/MIGRATIONS_AR.md`).
لعكس الترحيلات نفسها: ملفات `down.sql` في كل مجلد ترحيل، بالترتيب العكسي 0029 → 0021، بعد إيقاف `api`.

## ما بعد النشر
1. إحصاء المكررات: `docs/crm-phase-1/customer-duplicates-census.sql` عبر `psql` (الأمر في رأس الملف؛ قراءة فقط).
2. عرض القائمة على إياد → موافقة → نسخة احتياطية → تفعيل `crm.customer.mergeEnabled` → الدمج → إصدار يحوي 0023.
