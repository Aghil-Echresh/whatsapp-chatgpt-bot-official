const DEFAULT_BASE_URL = 'https://api.ycloud.com/v2';

export class YCloudError extends Error {
  constructor(message, { status = null, code = null, target = null, requestId = null, whatsappApiError = null, retryAfter = null, responseBody = null } = {}) {
    super(message);
    this.name = 'YCloudError';
    this.status = status;
    this.code = code;
    this.target = target;
    this.requestId = requestId;
    this.whatsappApiError = whatsappApiError;
    this.retryAfter = retryAfter;
    this.responseBody = responseBody;
  }
}

function requiredString(value, field, maxLength = 255) {
  if (typeof value !== 'string' || value.trim() === '' || value.length > maxLength) {
    throw new TypeError(field + ' must be a non-empty string of at most ' + maxLength + ' characters');
  }
  return value;
}

function validateE164(value, field) {
  requiredString(value, field);
  if (!/^\+[1-9]\d{7,14}$/.test(value)) {
    throw new TypeError(field + ' must be an E.164 phone number');
  }
  return value;
}

function resolveRecipient(input) {
  const hasTo = Object.prototype.hasOwnProperty.call(input, 'to');

  if (hasTo) {
    return { to: validateE164(input.to, 'to') };
  }

  return { recipient: requiredString(input.recipient, 'recipient') };
}

export function buildYCloudTextMessage({ from, to, recipient, body, externalId, context, previewUrl = false }) {
  const request = {
    from: validateE164(from, 'from'),
    type: 'text',
    text: {
      body: requiredString(body, 'text.body', 4096),
      preview_url: Boolean(previewUrl)
    }
  };

  Object.assign(request, resolveRecipient({ to, recipient }));

  if (externalId !== undefined && externalId !== null) {
    request.externalId = requiredString(externalId, 'externalId');
  }

  if (context !== undefined && context !== null) {
    if (typeof context !== 'object' || Array.isArray(context)) {
      throw new TypeError('context must be an object');
    }
    request.context = context;
  }

  return request;
}

async function parseErrorBody(response) {
  const text = await response.text();
  if (!text) return { raw: null, parsed: null };
  try { return { raw: text, parsed: JSON.parse(text) }; }
  catch { return { raw: text, parsed: null }; }
}

export class YCloudClient {
  constructor({ apiKey, baseUrl = DEFAULT_BASE_URL, fetchImpl = globalThis.fetch } = {}) {
    if (typeof fetchImpl !== 'function') throw new TypeError('A fetch implementation is required');
    this.apiKey = requiredString(apiKey, 'apiKey');
    this.baseUrl = String(baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, '');
    this.fetchImpl = fetchImpl;
  }

  async request(path, { method = 'GET', body } = {}) {
    const headers = { accept: 'application/json', 'X-API-Key': this.apiKey };
    const init = { method, headers };

    if (body !== undefined) {
      headers['content-type'] = 'application/json';
      init.body = JSON.stringify(body);
    }

    let response;
    try {
      response = await this.fetchImpl(this.baseUrl + path, init);
    } catch (error) {
      throw new YCloudError('YCloud transport error: ' + error.message, { code: 'TRANSPORT_ERROR' });
    }

    const requestId = response.headers?.get?.('YCloud-Request-ID') || null;
    const retryAfter = response.headers?.get?.('Retry-After') || null;

    if (!response.ok) {
      const { raw, parsed } = await parseErrorBody(response);
      const providerError = parsed?.error || {};
      throw new YCloudError(providerError.message || ('YCloud request failed with HTTP ' + response.status), {
        status: response.status,
        code: providerError.code || null,
        target: providerError.target || null,
        requestId: providerError.requestId || requestId,
        whatsappApiError: providerError.whatsappApiError || null,
        retryAfter,
        responseBody: raw
      });
    }

    const text = await response.text();
    if (!text) return null;
    try { return JSON.parse(text); }
    catch {
      throw new YCloudError('YCloud returned a non-JSON success response', {
        status: response.status, requestId, responseBody: text
      });
    }
  }

  async sendText({ from, to, recipient, body, externalId, context, previewUrl = false, direct = false, ttlSeconds, category, templateName, filterUnsubscribed = false, filterBlocked = false }) {
    const payload = buildYCloudTextMessage({ from, to, recipient, body, externalId, context, previewUrl });

    if (direct) {
      payload.useDirectSend = true;
      if (ttlSeconds !== undefined) payload.ttlSeconds = ttlSeconds;
      if (category !== undefined) payload.category = category;
      if (templateName !== undefined) payload.templateName = templateName;
    } else {
      payload.filterUnsubscribed = Boolean(filterUnsubscribed);
      payload.filterBlocked = Boolean(filterBlocked);
      if (templateName !== undefined) payload.templateName = templateName;
    }

    const endpoint = direct ? '/whatsapp/messages/sendDirectly' : '/whatsapp/messages';
    return this.request(endpoint, { method: 'POST', body: payload });
  }

  async retrieveMessage(id) {
    requiredString(id, 'id');
    return this.request('/whatsapp/messages/' + encodeURIComponent(id));
  }
}

export function getYCloudClientFromEnv(env = process.env, fetchImpl = globalThis.fetch) {
  return new YCloudClient({
    apiKey: env.YCLOUD_API_KEY,
    baseUrl: env.YCLOUD_API_BASE_URL || DEFAULT_BASE_URL,
    fetchImpl
  });
}