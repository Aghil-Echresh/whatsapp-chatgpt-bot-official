import 'dotenv/config';
import crypto from 'node:crypto';
import express from 'express';
import OpenAI from 'openai';
import { MongoClient } from 'mongodb';
import { toFile } from 'openai/uploads';
import { getYCloudClientFromEnv, YCloudError } from './lib/ycloud.js';
import { extractInboundMessage, extractMessageUpdate, parseYCloudEvent, payloadHash, verifyYCloudSignature } from './lib/ycloud-webhook.js';

const whatsappProvider = (process.env.WHATSAPP_PROVIDER || (process.env.YCLOUD_API_KEY ? 'ycloud' : 'meta')).toLowerCase();
const required = whatsappProvider === 'ycloud'
  ? ['YCLOUD_API_KEY', 'YCLOUD_WEBHOOK_SECRET', 'YCLOUD_SENDER_PHONE', 'OPENAI_API_KEY']
  : ['WHATSAPP_TOKEN', 'PHONE_NUMBER_ID', 'VERIFY_TOKEN', 'OPENAI_API_KEY'];
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
const adminApiToken = process.env.ADMIN_API_TOKEN;
const ycloudWebhookEndpointId = process.env.YCLOUD_WEBHOOK_ENDPOINT_ID || null;
const ycloudWebhookTolerance = Number(process.env.YCLOUD_SIGNATURE_TOLERANCE_SECONDS || 300);
const ycloudWebhookSecrets = [process.env.YCLOUD_WEBHOOK_SECRET, process.env.YCLOUD_WEBHOOK_SECRET_PREVIOUS].filter(Boolean);
const ycloudSenderPhone = process.env.YCLOUD_SENDER_PHONE;
const ycloudClient = whatsappProvider === 'ycloud' ? getYCloudClientFromEnv() : null;
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const model = process.env.OPENAI_MODEL || 'gpt-5';
const transcriptionModel = process.env.OPENAI_TRANSCRIPTION_MODEL || 'gpt-4o-mini-transcribe';
const MAX_MEDIA_BYTES = Number(process.env.MAX_MEDIA_BYTES || 15 * 1024 * 1024);
const systemPrompt = process.env.SYSTEM_PROMPT ||
  'You are a helpful WhatsApp assistant. Reply clearly and concisely in the same language as the user.';

let mongoClient;
let messagesCollection;
let usersCollection;
let processedCollection;
let webhookEventsCollection;
let webhookConflictsCollection;
let ycloudMessagesCollection;
const ycloudTransportReplayCache = new Map();
const ycloudEventMemory = new Map();

const conversations = new Map();
const processedMessages = new Map();
const MAX_HISTORY = Number(process.env.MAX_HISTORY || 20);
const MESSAGE_TTL_MS = 24 * 60 * 60 * 1000;

async function initializeMongo() {
  if (!process.env.MONGODB_URI) {
    console.log('MongoDB URI not provided, using in-memory storage');
    return false;
  }

  try {
    mongoClient = new MongoClient(process.env.MONGODB_URI);
    await mongoClient.connect();
    const db = mongoClient.db(process.env.MONGODB_DB || 'whatsapp_bot');
    messagesCollection = db.collection('messages');
    usersCollection = db.collection('users');
    processedCollection = db.collection('processed_messages');
    webhookEventsCollection = db.collection('ycloud_webhook_events');
    webhookConflictsCollection = db.collection('ycloud_webhook_conflicts');
    ycloudMessagesCollection = db.collection('ycloud_messages');

    await messagesCollection.createIndex({ from: 1, createdAt: -1 });
    await messagesCollection.createIndex({ createdAt: 1 }, { expireAfterSeconds: 86400 * 30 });
    await usersCollection.createIndex({ phone: 1 }, { unique: true });
    await processedCollection.createIndex({ messageId: 1 }, { unique: true });
    await processedCollection.createIndex({ createdAt: 1 }, { expireAfterSeconds: 172800 });
    await webhookEventsCollection.createIndex({ endpointId: 1, eventId: 1 }, { unique: true });
    await webhookEventsCollection.createIndex({ createdAt: 1 }, { expireAfterSeconds: 86400 });
    await webhookConflictsCollection.createIndex({ createdAt: 1 }, { expireAfterSeconds: 604800 });
    await ycloudMessagesCollection.createIndex({ providerMessageId: 1 }, { unique: true });
    await ycloudMessagesCollection.createIndex({ to: 1, createdAt: -1 });

    console.log('✓ MongoDB connected');
    return true;
  } catch (error) {
    console.warn('MongoDB connection failed, using in-memory storage:', error.message);
    return false;
  }
}

app.use('/webhook', express.raw({ type: 'application/json', limit: '2mb' }));
app.use(express.json({ limit: '2mb' }));

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

function requireAdmin(request, response) {
  if (!adminApiToken) {
    response.status(503).json({ error: 'Admin API is not configured' });
    return false;
  }
  const provided = request.get('authorization')?.replace(/^Bearer\s+/i, '');
  if (!provided || provided.length !== adminApiToken.length) {
    response.status(401).json({ error: 'Unauthorized' });
    return false;
  }
  const valid = crypto.timingSafeEqual(Buffer.from(provided), Buffer.from(adminApiToken));
  if (!valid) response.status(401).json({ error: 'Unauthorized' });
  return valid;
}

const rateLimit = new Map();
const RATE_LIMIT_WINDOW_MS = 60 * 1000;

function queueFor(phone, task) {
  const previous = userQueues.get(phone) || Promise.resolve();
  const next = previous.catch(() => {}).then(task);
  userQueues.set(phone, next);
  next.finally(() => { if (userQueues.get(phone) === next) userQueues.delete(phone); }).catch(() => {});
  return next;
}

const RATE_LIMIT_MAX = Number(process.env.RATE_LIMIT_MAX || 10);
const userQueues = new Map();

function allowRequest(phone) {
  const now = Date.now();
  const current = rateLimit.get(phone);
  if (!current || now - current.startedAt >= RATE_LIMIT_WINDOW_MS) {
    rateLimit.set(phone, { startedAt: now, count: 1 });
    return true;
  }
  if (current.count >= RATE_LIMIT_MAX) return false;
  current.count += 1;
  return true;
}

app.get('/health', (_request, response) => {
  response.json({ ok: true, service: 'whatsapp-chatgpt-bot', provider: whatsappProvider, mongodb: !!mongoClient });
});

app.get('/webhook', (request, response) => {
  const isValid = request.query['hub.mode'] === 'subscribe' &&
    request.query['hub.verify_token'] === verifyToken;
  if (!isValid) return response.sendStatus(403);
  return response.status(200).send(request.query['hub.challenge']);
});

app.post('/webhook', async (request, response) => {
  const rawBody = Buffer.isBuffer(request.body) ? request.body : Buffer.from('');
  const ycloudSignature = request.get('YCloud-Signature');

  if (whatsappProvider === 'ycloud' || ycloudSignature) {
    if (!ycloudSignature) return response.sendStatus(401);

    const endpointId = request.get('X-Webhook-Endpoint-ID') || null;
    if (ycloudWebhookEndpointId && endpointId !== ycloudWebhookEndpointId) {
      return response.sendStatus(401);
    }

    const verification = verifyYCloudSignature({
      rawBody,
      signatureHeader: ycloudSignature,
      secrets: ycloudWebhookSecrets,
      toleranceSeconds: ycloudWebhookTolerance
    });

    if (!verification.valid) {
      console.warn('Rejected YCloud webhook:', verification.reason);
      return response.sendStatus(401);
    }

    const replayKey = String(verification.timestamp) + ':' + verification.signature;
    if (ycloudTransportReplayCache.has(replayKey)) return response.sendStatus(200);
    ycloudTransportReplayCache.set(replayKey, Date.now());
    setTimeout(() => ycloudTransportReplayCache.delete(replayKey), Math.max(300000, ycloudWebhookTolerance * 1000));

    let event;
    try {
      event = parseYCloudEvent(rawBody);
    } catch (error) {
      console.warn('Invalid YCloud webhook envelope:', error.message);
      return response.sendStatus(400);
    }

    let claim;
    try {
      claim = await claimYCloudEvent(event, rawBody, endpointId || 'single-tenant');
    } catch (error) {
      console.error('YCloud webhook persistence failed:', error.message);
      return response.sendStatus(503);
    }
    if (claim === 'conflict') return response.sendStatus(200);
    if (claim === 'duplicate') return response.sendStatus(200);

    response.sendStatus(200);
    void processYCloudEvent(event).catch((error) => {
      console.error('YCloud webhook processing failed:', error);
    });
    return;
  }

  if (!validSignature({ ...request, rawBody })) return response.sendStatus(401);

  let metaBody;
  try {
    metaBody = JSON.parse(rawBody.toString('utf8'));
  } catch {
    return response.sendStatus(400);
  }

  response.sendStatus(200);
  void processWebhook(metaBody).catch((error) => {
    console.error('Webhook processing failed:', error);
  });
});

async function claimYCloudEvent(event, rawBody, endpointId) {
  const hash = payloadHash(rawBody);
  const eventId = event.id;
  const key = endpointId + ':' + eventId;

  if (!webhookEventsCollection) {
    const existing = ycloudEventMemory.get(key);
    if (existing) {
      if (existing !== hash) {
        console.error('YCloud webhook event conflict:', key);
        return 'conflict';
      }
      return 'duplicate';
    }
    ycloudEventMemory.set(key, hash);
    setTimeout(() => ycloudEventMemory.delete(key), 24 * 60 * 60 * 1000);
    return 'new';
  }

  const existing = await webhookEventsCollection.findOne({ endpointId, eventId });
  if (existing) {
    if (existing.payloadHash !== hash) {
      await webhookConflictsCollection.insertOne({
        endpointId,
        eventId,
        existingHash: existing.payloadHash,
        receivedHash: hash,
        createdAt: new Date()
      }).catch(() => {});
      console.error('YCloud webhook event conflict:', key);
      return 'conflict';
    }
    return 'duplicate';
  }

  try {
    await webhookEventsCollection.insertOne({
      endpointId,
      eventId,
      eventType: event.type,
      payloadHash: hash,
      receivedAt: new Date(),
      createdAt: new Date()
    });
    return 'new';
  } catch (error) {
    if (error?.code === 11000) return 'duplicate';
    throw error;
  }
}

async function processYCloudEvent(event) {
  const inbound = extractInboundMessage(event);

  if (inbound) {
    const from = inbound.from;
    if (!from) return;

    const profile = inbound.customerProfile || {};
    if (usersCollection) {
      await usersCollection.updateOne(
        { phone: from },
        {
          $set: {
            name: profile.name || null,
            username: profile.username || null,
            bsuid: inbound.fromUserId || null,
            parentBsuid: inbound.fromParentUserId || null,
            lastSeen: new Date()
          }
        },
        { upsert: true }
      ).catch(() => {});
    }

    await persistYCloudInbound(inbound, event);

    if (inbound.type === 'text') {
      const text = inbound.text?.body?.trim();
      if (text) {
        await answerMessage(from, text, { saveUser: false });
        return;
      }
    }

    if (inbound.type === 'button') {
      const buttonText = inbound.button?.text?.trim() || inbound.button?.payload?.trim();
      if (buttonText) {
        await answerMessage(from, buttonText, { saveUser: false });
        return;
      }
    }

    await safeSend(from, 'پیامت دریافت شد ❤️ فعلاً پاسخ هوشمند من برای پیام‌های متنی فعاله. پیام متنی بفرست تا ادامه بدیم.');
    return;
  }

  const update = extractMessageUpdate(event);
  if (update?.id) {
    await recordYCloudMessageUpdate(update, event);
    return;
  }

  console.log('YCloud event received and stored as unsupported:', event.type);
}

async function persistYCloudInbound(inbound, event) {
  if (!messagesCollection) return;
  const content = inbound.type === 'text'
    ? inbound.text?.body || ''
    : inbound.type === 'button'
      ? (inbound.button?.text || inbound.button?.payload || '')
      : '[' + inbound.type + ']';

  await messagesCollection.insertOne({
    from: inbound.from,
    role: 'user',
    content,
    provider: 'ycloud',
    providerMessageId: inbound.id || null,
    wamid: inbound.wamid || null,
    externalEventId: event.id,
    createdAt: new Date(inbound.sendTime || event.createTime || Date.now())
  }).catch(() => {});
}

async function recordYCloudMessageUpdate(update, event) {
  if (!ycloudMessagesCollection) return;

  await ycloudMessagesCollection.updateOne(
    { providerMessageId: update.id },
    {
      $set: {
        status: update.status || 'unknown',
        updateTime: update.updateTime || event.createTime || null,
        sendTime: update.sendTime || null,
        deliverTime: update.deliverTime || null,
        readTime: update.readTime || null,
        errorCode: update.errorCode || null,
        errorMessage: update.errorMessage || null,
        pricingCategory: update.pricingCategory || null,
        totalPrice: update.totalPrice ?? null,
        currency: update.currency || null,
        lastEventId: event.id,
        lastUpdatedAt: new Date()
      },
      $setOnInsert: {
        provider: 'ycloud',
        providerMessageId: update.id,
        createdAt: new Date()
      }
    },
    { upsert: true }
  );
}

async function processWebhook(body) {
  if (body.object !== 'whatsapp_business_account') return;

  for (const entry of body.entry || []) {
    for (const change of entry.changes || []) {
      const value = change.value;
      const senderPhone = value?.contacts?.[0]?.wa_id;
      const senderName = value?.contacts?.[0]?.profile?.name;

      if (senderPhone && usersCollection) {
        await usersCollection.updateOne(
          { phone: senderPhone },
          { $set: { name: senderName, lastSeen: new Date() } },
          { upsert: true }
        ).catch(() => {});
      }

      for (const message of value?.messages || []) {
        if (!message.id) continue;
        if (await isMessageProcessed(message.id)) continue;

        if (!message.from) continue;
        await queueFor(message.from, async () => {
          try {
            if (message.type === 'text') {
              const text = message.text?.body?.trim();
              if (text) await answerMessage(message.from, text);
            } else if (message.type === 'image') {
              await answerMediaMessage(message.from, 'image', message.image?.id, message.image?.caption?.trim() || 'این تصویر را بررسی کن و توضیح بده.');
            } else if (message.type === 'audio') {
              await answerMediaMessage(message.from, 'audio', message.audio?.id);
            } else if (message.type === 'document') {
              await answerMediaMessage(message.from, 'document', message.document?.id, message.document?.caption?.trim() || 'این فایل را بررسی کن و نکات مهمش را توضیح بده.', message.document?.filename);
            } else {
              await sendWhatsAppMessage(message.from, 'فعلاً پیام‌های متنی، عکس، فایل و صوتی را پشتیبانی می‌کنم. 📎');
            }
          } catch (error) {
            console.error('Message processing failed:', error);
            await safeSend(message.from, 'متأسفم، در پردازش پیام مشکلی پیش آمد. لطفاً دوباره تلاش کن.');
          }
        });
      }
    }
  }
}

async function getConversationHistory(from) {
  if (messagesCollection) {
    try {
      const messages = await messagesCollection
        .find({ from })
        .sort({ createdAt: -1 })
        .limit(MAX_HISTORY)
        .toArray();
      return messages.reverse().map(m => ({ role: m.role, content: m.content }));
    } catch (error) {
      console.warn('Failed to fetch history from MongoDB:', error.message);
    }
  }

  return conversations.get(from) || [];
}

async function saveMessage(from, role, content) {
  const message = { from, role, content, createdAt: new Date() };

  if (messagesCollection) {
    try {
      await messagesCollection.insertOne(message);
    } catch (error) {
      console.warn('Failed to save message to MongoDB:', error.message);
    }
  }

  const history = conversations.get(from) || [];
  const updated = [...history, message].slice(-MAX_HISTORY);
  conversations.set(from, updated);
}

async function answerMessage(from, text, { saveUser = true } = {}) {
  if (!allowRequest(from)) {
    await sendWhatsAppMessage(from, '⏳ تعداد پیام‌ها در این دقیقه زیاد است. لطفاً کمی بعد دوباره تلاش کنید.');
    return;
  }

  if (/^\/(reset|new|شروع)\b/i.test(text)) {
    await resetConversation(from);
    await sendWhatsAppMessage(from, '♻️ گفت‌وگوی قبلی پاک شد. از نو شروع کنیم؟');
    return;
  }

  if (/^(سلام|درود|hello|hi|hey)\s*[!؟?]*$/iu.test(text)) {
    const welcome = /[\u0600-\u06FF]/.test(text)
      ? 'سلام 👋 من دستیار هوش مصنوعی واتساپ هستم. متن، عکس، فایل و پیام صوتی بفرست.'
      : 'Hi 👋 I am your WhatsApp AI assistant. Send text, images, files or voice messages.';
    if (saveUser) await saveMessage(from, 'user', text);
    await saveMessage(from, 'assistant', welcome);
    await sendWhatsAppMessage(from, welcome);
    return;
  }

  try {
    await sendTypingIndicator(from);
    const history = await getConversationHistory(from);
    const response = await openai.responses.create({
      model,
      instructions: `${systemPrompt}\nAlways answer in the user's language. If the user writes Persian, use natural everyday Persian.`,
      input: [...history, { role: 'user', content: text }]
    });

    const answer = response.output_text?.trim() || 'متأسفم، نتوانستم پاسخ مناسبی تولید کنم.';
    if (saveUser) await saveMessage(from, 'user', text);
    await saveMessage(from, 'assistant', answer);
    await sendWhatsAppMessage(from, answer);
  } catch (error) {
    console.error('OpenAI/API error:', error?.response?.data || error.message || error);
    const errorMsg = error?.status === 429
      ? '⏳ سرویس هوش مصنوعی فعلاً شلوغ است. کمی بعد دوباره تلاش کنید.'
      : 'متأسفم، مشکلی پیش آمد. لطفاً چند لحظه بعد دوباره تلاش کنید.';
    await safeSend(from, errorMsg);
  }
}

async function answerMediaMessage(from, type, mediaId, prompt = '', filename = null) {
  if (!allowRequest(from)) {
    await sendWhatsAppMessage(from, '⏳ تعداد پیام‌ها در این دقیقه زیاد است. کمی بعد دوباره تلاش کنید.');
    return;
  }

  try {
    await sendTypingIndicator(from);
    const history = await getConversationHistory(from);
    let userText = prompt;
    let content;

    const media = await downloadWhatsAppMedia(mediaId);

    if (type === 'image') {
      const dataUrl = bufferToDataUrl(media.buffer, media.mimeType);
      content = [
        { type: 'input_text', text: prompt || 'این تصویر را بررسی کن.' },
        { type: 'input_image', image_url: dataUrl, detail: 'auto' }
      ];
    } else if (type === 'document') {
      const dataUrl = bufferToDataUrl(media.buffer, media.mimeType);
      content = [
        { type: 'input_text', text: prompt || 'این فایل را بررسی کن.' },
        { type: 'input_file', filename: filename || media.filename || 'document', file_data: dataUrl }
      ];
    } else if (type === 'audio') {
      const file = await toFile(media.buffer, media.filename || 'voice.ogg', { type: media.mimeType });
      const transcription = await openai.audio.transcriptions.create({
        file,
        model: transcriptionModel
      });
      userText = transcription.text?.trim() || '';
      if (!userText) {
        await sendWhatsAppMessage(from, '🎤 صدای دریافتی قابل تشخیص نبود. لطفاً دوباره ارسال کنید.');
        return;
      }
      content = `پیام صوتی کاربر به متن تبدیل شده است: ${userText}`;
    }

    const response = await openai.responses.create({
      model,
      instructions: `${systemPrompt}\\nAlways answer in the user's language. If the user writes Persian, use natural everyday Persian.`,
      input: [...history, { role: 'user', content }]
    });

    const answer = response.output_text?.trim() || 'متأسفم، نتوانستم پاسخ مناسبی تولید کنم.';
    await saveMessage(from, 'user', type === 'audio' ? `[پیام صوتی] ${userText}` : (prompt || `[پیام ${type}]`));
    await saveMessage(from, 'assistant', answer);
    await sendWhatsAppMessage(from, answer);
  } catch (error) {
    console.error('OpenAI/media error:', error?.response?.data || error.message || error);
    await safeSend(from, 'متأسفم، پردازش این فایل با مشکل روبه‌رو شد. لطفاً دوباره ارسال کنید.');
  }
}

async function resetConversation(from) {
  conversations.delete(from);
  if (messagesCollection) await messagesCollection.deleteMany({ from }).catch(() => {});
}

async function getWhatsAppMediaUrl(mediaId) {
  if (!mediaId) throw new Error('Missing WhatsApp media id');
  const result = await fetch(`https://graph.facebook.com/${graphVersion}/${mediaId}`, {
    headers: { Authorization: `Bearer ${whatsappToken}` }
  });
  if (!result.ok) throw new Error(`WhatsApp media metadata failed (${result.status}): ${await result.text()}`);
  const data = await result.json();
  if (!data.url) throw new Error('WhatsApp media URL was not returned');
  return { url: data.url, mimeType: data.mime_type || 'application/octet-stream', filename: data.filename || null };
}

async function downloadWhatsAppMedia(mediaId) {
  const meta = await getWhatsAppMediaUrl(mediaId);
  const result = await fetch(meta.url, { headers: { Authorization: `Bearer ${whatsappToken}` } });
  if (!result.ok) throw new Error(`WhatsApp media download failed (${result.status})`);
  const buffer = Buffer.from(await result.arrayBuffer());
  if (buffer.length > MAX_MEDIA_BYTES) throw new Error('Media exceeds MAX_MEDIA_BYTES');
  return { buffer, mimeType: meta.mimeType, filename: meta.filename };
}

function bufferToDataUrl(buffer, mimeType) {
  return `data:${mimeType};base64,${buffer.toString('base64')}`;
}

async function safeSend(to, body) {
  try { await sendWhatsAppMessage(to, body); } catch (error) { console.error('WhatsApp response failed:', error.message); }
}

async function sendTypingIndicator(to) {
  if (whatsappProvider === 'ycloud') return;
  const url = `https://graph.facebook.com/${graphVersion}/${phoneNumberId}/messages`;
  try {
    await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${whatsappToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to,
        type: 'typing_indicator'
      })
    });
  } catch (error) {
    console.warn('Failed to send typing indicator:', error.message);
  }
}

async function isMessageProcessed(messageId) {
  if (processedCollection) {
    try {
      await processedCollection.insertOne({ messageId, createdAt: new Date() });
      return false;
    } catch (error) {
      if (error?.code === 11000) return true;
      console.warn('Failed to persist message deduplication:', error.message);
    }
  }
  if (processedMessages.has(messageId)) return true;
  processedMessages.set(messageId, Date.now());
  setTimeout(() => processedMessages.delete(messageId), MESSAGE_TTL_MS);
  return false;
}

async function sendWhatsAppMessage(to, body) {
  if (whatsappProvider === 'ycloud') {
    const externalId = 'chat-' + Date.now() + '-' + crypto.randomUUID();
    let result;
    try {
      result = await ycloudClient.sendText({
        from: ycloudSenderPhone,
        to,
        body,
        externalId
      });
    } catch (error) {
      if (error instanceof YCloudError) {
        console.error('YCloud send failed:', {
          status: error.status,
          code: error.code,
          requestId: error.requestId,
          retryAfter: error.retryAfter
        });
      }
      throw error;
    }

    const providerMessageId = result?.id || null;
    if (ycloudMessagesCollection && providerMessageId) {
      await ycloudMessagesCollection.insertOne({
        provider: 'ycloud',
        providerMessageId,
        externalId,
        from: ycloudSenderPhone,
        to,
        body,
        status: result?.status || 'accepted',
        createdAt: new Date()
      }).catch(async (error) => {
        if (error?.code !== 11000) throw error;
      });
    }

    return result;
  }

  const url = 'https://graph.facebook.com/' + graphVersion + '/' + phoneNumberId + '/messages';
  const result = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: 'Bearer ' + whatsappToken,
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
    throw new Error('WhatsApp send failed (' + result.status + '): ' + details);
  }

  return await result.json();
}

app.get('/api/users/:phone/stats', async (request, response) => {
  if (!requireAdmin(request, response)) return;
  if (!messagesCollection) {
    return response.json({ error: 'MongoDB not available' });
  }

  const { phone } = request.params;
  try {
    const user = await usersCollection.findOne({ phone });
    const messageCount = await messagesCollection.countDocuments({ from: phone });
    response.json({ user, messageCount });
  } catch (error) {
    response.status(500).json({ error: error.message });
  }
});

app.get('/api/whatsapp/messages/:id', async (request, response) => {
  if (!requireAdmin(request, response)) return;

  if (whatsappProvider !== 'ycloud') {
    return response.status(404).json({ error: 'YCloud provider is not active' });
  }

  try {
    const message = await ycloudClient.retrieveMessage(request.params.id);
    return response.json(message);
  } catch (error) {
    if (error instanceof YCloudError) {
      return response.status(error.status || 502).json({
        error: error.code || 'YCLOUD_ERROR',
        requestId: error.requestId || null
      });
    }
    return response.status(502).json({ error: 'YCloud request failed' });
  }
});

app.get('/api/messages/:phone', async (request, response) => {
  if (!requireAdmin(request, response)) return;
  if (!messagesCollection) {
    return response.json({ error: 'MongoDB not available' });
  }

  const { phone } = request.params;
  const limit = Math.min(Number(request.query.limit || 50), 200);

  try {
    const messages = await messagesCollection
      .find({ from: phone })
      .sort({ createdAt: -1 })
      .limit(limit)
      .toArray();
    response.json(messages.reverse());
  } catch (error) {
    response.status(500).json({ error: error.message });
  }
});

process.on('SIGINT', async () => {
  console.log('Shutting down...');
  if (mongoClient) {
    await mongoClient.close();
  }
  process.exit(0);
});

(async () => {
  await initializeMongo();
  app.listen(port, '0.0.0.0', () => {
    console.log(`Server listening on port ${port}`);
  });
})();
