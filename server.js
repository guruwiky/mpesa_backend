// Import necessary modules
const express = require('express');
const axios = require('axios');
require('dotenv').config(); // Load environment variables from .env file
const admin = require('firebase-admin'); // Import Firebase Admin SDK

// --- Firebase Admin SDK Initialization ---
// Initialize Firebase Admin SDK using environment variables
try {
  admin.initializeApp({
    credential: admin.credential.cert({
      type: process.env.FIREBASE_TYPE,
      projectId: process.env.FIREBASE_PROJECT_ID,
      privateKeyId: process.env.FIREBASE_PRIVATE_KEY_ID,
      // IMPORTANT: Replace '\n' characters if they were escaped when setting the environment variable
      // Ensure privateKey is correctly parsed for newlines if stored as a single string in env
      privateKey: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n'),
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
      clientId: process.env.FIREBASE_CLIENT_ID,
      authUri: process.env.FIREBASE_AUTH_URI,
      tokenUri: process.env.FIREBASE_TOKEN_URI,
      authProviderX509CertUrl: process.env.FIREBASE_AUTH_PROVIDER_X509_CERT_URL,
      clientX509CertUrl: process.env.FIREBASE_CLIENT_X509_CERT_URL,
    }),
    // If you need to specify a database URL (e.g., for Realtime Database), uncomment below:
    // databaseURL: "https://YOUR_PROJECT_ID.firebaseio.com"
  });
  console.log('Firebase Admin SDK initialized successfully using environment variables.');
} catch (error) {
  console.error('Failed to initialize Firebase Admin SDK. Check your Firebase environment variables:', error);
  // Log specific environment variables (BE CAREFUL NOT TO LOG PRIVATE KEY IN PRODUCTION)
  // console.error('FIREBASE_PROJECT_ID:', process.env.FIREBASE_PROJECT_ID);
  // console.error('FIREBASE_CLIENT_EMAIL:', process.env.FIREBASE_CLIENT_EMAIL);
  process.exit(1); // Exit if Firebase cannot be initialized
}

const db = admin.firestore(); // Get a Firestore instance

// --- Express App Setup ---
const app = express();
app.use(express.json()); // Enable JSON body parsing for incoming requests

const port = process.env.PORT || 3000; // Use 3000 as a fallback if PORT is not set

// M-Pesa API credentials from environment variables
const consumerKey = process.env.CONSUMER_KEY;
const consumerSecret = process.env.CONSUMER_SECRET;
const shortcode = process.env.SHORTCODE;
const passkey = process.env.PASSKEY;
const callbackURL = process.env.CALLBACK_URL; // This should be your public URL for the /mpesa/callback endpoint

// Basic validation for M-Pesa environment variables
if (!consumerKey || !consumerSecret || !shortcode || !passkey || !callbackURL) {
  console.error("Missing one or more required M-Pesa environment variables. Please check your .env file or deployment environment settings.");
  process.exit(1); // Exit if essential variables are missing
}

// Encode Consumer Key and Secret for OAuth token generation
const auth = Buffer.from(`${consumerKey}:${consumerSecret}`).toString('base64');

// Cache for M-Pesa access token to minimize API calls
let accessTokenCache = {
  token: null,
  expiry: 0 // Timestamp when the token expires
};

/**
 * Fetches or retrieves a cached M-Pesa OAuth access token.
 * The token is cached and refreshed only when it's about to expire.
 * @returns {Promise<string>} The M-Pesa access token.
 */
async function getAccessToken() {
  const currentTime = Date.now();
  // Check if token is still valid (e.g., valid for 1 hour, refresh slightly before expiry)
  // 3500 * 1000 provides a buffer of approximately 100 seconds before the typical 3599s expiry
  if (accessTokenCache.token && accessTokenCache.expiry > currentTime + (100 * 1000)) { 
    return accessTokenCache.token;
  }

  try {
    const response = await axios.get(
      'https://api.safaricom.co.ke/oauth/v1/generate?grant_type=client_credentials', // Use production URL for live environment
      {
        headers: {
          Authorization: `Basic ${auth}`,
        },
      }
    );
    accessTokenCache.token = response.data.access_token;
    // M-Pesa token expiry is typically 3599 seconds (approx 1 hour)
    accessTokenCache.expiry = currentTime + (response.data.expires_in * 1000); // Convert seconds to milliseconds
    console.log('New M-Pesa access token fetched and cached.');
    return accessTokenCache.token;
  } catch (error) {
    console.error('Error fetching M-Pesa access token:', error.response ? error.response.data : error.message);
    throw new Error('Failed to get M-Pesa access token');
  }
}

// --- M-Pesa STK Push Endpoint ---
/**
 * Handles incoming requests for M-Pesa STK Push.
 * Requires phone, amount, organizationId, packageName, and subscriptionType in the request body.
 */
app.post('/stkpush', async (req, res) => {
  const { phone, amount, accountReference, transactionDesc, organizationId, packageName, subscriptionType } = req.body;
  
  // Validate required parameters
  if (!phone || !amount || !organizationId || !packageName || !subscriptionType) {
    return res.status(400).json({ success: false, message: 'Missing required parameters (phone, amount, organizationId, packageName, subscriptionType).' });
  }

  try {
    const token = await getAccessToken(); // Get M-Pesa access token
    const timestamp = new Date().toISOString().replace(/[^0-9]/g, '').slice(0, -3); // Generate timestamp (YYYYMMDDHHmmss)
    const password = Buffer.from(`${shortcode}${passkey}${timestamp}`).toString('base64'); // Generate password

    // Make the STK Push request to Safaricom Daraja API
    const mpesaResponse = await axios.post(
      'https://api.safaricom.co.ke/mpesa/stkpush/v1/processrequest', // Use production URL for live environment
      {
        BusinessShortCode: shortcode,
        Password: password,
        Timestamp: timestamp,
        TransactionType: 'CustomerPayBillOnline', // Or CustomerBuyGoodsOnline
        Amount: amount,
        PartyA: phone, // Customer's phone number
        PartyB: shortcode, // Your business short code
        PhoneNumber: phone, // Customer's phone number
        CallBackURL: callbackURL, // Your publicly accessible callback URL
        AccountReference: accountReference || 'SalonApp', // A unique identifier for the transaction
        TransactionDesc: transactionDesc || 'Subscription Payment', // Description of the transaction
      },
      {
        headers: {
          Authorization: `Bearer ${token}`, // Authorization header with the access token
        },
      }
    );

    const mpesaData = mpesaResponse.data;
    console.log('STK Push Response from Safaricom:', mpesaData);

    // Check if STK Push initiation was successful (ResponseCode '0')
    if (mpesaData.ResponseCode === '0') {
      // STK Push was successfully initiated. Record the transaction in Firestore.
      const transactionDocRef = db.collection('mpesa_transactions').doc(mpesaData.CheckoutRequestID);

      await transactionDocRef.set({
        organizationId: organizationId,
        packageName: packageName, // Store for later subscription update
        subscriptionType: subscriptionType, // Store for later subscription update
        requestedAmount: amount,
        phoneNumber: phone,
        checkoutRequestID: mpesaData.CheckoutRequestID,
        merchantRequestID: mpesaData.MerchantRequestID,
        status: 'PENDING', // Initial status
        stkPushResponse: mpesaData, // Store the full response from Safaricom
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });

      res.status(200).json({
        success: true,
        message: 'STK push initiated successfully. Awaiting customer confirmation.',
        checkoutRequestID: mpesaData.CheckoutRequestID, // Return this to the client (e.g., Flutter app)
        customerMessage: mpesaData.CustomerMessage,
      });
    } else {
      // STK Push initiation failed (e.g., invalid phone number, insufficient balance in paybill account, etc.)
      console.error('STK Push initiation failed:', mpesaData);
      res.status(400).json({
        success: false,
        message: mpesaData.CustomerMessage || mpesaData.ResponseDescription || 'STK Push initiation failed.',
        responseCode: mpesaData.ResponseCode,
        errorCode: mpesaData.errorCode, // Include any specific error code from M-Pesa
      });
    }
  } catch (err) {
    console.error('STK Push Error:', err.response ? err.response.data : err.message);
    const errorMessage = err.response ? (err.response.data.errorMessage || err.response.data.message || 'An error occurred during STK push.') : 'Network or server error.';
    res.status(500).json({ success: false, message: errorMessage });
  }
});

// --- M-Pesa Callback URL Route ---
/**
 * This route receives the transaction result from Safaricom after an STK Push.
 * It updates the transaction status in Firestore and then updates the organization's subscription.
 */
app.post('/mpesa/callback', async (req, res) => {
  console.log('✅ M-Pesa Callback Received:', JSON.stringify(req.body, null, 2));

  // Safaricom sometimes sends an empty body or an unexpected structure.
  // Perform robust checks to avoid errors.
  if (!req.body || !req.body.Body || !req.body.Body.stkCallback) {
    console.error('Invalid M-Pesa callback body received. Missing expected structure.');
    return res.status(400).json({ message: 'Invalid callback data.' });
  }

  const {
    Body: {
      stkCallback: {
        CheckoutRequestID,
        ResultCode,
        ResultDesc,
        CallbackMetadata,
        MerchantRequestID // Also available here, useful for logging
      }
    }
  } = req.body;

  try {
    // Find the corresponding pending transaction in Firestore using CheckoutRequestID
    const transactionDocRef = db.collection('mpesa_transactions').doc(CheckoutRequestID);
    const transactionDoc = await transactionDocRef.get();

    // If transaction document does not exist, it might be a duplicate callback or unrecorded transaction
    if (!transactionDoc.exists) {
      console.warn(`Transaction with CheckoutRequestID ${CheckoutRequestID} not found in Firestore. This might be a duplicate callback or an unrecorded transaction.`);
      // Still respond 200 OK to M-Pesa to prevent retries, even if we can't process it further.
      return res.status(200).json({ message: 'Transaction not found in our records, but callback acknowledged.' });
    }

    const transactionData = transactionDoc.data();
    const organizationId = transactionData.organizationId; // Retrieve organizationId from initial transaction data

    let updateData = {
      callbackResultCode: ResultCode,
      callbackResultDesc: ResultDesc,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    };
    
    // Conditionally add CallbackMetadata if it exists
    if (CallbackMetadata !== undefined && CallbackMetadata !== null) {
      updateData.callbackMetadata = CallbackMetadata;
    }

    if (ResultCode === 0) {
      // Payment was successful
      const amountItem = CallbackMetadata?.Item?.find(item => item.Name === 'Amount');
      const mpesaReceiptNumberItem = CallbackMetadata?.Item?.find(item => item.Name === 'MpesaReceiptNumber');
      const transactionDateItem = CallbackMetadata?.Item?.find(item => item.Name === 'TransactionDate');
      const phoneNumberItem = CallbackMetadata?.Item?.find(item => item.Name === 'PhoneNumber');

      const paidAmount = amountItem ? amountItem.Value : null;
      const mpesaReceiptNumber = mpesaReceiptNumberItem ? mpesaReceiptNumberItem.Value : null;
      const transactionDate = transactionDateItem ? transactionDateItem.Value : null;
      const payerPhoneNumber = phoneNumberItem ? phoneNumberItem.Value : null;

      updateData.status = 'COMPLETED';
      updateData.mpesaReceiptNumber = mpesaReceiptNumber;
      updateData.transactionDate = transactionDate;
      updateData.payerPhoneNumber = payerPhoneNumber;
      updateData.paidAmount = paidAmount;

      // Update the mpesa_transactions document with the final status and details
      await transactionDocRef.update(updateData);
      console.log(`Transaction ${CheckoutRequestID} marked as COMPLETED. MpesaReceiptNumber: ${mpesaReceiptNumber}`);

      // Now, update the organization's subscription in Firestore
      const orgDocRef = db.collection('organizations').doc(organizationId);

      // Retrieve package and subscription type from the initial transaction data
      const packageName = transactionData.packageName;
      const subscriptionType = transactionData.subscriptionType; // e.g., 'Monthly', 'Quarterly', 'Annually'

      let durationInDays;
      switch (subscriptionType) {
        case 'Monthly':
          durationInDays = 30; // Approximation for simplicity, can be more precise (e.g., using date-fns)
          break;
        case 'Quarterly':
          durationInDays = 90; // Approximation
          break;
        case 'Annually':
          durationInDays = 365; // Approximation
          break;
        default:
          console.warn(`Unknown subscription type: ${subscriptionType} for organization ${organizationId}. Defaulting to 30 days.`);
          durationInDays = 30;
          break;
      }

      // Calculate new end date. For simplicity, we add duration from the current date.
      // For renewals, you might want to fetch the existing 'subscriptionEndDate' and add duration to it
      // to avoid shortening the subscription if renewed early.
      const subscriptionStartDate = admin.firestore.Timestamp.now(); // Current timestamp
      const subscriptionEndDate = admin.firestore.Timestamp.fromDate(
        new Date(Date.now() + durationInDays * 24 * 60 * 60 * 1000) // Calculate end date
      );

      // Update the organization's document with new subscription details
      await orgDocRef.update({
        'activePackage': packageName,
        'subscriptionStartDate': subscriptionStartDate,
        'subscriptionEndDate': subscriptionEndDate,
        'subscriptionType': subscriptionType,
        'lastPaidAmount': paidAmount,
        'paymentTransactionId': mpesaReceiptNumber, // Use the actual M-Pesa receipt
        'lastUpdated': admin.firestore.FieldValue.serverTimestamp(),
        'paymentConfirmed': true, // Flag for easy check from frontend
      });
      console.log(`Organization ${organizationId} subscription updated successfully.`);

    } else {
      // Payment failed or was cancelled by the user
      updateData.status = 'FAILED';
      await transactionDocRef.update(updateData);
      console.log(`Transaction ${CheckoutRequestID} marked as FAILED. ResultCode: ${ResultCode}, ResultDesc: ${ResultDesc}`);
      // Optionally, you might want to send a notification or log about the failed payment to your internal system.
    }
  } catch (error) {
    console.error('Error processing M-Pesa callback:', error);
    // Even if there's an error on our side, Safaricom expects a 200 OK.
    // Log the error internally and respond with 200.
  }

  // Always respond with 200 OK to M-Pesa to acknowledge receipt of the callback.
  // If you don't, Safaricom may retry sending the callback.
  res.status(200).json({ message: 'Callback received successfully.' });
});


// --- Health Check Endpoint ---
app.get('/', (req, res) => {
  res.send('M-Pesa API is live 🚀');
});

// --- Start the Express Server ---
app.get('/myip', (req, res) => {
  const ip = req.headers['x-forwarded-for'] || req.connection.remoteAddress;
  res.send(`Your public IP is: ${ip}`);
});
app.get('/myip', (req, res) => {
  const ip = req.headers['x-forwarded-for'] || req.connection.remoteAddress;
  res.send(`Your public IP is: ${ip}`);
});

app.listen(port, () => {
  console.log(`Server running on port ${port}`);
  console.log('PORT from env:', process.env.PORT);
});
