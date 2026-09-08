import { mapTbcStatus } from '../tbc-status.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function failure(message, statusCode = 502, upstreamStatus) {
  const error = new Error(message);
  error.statusCode = statusCode;
  if (Number.isInteger(upstreamStatus)) error.upstreamStatus = upstreamStatus;
  return error;
}
function required(env, name) {
  const value = env[name]?.trim();
  if (!value) throw failure('TBC is not configured: missing ' + name, 503);
  return value;
}
export function tbcEnvironment(env = process.env) {
  const mode = env.TBC_MODE?.trim() || 'test';
  if (!['test', 'production'].includes(mode)) throw failure('TBC_MODE must be test or production', 503);
  return mode;
}
function safeRedirect(value) {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || url.port) return null;
    if (url.hostname !== 'tbcbank.ge' && !url.hostname.endsWith('.tbcbank.ge')) return null;
    return url.href;
  } catch { return null; }
}
export function tbcProducts(items, totalMinor) {
  if (!Array.isArray(items) || !items.length || !Number.isSafeInteger(totalMinor) || totalMinor <= 0) {
    throw failure('Invalid TBC cart', 400);
  }
  let sum = 0;
  const products = items.map((item) => {
    const lineMinor = item.unitMinor * item.quantity;
    if (!Number.isSafeInteger(item.unitMinor) || item.unitMinor <= 0 ||
        !Number.isSafeInteger(item.quantity) || item.quantity <= 0 ||
        !Number.isSafeInteger(lineMinor) ||
        (item.lineMinor !== undefined && item.lineMinor !== lineMinor) ||
        typeof item.title !== 'string' || !item.title.trim()) {
      throw failure('Invalid TBC product', 400);
    }
    sum += lineMinor;
    // TBC expects the LINE total, not a unit price (PDF pages 9 and 14).
    return { name: item.title.slice(0, 250), price: lineMinor / 100, quantity: item.quantity };
  });
  if (!Number.isSafeInteger(sum) || sum !== totalMinor) throw failure('TBC cart totals do not match', 400);
  return products;
}
function sessionId(value) {
  if (typeof value !== 'string' || !UUID.test(value)) throw failure('Invalid TBC session ID', 400);
  return value;
}
export function createTbcProvider({ env = process.env, client, now = () => Date.now() } = {}) {
  let cachedToken;
  let tokenExpiresAt = 0;
  let tokenRequest;
  async function httpClient() { return client || (await import('axios')).default; }
  function baseUrl() {
    return tbcEnvironment(env) === 'production' ? 'https://api.tbcbank.ge' : 'https://test-api.tbcbank.ge';
  }
  async function request(options, operation) {
    let response;
    try {
      response = await (await httpClient()).request({
        timeout: 15_000, maxRedirects: 0, validateStatus: () => true, ...options
      });
    } catch {
      // Never expose Axios config, tokens, credentials or raw bank response bodies.
      throw failure('TBC ' + operation + ' service could not be reached');
    }
    if (response.status < 200 || response.status >= 300) {
      throw failure('TBC ' + operation + ' failed (HTTP ' + response.status + ')', 502, response.status);
    }
    return response;
  }
  async function accessToken() {
    if (cachedToken && now() < tokenExpiresAt) return cachedToken;
    if (tokenRequest) return tokenRequest;
    tokenRequest = (async () => {
      const apiKey = required(env, 'TBC_API_KEY');
      const apiSecret = required(env, 'TBC_API_SECRET');
      const authMethod = env.TBC_AUTH_METHOD || 'basic';
      if (!['headers', 'basic'].includes(authMethod)) throw failure('Invalid TBC_AUTH_METHOD', 503);
      const headers = { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' };
      // Basic was verified against AERIS production (headers returned invalid_client).
      // Never silently switch environments on authentication failure.
      if (authMethod === 'basic') headers.Authorization = 'Basic ' + Buffer.from(apiKey + ':' + apiSecret).toString('base64');
      else Object.assign(headers, { client_id: apiKey, client_secret: apiSecret });
      const response = await request({
        method: 'POST', url: baseUrl() + '/oauth/token', headers,
        data: new URLSearchParams({ grant_type: 'client_credentials', scope: 'online_installments' }).toString()
      }, 'authentication');
      const token = response.data?.access_token;
      if (typeof token !== 'string' || !token) throw failure('TBC did not return an access token');
      // Documentation differs on expires_in units. Cache conservatively, at most 60s.
      const ttl = Math.min(Number(response.data?.expires_in), 60_000);
      cachedToken = token;
      tokenExpiresAt = now() + (Number.isFinite(ttl) && ttl > 1000 ? ttl - 1000 : 0);
      return token;
    })();
    try { return await tokenRequest; } finally { tokenRequest = null; }
  }
  async function authorized(method, path, data, operation) {
    const token = await accessToken();
    try {
      return await request({ method, url: baseUrl() + '/v1/online-installments/' + path, data,
        headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json', Accept: 'application/json' }
      }, operation);
    } catch (error) {
      if (error.upstreamStatus === 401) { cachedToken = null; tokenExpiresAt = 0; }
      // Never repeat a potentially accepted create/confirm POST automatically.
      throw error;
    }
  }
  return {
    environment: () => tbcEnvironment(env),
    isConfigured: () => ['TBC_API_KEY', 'TBC_API_SECRET', 'TBC_MERCHANT_KEY', 'TBC_CAMPAIGN_ID'].every((name) => env[name]?.trim()),
    async checkAuthentication() { await accessToken(); return { ok: true, environment: tbcEnvironment(env) }; },
    async initiate({ orderId, items, totalMinor }) {
      const products = tbcProducts(items, totalMinor);
      if (typeof orderId !== 'string' || !orderId.trim()) throw failure('Invalid TBC invoice ID', 400);
      const response = await authorized('POST', 'applications', {
        merchantKey: required(env, 'TBC_MERCHANT_KEY'), campaignId: required(env, 'TBC_CAMPAIGN_ID'),
        invoiceId: orderId, priceTotal: totalMinor / 100, products
      }, 'application creation');
      const redirectUrl = safeRedirect(response.headers?.location);
      const providerOrderId = response.data?.sessionId;
      if (response.status !== 201 || !redirectUrl || typeof providerOrderId !== 'string' || !UUID.test(providerOrderId)) {
        throw failure('TBC returned an invalid application response');
      }
      return { providerOrderId, redirectUrl, environment: tbcEnvironment(env) };
    },
    async getStatus({ providerOrderId }) {
      const id = sessionId(providerOrderId);
      // TBC explicitly documents a JSON body on this GET. Axios supports it.
      const response = await authorized('GET', 'applications/' + id + '/status', {
        merchantKey: required(env, 'TBC_MERCHANT_KEY')
      }, 'status lookup');
      const bankStatus = response.data?.statusId;
      return { providerOrderId: id, bankStatus, ...mapTbcStatus(bankStatus) };
    },
    async confirm({ providerOrderId, stockVerified = false }) {
      if (stockVerified !== true) throw failure('Merchant must verify product availability before confirmation', 409);
      const current = await this.getStatus({ providerOrderId });
      if ([8, 9].includes(current.bankStatus)) return { alreadyConfirmed: true };
      if (current.bankStatus !== 5) throw failure('TBC application is not awaiting merchant confirmation', 409);
      await authorized('POST', 'applications/' + sessionId(providerOrderId) + '/confirm', {
        merchantKey: required(env, 'TBC_MERCHANT_KEY')
      }, 'merchant confirmation');
      // Success is NOT proof of disbursement; the status worker checks the result.
      return { confirmationSubmitted: true };
    },
    verifyWebhook() { return false; },
    parseWebhook() { throw failure('TBC uses authenticated status lookup', 400); }
  };
}
export const tbc = createTbcProvider();
export const tbcInternals = { safeRedirect };
