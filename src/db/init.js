import { db } from './client.js';

await db.query(`
  CREATE TABLE IF NOT EXISTS orders (
    id UUID PRIMARY KEY,
    bank TEXT NOT NULL CHECK (bank IN ('tbc', 'bog', 'credo', 'keepz')),
    status TEXT NOT NULL CHECK (status IN ('pending', 'redirected', 'approved', 'declined', 'failed', 'cancelled')),
    currency CHAR(3) NOT NULL DEFAULT 'GEL',
    total_minor INTEGER NOT NULL CHECK (total_minor > 0),
    items JSONB NOT NULL,
    customer JSONB NOT NULL,
    provider_order_id TEXT UNIQUE,
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
`);
await db.end();
console.log('Database schema ready.');
