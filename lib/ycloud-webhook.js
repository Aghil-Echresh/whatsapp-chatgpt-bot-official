import crypto from 'node:crypto';

export function parseYCloudSignatureHeader(header) {
  if (typeof header !== 'string') return null;
  const parts = header.split(',');
  if (parts.length !== 2) return null;
  const parsed = {};
  for (const part of parts) {
    const separator = part.indexOf('=');
    if (separator <= 0) return null;
    const key = part.slice(0, separator).trim();
    const value = part.slice(separator + 1).trim();
    if (!value || parsed[key] !== undefined) return null;
    parsed[key] = value;
  }
  if (!/^\d+$/.test(parsed.t || '') || !/^[0-9a-f]{64}$/.test(parsed.s || '')) return null;
  const timestamp = Number(parsed.t);
  if (!Number.isSafeInteger(timestamp) || timestamp <= 0) return null;
  return { timestamp, signature: parsed.s };
}

export function verifyYCloudSignature({ rawBody, signatureHeader, secrets, now = Math.floor(Date.now() / 1000), toleranceSeconds = 300 }) {
  if (!Buffer.isBuffer(rawBody)) return { valid: false, reason: 'missing_raw_body' };
  const parsed = parseYCloudSignatureHeader(signatureHeader);
  if (!parsed) return { valid: false, reason: 'invalid_signature_header' };
  if (!Number.isFinite(toleranceSeconds) || toleranceSeconds < 0) return { valid: false, reason: 'invalid_tolerance' };
  if (Math.abs(now - parsed.timestamp) > toleranceSeconds) return { valid: false, reason: 'timestamp_out_of_range' };
  const candidates = (Array.isArray(secrets) ? secrets : [secrets]).filter((secret) => typeof secret === 'string' && secret.length > 0);
  if (!candidates.length) return { valid: false, reason: 'missing_secret' };

  const signedPayload = Buffer.concat([Buffer.from(String(parsed.timestamp), 'ascii'), Buffer.from('.', 'ascii'), rawBody]);
  const received = Buffer.from(parsed.signature, 'hex');
  let matches = false;
  for (const secret of candidates) {
    const computed = crypto.createHmac('sha256', Buffer.from(secret, 'utf8')).update(signedPayload).digest();
    matches = crypto.timingSafeEqual(computed, received) || matches;
  }

  return { valid: matches, reason: matches ? 'ok' : 'signature_mismatch', timestamp: parsed.timestamp, signature: parsed.signature };
}

export function parseYCloudEvent(rawBody) {
  if (!Buffer.isBuffer(rawBody)) throw new TypeError('rawBody must be a Buffer');
  const body = JSON.parse(rawBody.toString('utf8'));
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new TypeError('Webhook body must be an object');
  if (typeof body.id !== 'string' || !body.id) throw new TypeError('Webhook event id is required');
  if (typeof body.type !== 'string' || !body.type) throw new TypeError('Webhook event type is required');
  return body;
}

export function extractInboundMessage(event) {
  if (event?.type !== 'whatsapp.inbound_message.received') return null;
  return event.whatsappInboundMessage || null;
}

export function extractMessageUpdate(event) {
  if (event?.type !== 'whatsapp.message.updated') return null;
  return event.whatsappMessage || null;
}

export function payloadHash(rawBody) {
  return crypto.createHash('sha256').update(rawBody).digest('hex');
}