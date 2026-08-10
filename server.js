import crypto from 'node:crypto';
import cors from 'cors';
import express from 'express';
import helmet from 'helmet';
import { z } from 'zod';
import { config } from './config.js';
import { createAirtableOrder, updateAirtableOrder } from './airtable.js';
import { db } from './db/client.js';
import { providerFor } from './providers/index.js';
import { resolveCart } from './shopify.js';


const startSchema = z.object({
  bank: z.enum(['tbc', 'bog', 'credo', 'keepz']),
  items: z.array(z.object({ variantId: z.string().min(1), quantity: z.number().int().min(1).max(20) })).min(1).max(20),
  // Customer details are optional at initiation. TBC collects the applicant's details on its own protected page.
  customer: z.object({
    name: z.string().trim().min(2).max(120).optional(),
    phone: z.string().trim().min(6).max(30).optional(),
    address: z.string().trim().min(4).max(300).optional()
  }).optional().default({})
});


const codSchema = z.object({
  items: z.array(z.object({ variantId: z.string().min(1), quantity: z.number().int().min(1).max(20) })).min(1).max(20),
  customer: z.object({
    name: z.string().trim().min(2).max(120),
    phone: z.string().trim().min(6).max(30),
    address: z.string().trim().min(4).max(300)
  })
});


const app = express();
app.use(helmet());
app.use(cors({ origin(origin, callback) { if (!origin || config.allowedOrigins.includes(origin)) return callback(null, true); callback(new Error('Origin not allowed')); } }));
app.use(express.json({ limit: '100kb' }));


app.get('/', (_, res) => res.json({ ok: true, service: 'Aeris payments backend' }));
app.get('/health', (_, res) => res.json({ ok: true }));


app.post('/api/orders/cod', async (req, res, next) => {
  try {
    const request = codSchema.parse(req.body);
    // The browser sends only a Shopify variant ID and quantity. Product prices are re-read from Shopify.
    const items = await resolveCart(request.items);
    const totalMinor = items.reduce((sum, item) => sum + item.lineMinor, 0);
    const orderId = crypto.randomUUID();
    await db.query('INSERT INTO orders (id, bank, status, total_minor, items, customer) VALUES ($1, $2, $3, $4, $5, $6)', [orderId, 'cod', 'pending', totalMinor, JSON.stringify(items), JSON.stringify(request.customer)]);
    try {
      const airtableRecordId = await createAirtableOrder({ ...request, orderId, bank: 'cod', items, totalMinor, status: 'pending' });
      if (airtableRecordId) await db.query('UPDATE orders SET airtable_record_id = $1 WHERE id = $2', [airtableRecordId, orderId]);
    } catch (syncError) {
      console.error('Airtable COD sync failed:', syncError.message);
    }
    sendMetaPurchaseEvent(req, { orderId, items, totalMinor, customer: request.customer }).catch((metaError) => {
      console.error('Meta CAPI sync failed:', metaError.message);
    });
    res.status(201).json({ orderId, status: 'pending' });
  } catch (error) { next(error); }
});


app.post('/api/installments/start', async (req, res, next) => {
  try {
    const request = startSchema.parse(req.body);
    const items = await resolveCart(request.items); // prices come from Shopify, never the browser
    const totalMinor = items.reduce((sum, item) => sum + item.lineMinor, 0);
    const orderId = crypto.randomUUID();
    await db.query('INSERT INTO orders (id, bank, status, total_minor, items, customer) VALUES ($1, $2, $3, $4, $5, $6)', [orderId, request.bank, 'pending', totalMinor, JSON.stringify(items), JSON.stringify(request.customer)]);
    const result = await providerFor(request.bank).initiate({ orderId, items, totalMinor, customer: request.customer, callbackUrl: `${config.publicApiUrl}/api/webhooks/${request.bank}` });
    await db.query("UPDATE orders SET status = 'redirected', provider_order_id = $1, updated_at = NOW() WHERE id = $2", [result.providerOrderId, orderId]);
    // Airtable/Softr is an operational view only. A sync failure must never stop a bank application.
    try {
      const airtableRecordId = await createAirtableOrder({ ...request, orderId, items, totalMinor, status: 'redirected' });
      if (airtableRecordId) await db.query('UPDATE orders SET airtable_record_id = $1 WHERE id = $2', [airtableRecordId, orderId]);
    } catch (syncError) {
      console.error('Airtable order sync failed:', syncError.message);
    }
    res.status(201).json({ orderId, redirectUrl: result.redirectUrl });
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


async function sendMetaPurchaseEvent(req, { orderId, items, totalMinor, customer }) {
  const token = process.env.META_CAPI_ACCESS_TOKEN;
  if (!token) return;

  const pixelId = process.env.META_PIXEL_ID || '921615717643409';
  const endpoint = 'https://graph.facebook.com/v23.0/' + encodeURIComponent(pixelId) + '/events?access_token=' + encodeURIComponent(token);
  const normalizedName = String(customer.name || '').trim().toLocaleLowerCase('ka-GE').replace(/\s+/g, ' ');
  const [firstName = '', ...lastNameParts] = normalizedName.split(' ');
  const phone = normalizeMetaPhone(customer.phone);
  const userData = {
    client_ip_address: String(req.headers['cf-connecting-ip'] || req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.ip,
    client_user_agent: req.get('user-agent')
  };
  if (phone.length >= 7) userData.ph = [sha256Hex(phone)];
  if (firstName.length > 1) userData.fn = [sha256Hex(firstName)];
  const lastName = lastNameParts.join(' ');
  if (lastName.length > 1) userData.ln = [sha256Hex(lastName)];

  const payload = {
    data: [{
      event_name: 'Purchase',
      event_time: Math.floor(Date.now() / 1000),
      event_id: orderId,
      action_source: 'website',
      event_source_url: safeMetaSourceUrl(req.get('referer')) || 'https://aeris.ge/cart',
      user_data: stripEmpty(userData),
      custom_data: {
        currency: 'GEL',
        value: Number((totalMinor / 100).toFixed(2)),
        content_type: 'product',
        content_ids: items.map((item) => String(item.variantId)),
        contents: items.map((item) => ({
          id: String(item.variantId),
          quantity: item.quantity,
          item_price: Number((item.unitMinor / 100).toFixed(2))
        })),
        num_items: items.reduce((sum, item) => sum + item.quantity, 0)
      }
    }]
  };
  if (process.env.META_CAPI_TEST_EVENT_CODE) payload.test_event_code = process.env.META_CAPI_TEST_EVENT_CODE;

  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload)
  });
  if (!response.ok) throw new Error('Meta CAPI returned ' + response.status + ': ' + (await response.text()).slice(0, 500));
}

function normalizeMetaPhone(value) {
  return String(value || '').replace(/\D/g, '');
}

function sha256Hex(value) {
  return crypto.createHash('sha256').update(String(value).trim().toLowerCase()).digest('hex');
}

function safeMetaSourceUrl(value) {
  try {
    const url = new URL(String(value || ''));
    return url.protocol === 'https:' && ['aeris.ge', 'www.aeris.ge'].includes(url.hostname) ? url.href.slice(0, 2048) : '';
  } catch (_) {
    return '';
  }
}

function stripEmpty(value) {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry));
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
      bank TEXT NOT NULL CHECK (bank IN ('tbc', 'bog', 'credo', 'keepz', 'cod')),
      status TEXT NOT NULL CHECK (status IN ('pending', 'redirected', 'approved', 'declined', 'failed', 'cancelled')),
      currency CHAR(3) NOT NULL DEFAULT 'GEL',
      total_minor INTEGER NOT NULL CHECK (total_minor > 0),
      items JSONB NOT NULL,
      customer JSONB NOT NULL,
      provider_order_id TEXT UNIQUE,
      airtable_record_id TEXT,
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
    ALTER TABLE orders DROP CONSTRAINT IF EXISTS orders_bank_check;
    ALTER TABLE orders ADD CONSTRAINT orders_bank_check CHECK (bank IN ('tbc', 'bog', 'credo', 'keepz', 'cod'));
  `);
  app.listen(config.port, () => console.log(`Listening on ${config.port}`));
}


start().catch((error) => {
  console.error('Database initialization failed:', error.message);
  process.exit(1);
});
