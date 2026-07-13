const express = require('express');
const Actual = require('@actual-app/api');
const path = require('path');
const fs = require('fs').promises;

// Intercept the known Actual API package bug to keep the Express server from crashing
process.on('unhandledRejection', (reason, promise) => {
  console.warn('⚠️ Intercepted an unhandled promise rejection (Actual API bug):', reason);
});

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;
const DATA_DIR = '/tmp/actual-api-data';
const ACTUAL_SERVER_URL = (process.env.ACTUAL_SERVER_URL || '').trim();
const ACTUAL_PASSWORD = (process.env.ACTUAL_PASSWORD || '').trim();
const SYNC_ID = (process.env.ACTUAL_SYNC_ID || '').trim();
const DEFAULT_ACCOUNT = process.env.DEFAULT_ACCOUNT || 'ING Direct Debits';
const INGRESS_API_KEY = process.env.INGRESS_API_KEY || '';

if (process.env.NODE_ENV === 'production' && !INGRESS_API_KEY) {
  console.warn('⚠️ WARNING: INGRESS_API_KEY is not set in production. The bridge is running completely open!');
}

// Helper function to resolve account UUID dynamically
async function resolveAccountId(friendlyName) {
  const accounts = await Actual.getAccounts();
  const searchName = friendlyName ? friendlyName.toLowerCase().trim() : '';

  // 1. Try exact match
  let account = accounts.find(a => a.name.toLowerCase() === searchName);
  
  // 2. Try prefix fallback match if exact failed
  if (!account && searchName) {
    account = accounts.find(a => a.name.toLowerCase() === `ing ${searchName}`);
  }

  // 3. Fallback to default account if nothing matched
  if (!account) {
    account = accounts.find(a => a.name.toLowerCase() === DEFAULT_ACCOUNT.toLowerCase());
  }

  if (!account) {
    throw new Error(`Could not find account matching "${friendlyName}" or default "${DEFAULT_ACCOUNT}"`);
  }

  return account.id;
}

async function initActual() {
  await fs.mkdir(DATA_DIR, { recursive: true });
  await Actual.init({
    dataDir: DATA_DIR,
    serverURL: ACTUAL_SERVER_URL,
    password: ACTUAL_PASSWORD,
  });

  const budgets = await Actual.getBudgets();
  const existing = budgets.find(b => b.id === SYNC_ID);

  if (!existing) {
    console.log('📥 Budget not found locally. Downloading...');
    await Actual.downloadBudget(SYNC_ID);
  } else {
    console.log(`📂 Loading local budget: ${existing.id}`);
    await Actual.loadBudget(existing.id);
  }
}

// Helper to find the Transfer Payee ID for a given account name
async function getTransferPayeeId(accountName) {
  const payees = await Actual.getPayees();
  const transferPayee = payees.find(p => 
    p.transfer_acct && 
    p.name.toLowerCase().includes(accountName.toLowerCase())
  );
  return transferPayee ? transferPayee.id : null;
}

app.post('/transaction', async (req, res) => {

  // Enforce API key check if configured
  if (INGRESS_API_KEY) {
    const inboundKey = req.headers['x-api-key'];
    if (!inboundKey || inboundKey !== INGRESS_API_KEY) {
      console.log(`🔒 Blocked unauthorized request. Provided key: ${inboundKey ? 'invalid' : 'none'}`);
      return res.status(401).json({ error: 'Unauthorized: Invalid or missing X-Api-Key' });
    }
  }
  
  const { transaction, messageId } = req.body; 

  // 1. Guard Clause: Validate required top-level fields
  if (!messageId || !transaction) {
    console.warn('⚠️ Rejected request: Missing messageId or transaction object');
    return res.status(400).json({ 
      success: false, 
      error: 'Missing required fields: messageId and transaction are mandatory.' 
    });
  }

  try {
    // 2. Connect and ensure budget is loaded
    await initActual();

    // Resolve the physical ledger account we are writing into (the Destination account)
    const accountId = await resolveAccountId(transaction.targetAccount);

    // 3. Check for duplicates in a 4-day window to prevent n8n retry double-posting
    const startSearch = new Date(transaction.date);
    startSearch.setDate(startSearch.getDate() - 3);
    const startDate = startSearch.toISOString().split('T')[0];
    const endDate = new Date().toISOString().split('T')[0];

    const accountTxns = await Actual.getTransactions(accountId, startDate, endDate);
    const alreadyProcessed = accountTxns.some(tx => tx.notes && tx.notes.includes(messageId));

    if (alreadyProcessed) {
      console.log(`⏭️ Skipping: Sync-ID ${messageId} already exists in Actual.`);
      await Actual.shutdown();
      return res.json({ success: true, message: 'Duplicate transaction skipped' });
    }

    // 4. Check type and prepare the insertion array
    const transactionsToInsert = [];

    if (transaction.type === 'internal_transfer') {
      console.log(`🔀 Processing as an internal transfer from "${transaction.payee}" to "${transaction.targetAccount}"`);
      
      // Resolve account UUIDs for both sides
      const sourceAccountId = await resolveAccountId(transaction.payee);
      const destinationAccountId = await resolveAccountId(transaction.targetAccount);
      
      // Fetch system payees list
      const payeesList = await Actual.getPayees();
      
      // Find the transfer payees that point to each account
      const sourceTransferPayee = payeesList.find(p => p.transfer_acct === sourceAccountId);
      const destinationTransferPayee = payeesList.find(p => p.transfer_acct === destinationAccountId);

      if (!sourceTransferPayee || !destinationTransferPayee) {
        throw new Error(`Missing system transfer payees. Source found: ${!!sourceTransferPayee}, Dest found: ${!!destinationTransferPayee}`);
      }

      // Generate two unique database IDs for the twin transactions locally
      const idA = crypto.randomUUID();
      const idB = crypto.randomUUID();

      // Leg A: The Destination Account (Inflow / Positive)
      transactionsToInsert.push({
        id: idA,
        transfer_id: idB,
        date: transaction.date,
        amount: transaction.amount,
        account: destinationAccountId,
        payee: sourceTransferPayee.id,
        cleared: false,
        notes: `Sync-ID: ${messageId}`
      });

      // Leg B: The Source Account (Outflow / Negative)
      transactionsToInsert.push({
        id: idB,
        transfer_id: idA,
        date: transaction.date,
        amount: -transaction.amount, // Negative inversion for outflow
        account: sourceAccountId,
        payee: destinationTransferPayee.id,
        cleared: false,
        notes: `Sync-ID: ${messageId}`
      });

    } else {
      console.log(`💰 Processing as a standard transaction payload for payee: "${transaction.payee}"`);
      
      // For standard transactions, we insert a single payload into the destination ledger
      transactionsToInsert.push({
        date: transaction.date,
        amount: transaction.amount,
        account: accountId,
        payee_name: transaction.payee || null,
        payee: null,
        cleared: false,
        notes: `Sync-ID: ${messageId}`
      });
    }

    // 5. Inject the transaction(s) into their correct ledger(s)
    if (transaction.type === 'internal_transfer') {
      console.log(`📥 Injecting transfer legs: Leg A into Destination, Leg B into Source...`);
      
      // Pull out the individual legs from the array we built
      const [legA, legB] = transactionsToInsert;

      // Insert Leg A into the Destination Account, and Leg B into the Source Account
      await Actual.addTransactions(legA.account, [legA]);
      await Actual.addTransactions(legB.account, [legB]);
    } else {
      console.log(`📥 Injecting standard transaction via addTransactions...`);
      await Actual.addTransactions(accountId, transactionsToInsert);
    }

    // 7. Sync updates back to the server instance
    console.log('🔄 Syncing changes back to server...');
    await Actual.sync();
    console.log(`✅ Staged and Synced successfully.`);

    // 8. Graceful close
    await Actual.shutdown();
    return res.json({ success: true, message: 'Transaction synced successfully' });

  } catch (error) {
    console.error('❌ Error handling transaction webhook:', error);
    try { await Actual.shutdown(); } catch (_) {}
    return res.status(500).json({ error: error.message });
  }
});

app.listen(PORT, () => {
  console.log(`Actual Budget bridge listening on port ${PORT}`);
});