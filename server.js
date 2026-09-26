import 'dotenv/config';
import crypto from 'node:crypto';
import express from 'express';
import OpenAI from 'openai';
import { MongoClient } from 'mongodb';

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

let mongoClient;
let messagesCollection;
let usersCollection;

// In-memory fallback (for when MongoDB is not available)
const conversations = new Map();
const processedMessages = new Map();
const MAX_HISTORY = 15;
const MESSAGE_TTL_MS = 24 * 60 * 60 * 1000;

// Initialize MongoDB if connection string is provided
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
    
    // Create indexes
    await messagesCollection.createIndex({ from: 1, createdAt: -1 });
    await messagesCollection.createIndex({ createdAt: 1 }, { expireAfterSeconds: 86400 * 30 });
    await usersCollection.createIndex({ phone: 1 }, { unique: true });
    
    console.log('✓ MongoDB connected');
    return true;
  } catch (error) {
    console.warn('MongoDB connection failed, using in-memory storage:', error.message);
    return false;
  }
}

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
  response.json({ ok: true, service: 'whatsapp-chatgpt-bot', mongodb: !!mongoClient });
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
      const senderPhone = value?.contacts?.[0]?.wa_id;
      const senderName = value?.contacts?.[0]?.profile?.name;
      
      // Track user
      if (senderPhone && usersCollection) {
        await usersCollection.updateOne(
          { phone: senderPhone },
          { $set: { name: senderName, lastSeen: new Date() } },
          { upsert: true }
        ).catch(() => {});
      }
      
      for (const message of value?.messages || []) {
        if (processedMessages.has(message.id)) continue;
        processedMessages.set(message.id, Date.now());
        setTimeout(() => processedMessages.delete(message.id), MESSAGE_TTL_MS);

        // Handle different message types
        if (message.type === 'text') {
          const text = message.text?.body?.trim();
          if (text) await answerMessage(message.from, text);
        } else if (message.type === 'image') {
          await sendWhatsAppMessage(message.from, '📸 I received an image, but I can only process text messages for now.');
        } else if (message.type === 'document') {
          await sendWhatsAppMessage(message.from, '📄 I received a document, but I can only process text messages for now.');
        } else if (message.type === 'audio') {
          await sendWhatsAppMessage(message.from, '🎤 I received an audio message, but I can only process text messages for now.');
        } else {
          await sendWhatsAppMessage(message.from, 'فعلاً فقط پیام‌های متنی را پشتیبانی می‌کنم.');
        }
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
      return messages.reverse().map(m => ({
        role: m.role,
        content: m.content
      }));
    } catch (error) {
      console.warn('Failed to fetch history from MongoDB:', error.message);
    }
  }
  
  // Fallback to in-memory
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
  
  // Also keep in-memory
  const history = conversations.get(from) || [];
  const updated = [...history, message].slice(-MAX_HISTORY);
  conversations.set(from, updated);
}

async function answerMessage(from, text) {
  const history = await getConversationHistory(from);
  
  // Detect language
  const isArabicOrFarsi = /[\u0600-\u06FF]/.test(text);
  const language = isArabicOrFarsi ? 'Persian' : 'English';
  const customPrompt = `${systemPrompt} Always respond in ${language}.`;
  
  try {
    // Show typing indicator
    await sendTypingIndicator(from);
    
    const completion = await openai.chat.completions.create({
      model,
      temperature: 0.7,
      max_tokens: 700,
      messages: [
        { role: 'system', content: customPrompt },
        ...history,
        { role: 'user', content: text }
      ]
    });
    
    const answer = completion.choices[0]?.message?.content?.trim() ||
      'متأسفم، در حال حاضر نتوانستم پاسخ منسجمی تولید کنم.';

    await saveMessage(from, 'user', text);
    await saveMessage(from, 'assistant', answer);
    await sendWhatsAppMessage(from, answer);
  } catch (error) {
    console.error('OpenAI/API error:', error?.response?.data || error.message || error);
    const errorMsg = error?.status === 429 
      ? 'متأسفم، سرویس اکنون مشغول است. لطفاً بعد از کمی فاصله دوباره تلاش کنید.'
      : 'متأسفم، مشکلی پیش آمد. لطفاً چند لحظه بعد دوباره تلاش کنید.';
    await sendWhatsAppMessage(from, errorMsg);
  }
}

async function sendTypingIndicator(to) {
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

// API endpoint to get user stats
app.get('/api/users/:phone/stats', async (request, response) => {
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

// API endpoint to get conversation history
app.get('/api/messages/:phone', async (request, response) => {
  if (!messagesCollection) {
    return response.json({ error: 'MongoDB not available' });
  }
  
  const { phone } = request.params;
  const limit = Number(request.query.limit || 50);
  
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

// Graceful shutdown
process.on('SIGINT', async () => {
  console.log('Shutting down...');
  if (mongoClient) {
    await mongoClient.close();
  }
  process.exit(0);
});

(async () => {
  await initializeMongo();
  app.listen(port, () => {
    console.log(`Server listening on port ${port}`);
  });
})();
