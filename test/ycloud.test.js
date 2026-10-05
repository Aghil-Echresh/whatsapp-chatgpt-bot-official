import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { buildYCloudTextMessage, YCloudClient, YCloudError } from '../lib/ycloud.js';
import { verifyYCloudSignature } from '../lib/ycloud-webhook.js';

const FROM = '+15551234567';
const TO = '+15557654321';
const KEY = '<YCLOUD_API_KEY>';
const SECRET = 'synthetic-webhook-secret';

test('YCloud text request requires exactly one recipient', () => {
  assert.throws(
    () => buildYCloudTextMessage({ from: FROM, body: 'hi' }),
    /recipient/
  );

  assert.equal(
    buildYCloudTextMessage({ from: FROM, to: TO, body: 'hi' }).to,
    TO
  );

  assert.equal(
    buildYCloudTextMessage({ from: FROM, recipient: 'US.synthetic-user', body: 'hi' }).recipient,
    'US.synthetic-user'
  );
});

test('valid to wins and ignored recipient does not affect the request', () => {
  const onlyTo = buildYCloudTextMessage({
    from: FROM,
    to: TO,
    body: 'hello'
  });

  const both = buildYCloudTextMessage({
    from: FROM,
    to: TO,
    recipient: { malformed: true },
    body: 'hello'
  });

  assert.deepEqual(both, onlyTo);
  assert.equal('recipient' in both, false);
});

test('invalid to never falls back to recipient', () => {
  assert.throws(
    () => buildYCloudTextMessage({
      from: FROM,
      to: 'bad-phone',
      recipient: 'US.synthetic-user',
      body: 'hello'
    }),
    /E\.164/
  );
});

test('client sends through YCloud with X-API-Key and preserves response request id', async () => {
  let captured;
  const client = new YCloudClient({
    apiKey: KEY,
    fetchImpl: async (url, init) => {
      captured = { url, init };
      return new Response(JSON.stringify({
        id: 'synthetic-message-id',
        status: 'accepted',
        from: FROM,
        to: TO,
        type: 'text'
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json', 'YCloud-Request-ID': 'req_synthetic' }
      });
    }
  });

  const result = await client.sendText({
    from: FROM,
    to: TO,
    body: 'سلام 👋',
    externalId: 'order-123'
  });

  assert.equal(result.id, 'synthetic-message-id');
  assert.equal(captured.url, 'https://api.ycloud.com/v2/whatsapp/messages');
  assert.equal(captured.init.headers['X-API-Key'], KEY);
  assert.deepEqual(JSON.parse(captured.init.body), {
    from: FROM,
    to: TO,
    type: 'text',
    text: { body: 'سلام 👋', preview_url: false },
    externalId: 'order-123',
    filterUnsubscribed: false,
    filterBlocked: false
  });
});

test('client exposes YCloud error envelope and Retry-After', async () => {
  const client = new YCloudClient({
    apiKey: KEY,
    fetchImpl: async () => new Response(JSON.stringify({
      error: {
        status: 429,
        code: 'TOO_MANY_REQUESTS',
        message: 'rate limited',
        requestId: 'req_rate'
      }
    }), {
      status: 429,
      headers: { 'Content-Type': 'application/json', 'Retry-After': '7' }
    })
  });

  await assert.rejects(
    () => client.sendText({ from: FROM, to: TO, body: 'hi' }),
    (error) => {
      assert(error instanceof YCloudError);
      assert.equal(error.status, 429);
      assert.equal(error.code, 'TOO_MANY_REQUESTS');
      assert.equal(error.requestId, 'req_rate');
      assert.equal(error.retryAfter, '7');
      return true;
    }
  );
});

test('YCloud webhook signature validates exact raw bytes', () => {
  const now = 1760000000;
  const raw = Buffer.from('{"id":"evt_1","type":"whatsapp.inbound_message.received"}', 'utf8');
  const digest = crypto.createHmac('sha256', SECRET)
    .update(Buffer.from(String(now) + '.', 'ascii'))
    .update(raw)
    .digest('hex');

  const header = 't=' + now + ',s=' + digest;
  const valid = verifyYCloudSignature({
    rawBody: raw,
    signatureHeader: header,
    secrets: [SECRET],
    now
  });

  assert.equal(valid.valid, true);

  const tampered = verifyYCloudSignature({
    rawBody: Buffer.from(raw.toString().replace('evt_1', 'evt_2'), 'utf8'),
    signatureHeader: header,
    secrets: [SECRET],
    now
  });
  assert.equal(tampered.valid, false);
});

test('YCloud webhook rejects stale signatures', () => {
  const now = 1760000000;
  const timestamp = now - 301;
  const raw = Buffer.from('{}');
  const digest = crypto.createHmac('sha256', SECRET)
    .update(Buffer.from(String(timestamp) + '.', 'ascii'))
    .update(raw)
    .digest('hex');

  const result = verifyYCloudSignature({
    rawBody: raw,
    signatureHeader: 't=' + timestamp + ',s=' + digest,
    secrets: [SECRET],
    now,
    toleranceSeconds: 300
  });

  assert.equal(result.valid, false);
  assert.equal(result.reason, 'timestamp_out_of_range');
});
