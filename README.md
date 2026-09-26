# WhatsApp ChatGPT Bot (Meta Cloud API)

ربات واتساپ با **WhatsApp Cloud API رسمی متا** و OpenAI. این پروژه از WhatsApp Web یا کت��بخانه‌های غیررسمی استفاده نمی‌کند.

## پیش‌نیازها

- Node.js 18 یا جدیدتر
- یک اپ در [Meta for Developers](https://developers.facebook.com/)
- یک شماره تلفن WhatsApp Business متصل به Cloud API
- کلید API از OpenAI
- یک آدرس HTTPS عمومی برای webhook (برای توسعه می‌توانید از Render یا ngrok استفاده کنید)

## اجرای محلی

```bash
cp .env.example .env
npm install
npm start
```

متغیرهای `.env` را با مقادیر واقعی پر کنید. برای تست محلی:

```bash
curl http://localhost:3000/health
```

## تنظیم Meta WhatsApp Cloud API

1. در Meta Developer Dashboard یک App بسازید و محصول **WhatsApp** را اضافه کنید.
2. از بخش API Setup، مقادیر `PHONE_NUMBER_ID` و access token را بردارید.
3. برای محیط واقعی یک System User token دائمی با مجوز `whatsapp_business_messaging` بسازید و آن را در `WHATSAPP_TOKEN` قرار دهید.
4. برنامه را روی HTTPS منتشر کنید؛ مثلاً با Render.
5. در بخش WhatsApp > Configuration، آدرس زیر را ثبت کنید:
   `https://YOUR-DOMAIN.example.com/webhook`
6. مقدار `VERIFY_TOKEN` را دقیقاً همان مقداری وارد کنید که در داشبورد Meta ثبت کرده‌اید.
7. webhook field مربوط به `messages` را Subscribe کنید.
8. در حالت توسعه، شماره آزمایشی و شماره گیرنده را در Meta اضافه و تأیید کنید.

`META_APP_SECRET` اختیاری است، اما توصیه می‌شود؛ وقتی تنظیم شود، امضای `x-hub-signature-256` درخواست‌ها بررسی می‌شود.

## انتشار روی Render

این مخزن دارای `render.yaml` است. یک **New Blueprint** از مخزن بسازید و secretهای زیر را در Render وارد کنید:

- `WHATSAPP_TOKEN`
- `PHONE_NUMBER_ID`
- `VERIFY_TOKEN`
- `META_APP_SECRET`
- `OPENAI_API_KEY`

پس از deploy، آدرس سرویس را در تنظیمات webhook متا قرار دهید.

## رفتار ربات

- پیام‌های متنی را به مدل `OPENAI_MODEL` می‌فرستد.
- برای هر شماره، حداکثر ۱۲ پیام آخر را در حافظه نگه می‌دارد.
- پیام‌های تکراری Meta را تا ۲۴ ساعت نادیده می‌گیرد.
- برای پیام‌های غیرمتنی پاسخ راهنما می‌فرستد.
- پاسخ webhook را فوراً با HTTP 200 برمی‌گرداند تا Meta درخواست را retry نکند.

> تاریخچه گفتگو در حافظه فرایند است و با restart یا چند instance از بین می‌رود. برای استفاده تجاری، آن را به Redis یا دیتابیس منتقل کنید و rate limiting و صف پردازش اضافه کنید.

## تست ارسال پیام

بعد از تنظیم token و phone number ID می‌توانید endpoint رسمی Meta را تست کنید:

```bash
curl -X POST "https://graph.facebook.com/v23.0/$PHONE_NUMBER_ID/messages" \\
  -H "Authorization: Bearer $WHATSAPP_TOKEN" \\
  -H "Content-Type: application/json" \\
  -d '{"messaging_product":"whatsapp","to":"RECIPIENT_NUMBER","type":"text","text":{"body":"سلام"}}'
```
