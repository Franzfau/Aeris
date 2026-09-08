import crypto from 'node:crypto';

const ORDER_URL = 'https://ganvadeba.credo.ge/widget_api/order.php';
const STATUS_URL = 'https://ganvadeba.credo.ge/widget/api.php';
const FIRST_STATUS_DELAY = 30 * 60 * 1000;
const KNOWN_STATUSES = new Set([2, 3, 4, 5, 6, 7, 9, 10, 11, 12, 13, 14]);

function failure(message, statusCode = 502) {
  return Object.assign(new Error(message), { statusCode });
}

function md5(value) {
  return crypto.createHash('md5').update(value, 'utf8').digest('hex');
}

function orderCode(value) {
  const code = String(value).replaceAll('-', '');
  if (!/^[a-zA-Z0-9_]{1,50}$/.test(code)) throw failure('Invalid Credo order code', 400);
  return code;
}

function productsFor(items) {
  if (!Array.isArray(items) || !items.length || items.length > 20) throw failure('Invalid Credo products', 400);
  return items.map(item => {
    const match = String(item.variantId).match(/^(?:gid:\/\/shopify\/ProductVariant\/)?(\d+)$/);
    if (!match || typeof item.title !== 'string' || !item.title.trim() ||
        !Number.isSafeInteger(item.quantity) || item.quantity < 1 || item.quantity > 20 ||
        !Number.isSafeInteger(item.unitMinor) || item.unitMinor <= 0) throw failure('Invalid Credo product', 400);
    // Keep the exact Unicode title in both the hash and JSON. Price is per unit, in tetri.
    return { id: match[1], title: item.title, amount: item.quantity, price: item.unitMinor, type: 0 };
  });
}

function orderCheck(products, secret) {
  return md5(products.map(p => `${p.id}${p.title}${p.amount}${p.price}${p.type}`).join('') + secret);
}

function safeRedirect(value) {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.hostname !== 'ganvadeba.credo.ge' ||
        url.username || url.password || url.port || !/^\/installment(?:\/|$)/.test(url.pathname)) return null;
    return url.href;
  } catch { return null; }
}

function mapStatus(code) {
  if (!KNOWN_STATUSES.has(code)) throw failure('Credo returned an unknown application status');
  if (code === 6) return { status: 'declined', stage: 'rejected', terminal: true };
  if (code === 7) return { status: 'cancelled', stage: 'cancelled', terminal: true };
  if (code === 5) return { status: 'approved', stage: 'settled', terminal: true };
  // Signed != paid. This module never marks an order paid or shipped.
  if (code === 12) return { status: 'approved', stage: 'signed_awaiting_delivery', terminal: false };
  if (code === 3 || code === 4) return { status: 'redirected', stage: 'preliminary_approval', terminal: false };
  if (code === 10 || code === 11) return { status: 'redirected', stage: 'customer_filling', terminal: false };
  return { status: 'redirected', stage: 'processing', terminal: false };
}

export function createCredoProvider({ env = process.env, client, now = () => Date.now() } = {}) {
  function credentials() {
    const merchantId = env.CREDO_MERCHANT_ID?.trim();
    const secret = env.CREDO_SECRET?.trim();
    if (!/^\d+$/.test(merchantId || '') || !secret) throw failure('Credo is not configured', 503);
    return { merchantId, secret };
  }
  async function http() { return client || (await import('axios')).default; }
  return {
    isConfigured() { try { credentials(); return true; } catch { return false; } },
    merchantId() { return credentials().merchantId; },
    async initiate({ orderId, items }) {
      const { merchantId, secret } = credentials();
      const providerOrderId = orderCode(orderId);
      const products = productsFor(items);
      let response;
      try {
        response = await (await http()).post(ORDER_URL, {
          merchantId, orderCode: providerOrderId, check: orderCheck(products, secret), products
        }, {
          headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
          timeout: 20_000, maxRedirects: 0, validateStatus: () => true
        });
      } catch { throw failure('Credo installment service could not be reached'); }
      const redirectUrl = safeRedirect(response.data?.data?.URL);
      if (response.status !== 200 || response.data?.status !== 200 || !redirectUrl) {
        throw failure('Credo did not create an installment application');
      }
      return { providerOrderId, redirectUrl };
    },
    async getStatus({ providerOrderId, createdAt }) {
      const created = new Date(createdAt).getTime();
      if (!Number.isFinite(created)) throw failure('Invalid Credo creation time', 400);
      const remaining = FIRST_STATUS_DELAY - (now() - created);
      if (remaining > 0) return { waiting: true, retryAfterMs: remaining };
      const { merchantId, secret } = credentials();
      const code = orderCode(providerOrderId);
      let response;
      try {
        response = await (await http()).get(STATUS_URL, {
          params: { merchantId, orderCode: code, hash: md5(`${merchantId}${code}${secret}`) },
          headers: { Accept: 'application/json' }, timeout: 15_000,
          maxRedirects: 0, validateStatus: () => true
        });
      } catch { throw failure('Credo status service could not be reached'); }
      const raw = response.data?.data;
      const bankStatus = typeof raw === 'number' ? raw : typeof raw === 'string' && /^\d+$/.test(raw) ? Number(raw) : NaN;
      if (response.status !== 200 || response.data?.status !== 200 || !Number.isInteger(bankStatus)) {
        throw failure('Credo did not return an installment status');
      }
      // Do not persist the personal ID and other private fields returned in response.info.
      return { providerOrderId: code, bankStatus, ...mapStatus(bankStatus) };
    },
    // The documented integration has authenticated polling, not a signed public webhook.
    verifyWebhook() { return false; }
  };
}

export const credo = createCredoProvider();
export const credoInternals = { md5, orderCode, productsFor, orderCheck, safeRedirect, mapStatus };
