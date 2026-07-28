import 'dotenv/config';

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

export const config = {
  port: Number(process.env.PORT || 3000),
  publicApiUrl: required('PUBLIC_API_URL').replace(/\/$/, ''),
  databaseUrl: required('DATABASE_URL'),
  allowedOrigins: (process.env.ALLOWED_ORIGINS || '').split(',').map((x) => x.trim()).filter(Boolean),
  shopify: {
    storeDomain: required('SHOPIFY_STORE_DOMAIN'),
    clientId: required('SHOPIFY_CLIENT_ID'),
    clientSecret: required('SHOPIFY_CLIENT_SECRET'),
    apiVersion: process.env.SHOPIFY_API_VERSION || '2026-07'
  },
  // Optional operational dashboard sync. Keep these values only in Render.
  airtable: {
    token: process.env.AIRTABLE_API_TOKEN,
    baseId: process.env.AIRTABLE_BASE_ID,
    tableId: process.env.AIRTABLE_TABLE_ID
  }
};
