import axios from 'axios';
import { config } from './config.js';

async function adminClient() {
  let accessToken = config.shopify.accessToken;

  if (!accessToken) {
    const credentials = new URLSearchParams({
      client_id: config.shopify.clientId,
      client_secret: config.shopify.clientSecret,
      grant_type: 'client_credentials'
    });
    const tokenResponse = await axios.post(
      `https://${config.shopify.storeDomain}/admin/oauth/access_token`,
      credentials.toString(),
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, timeout: 15_000 }
    );
    accessToken = tokenResponse.data.access_token;
  }

  return axios.create({
    baseURL: `https://${config.shopify.storeDomain}/admin/api/${config.shopify.apiVersion}`,
    headers: { 'X-Shopify-Access-Token': accessToken, 'Content-Type': 'application/json' },
    timeout: 15_000
  });
}

export async function resolveCart(items) {
  const ids = items.map((item) => item.variantId);
  // In the current Admin API, ProductVariant.price is a Money scalar (for example "199.00").
  const query = `query variants($ids: [ID!]!) { nodes(ids: $ids) { ... on ProductVariant { id title price product { title } } } }`;
  const { data } = await (await adminClient()).post('/graphql.json', { query, variables: { ids } });
  if (data.errors?.length) {
    // The message is safe to log: Shopify does not include our credentials in GraphQL errors.
    const error = new Error(`Shopify product lookup failed: ${data.errors.map((item) => item.message).join('; ')}`);
    error.statusCode = 502;
    throw error;
  }
  if (data.data.nodes.some((node) => !node)) throw new Error('One or more variants do not exist');

  return data.data.nodes.map((variant, index) => {
    const quantity = items[index].quantity;
    const unitMinor = Math.round(Number(variant.price) * 100);
    if (!Number.isFinite(unitMinor) || unitMinor <= 0) throw new Error('Shopify returned an invalid product price');
    return { variantId: variant.id, title: `${variant.product.title} — ${variant.title}`, quantity, unitMinor, lineMinor: unitMinor * quantity };
  });
}

function splitCustomerName(fullName) {
  const parts = fullName.trim().split(/\s+/);
  const firstName = parts.shift() || 'Customer';
  return { firstName, lastName: parts.join(' ') || '-' };
}

export async function createShopifyOrder({ orderId, paymentMethod, items, customer }) {
  const { firstName, lastName } = splitCustomerName(customer.name);
  const city = customer.city.trim();
  const cityPrefix = city + ',';
  const address1 = customer.address.startsWith(cityPrefix)
    ? customer.address.slice(cityPrefix.length).trim()
    : customer.address;
  const customerAddress = { firstName, lastName, address1, city, phone: customer.phone };
  const mutation = 'mutation createExternalOrder($order: OrderCreateOrderInput!) { orderCreate(order: $order) { order { id name } userErrors { field message } } }';
  const order = {
    lineItems: items.map((item) => ({ variantId: item.variantId, quantity: item.quantity, requiresShipping: true })),
    financialStatus: 'PENDING',
    phone: customer.phone,
    customer: {
      toUpsert: {
        firstName,
        lastName,
        phone: customer.phone,
        addresses: [{ ...customerAddress, country: 'Georgia' }]
      }
    },
    shippingAddress: { ...customerAddress, countryCode: 'GE' },
    note: 'AERIS ' + paymentMethod.toUpperCase() + ' order. External reference: ' + orderId,
    sourceIdentifier: orderId,
    tags: ['AERIS', paymentMethod.toUpperCase()]
  };

  const { data } = await (await adminClient()).post('/graphql.json', { query: mutation, variables: { order } });
  if (data.errors?.length) {
    const error = new Error('Shopify order creation failed: ' + data.errors.map((item) => item.message).join('; '));
    error.statusCode = 502;
    throw error;
  }

  const payload = data.data?.orderCreate;
  if (payload?.userErrors?.length) {
    const error = new Error('Shopify rejected the order: ' + payload.userErrors.map((item) => item.message).join('; '));
    error.statusCode = 502;
    throw error;
  }
  if (!payload?.order) {
    const error = new Error('Shopify did not return the created order');
    error.statusCode = 502;
    throw error;
  }
  return payload.order;
}
