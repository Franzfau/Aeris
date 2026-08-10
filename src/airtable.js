import axios from 'axios';
// Kept separate from the main config so this optional dashboard integration
// can be added to an already-deployed service without changing core startup settings.
const airtableConfig = {
  token: process.env.AIRTABLE_API_TOKEN,
  baseId: process.env.AIRTABLE_BASE_ID,
  tableId: process.env.AIRTABLE_TABLE_ID
};


const PAYMENT_LABELS = {
  cod: 'კურიერთან გადახდა',
  transfer: 'საბანკო გადარიცხვა',
  tbc: 'TBC განვადება',
  bog: 'საქართველოს ბანკის განვადება',
  credo: 'Credo განვადება',
  keepz: 'ნაწილ-ნაწილ'
};


const STATUS_LABELS = {
  pending: 'მიმდინარეობს',
  verification_required: 'ჩარიცხვა გადასამოწმებელია',
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


function productUrl(item = {}) {
  return item.productUrl || item.onlineStoreUrl || item.url || '';
}

function formatOrderItems(items = []) {
  return items.map((item, index) => {
    const quantity = Number(item.quantity || 1);
    const lineTotal = Number.isFinite(Number(item.lineMinor)) ? (Number(item.lineMinor) / 100).toFixed(2) + ' GEL' : '';
    const link = productUrl(item);
    return `${index + 1}) ${item.title || 'პროდუქტი'} × ${quantity}${lineTotal ? ' — ' + lineTotal : ''}${link ? ' — ბმული: ' + link : ''}`;
  }).join(' | ');
}

function firstProductUrl(items = []) {
  return items.map(productUrl).find(Boolean) || '';
}


function unknownFieldName(error) {
  const message = error.response?.data?.error?.message || '';
  return message.match(/Unknown field name: \"(.+?)\"/)?.[1] || null;
}

async function createRecord(fields) {
  try {
    const response = await client().post('', { records: [{ fields }], typecast: true });
    return response.data.records?.[0]?.id || null;
  } catch (error) {
    const missingField = unknownFieldName(error);
    if (missingField && Object.prototype.hasOwnProperty.call(fields, missingField)) {
      console.warn(`Airtable field ${missingField} does not exist; retrying without it`);
      const fallbackFields = { ...fields };
      delete fallbackFields[missingField];
      return createRecord(fallbackFields);
    }
    if (error.response?.data) {
      console.error('Airtable create failed:', JSON.stringify(error.response.data));
    }
    throw error;
  }
}

function fieldsFor(order) {
  const customer = order.customer || {};
  const fields = {
    'პროდუქტები და ზომები': formatOrderItems(order.items),
    'სულ თანხა': `${(order.totalMinor / 100).toFixed(2)} GEL`,
    'გადახდის მეთოდი': PAYMENT_LABELS[order.bank] || order.bank,
    'შეკვეთის სტატუსი': STATUS_LABELS[order.status] || 'მიმდინარეობს',
    'შეკვეთის თარიღი': new Date().toISOString()
  };

  const shopifyOrderName = order.shopifyOrder?.name || order.shopifyOrderName;
  if (shopifyOrderName) fields['შეკვეთის ნომერი'] = shopifyOrderName;

  const firstLink = firstProductUrl(order.items);
  if (firstLink) fields['პროდუქტის ბმული'] = firstLink;

  // These fields are added only when the buyer has supplied them in the checkout form.
  if (customer.name) fields['სახელი და გვარი'] = customer.name;
  if (customer.phone) fields['ტელეფონი'] = customer.phone;
  if (customer.city) fields['ქალაქი'] = customer.city;
  if (customer.address) fields['ზუსტი მისამართი'] = customer.address;

  return fields;
}


export async function createAirtableOrder(order) {
  if (!enabled()) return null;
  return createRecord(fieldsFor(order));
}


export async function updateAirtableOrder(recordId, status) {
  if (!enabled() || !recordId) return;
  try {
    await client().patch(`/${recordId}`, { fields: { 'შეკვეთის სტატუსი': STATUS_LABELS[status] || 'მიმდინარეობს' }, typecast: true });
  } catch (error) {
    if (unknownFieldName(error) === 'შეკვეთის სტატუსი') {
      console.warn('Airtable field შეკვეთის სტატუსი does not exist; skipped status update');
      return;
    }
    throw error;
  }
}
