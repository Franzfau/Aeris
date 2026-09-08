import { credo } from './providers/credo.js';

export async function initializeCredoSchema(db) {
  await db.query(`
    ALTER TABLE orders ADD COLUMN IF NOT EXISTS credo_merchant_id TEXT;
    ALTER TABLE orders ADD COLUMN IF NOT EXISTS credo_bank_status INTEGER;
    ALTER TABLE orders ADD COLUMN IF NOT EXISTS credo_terminal BOOLEAN NOT NULL DEFAULT FALSE;
    ALTER TABLE orders ADD COLUMN IF NOT EXISTS credo_sync_pending BOOLEAN NOT NULL DEFAULT FALSE;
    ALTER TABLE orders ADD COLUMN IF NOT EXISTS credo_next_poll_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
    CREATE INDEX IF NOT EXISTS orders_credo_poll_idx ON orders(credo_next_poll_at) WHERE bank = 'credo';
  `);
}

export function credoOrderFields(order) {
  const code = order.credo_bank_status;
  const label = ['declined', 'cancelled', 'failed'].includes(order.status) ? 'უარყოფილია'
    : [5, 12].includes(code) ? 'დამტკიცებულია'
    : code == null || [10, 11].includes(code) ? 'მომხმარებელი ავსებს' : 'განხილვაშია';
  const detail = code === 12 ? 'ხელშეკრულება ხელმოწერილია; მიწოდება დასადასტურებელია'
    : code === 5 ? 'დასრულებულია' : [3, 4].includes(code) ? 'წინასწარი დამტკიცება' : order.status;
  const fields = {
    'განვადების ბანკი': 'კრედო',
    'განვადების სტატუსი': label,
    'სტატუსის წყარო': `Credo API${code == null ? '' : ' (' + code + ')'} — ${detail}`,
    'ბოლო სტატუსის განახლება': new Date(order.updated_at || order.created_at).toISOString()
  };
  // Bank updates must not overwrite manual delivery, payment or customer edits.
  if (order.airtable_record_id) return fields;
  Object.assign(fields, {
    'შეკვეთის ნომერი': 'CREDO-' + order.id,
    'გადახდის მეთოდი': 'Credo განვადება',
    'სულ თანხა': (order.total_minor / 100).toFixed(2) + ' GEL',
    'შეკვეთის თარიღი': new Date(order.created_at).toISOString(),
    'პროდუქტები და ზომები': order.items.map(item =>
      `${item.title} × ${item.quantity} — ${(item.lineMinor / 100).toFixed(2)} GEL${item.productUrl ? ' — ' + item.productUrl : ''}`
    ).join(' | ')
  });
  for (const [key, field] of Object.entries({ name: 'სახელი და გვარი', phone: 'ტელეფონი', city: 'ქალაქი', address: 'ზუსტი მისამართი' })) {
    if (order.customer?.[key]) fields[field] = order.customer[key];
  }
  return fields;
}

export function createCredoAdminSync({ env = process.env, client } = {}) {
  return async order => {
    if (!env.AIRTABLE_API_TOKEN || !env.AIRTABLE_BASE_ID || !env.AIRTABLE_TABLE_ID) throw new Error('Credo dashboard sync is not configured');
    const http = client || (await import('axios')).default;
    const data = { records: [{ ...(order.airtable_record_id ? { id: order.airtable_record_id } : {}), fields: credoOrderFields(order) }], typecast: true };
    if (!order.airtable_record_id) data.performUpsert = { fieldsToMergeOn: ['შეკვეთის ნომერი'] };
    let response;
    try {
      response = await http.request({ method: 'PATCH',
        url: `https://api.airtable.com/v0/${env.AIRTABLE_BASE_ID}/${env.AIRTABLE_TABLE_ID}`,
        headers: { Authorization: 'Bearer ' + env.AIRTABLE_API_TOKEN, 'Content-Type': 'application/json' },
        data, timeout: 15_000, maxRedirects: 0, validateStatus: () => true
      });
    } catch { throw new Error('Credo dashboard sync could not be reached'); }
    const id = response.data?.records?.[0]?.id;
    if (response.status !== 200 || typeof id !== 'string' || !/^rec[a-zA-Z0-9]+$/.test(id)) throw new Error('Credo dashboard sync failed (HTTP ' + response.status + ')');
    return id;
  };
}

export async function pollCredoOrder({ db, provider, sync, order }) {
  if (order.credo_merchant_id !== provider.merchantId()) return;
  if (!order.credo_terminal && order.provider_order_id) {
    try {
      const event = await provider.getStatus({ providerOrderId: order.provider_order_id, createdAt: order.created_at });
      if (event.waiting) {
        await db.query("UPDATE orders SET credo_next_poll_at = NOW() + ($1 * INTERVAL '1 millisecond') WHERE id = $2 AND bank = 'credo'", [event.retryAfterMs, order.id]);
      } else {
        await db.query('BEGIN');
        let updated;
        try {
          updated = await db.query(`UPDATE orders SET status = $1, credo_bank_status = $2,
            credo_terminal = $3, credo_sync_pending = credo_sync_pending OR credo_bank_status IS DISTINCT FROM $2,
            credo_next_poll_at = NOW() + INTERVAL '5 minutes', updated_at = CASE
              WHEN credo_bank_status IS DISTINCT FROM $2 THEN NOW() ELSE updated_at END
            WHERE id = $4 AND bank = 'credo' RETURNING *`, [event.status, event.bankStatus, event.terminal, order.id]);
          if (updated.rows[0] && order.credo_bank_status !== event.bankStatus) {
            await db.query('INSERT INTO order_events (order_id, source, event_type, payload) VALUES ($1, $2, $3, $4)',
              [order.id, 'credo', event.stage, JSON.stringify({ bankStatus: event.bankStatus, stage: event.stage })]);
          }
          await db.query('COMMIT');
        } catch (error) { await db.query('ROLLBACK'); throw error; }
        if (!updated.rows[0]) return;
        order = updated.rows[0];
      }
    } catch (error) {
      await db.query("UPDATE orders SET credo_next_poll_at = NOW() + INTERVAL '5 minutes' WHERE id = $1 AND bank = 'credo'", [order.id]);
      console.error('Credo status check failed:', error.message);
    }
  }
  if (order.credo_sync_pending || !order.airtable_record_id) {
    try {
      const recordId = await sync(order);
      await db.query(`UPDATE orders SET airtable_record_id = $1, credo_sync_pending = FALSE
        WHERE id = $2 AND bank = 'credo' AND credo_bank_status IS NOT DISTINCT FROM $3`, [recordId, order.id, order.credo_bank_status]);
    } catch (error) {
      await db.query("UPDATE orders SET credo_sync_pending = TRUE, credo_next_poll_at = NOW() + INTERVAL '5 minutes' WHERE id = $1 AND bank = 'credo'", [order.id]);
      console.error('Credo dashboard sync pending retry:', error.message);
    }
  }
}

export function startCredoWorker({ db, provider = credo, sync = createCredoAdminSync(), env = process.env } = {}) {
  let stopped = false;
  let timer;
  async function tick() {
    let conn;
    let locked = false;
    try {
      if (!provider.isConfigured() || env.CREDO_STATUS_POLLING === 'false') return;
      conn = await db.connect();
      locked = (await conn.query('SELECT pg_try_advisory_lock(734192504) AS locked')).rows[0].locked;
      if (!locked) return;
      const result = await conn.query(`SELECT * FROM orders WHERE bank = 'credo'
        AND credo_merchant_id = $1 AND credo_next_poll_at <= NOW()
        AND ((provider_order_id IS NOT NULL AND NOT credo_terminal) OR credo_sync_pending)
        ORDER BY credo_next_poll_at LIMIT 20`, [provider.merchantId()]);
      for (const order of result.rows) {
        if (stopped) break;
        await pollCredoOrder({ db: conn, provider, sync, order });
      }
    } catch (error) { console.error('Credo status worker failed:', error.message); }
    finally {
      if (conn) {
        let discard = false;
        if (locked) try { await conn.query('SELECT pg_advisory_unlock(734192504)'); } catch { discard = true; }
        conn.release(discard);
      }
      if (!stopped) { timer = setTimeout(tick, 30_000); timer.unref?.(); }
    }
  }
  timer = setTimeout(tick, 5_000);
  timer.unref?.();
  return () => { stopped = true; clearTimeout(timer); };
}
