import 'dotenv/config';
import crypto from 'node:crypto';
import express from 'express';
import OpenAI from 'openai';

const required = ['WHATSAPP_TOKEN', 'PHONE_NUMBER_ID', 'VERIFY_TOKEN', 'OPENAI_API_KEY'];
const missing = required.filter((name) => !process.env[name]);
if (missing.length) {
  console.error(`Missing environment variables: ${missing.join(', ')}`);
  process.exit(1);
}

const app = express();
const port = Number(process.env.PORT || 3000);
const graphVersion = process.env.META_GRAPH_VERSION || 'v23.0';
const whatsappToken = process.env.WHATSAPP_TOKEN;
const phoneNumberId = process.env.PHONE_NUMBER_ID;
const verifyToken = process.env.VERIFY_TOKEN;
const appSecret = process.env.META_APP_SECRET;
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const model = process.env.OPENAI_MODEL || 'gpt-4o-mini';
const systemPrompt = process.env.SYSTEM_PROMPT ||
  'You are a helpful WhatsApp assistant. Reply clearly and concisely in the same language as the user.';

// Keep a small in-memory conversation history per WhatsApp number.
// Use Redis or a database for persistence when deploying multiple instances.
const conversations = new Map();
const processedMessages = new Map();
const MAX_HISTORY = 12;
const MESSAGE_TTL_MS = 24 * 60 * 60 * 1000;

app.use(express.json({
  verify: (request, _response, buffer) => {
    request.rawBody = buffer;
  }
}));

function validSignature(request) {
  if (!appSecret) return true;
  const signature = request.get('x-hub-signature-256');
  if (!signature || !request.rawBody) return false;
  const expected = `sha256=${crypto.createHmac('sha256', appSecret).update(request.rawBody).digest('hex')}`;
  return signature.length === expected.length && crypto.timingSafeEqual(
    Buffer.from(signature),
    Buffer.from(expected)
  );
}

app.get('/health', (_request, response) => {
  response.json({ ok: true, service: 'whatsapp-chatgpt-bot' });
});

// Meta calls this endpoint once when configuring the webhook.
app.get('/webhook', (request, response) => {
  const isValid = request.query['hub.mode'] === 'subscribe' &&
    request.query['hub.verify_token'] === verifyToken;
  if (!isValid) return response.sendStatus(403);
  return response.status(200).send(request.query['hub.challenge']);
});

app.post('/webhook', (request, response) => {
  if (!validSignature(request)) return response.sendStatus(401);

  // Acknowledge quickly; Meta retries webhooks that take too long.
  response.sendStatus(200);
  void processWebhook(request.body).catch((error) => {
    console.error('Webhook processing failed:', error);
  });
});

async function processWebhook(body) {
  if (body.object !== 'whatsapp_business_account') return;

  for (const entry of body.entry || []) {
    for (const change of entry.changes || []) {
      const value = change.value;
      for (const message of value?.messages || []) {
        if (processedMessages.has(message.id)) continue;
        processedMessages.set(message.id, Date.now());
        setTimeout(() => processedMessages.delete(message.id), MESSAGE_TTL_MS);

        if (message.type !== 'text') {
          await sendWhatsAppMessage(message.from, 'فعلاً فقط پیام‌های متنی را پشتیبانی می‌کنم.');
          continue;
        }

        const text = message.text?.body?.trim();
        if (!text) continue;
        await answerMessage(message.from, text);
      }
    }
  }
}

async function answerMessage(from, text) {
  const history = conversations.get(from) || [];
  try {
    const completion = await openai.chat.completions.create({
      model,
      temperature: 0.7,
      max_tokens: 700,
      messages: [
        { role: 'system', content: systemPrompt },
        ...history,
        { role: 'user', content: text }
      ]
    });
    const answer = completion.choices[0]?.message?.content?.trim() ||
      'متأسفم، در حال حاضر نتوانستم پاسخ مناسبی تولید کنم.';

    const updated = [
      ...history,
      { role: 'user', content: text },
      { role: 'assistant', content: answer }
    ].slice(-MAX_HISTORY);
    conversations.set(from, updated);
    await sendWhatsAppMessage(from, answer);
  } catch (error) {
    console.error('OpenAI/API error:', error?.response?.data || error.message || error);
    await sendWhatsAppMessage(from, 'متأسفم، مشکلی پیش آمد. لطفاً چند لحظه بعد دوباره تلاش کنید.');
  }
}

async function sendWhatsAppMessage(to, body) {
  const url = `https://graph.facebook.com/${graphVersion}/${phoneNumberId}/messages`;
  const result = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${whatsappToken}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to,
      type: 'text',
      text: { preview_url: false, body }
    })
  });

  if (!result.ok) {
    const details = await result.text();
    throw new Error(`WhatsApp send failed (${result.status}): ${details}`);
  }
}

app.listen(port, () => {
  console.log(`Server listening on port ${port}`);
});
