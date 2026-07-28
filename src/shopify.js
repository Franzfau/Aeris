import axios from 'axios';
import { config } from './config.js';

async function adminClient() {
  const tokenResponse = await axios.post(
    `https://${config.shopify.storeDomain}/admin/oauth/access_token`,
    {
      client_id: config.shopify.clientId,
      client_secret: config.shopify.clientSecret,
      grant_type: 'client_credentials'
    },
    { timeout: 15_000 }
  );
  return axios.create({
    baseURL: `https://${config.shopify.storeDomain}/admin/api/${config.shopify.apiVersion}`,
    headers: { 'X-Shopify-Access-Token': tokenResponse.data.access_token, 'Content-Type': 'application/json' },
    timeout: 15_000
  });
}

export async function resolveCart(items) {
  const ids = items.map((item) => item.variantId);
  const query = `query variants($ids: [ID!]!) { nodes(ids: $ids) { ... on ProductVariant { id title price { amount currencyCode } product { title } } } }`;
  const { data } = await (await adminClient()).post('/graphql.json', { query, variables: { ids } });
  if (data.errors?.length) throw new Error('Shopify product lookup failed');
  if (data.data.nodes.some((node) => !node)) throw new Error('One or more variants do not exist');

  return data.data.nodes.map((variant, index) => {
    const quantity = items[index].quantity;
    if (variant.price.currencyCode !== 'GEL') throw new Error('Only GEL variants can be financed');
    const unitMinor = Math.round(Number(variant.price.amount) * 100);
    return { variantId: variant.id, title: `${variant.product.title} — ${variant.title}`, quantity, unitMinor, lineMinor: unitMinor * quantity };
  });
}
