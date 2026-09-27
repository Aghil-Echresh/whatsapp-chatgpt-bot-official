# WhatsApp ChatGPT Bot (Meta Cloud API) - v2.0

**ربات واتساپ + ChatGPT رسمی** با Meta Cloud API و OpenAI — حرفه‌ای‌تر، با MongoDB برای ذخیره تاریخچه و مدیریت کاربران.

## ویژگی‌ها

✅ **WhatsApp Cloud API رسمی** — بدون نیاز به تقلب یا کتابخانه‌های غیررسمی
✅ **OpenAI Integration** — پاسخ‌های هوشمند و طبیعی
✅ **MongoDB** — ذخیره تاریخچه پیام‌ها و اطلاعات کاربران
✅ **پشتیبانی چندزبانه** — تشخیص خودکار زبان (فارسی، انگلیسی، و...)
✅ **Typing Indicator** — نشانگر تایپ برای بهتر بودن تجربه
✅ **API REST** — دسترسی به آمار کاربران و تاریخچه گفتگو
✅ **Graceful Shutdown** — بسته‌شدن ایمن MongoDB
✅ **Health Check** — endpoint برای مانیتورینگ

## پیش‌نیازها

- Node.js 18+
- حساب Meta for Developers با WhatsApp Business Account
- شماره تلفن تایید شده برای واتساپ
- API Key از OpenAI
- حساب MongoDB Atlas (یا محلی)
- HTTPS Domain برای webhook

## نصب و تنظیم

### 1. کلون و نصب وابستگی��ها

```bash
git clone https://github.com/Aghil-Echresh/whatsapp-chatgpt-bot-official.git
cd whatsapp-chatgpt-bot-official
cp .env.example .env
npm install
```

### 2. تنظیم متغیرهای محیط

فایل `.env` را با مقادیر واقعی پر کنید:

```env
WHATSAPP_TOKEN=your_permanent_access_token
PHONE_NUMBER_ID=your_phone_number_id
VERIFY_TOKEN=your_secure_webhook_token
META_APP_SECRET=your_app_secret
ADMIN_API_TOKEN=your_long_random_admin_token
OPENAI_API_KEY=your_openai_key
MONGODB_URI=mongodb+srv://user:pass@cluster.mongodb.net/?retryWrites=true
MONGODB_DB=whatsapp_bot
```

### 3. تنظیم Meta WhatsApp Cloud API

1. به [Meta Developers](https://developers.facebook.com/) بروید
2. یک App جدید بسازید (یا از موجود استفاده کنید)
3. محصول **WhatsApp** را اضافه کنید
4. در بخش API Setup:
   - `Phone Number ID` را کپی کنید → `PHONE_NUMBER_ID`
   - یک **System User Token** دائمی با permission `whatsapp_business_messaging` بسازید → `WHATSAPP_TOKEN`
   - `App Secret` را کپی کنید → `META_APP_SECRET`
5. یک `VERIFY_TOKEN` انتخابی کنید

### 4. تنظیم Webhook

1. پروژه را روی **Render** یا سرور HTTPS دیگری deploy کنید
2. در Meta Developer Dashboard → WhatsApp → Configuration:
   ```
   Webhook URL: https://YOUR-DOMAIN.com/webhook
   Verify Token: (مقدار VERIFY_TOKEN شما)
   ```
3. Subscribe کنید به event: `messages`

### 5. تست محلی (اختیاری)

```bash
npm run dev
# یا
npm start
```

در terminal دیگر:

```bash
curl http://localhost:3000/health
```

## Deploy روی Render

### گام‌ها:

1. مخزن را Render متصل کنید
2. یک **New Blueprint** بسازید
3. متغیرهای `sync: false` را مقداردهی کنید:
   - `WHATSAPP_TOKEN`
   - `PHONE_NUMBER_ID`
   - `VERIFY_TOKEN`
   - `META_APP_SECRET`
   - `OPENAI_API_KEY`
   - `MONGODB_URI`
4. Deploy کنید
5. از دسترسی به webhook آپ شما اطمینان حاصل کنید

## امنیت API مدیریت

مسیرهای `/api/users/*` و `/api/messages/*` با `ADMIN_API_TOKEN` محافظت می‌شوند. درخواست‌ها باید هدر `Authorization: Bearer YOUR_ADMIN_API_TOKEN` را داشته باشند. همچنین هر شماره واتساپ حداکثر ۱۰ پیام در دقیقه می‌تواند پردازش کند و شناسه پیام‌ها برای جلوگیری از پردازش تکراری در MongoDB ثبت می‌شوند.

## استفاده

### ارسال پیام از طریق Meta API (تست)

```bash
curl -X POST "https://graph.facebook.com/v23.0/$PHONE_NUMBER_ID/messages" \
  -H "Authorization: Bearer $WHATSAPP_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "messaging_product": "whatsapp",
    "to": "RECIPIENT_PHONE",
    "type": "text",
    "text": { "body": "سلام" }
  }'
```

### دریافت آمار کاربر

```bash
curl http://localhost:3000/api/users/1234567890/stats
```

### دریافت تاریخچه گفتگو

```bash
curl "http://localhost:3000/api/messages/1234567890?limit=50"
```

## ساختار پروژه

```
.
├── server.js          # سرور Express + Webhook + API
├── package.json       # وابستگی‌ها
├── .env.example       # نمونه متغیرهای محیط
├── render.yaml        # تنظیمات Render
└── README.md          # این فایل
```

## چگونه کار می‌کند

1. **Webhook** → Meta فعالیت‌های واتساپ را به URL ما ارسال می‌کند
2. **Signature Check** → اگر `META_APP_SECRET` تنظیم شده، صحت درخواست را بررسی می‌کنیم
3. **Deduplication** → پیام‌های تکراری را برای 24 ساعت نادیده می‌گیریم
4. **Language Detection** → زبان پیام را تشخیص می‌دهیم
5. **OpenAI** → متن را به GPT ارسال می‌کنیم
6. **History** → تاریخچه را در MongoDB یا حافظه ذخیره می‌کنیم
7. **Response** → پاسخ را از طریق Meta API برمی‌گردانیم

## بهینه‌سازی برای تولید

برای استفاده تجاری:

- [ ] **Redis** برای session/rate-limiting
- [ ] **Queue System** (BullMQ) برای پردازش ناهمزمان
- [ ] **Logging** (Winston/Morgan) برای مانیتورینگ
- [ ] **Error Tracking** (Sentry)
- [ ] **Caching** برای پاسخ‌های مشابه
- [ ] **Analytics Dashboard** برای مدیریت
- [ ] **Multi-language Support** پیشرفته‌تر
- [ ] **Handle Media** (صور، ویدیو، فایل)
- [ ] **Interactive Messages** (Button، List)

## حل مشکلات

### Webhook دریافت نمی‌شود

- ✓ Domain شما HTTPS است؟
- ✓ Port 443 باز است؟
- ✓ `VERIFY_TOKEN` در Meta و `.env` یکی است؟
- ✓ آپ deploy کرده‌اید؟

### OpenAI خطا می‌دهد

- ✓ `OPENAI_API_KEY` صحیح است؟
- ✓ توازن حساب کافی است؟
- ✓ مدل `gpt-4o-mini` در حساب فعال است؟

### MongoDB متصل نمی‌شود

- ✓ `MONGODB_URI` صحیح است؟
- ✓ IP خودکار اضافه شده است؟
- ✓ پسورد کاراکترهای خاص ندارد؟
- در صورت عدم اتصال، سیستم به حافظه فال‌بک می‌شود.

## لایسنس

MIT

## تماس و پشتیبانی

https://github.com/Aghil-Echresh/whatsapp-chatgpt-bot-official/issues
