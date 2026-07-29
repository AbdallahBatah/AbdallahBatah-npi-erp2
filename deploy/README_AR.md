# دليل نشر نسخة العرض — NPI Solar ERP

من صفر إلى رابط يجربه العملاء في ~30 دقيقة. لا يحتاج دومين — يعمل على عنوان IP مباشرة، وبخدعة `sslip.io` تحصل على HTTPS حقيقي بلا شراء دومين.

## 1) استئجار خادم

أي مزود سحابي يفي بالغرض (Hetzner / DigitalOcean / Vultr / OCI):

- **النظام:** Ubuntu 22.04 أو 24.04
- **المواصفات:** 2 vCPU / 4GB RAM / 40GB — (~20–40$ شهرياً)
- افتح المنفذين **80** و **443** في جدار الحماية (لوحة المزود + `ufw allow 80,443/tcp` إن كان مفعلاً)
- سجّل عنوان الـ IP — سنسميه `SERVER_IP`

## 2) تثبيت Docker على الخادم

```bash
ssh root@SERVER_IP
curl -fsSL https://get.docker.com | sh
```

## 3) نقل الكود من جهازك

على جهازك (ويندوز)، من جذر المشروع:

```powershell
powershell -ExecutionPolicy Bypass -File deploy\pack.ps1
scp npi-erp-deploy.tar.gz root@SERVER_IP:/opt/
```

ثم على الخادم:

```bash
cd /opt && mkdir -p npi-erp && tar -xzf npi-erp-deploy.tar.gz -C npi-erp && cd npi-erp
```

## 4) إعداد الأسرار

```bash
cp deploy/.env.example deploy/.env
openssl rand -hex 32   # انسخ الناتج إلى JWT_SECRET
nano deploy/.env       # عدّل POSTGRES_PASSWORD و JWT_SECRET
```

اترك `SITE_ADDRESS=:80` الآن (عمل على IP مباشرة).

## 5) التشغيل الأول

```bash
docker compose -f docker-compose.prod.yml --env-file deploy/.env up -d --build
docker compose -f docker-compose.prod.yml --env-file deploy/.env run --rm reset
```

الأمر الأول يبني ويشغّل (قاعدة البيانات + API + الواجهة + البوابة). الثاني يملأ البيانات التجريبية الغنية (51 سيناريو).

**افتح المتصفح على** `http://SERVER_IP` **وسجّل الدخول بحسابات العرض** (admin@npi.sa / Admin@123 وبقية الأدوار الخمسة).

## 6) HTTPS بلا دومين (موصى به قبل مشاركة الرابط)

خدمة `sslip.io` المجانية تعطي أي IP اسم نطاق تلقائياً. إن كان IP خادمك مثلاً `203.0.113.10`:

```bash
nano deploy/.env    # SITE_ADDRESS=203-0-113-10.sslip.io  (النقاط تصير شرطات)
docker compose -f docker-compose.prod.yml --env-file deploy/.env up -d caddy
```

خلال ثوانٍ تحصل على `https://203-0-113-10.sslip.io` بشهادة صالحة — رابط يليق بمشاركته مع العملاء. وعند شراء دومين لاحقاً: وجّه سجل A إلى الخادم، وغيّر `SITE_ADDRESS=demo.yourdomain.sa`، ونفّذ الأمر الثاني نفسه.

## 7) التصفير الليلي (يعبث العملاء بحرية، وتعود النسخة نظيفة)

```bash
crontab -e
```

أضف السطر (3 فجراً بتوقيت الرياض):

```
0 3 * * * cd /opt/npi-erp && docker compose -f docker-compose.prod.yml --env-file deploy/.env run --rm reset >> /var/log/npi-reset.log 2>&1
```

وتأكد أن توقيت الخادم `timedatectl set-timezone Asia/Riyadh`.

## أوامر الصيانة

| الغرض | الأمر |
|---|---|
| حالة الخدمات | `docker compose -f docker-compose.prod.yml --env-file deploy/.env ps` |
| سجلات API | `docker compose -f docker-compose.prod.yml --env-file deploy/.env logs -f api` |
| تحديث بعد تعديل الكود | ارفع tar.gz جديداً وفك الضغط ثم `up -d --build` |
| نسخة احتياطية | `docker compose -f docker-compose.prod.yml --env-file deploy/.env exec postgres pg_dump -U npi npi_erp > backup_$(date +%F).sql` |
| إيقاف كامل | `docker compose -f docker-compose.prod.yml --env-file deploy/.env down` |

## المرحلة التالية — نسخة خاصة لكل عميل جاد

أبسط طريق: **خادم صغير مستقل لكل عميل** بنفس هذه الخطوات حرفياً (خوادم 4GB رخيصة، والعزل كامل). عند تجاوز ~5 نسخ متزامنة يستحق الأمر بوابة مشتركة واحدة توزع على النسخ حسب النطاق الفرعي — تعديل صغير على Caddyfile يُضاف عند الحاجة.

## ملاحظات

- الختم الإلكتروني ZATCA **محاكى** في نسخة العرض — الربط الفعلي بمنصة فاتورة يتم عند التعاقد بشهادة CSID باسم منشأة العميل.
- `deploy/.env` يحوي الأسرار — لا يُنسخ لأي مكان عام (مستثنى تلقائياً من zip النقل ومن صور Docker).
- كلمات مرور حسابات العرض تجريبية ومعلنة عمداً؛ البيانات تُصفَّر ليلياً فلا قيمة لما يدخله الزوار.
