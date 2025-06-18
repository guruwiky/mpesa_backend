const express = require('express');
const axios = require('axios');
require('dotenv').config();

const app = express();
app.use(express.json());

const port = process.env.PORT;

const consumerKey = process.env.CONSUMER_KEY;
const consumerSecret = process.env.CONSUMER_SECRET;
const shortcode = process.env.SHORTCODE;
const passkey = process.env.PASSKEY;
const callbackURL = process.env.CALLBACK_URL;

const auth = Buffer.from(`${consumerKey}:${consumerSecret}`).toString('base64');

// Get OAuth Token
async function getAccessToken() {
  const response = await axios.get(
    'https://sandbox.safaricom.co.ke/oauth/v1/generate?grant_type=client_credentials',
    {
      headers: {
        Authorization: `Basic ${auth}`,
      },
    }
  );
  return response.data.access_token;
}

// STK Push Route
app.post('/stkpush', async (req, res) => {
  const { phone, amount, accountReference, transactionDesc } = req.body;
  const token = await getAccessToken();
  const timestamp = new Date().toISOString().replace(/[^0-9]/g, '').slice(0, -3);

  const password = Buffer.from(`${shortcode}${passkey}${timestamp}`).toString('base64');

  try {
    const response = await axios.post(
      'https://sandbox.safaricom.co.ke/mpesa/stkpush/v1/processrequest',
      {
        BusinessShortCode: shortcode,
        Password: password,
        Timestamp: timestamp,
        TransactionType: 'CustomerPayBillOnline',
        Amount: amount,
        PartyA: phone,
        PartyB: shortcode,
        PhoneNumber: phone,
        CallBackURL: callbackURL,
        AccountReference: accountReference,
        TransactionDesc: transactionDesc,
      },
      {
        headers: {
          Authorization: `Bearer ${token}`,
        },
      }
    );
    res.status(200).json(response.data);
  } catch (err) {
    console.error('STK Push Error:', err.response.data);
    res.status(500).json(err.response.data);
  }
});

// Callback URL route — this was missing
app.post('/payment', (req, res) => {
  console.log('✅ Payment Callback Received:', req.body);
  res.status(200).json({ message: 'Callback received successfully.' });
});

// Health check
app.get('/', (req, res) => {
  res.send('M-Pesa API is live 🚀');
});

app.listen(port, () => console.log(`Server running on port ${port}`));
console.log('PORT from env:', process.env.PORT);
