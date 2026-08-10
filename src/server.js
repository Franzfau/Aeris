import crypto from 'node:crypto';
import cors from 'cors';
import express from 'express';
import helmet from 'helmet';
import { z } from 'zod';
import { config } from './config.js';
import { createAirtableOrder, updateAirtableOrder } from './airtable.js';
import { db } from './db/client.js';
import { providerFor } from './providers/index.js';
import { createShopifyOrder, resolveCart } from './shopify.js';

function normalizeGeorgianPhone(value) {
  const digits = value.replace(/\D/g, '');

  if (/^9955\d{8}$/.test(digits)) return `+${digits}`;
  if (/^05\d{8}$/.test(digits)) return `+995${digits.slice(1)}`;
  if (/^5\d{8}$/.test(digits)) return `+995${digits}`;

  return value;
}

const georgianPhoneSchema = z.string()
  .trim()
  .min(6)
  .max(30)
  .transform(normalizeGeorgianPhone)
  .refine((value) => /^\+9955\d{8}$/.test(value), {
    message: 'Enter a valid Georgian mobile number'
  });


const startSchema = z.object({
  bank: z.enum(['tbc', 'bog', 'credo', 'keepz']),
  items: z.array(z.object({ variantId: z.string().min(1), quantity: z.number().int().min(1).max(20) })).min(1).max(20),
  // Customer details are optional at initiation. TBC collects the applicant's details on its own protected page.
  customer: z.object({
    name: z.string().trim().min(2).max(120).optional(),
    phone: georgianPhoneSchema.optional(),
    address: z.string().trim().min(4).max(300).optional()
  }).optional().default({})
});


const codSchema = z.object({
  items: z.array(z.object({ variantId: z.string().min(1), quantity: z.number().int().min(1).max(20) })).min(1).max(20),
  customer: z.object({
    name: z.string().trim().min(2).max(120),
    phone: georgianPhoneSchema,
    city: z.string().trim().min(2).max(100),
    address: z.string().trim().min(4).max(300)
  })
});


const transferSchema = codSchema;


const app = express();
app.use(helmet());
app.use(cors({ origin(origin, callback) { if (!origin || config.allowedOrigins.includes(origin)) return callback(null, true); callback(new Error('Origin not allowed')); } }));
app.use(express.json({ limit: '100kb' }));


app.get('/', (_, res) => res.json({ ok: true, service: 'Aeris payments backend' }));
app.get('/health', (_, res) => res.json({ ok: true }));

async function createAndAttachShopifyOrder({ orderId, paymentMethod, items, customer }) {
  try {
    const shopifyOrder = await createShopifyOrder({ orderId, paymentMethod, items, customer });
    await db.query(
      'UPDATE orders SET shopify_order_id = $1, shopify_order_name = $2, updated_at = NOW() WHERE id = $3',
      [shopifyOrder.id, shopifyOrder.name, orderId]
    );
    return shopifyOrder;
  } catch (error) {
    await db.query("UPDATE orders SET status = 'failed', updated_at = NOW() WHERE id = $1", [orderId]).catch(() => {});
    throw error;
  }
}


app.post('/api/orders/cod', async (req, res, next) => {
  try {
    const request = codSchema.parse(req.body);
    // The browser sends only a Shopify variant ID and quantity. Product prices are re-read from Shopify.
    const items = await resolveCart(request.items);
    const totalMinor = items.reduce((sum, item) => sum + item.lineMinor, 0);
    const orderId = crypto.randomUUID();
    await db.query('INSERT INTO orders (id, bank, status, total_minor, items, customer) VALUES ($1, $2, $3, $4, $5, $6)', [orderId, 'cod', 'pending', totalMinor, JSON.stringify(items), JSON.stringify(request.customer)]);
    const shopifyOrder = await createAndAttachShopifyOrder({ orderId, paymentMethod: 'cod', items, customer: request.customer });
    try {
      const airtableRecordId = await createAirtableOrder({ ...request, orderId, bank: 'cod', items, totalMinor, status: 'pending', shopifyOrder });
      if (airtableRecordId) await db.query('UPDATE orders SET airtable_record_id = $1 WHERE id = $2', [airtableRecordId, orderId]);
    } catch (syncError) {
      console.error('Airtable COD sync failed:', syncError.message);
    }
    sendMetaPurchaseEvent(req, { orderId, items, totalMinor, customer: request.customer }).catch((metaError) => {
      console.error('Meta CAPI sync failed:', metaError.message);
    });
    res.status(201).json({ orderId, status: 'pending', shopifyOrderId: shopifyOrder.id, shopifyOrderName: shopifyOrder.name });
  } catch (error) { next(error); }
});


app.post('/api/orders/transfer', async (req, res, next) => {
  try {
    const request = transferSchema.parse(req.body);
    const items = await resolveCart(request.items);
    const totalMinor = items.reduce((sum, item) => sum + item.lineMinor, 0);
    const orderId = crypto.randomUUID();
    await db.query('INSERT INTO orders (id, bank, status, total_minor, items, customer) VALUES ($1, $2, $3, $4, $5, $6)', [orderId, 'transfer', 'pending', totalMinor, JSON.stringify(items), JSON.stringify(request.customer)]);
    const shopifyOrder = await createAndAttachShopifyOrder({ orderId, paymentMethod: 'transfer', items, customer: request.customer });
    try {
      const airtableRecordId = await createAirtableOrder({ ...request, orderId, bank: 'transfer', items, totalMinor, status: 'pending', shopifyOrder });
      if (airtableRecordId) await db.query('UPDATE orders SET airtable_record_id = $1 WHERE id = $2', [airtableRecordId, orderId]);
    } catch (syncError) {
      console.error('Airtable transfer sync failed:', syncError.message);
    }
    res.status(201).json({ orderId, status: 'pending', shopifyOrderId: shopifyOrder.id, shopifyOrderName: shopifyOrder.name });
  } catch (error) { next(error); }
});


app.post('/api/orders/transfer/confirm', async (req, res, next) => {
  try {
    const orderId = z.string().uuid().parse(req.body?.orderId);
    const result = await db.query(
      "UPDATE orders SET status = 'verification_required', updated_at = NOW() WHERE id = $1 AND bank = 'transfer' AND status IN ('pending', 'verification_required') RETURNING airtable_record_id",
      [orderId]
    );
    if (!result.rowCount) return res.status(404).json({ error: 'Transfer order not found' });
    await updateAirtableOrder(result.rows[0].airtable_record_id, 'verification_required');
    res.json({ orderId, status: 'verification_required' });
  } catch (error) { next(error); }
});


app.post('/api/installments/start', async (req, res, next) => {
  try {
    const request = startSchema.parse(req.body);
    const items = await resolveCart(request.items); // prices come from Shopify, never the browser
    const totalMinor = items.reduce((sum, item) => sum + item.lineMinor, 0);
    const orderId = crypto.randomUUID();
    await db.query('INSERT INTO orders (id, bank, status, total_minor, items, customer) VALUES ($1, $2, $3, $4, $5, $6)', [orderId, request.bank, 'pending', totalMinor, JSON.stringify(items), JSON.stringify(request.customer)]);
    // Staging mode: save the application now. A contracted bank provider can later
    // return a verified redirectUrl without changing the Shopify form contract.
    try {
      const airtableRecordId = await createAirtableOrder({ ...request, orderId, items, totalMinor, status: 'pending' });
      if (airtableRecordId) await db.query('UPDATE orders SET airtable_record_id = $1 WHERE id = $2', [airtableRecordId, orderId]);
    } catch (syncError) {
      console.error('Airtable installment sync failed:', syncError.message);
    }
    res.status(201).json({ orderId, status: 'pending', redirectUrl: null });
  } catch (error) { next(error); }
});


app.post('/api/webhooks/:bank', async (req, res, next) => {
  try {
    const provider = providerFor(req.params.bank);
    if (!provider.verifyWebhook(req)) return res.sendStatus(401);
    const event = provider.parseWebhook(req.body);
    const result = await db.query('UPDATE orders SET status = $1, updated_at = NOW() WHERE provider_order_id = $2 AND status IN (\'pending\', \'redirected\') RETURNING id, airtable_record_id', [event.status, event.providerOrderId]);
    if (result.rowCount) {
      await db.query('INSERT INTO order_events (order_id, source, event_type, payload) VALUES ($1, $2, $3, $4)', [result.rows[0].id, req.params.bank, event.status, JSON.stringify(req.body)]);
      try { await updateAirtableOrder(result.rows[0].airtable_record_id, event.status); } catch (syncError) { console.error('Airtable status sync failed:', syncError.message); }
    }
    res.sendStatus(200); // idempotent: duplicate callbacks do not create a second order
  } catch (error) { next(error); }
});


function sha256(value) {
  return crypto.createHash('sha256').update(String(value).trim().toLowerCase()).digest('hex');
}

function getClientIp(req) {
  const forwarded = req.headers['x-forwarded-for'];
  if (typeof forwarded === 'string' && forwarded.length) return forwarded.split(',')[0].trim();
  if (Array.isArray(forwarded) && forwarded[0]) return forwarded[0].split(',')[0].trim();
  return req.headers['x-real-ip'] || req.socket?.remoteAddress || undefined;
}

function getCustomerNameParts(customer = {}) {
  const fullName = customer.name || customer.fullName || '';
  const parts = String(fullName).trim().split(/\s+/).filter(Boolean);
  return {
    firstName: customer.firstName || parts[0],
    lastName: customer.lastName || parts.slice(1).join(' ') || undefined
  };
}

async function sendMetaPurchaseEvent(req, { orderId, items, totalMinor, customer }) {
  const accessToken = process.env.META_CAPI_ACCESS_TOKEN;
  const pixelId = process.env.META_PIXEL_ID || '921615717643409';
  if (!accessToken || !pixelId) return;

  const { firstName, lastName } = getCustomerNameParts(customer);
  const phone = customer?.phone ? String(customer.phone).replace(/\D/g, '') : '';
  const userData = {
    client_ip_address: getClientIp(req),
    client_user_agent: req.headers['user-agent']
  };
  if (phone) userData.ph = [sha256(phone)];
  if (firstName) userData.fn = [sha256(firstName)];
  if (lastName) userData.ln = [sha256(lastName)];

  const event = {
    event_name: 'Purchase',
    event_time: Math.floor(Date.now() / 1000),
    event_id: orderId,
    action_source: 'website',
    event_source_url: req.headers.referer || req.headers.origin || 'https://aeris.ge/cart',
    user_data: userData,
    custom_data: {
      currency: 'GEL',
      value: Number((totalMinor / 100).toFixed(2)),
      content_type: 'product',
      content_ids: items.map((item) => String(item.variantId || item.productId || item.title)).filter(Boolean),
      contents: items.map((item) => ({
        id: String(item.variantId || item.productId || item.title),
        quantity: item.quantity,
        item_price: Number(((item.unitMinor || 0) / 100).toFixed(2))
      }))
    }
  };

  const body = { data: [event] };
  if (process.env.META_CAPI_TEST_EVENT_CODE) body.test_event_code = process.env.META_CAPI_TEST_EVENT_CODE;

  const response = await fetch('https://graph.facebook.com/v23.0/' + pixelId + '/events?access_token=' + encodeURIComponent(accessToken), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });

  if (!response.ok) {
    const message = await response.text();
    throw new Error('Meta CAPI responded with ' + response.status + ': ' + message);
  }
}

app.use((error, _req, res, _next) => {
  const status = error instanceof z.ZodError ? 400 : error.statusCode || 500;
  if (status >= 500) console.error(error.message);
  res.status(status).json({ error: status === 500 ? 'Internal server error' : error.message });
});


async function start() {
  // Safe to run on every deploy: every statement is idempotent.
  await db.query(`
    CREATE TABLE IF NOT EXISTS orders (
      id UUID PRIMARY KEY,
      bank TEXT NOT NULL CHECK (bank IN ('tbc', 'bog', 'credo', 'keepz', 'transfer', 'cod')),
      status TEXT NOT NULL CHECK (status IN ('pending', 'verification_required', 'redirected', 'approved', 'declined', 'failed', 'cancelled')),
      currency CHAR(3) NOT NULL DEFAULT 'GEL',
      total_minor INTEGER NOT NULL CHECK (total_minor > 0),
      items JSONB NOT NULL,
      customer JSONB NOT NULL,
      provider_order_id TEXT UNIQUE,
      airtable_record_id TEXT,
      shopify_order_id TEXT UNIQUE,
      shopify_order_name TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS order_events (
      id BIGSERIAL PRIMARY KEY,
      order_id UUID NOT NULL REFERENCES orders(id),
      source TEXT NOT NULL,
      event_type TEXT NOT NULL,
      payload JSONB NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS orders_provider_order_id_idx ON orders(provider_order_id);
    ALTER TABLE orders ADD COLUMN IF NOT EXISTS airtable_record_id TEXT;
    ALTER TABLE orders ADD COLUMN IF NOT EXISTS shopify_order_id TEXT;
    ALTER TABLE orders ADD COLUMN IF NOT EXISTS shopify_order_name TEXT;
    CREATE UNIQUE INDEX IF NOT EXISTS orders_shopify_order_id_idx ON orders(shopify_order_id) WHERE shopify_order_id IS NOT NULL;
    ALTER TABLE orders DROP CONSTRAINT IF EXISTS orders_bank_check;
    ALTER TABLE orders ADD CONSTRAINT orders_bank_check CHECK (bank IN ('tbc', 'bog', 'credo', 'keepz', 'transfer', 'cod'));
    ALTER TABLE orders DROP CONSTRAINT IF EXISTS orders_status_check;
    ALTER TABLE orders ADD CONSTRAINT orders_status_check CHECK (status IN ('pending', 'verification_required', 'redirected', 'approved', 'declined', 'failed', 'cancelled'));
  `);
  app.listen(config.port, () => console.log(`Listening on ${config.port}`));
}


start().catch((error) => {
  console.error('Database initialization failed:', error.message);
  process.exit(1);
});
