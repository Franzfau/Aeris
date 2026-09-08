// Server-only operator commands. Never expose merchant confirmation to the storefront.
import 'dotenv/config';
import { tbc } from './providers/tbc.js';

const [command, orderId, acknowledgement] = process.argv.slice(2);
let db;
try {
  if (command === 'auth-check') {
    console.log(JSON.stringify(await tbc.checkAuthentication()));
  } else if (['status', 'confirm'].includes(command) && /^[0-9a-f-]{36}$/i.test(orderId || '')) {
    ({ db } = await import('./db/client.js'));
    const result = await db.query("SELECT * FROM orders WHERE id = $1 AND bank = 'tbc'", [orderId]);
    const order = result.rows[0];
    if (!order?.provider_order_id || order.tbc_environment !== tbc.environment()) throw Error('Order not found in current TBC environment');
    if (command === 'confirm') {
      if (acknowledgement !== '--stock-verified') throw Error('Check availability, then pass --stock-verified');
      const confirmation = await tbc.confirm({ providerOrderId: order.provider_order_id, stockVerified: true });
      await db.query("UPDATE orders SET tbc_next_poll_at = NOW() WHERE id = $1 AND bank = 'tbc'", [orderId]);
      console.log(JSON.stringify(confirmation));
    } else console.log(JSON.stringify(await tbc.getStatus({ providerOrderId: order.provider_order_id })));
  } else throw Error('Use: node src/tbc-operator.js auth-check | status ORDER_UUID | confirm ORDER_UUID --stock-verified');
} catch (error) { console.error(error.message); process.exitCode = 1; }
finally { if (db) await db.end(); }
