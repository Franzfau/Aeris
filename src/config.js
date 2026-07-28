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
    adminAccessToken: required('SHOPIFY_ADMIN_ACCESS_TOKEN'),
    apiVersion: process.env.SHOPIFY_API_VERSION || '2025-10'
  }
};
