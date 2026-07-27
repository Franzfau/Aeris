const express = require('express');
const axios = require('axios');
const crypto = require('crypto');
const qs = require('qs');
const cors = require('cors');

const app = express();
app.use(express.json());
app.use(cors());

const SHOP = process.env.SHOP;
const CLIENT_ID = process.env.CLIENT_ID || 'd7eef7c965c368ed5c61d8605f8aa3cb';
const CLIENT_SECRET = process.env.CLIENT_SECRET || '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';
const SECRET_EZZY = process.env.SECRET_EZZY || process.env.EZZY_SECRET;
const MERCHANT_ID_EZZY = process.env.MERCHANT_ID_EZZY || process.env.EZZY_MERCHANT_ID;

// 1. ავტორიზაციის ქოლბექი, რომელიც იჭერს Shopify-ის კოდს და ცვლის shpat_ ტოკენში
app.get('/auth/callback', async (req, res) => {
  const { code, shop } = req.query;
  
  if (!code || !shop) {
    return res.status(400).send("Missing code or shop parameter");
  }

  try {
    const response = await axios.post(`https://${shop}/admin/oauth/access_token`, {
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      code: code
    });
    
    const accessToken = response.data.access_token;
    
    res.send(`
      <h2>ტოკენი წარმატებით მიღებულია!</h2>
      <p>თქვენი <b>ACCESS_TOKEN (shpat_)</b> არის:</p>
      <textarea style="width:100%; height:60px;" readonly>${accessToken}</textarea>
      <p>დააკოპირეთ ეს ტოკენი და ჩასვით Render-ის Environment Variables-ში როგორც <b>ACCESS_TOKEN</b>.</p>
    `);
  } catch (error) {
    console.error("Token exchange error:", error.response?.data || error.message);
    res.status(500).send("Failed to exchange token: " + (error.response?.data?.error_description || error.message));
  }
});

// 2. შეკვეთისა და განვადების ლოგიკა
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
          'X-Shopify-Access-Token': process.env.ACCESS_TOKEN,
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

app.post('/api/create-order-and-credo', handleCredoOrder);
app.post('/api/create-order-and-bog-ezzy', handleCredoOrder);

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});
