import crypto from 'node:crypto';
import axios from 'axios';

const BOG_API_URL = 'https://api.bog.ge/payments/v1';
const BOG_TOKEN_URL = 'https://oauth2.bog.ge/auth/realms/bog/protocol/openid-connect/token';
const BOG_CALLBACK_PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAu4RUyAw3+CdkS3ZNILQh
zHI9Hemo+vKB9U2BSabppkKjzjjkf+0Sm76hSMiu/HFtYhqWOESryoCDJoqffY0Q
1VNt25aTxbj068QNUtnxQ7KQVLA+pG0smf+EBWlS1vBEAFbIas9d8c9b9sSEkTrr
TYQ90WIM8bGB6S/KLVoT1a7SnzabjoLc5Qf/SLDG5fu8dH8zckyeYKdRKSBJKvhx
tcBuHV4f7qsynQT+f2UYbESX/TLHwT5qFWZDHZ0YUOUIvb8n7JujVSGZO9/+ll/g
4ZIWhC1MlJgPObDwRkRd8NFOopgxMcMsDIZIoLbWKhHVq67hdbwpAq9K9WMmEhPn
PwIDAQAB
-----END PUBLIC KEY-----`;

function required(name) {
  const value = process.env[name];
  if (!value) {
    const error = new Error(`Bank of Georgia is not configured: missing ${name}`);
    error.statusCode = 503;
    throw error;
  }
  return value;
}

async function accessToken() {
  const response = await axios.post(
    BOG_TOKEN_URL,
    new URLSearchParams({ grant_type: 'client_credentials' }).toString(),
    {
      auth: {
        username: required('BOG_CLIENT_ID'),
        password: required('BOG_CLIENT_SECRET')
      },
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      timeout: 15_000,
      validateStatus: () => true
    }
  );

  const token = response.data?.access_token;
  if (response.status < 200 || response.status >= 300 || !token) {
    const error = new Error(`Bank of Georgia authentication failed (${response.status})`);
    error.statusCode = 502;
    throw error;
  }
  return token;
}

function money(minor) {
  return Number((minor / 100).toFixed(2));
}

export const bog = {
  async initiate({ orderId, items, totalMinor, loan }) {
    const token = await accessToken();
    const publicApiUrl = required('PUBLIC_API_URL').replace(/\/$/, '');
    const response = await axios.post(
      `${BOG_API_URL}/ecommerce/orders`,
      {
        callback_url: `${publicApiUrl}/api/webhooks/bog`,
        external_order_id: orderId,
        purchase_units: {
          currency: 'GEL',
          total_amount: money(totalMinor),
          basket: items.map((item) => ({
            product_id: String(item.variantId),
            description: item.title.slice(0, 250),
            quantity: item.quantity,
            unit_price: money(item.unitMinor)
          }))
        },
        redirect_urls: {
          success: process.env.BOG_SUCCESS_URL || 'https://aeris.ge/?payment=success',
          fail: process.env.BOG_FAIL_URL || 'https://aeris.ge/cart?payment=failed'
        },
        payment_method: ['bog_loan'],
        config: {
          loan: {
            type: loan?.type || process.env.BOG_LOAN_TYPE || 'standard',
            month: loan?.month || Number(process.env.BOG_LOAN_MONTH || 3)
          }
        }
      },
      {
        headers: {
          Authorization: `Bearer ${token}`,
          'Accept-Language': 'ka',
          'Content-Type': 'application/json',
          'Idempotency-Key': crypto.randomUUID()
        },
        timeout: 20_000,
        validateStatus: () => true
      }
    );

    const providerOrderId = response.data?.id;
    const redirectUrl = response.data?._links?.redirect?.href;
    if (response.status < 200 || response.status >= 300 || !providerOrderId || !redirectUrl) {
      const message = response.data?.detail || response.data?.message || `HTTP ${response.status}`;
      const error = new Error(`Bank of Georgia did not create an installment order: ${message}`);
      error.statusCode = 502;
      throw error;
    }
    return { providerOrderId, redirectUrl };
  },

  verifyWebhook(req) {
    const signature = req.get('Callback-Signature');
    if (!signature || !req.rawBody) return false;
    try {
      return crypto.verify(
        'RSA-SHA256',
        req.rawBody,
        BOG_CALLBACK_PUBLIC_KEY,
        Buffer.from(signature, 'base64')
      );
    } catch {
      return false;
    }
  },

  parseWebhook(payload) {
    const body = payload?.body || {};
    const providerOrderId = body.order_id;
    if (!providerOrderId) throw new Error('Bank of Georgia callback is missing order_id');

    const statuses = {
      completed: 'approved',
      rejected: 'declined',
      refunded: 'cancelled',
      refunded_partially: 'cancelled',
      created: 'redirected',
      processing: 'redirected'
    };
    return {
      providerOrderId,
      status: statuses[body.order_status?.key] || 'redirected'
    };
  }
};
