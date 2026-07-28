# Shopify installment backend starter

This project is a secure base for TBC, Bank of Georgia, Credo, and Keepz installment integrations. It deliberately contains **no credentials** and does not copy the legacy provider requests, because the shared legacy credentials must be rotated and each bank's current contract documentation must be followed.

## Where the database lives

Create a **Render PostgreSQL** database. In Render, copy its Internal Database URL into `DATABASE_URL` for the web service. That keeps traffic private within Render and stores orders independently of the running server.

The database stores:

- `orders`: immutable server-calculated GEL totals and lifecycle status;
- `order_events`: webhook/callback audit trail, useful for support and fraud investigation.

## Local start

1. Copy `.env.example` to `.env` and fill only newly issued credentials. For Shopify, create a new custom app and use its Client ID and Client secret; do not use a legacy Admin API token.
2. Run `npm install`.
3. Run `npm run db:init`.
4. Run `npm run dev`.

## Render deployment

Create a Web Service from this directory:

- Build command: `npm install`
- Start command: `npm start`
- Add the variables from `.env.example` in Render's Environment page, never in GitHub.
- Add a Render PostgreSQL database and set `DATABASE_URL` to its Internal Database URL.

## Frontend request

The Shopify theme must send variant IDs and quantities only; never a price.

```js
const response = await fetch('https://YOUR-API/api/installments/start', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    bank: 'tbc',
    items: [{ variantId: 'gid://shopify/ProductVariant/123', quantity: 1 }],
    customer: { name: 'სახელი გვარი', phone: '+9955XXXXXXXX' }
  })
});
const { redirectUrl } = await response.json();
window.location.assign(redirectUrl);
```

## Before enabling a bank

Implement the bank's current `initiate()` request in `src/providers/` from its official integration guide and validate the provider's callback signature in `verifyWebhook()`. Do not mark an order paid from a browser return URL. Only a verified server-to-server callback may do that.
