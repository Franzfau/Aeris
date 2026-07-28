import axios from 'axios';
// Kept separate from the main config so this optional dashboard integration
// can be added to an already-deployed service without changing core startup settings.
const airtableConfig = {
  token: process.env.AIRTABLE_API_TOKEN,
  baseId: process.env.AIRTABLE_BASE_ID,
  tableId: process.env.AIRTABLE_TABLE_ID
};

const STATUS_LABELS = {
  pending: 'მიმდინარეობს',
  redirected: 'მიმდინარეობს',
  approved: 'დამტკიცებულია',
  declined: 'უარყოფილია',
  failed: 'უარყოფილია',
  cancelled: 'უარყოფილია'
};

function enabled() {
  return Boolean(airtableConfig.token && airtableConfig.baseId && airtableConfig.tableId);
}

function client() {
  return axios.create({
    baseURL: `https://api.airtable.com/v0/${airtableConfig.baseId}/${airtableConfig.tableId}`,
    headers: {
      Authorization: `Bearer ${airtableConfig.token}`,
      'Content-Type': 'application/json'
    },
    timeout: 15_000
  });
}

function fieldsFor(order) {
  const customer = order.customer || {};
  const fields = {
    'პროდუქტები და ზომები': order.items.map((item) => `${item.title} × ${item.quantity}`).join(', '),
    'სულ თანხა': `${(order.totalMinor / 100).toFixed(2)} GEL`,
    'გადახდის მეთოდი': order.bank === 'cod' ? 'კურიერთან გადახდა' : order.bank === 'tbc' ? 'TBC განვადება' : `${order.bank.toUpperCase()} განვადება`,
    'სტატუსი': STATUS_LABELS[order.status] || 'მიმდინარეობს'
  };

  // These fields are added only when the buyer has supplied them in the checkout form.
  if (customer.name) fields['სახელი და გვარი'] = customer.name;
  if (customer.phone) fields['ტელეფონი'] = customer.phone;
  if (customer.address) fields['მისამართი'] = customer.address;
  return fields;
}

export async function createAirtableOrder(order) {
  if (!enabled()) return null;
  const response = await client().post('', { records: [{ fields: fieldsFor(order) }], typecast: true });
  return response.data.records?.[0]?.id || null;
}

export async function updateAirtableOrder(recordId, status) {
  if (!enabled() || !recordId) return;
  await client().patch(`/${recordId}`, { fields: { 'სტატუსი': STATUS_LABELS[status] || 'მიმდინარეობს' }, typecast: true });
}
