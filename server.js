const express = require('express');
const axios = require('axios');
const qs = require('qs');
const cors = require('cors');
const crypto = require('crypto');

const app = express();
app.use(express.json());
app.use(cors());

// --- სერვერის ცვლადები (Environment Variables) ---
const SHOP = process.env.SHOP; 
const ACCESS_TOKEN = process.env.ACCESS_TOKEN; 

// TBC Keys
const TBC_API_KEY_EZZY = process.env.TBC_API_KEY_EZZY;
const TBC_API_SECRET_EZZY = process.env.TBC_API_SECRET_EZZY;
const TBC_MERCHANT_KEY_EZZY = process.env.TBC_MERCHANT_KEY_EZZY;
const TBC_CAMPAIGN_ID_EZZY = process.env.TBC_CAMPAIGN_ID_EZZY;

// BOG Keys
const BOG_CLIENT_ID_EZZY = process.env.BOG_CLIENT_ID_EZZY;
const BOG_CLIENT_SECRET_EZZY = process.env.BOG_CLIENT_SECRET_EZZY;

// Credo Keys
const MERCHANT_ID_EZZY = process.env.MERCHANT_ID_EZZY;
const SECRET_EZZY = process.env.SECRET_EZZY;


// ===================== TBC ORDER =====================
app.post('/api/tbc-order', async (req, res) => {
  try {
    const products = Array.isArray(req.body.products) ? req.body.products : [];
    if (products.length === 0) {
      return res.status(400).json({ error: "No products" });
    }

    const tokenResponse = await axios.post(
      'https://api.tbcbank.ge/oauth/token',
      qs.stringify({ grant_type: 'client_credentials' }),
      {
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Authorization': 'Basic ' + Buffer.from(TBC_API_KEY_EZZY + ':' + TBC_API_SECRET_EZZY).toString('base64')
        }
      }
    );

    const accessToken = tokenResponse.data.access_token;

    const tbcResponse = await axios.post(
      'https://api.tbcbank.ge/v1/online-installments/applications',
      {
        merchantKey: TBC_MERCHANT_KEY_EZZY,
        campaignId: TBC_CAMPAIGN_ID_EZZY,
        priceTotal: Number(
          products.reduce((sum, p) => {
            const rawPrice = Number(p.price);
            return sum + ((rawPrice > 10000 ? rawPrice / 100 : rawPrice) * (Number(p.amount) || 1));
          }, 0)
        ),
        currency: "GEL",
        invoiceId: "INV_" + Date.now(),
        products: products.map(p => ({
          name: p.product_title ? `${p.product_title} - ${p.title}` : (p.title || "Product"),
          price: Number(p.price) > 10000 ? Number(p.price) / 100 : Number(p.price),
          quantity: Number(p.amount) || 1
        }))
      },
      {
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'Content-Type': 'application/json'
        },
        maxRedirects: 0,
        validateStatus: () => true
      }
    );

    const redirectUrl = tbcResponse.headers.location;
    if (!redirectUrl) {
      return res.status(400).json({ error: "No redirect URL", data: tbcResponse.data });
    }

    return res.json({ redirectUrl });
  } catch (err) {
    console.log("TBC ERROR:", err.response?.data || err.message);
    return res.status(500).json({ error: err.response?.data || err.message });
  }
});


// ===================== BOG ORDER LOGIC =====================
async function getBogToken() {
  const tokenResponse = await axios.post(
    'https://oauth2.bog.ge/auth/realms/bog/protocol/openid-connect/token',
    qs.stringify({ grant_type: 'client_credentials' }),
    {
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Authorization': 'Basic ' + Buffer.from(BOG_CLIENT_ID_EZZY + ':' + BOG_CLIENT_SECRET_EZZY).toString('base64')
      }
    }
  );
  return tokenResponse.data.access_token;
}

app.post('/api/create-order-and-bog-ezzy', async (req, res) => {
  try {
    const products = req.body.products || [];
    
    // 1. ვქმნით Draft Order-ს შოპიფაიში
    const shopifyResponse = await axios.post(
      `https://${SHOP}/admin/api/2024-01/draft_orders.json`,
      {
        draft_order: {
          line_items: products.map(p => ({ variant_id: Number(p.id), quantity: p.amount || 1 })),
          customer: { first_name: req.body.name || "Customer" },
          shipping_address: {
            first_name: req.body.name || "Customer",
            address1: req.body.address || "",
            phone: req.body.phone || "",
            country: "Georgia"
          },
          note: `BOG Installment\nName: ${req.body.name}\nPhone: ${req.body.phone}\nAddress: ${req.body.address}`,
          tags: "BOG",
          use_customer_default_address: false
        }
      },
      { headers: { 'X-Shopify-Access-Token': ACCESS_TOKEN, 'Content-Type': 'application/json' } }
    );

    // 2. ვუკავშირდებით საქართველოს ბანკის API-ს პირდაპირ
    const accessToken = await getBogToken();
    const amount = Number(
      products.reduce((sum, p) => {
        const rawPrice = Number(p.price);
        return sum + ((rawPrice > 10000 ? rawPrice / 100 : rawPrice) * (Number(p.amount) || 1));
      }, 0)
    );

    const cartItems = products.map(p => ({
      total_item_amount: (Number(p.price) > 10000 ? Number(p.price) / 100 : Number(p.price)) * (Number(p.amount) || 1),
      item_description: p.title || "Product",
      total_item_qty: Number(p.amount) || 1,
      item_vendor_code: String(p.id),
      product_image_url: "https://",
      item_site_detail_url: "https://"
    }));

    const checkoutResponse = await axios.post(
      'https://installment.bog.ge/v1/installment/checkout',
      {
        intent: "LOAN",
        installment_month: 12,
        installment_type: "STANDARD",
        shop_order_id: "BOG_" + Date.now(),
        success_redirect_url: "https://" + SHOP,
        fail_redirect_url: "https://" + SHOP,
        reject_redirect_url: "https://" + SHOP,
        validate_items: true,
        locale: "ka",
        purchase_units: [{ amount: { currency_code: "GEL", value: amount } }],
        cart_items: cartItems
      },
      { headers: { 'Authorization': `Bearer ${accessToken}`, 'Content-Type': 'application/json' } }
    );

    const redirectLink = checkoutResponse.data.links.find(l => l.rel === "target");

    return res.json({
      draftOrderId: shopifyResponse.data.draft_order.id,
      redirectUrl: redirectLink?.href,
      orderId: checkoutResponse.data.order_id
    });
  } catch (err) {
    console.log("BOG EZZY ERROR:", err.response?.data || err.message);
    return res.status(500).json({ error: err.response?.data || err.message });
  }
});


// ===================== CREDO ORDER =====================
app.post('/api/create-order-and-credo', async (req, res) => {
  try {
    const products = Array.isArray(req.body.products) ? req.body.products : [];

    const shopifyResponse = await axios.post(
      `https://${SHOP}/admin/api/2024-01/draft_orders.json`,
      {
        draft_order: {
          line_items: products.map(p => ({ variant_id: Number(p.id), quantity: p.amount || 1 })),
          customer: { first_name: req.body.name || "Customer" },
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
      { headers: { 'X-Shopify-Access-Token': ACCESS_TOKEN, 'Content-Type': 'application/json' } }
    );

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

    const response = await axios.post(
      'https://ganvadeba.credo.ge/widget_api/index.php',
      qs.stringify(data),
      {
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        maxRedirects: 0,
        validateStatus: () => true
      }
    );

    let redirectUrl =
      response.headers.location ||
      (response.headers.refresh && response.headers.refresh.includes('url=') ? response.headers.refresh.split('url=')[1] : null) ||
      (response.data && response.data.URL) ||
      (response.data && response.data.data && response.data.data.URL);

    return res.json({
      draftOrderId: shopifyResponse.data.draft_order.id,
      redirectUrl: redirectUrl
    });
  } catch (err) {
    console.log("CREDO ERROR:", err.response?.data || err.message);
    return res.status(500).json({ error: err.response?.data || err.message });
  }
});


const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});
