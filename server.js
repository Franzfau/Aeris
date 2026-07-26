const express = require('express');
const axios = require('axios');
const crypto = require('crypto');
const qs = require('qs');

const app = express();
app.use(express.json());

const SHOP = process.env.SHOP;
const ACCESS_TOKEN = process.env.ACCESS_TOKEN;
const SECRET_EZZY = process.env.SECRET_EZZY;
const MERCHANT_ID_EZZY = process.env.MERCHANT_ID_EZZY;
const cors = require('cors');
app.use(cors());

// საერთო ფუნქცია შეკვეთისა და კრედოს ინტეგრაციისთვის
const handleCredoOrder = async (req, res) => {
  try {
    const products = Array.isArray(req.body.products) ? req.body.products : [];

    const shopifyResponse = await axios.post(
      `https://${SHOP}/admin/api/2024-01/draft_orders.json`,
      {
        draft_order: {
          line_items: products.map(p => ({
            variant_id: Number(p.id),
            quantity: p.amount || 1
          })),
          customer: {
            first_name: req.body.name || "Customer"
          },
          shipping_address: {
            first_name: req.body.name || "Customer",
            address1: req.body.address || "",
            phone: req.body.phone || "",
            country: "Georgia"
          },
          note: `Credo Order\nName: ${req.body.name}\nPhone: ${req.body.phone}\nAddress: ${req.body.address}`,
          tags: "CREDO",
          use_customer_default_address: false
        }
      },
      {
        headers: {
          'X-Shopify-Access-Token': ACCESS_TOKEN,
          'Content-Type': 'application/json'
        }
      }
    );

    const draftOrder = shopifyResponse.data.draft_order;

    const orderCode = 'ORD_' + Date.now();
    const formattedProducts = products.map(p => ({
      id: String(p.id),
      title: String(p.title || "Product").replace(/[^\x00-\x7F]/g, '').trim(),
      amount: Number(p.amount || 1),
      price: Number(p.price),
      type: 0
    }));

    let stringToHash = '';
    formattedProducts.forEach(p => {
      stringToHash += p.id + p.title + p.amount + p.price + "0";
    });
    stringToHash += SECRET_EZZY;

    const check = crypto.createHash('md5').update(stringToHash).digest('hex');

    const data = {
      merchantId: MERCHANT_ID_EZZY,
      orderCode: orderCode,
      check: check,
      installmentLength: 12
    };

    formattedProducts.forEach((p, i) => {
      data[`products[${i}][id]`] = p.id;
      data[`products[${i}][title]`] = p.title;
      data[`products[${i}][amount]`] = p.amount;
      data[`products[${i}][price]`] = p.price;
      data[`products[${i}][type]`] = 0;
    });

    const credoResponse = await axios.post(
      'https://ganvadeba.credo.ge/widget_api/index.php',
      qs.stringify(data),
      {
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        maxRedirects: 0,
        validateStatus: () => true
      }
    );

    let redirectUrl =
      credoResponse.headers.location ||
      (credoResponse.headers.refresh && credoResponse.headers.refresh.includes('url=') ? credoResponse.headers.refresh.split('url=')[1] : null) ||
      (credoResponse.data && credoResponse.data.URL) ||
      (credoResponse.data && credoResponse.data.data && credoResponse.data.data.URL);

    return res.json({
      draftOrderId: draftOrder.id,
      redirectUrl: redirectUrl
    });

  } catch (err) {
    console.log("CREDO FLOW ERROR:", err.response?.data || err.message);
    return res.status(500).json({
      error: err.response?.data || err.message
    });
  }
};

// ორივე მისამართის მხარდაჭერა 404 შეცდომის თავიდან ასაცილებლად
app.post('/api/create-order-and-credo', handleCredoOrder);
app.post('/api/create-order-and-bog-ezzy', handleCredoOrder);

// სერვერის გაშვება
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});
