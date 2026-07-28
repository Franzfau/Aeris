import axios from 'axios';

function required(name) {
  const value = process.env[name];
  if (!value) {
    const error = new Error(`TBC is not configured: missing ${name}`);
    error.statusCode = 503;
    throw error;
  }
  return value;
}

function baseUrl() {
  // Production must be an explicit decision after TBC approves the merchant.
  return process.env.TBC_MODE === 'production' ? 'https://api.tbcbank.ge' : 'https://test-api.tbcbank.ge';
}

async function accessToken() {
  const apiKey = required('TBC_API_KEY');
  const apiSecret = required('TBC_API_SECRET');
  const body = new URLSearchParams({ grant_type: 'client_credentials', scope: 'online_installments' });
  const response = await axios.post(`${baseUrl()}/oauth/token`, body.toString(), {
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Authorization: `Basic ${Buffer.from(`${apiKey}:${apiSecret}`).toString('base64')}`
    },
    timeout: 15_000
  });
  return response.data.access_token;
}

export const tbc = {
  async initiate({ orderId, items, totalMinor }) {
    const token = await accessToken();
    const response = await axios.post(
      `${baseUrl()}/v1/online-installments/applications`,
      {
        merchantKey: required('TBC_MERCHANT_KEY'),
        campaignId: required('TBC_CAMPAIGN_ID'),
        invoiceId: orderId,
        priceTotal: Number((totalMinor / 100).toFixed(2)),
        products: items.map((item) => ({
          name: item.title.slice(0, 250),
          price: Number((item.unitMinor / 100).toFixed(2)),
          quantity: item.quantity
        }))
      },
      {
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        timeout: 15_000,
        validateStatus: () => true
      }
    );
    const redirectUrl = response.headers.location;
    const sessionId = response.data?.sessionId;
    if (response.status < 200 || response.status >= 300 || !redirectUrl || !sessionId) {
      const error = new Error('TBC did not create an installment application');
      error.statusCode = 502;
      throw error;
    }
    return { providerOrderId: sessionId, redirectUrl };
  },
  // TBC Online Installments uses authenticated status polling, not an unauthenticated browser callback.
  verifyWebhook() { return false; },
  parseWebhook() { throw new Error('TBC does not use this webhook endpoint'); }
};
