import { tbc } from './providers/tbc.js';
import { tbcStatusFields } from './tbc-status.js';

export async function initializeTbcSchema(db) {
  await db.query(`
    ALTER TABLE orders ADD COLUMN IF NOT EXISTS tbc_environment TEXT;
    ALTER TABLE orders ADD COLUMN IF NOT EXISTS tbc_bank_status INTEGER;
    ALTER TABLE orders ADD COLUMN IF NOT EXISTS tbc_terminal BOOLEAN NOT NULL DEFAULT FALSE;
    ALTER TABLE orders ADD COLUMN IF NOT EXISTS tbc_sync_pending BOOLEAN NOT NULL DEFAULT FALSE;
    ALTER TABLE orders ADD COLUMN IF NOT EXISTS tbc_next_poll_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
    CREATE INDEX IF NOT EXISTS orders_tbc_poll_idx ON orders(tbc_next_poll_at) WHERE bank = 'tbc';
  `);
}

export function tbcOrderFields(order, now = new Date()) {
  const fields = tbcStatusFields(order.status, { now });
  if (order.airtable_record_id) return fields;
  // Full UUID is an idempotency key: a timeout cannot create a duplicate dashboard order.
  Object.assign(fields, {
    'შეკვეთის ნომერი': 'TBC-' + order.id,
    'გადახდის მეთოდი': 'TBC განვადება',
    'სულ თანხა': (order.total_minor / 100).toFixed(2) + ' GEL',
    'შეკვეთის თარიღი': new Date(order.created_at).toISOString(),
    'პროდუქტები და ზომები': order.items.map((item) =>
      `${item.title} × ${item.quantity} — ${(item.lineMinor / 100).toFixed(2)} GEL${item.productUrl ? ' — ' + item.productUrl : ''}`
    ).join(' | ')
  });
  const customer = order.customer || {};
  for (const [key, field] of Object.entries({ name: 'სახელი და გვარი', phone: 'ტელეფონი', city: 'ქალაქი', address: 'ზუსტი მისამართი' })) {
    if (customer[key]) fields[field] = customer[key];
  }
  return fields;
}

export function createTbcAdminSync({ env = process.env, client } = {}) {
  return async function sync(order) {
    if (!env.AIRTABLE_API_TOKEN || !env.AIRTABLE_BASE_ID || !env.AIRTABLE_TABLE_ID) {
      throw new Error('TBC dashboard sync is not configured');
    }
    const http = client || (await import('axios')).default;
    const fields = tbcOrderFields(order);
    const data = { records: [{ ...(order.airtable_record_id ? { id: order.airtable_record_id } : {}), fields }], typecast: true };
    if (!order.airtable_record_id) data.performUpsert = { fieldsToMergeOn: ['შეკვეთის ნომერი'] };
    let response;
    try {
      response = await http.request({ method: 'PATCH',
        url: `https://api.airtable.com/v0/${env.AIRTABLE_BASE_ID}/${env.AIRTABLE_TABLE_ID}`,
        headers: { Authorization: 'Bearer ' + env.AIRTABLE_API_TOKEN, 'Content-Type': 'application/json' },
        data, timeout: 15_000, maxRedirects: 0, validateStatus: () => true
      });
    } catch { throw new Error('TBC dashboard sync could not be reached'); }
    const id = response.data?.records?.[0]?.id;
    if (response.status !== 200 || typeof id !== 'string' || !/^rec[a-zA-Z0-9]+$/.test(id)) {
      throw new Error('TBC dashboard sync failed (HTTP ' + response.status + ')');
    }
    return id;
  };
}

export async function pollTbcOrder({ db, provider, sync, order }) {
  // Never use production credentials for a test order, or guess legacy order environments.
  if (order.tbc_environment !== provider.environment()) return;
  if (!order.tbc_terminal && order.provider_order_id) {
    try {
      const event = await provider.getStatus({ providerOrderId: order.provider_order_id });
      await db.query('BEGIN');
      let updated;
      try {
      updated = await db.query(`UPDATE orders SET status = $1, tbc_bank_status = $2,
        tbc_terminal = $3, tbc_sync_pending = tbc_sync_pending OR tbc_bank_status IS DISTINCT FROM $2,
        tbc_next_poll_at = NOW() + INTERVAL '60 seconds', updated_at = CASE
          WHEN tbc_bank_status IS DISTINCT FROM $2 THEN NOW() ELSE updated_at END
        WHERE id = $4 AND bank = 'tbc' RETURNING *`, [event.status, event.bankStatus, event.terminal, order.id]);
      if (updated.rows[0] && order.tbc_bank_status !== event.bankStatus) {
        await db.query('INSERT INTO order_events (order_id, source, event_type, payload) VALUES ($1, $2, $3, $4)',
          [order.id, 'tbc', event.stage, JSON.stringify({ bankStatus: event.bankStatus, stage: event.stage })]);
      }
      await db.query('COMMIT');
      } catch (error) { await db.query('ROLLBACK'); throw error; }
      if (!updated.rows[0]) return;
      order = updated.rows[0];
    } catch (error) {
      await db.query("UPDATE orders SET tbc_next_poll_at = NOW() + INTERVAL '5 minutes' WHERE id = $1 AND bank = 'tbc'", [order.id]);
      console.error('TBC status check failed:', error.message);
      // Still retry a pending dashboard sync even while the bank API is unavailable.
    }
  }
  if (order.tbc_sync_pending || !order.airtable_record_id) {
    try {
      const recordId = await sync(order);
      await db.query(`UPDATE orders SET airtable_record_id = $1, tbc_sync_pending = FALSE
        WHERE id = $2 AND bank = 'tbc' AND tbc_bank_status IS NOT DISTINCT FROM $3`,
      [recordId, order.id, order.tbc_bank_status]);
    } catch (error) {
      await db.query("UPDATE orders SET tbc_sync_pending = TRUE, tbc_next_poll_at = NOW() + INTERVAL '5 minutes' WHERE id = $1 AND bank = 'tbc'", [order.id]);
      console.error('TBC dashboard sync pending retry:', error.message);
    }
  }
}

export function startTbcWorker({ db, provider = tbc, sync = createTbcAdminSync(), env = process.env } = {}) {
  let stopped = false;
  let timer;
  async function tick() {
    let conn;
    let locked = false;
    try {
      if (!provider.isConfigured() || env.TBC_STATUS_POLLING === 'false') return;
      conn = await db.connect();
      // Session advisory lock prevents overlapping workers across Render instances.
      const lock = await conn.query('SELECT pg_try_advisory_lock(734190529) AS locked');
      locked = lock.rows[0].locked;
      if (!locked) return;
      const result = await conn.query(`SELECT * FROM orders WHERE bank = 'tbc'
        AND tbc_environment = $1 AND tbc_next_poll_at <= NOW()
        AND ((provider_order_id IS NOT NULL AND NOT tbc_terminal) OR tbc_sync_pending)
        ORDER BY tbc_next_poll_at LIMIT 20`, [provider.environment()]);
      for (const order of result.rows) {
        if (stopped) break;
        await pollTbcOrder({ db: conn, provider, sync, order });
      }
    } catch (error) { console.error('TBC status worker failed:', error.message); }
    finally {
      if (conn) {
        let discard = false;
        if (locked) try { await conn.query('SELECT pg_advisory_unlock(734190529)'); } catch { discard = true; }
        conn.release(discard);
      }
      if (!stopped) { timer = setTimeout(tick, 30_000); timer.unref?.(); }
    }
  }
  timer = setTimeout(tick, 5_000);
  timer.unref?.();
  return () => { stopped = true; clearTimeout(timer); };
}
