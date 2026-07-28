import axios from 'axios';
import { config } from './config.js';

async function adminClient() {
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
  return axios.create({
    baseURL: `https://${config.shopify.storeDomain}/admin/api/${config.shopify.apiVersion}`,
    headers: { 'X-Shopify-Access-Token': tokenResponse.data.access_token, 'Content-Type': 'application/json' },
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
