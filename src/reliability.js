import crypto from 'node:crypto';

export const RELIABILITY_REVISION = 'orders-2026-09-09-r1';
const hash = value => crypto.createHash('sha256').update(value).digest('hex');

export async function initializeReliability(db) {
  await db.query(`CREATE TABLE IF NOT EXISTS order_requests (
    key_hash TEXT PRIMARY KEY, request_hash TEXT NOT NULL,
    response_status INTEGER, response_body JSONB, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
  ALTER TABLE orders ADD COLUMN IF NOT EXISTS admin_sync_revision BIGINT NOT NULL DEFAULT 0;
  ALTER TABLE orders ADD COLUMN IF NOT EXISTS admin_synced_revision BIGINT NOT NULL DEFAULT 0;
  ALTER TABLE orders ADD COLUMN IF NOT EXISTS admin_retry_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
  CREATE OR REPLACE FUNCTION aeris_queue_admin_sync() RETURNS trigger AS $$
  BEGIN
    IF NEW.bank IN ('cod', 'transfer', 'bog') AND
       (NEW.bank = 'bog' OR NEW.shopify_order_name IS NOT NULL) THEN
      IF TG_OP = 'INSERT' THEN
        NEW.admin_sync_revision := 1;
      ELSIF NEW.status IS DISTINCT FROM OLD.status OR
            NEW.shopify_order_name IS DISTINCT FROM OLD.shopify_order_name THEN
        NEW.admin_sync_revision := OLD.admin_sync_revision + 1;
        NEW.admin_retry_at := NOW();
      END IF;
    END IF;
    RETURN NEW;
  END;
  $$ LANGUAGE plpgsql;
  DROP TRIGGER IF EXISTS aeris_admin_sync_queue ON orders;
  CREATE TRIGGER aeris_admin_sync_queue BEFORE INSERT OR UPDATE OF status, shopify_order_name
    ON orders FOR EACH ROW EXECUTE FUNCTION aeris_queue_admin_sync();`);
}

// Claim before any Shopify/bank side effect. A crashed/uncertain request stays
// claimed: never automatically create a second order to resolve uncertainty.
export function idempotencyMiddleware(db) {
  return async (req, res, next) => {
    if (req.method !== 'POST' || !['/api/orders/cod', '/api/orders/transfer', '/api/installments/start'].includes(req.path)) return next();
    const key = req.get('Idempotency-Key');
    if (!key) return next(); // compatibility with already-open older storefronts
    if (!/^[a-zA-Z0-9_-]{16,100}$/.test(key)) return res.status(400).json({ error: 'Invalid request key' });
    const keyHash = hash(req.path + ':' + key);
    const requestHash = hash(JSON.stringify(req.body));
    try {
      const claimed = await db.query('INSERT INTO order_requests (key_hash, request_hash) VALUES ($1,$2) ON CONFLICT DO NOTHING RETURNING key_hash', [keyHash, requestHash]);
      if (!claimed.rowCount) {
        const { rows } = await db.query('SELECT * FROM order_requests WHERE key_hash=$1', [keyHash]);
        const previous = rows[0];
        if (!previous || previous.request_hash !== requestHash) return res.status(409).json({ error: 'Request key conflict', code: 'REQUEST_CONFLICT' });
        if (previous.response_status) return res.status(previous.response_status).json(previous.response_body);
        return res.status(409).json({ error: 'Request is processing or needs verification', code: 'REQUEST_PENDING' });
      }
      const send = res.json.bind(res);
      res.json = body => {
        const status = res.statusCode;
        db.query('UPDATE order_requests SET response_status=$1,response_body=$2 WHERE key_hash=$3', [status, JSON.stringify(body), keyHash])
          .then(() => send(body))
          .catch(() => { res.status(503); send({ error: 'Please check order status before trying again', code: 'REQUEST_PENDING' }); });
        return res;
      };
      next();
    } catch (error) { next(error); }
  };
}

export async function syncQueuedOrder(db, sync, order) {
  const recordId = await sync(order);
  if (!recordId) throw new Error('Dashboard synchronization unavailable');
  // A newer status arriving during the HTTP request remains queued.
  await db.query(`UPDATE orders SET airtable_record_id=$1,
    admin_synced_revision=GREATEST(admin_synced_revision,$2) WHERE id=$3`,
  [recordId, order.admin_sync_revision, order.id]);
}

export function startAdminRetryWorker(db, sync) {
  let running = false;
  async function tick() {
    if (running) return;
    running = true;
    let connection;
    let locked = false;
    try {
      connection = await db.connect();
      const result = await connection.query('SELECT pg_try_advisory_lock(20260909, 41) AS locked');
      locked = result.rows[0].locked;
      if (!locked) return;
      const { rows } = await connection.query(`SELECT * FROM orders WHERE bank IN ('cod','transfer','bog')
        AND admin_sync_revision > admin_synced_revision AND admin_retry_at <= NOW()
        ORDER BY admin_retry_at LIMIT 10`);
      for (const order of rows) {
        try { await syncQueuedOrder(connection, sync, order); }
        catch (_) {
          await connection.query("UPDATE orders SET admin_retry_at=NOW()+INTERVAL '1 minute' WHERE id=$1", [order.id]);
          console.warn('Dashboard synchronization queued for retry:', order.id);
        }
      }
    } catch (_) { console.warn('Dashboard retry worker unavailable; will retry'); }
    finally {
      if (connection) {
        if (locked) await connection.query('SELECT pg_advisory_unlock(20260909, 41)').catch(() => {});
        connection.release();
      }
      running = false;
    }
  }
  const timer = setInterval(tick, 15_000);
  timer.unref();
  tick();
  return () => clearInterval(timer);
}
