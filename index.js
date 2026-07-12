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

// Helper function to resolve account UUID dynamically based on your old script's rules
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

app.post('/transaction', async (req, res) => {
  const { transaction, messageId } = req.body; // n8n can pass the email messageId for deduplication

  // Guard Clause: Validate required top-level fields
  if (!messageId) {
    console.warn('⚠️ Rejected request: Missing messageId');
    return res.status(400).json({ 
      success: false, 
      error: 'Missing required field: messageId' 
    });
  }

  if (!transaction) {
    console.warn('⚠️ Rejected request: Missing transaction object');
    return res.status(400).json({ 
      success: false, 
      error: 'Missing required field: transaction' 
    });
  }

  const uniqueId = messageId

  try {
    // 1. Connect and ensure budget is loaded
    await initActual();

    // 2. Find the correct account using our dynamic lookup logic
    const accountId = await resolveAccountId(transaction.targetAccount);

    // 3. Check for duplicates in a 4-day window (matching your old look-back logic)
    const startSearch = new Date(transaction.date);
    startSearch.setDate(startSearch.getDate() - 3);
    const startDate = startSearch.toISOString().split('T')[0];
    const endDate = new Date().toISOString().split('T')[0];

    const accountTxns = await Actual.getTransactions(accountId, startDate, endDate);
    const alreadyProcessed = accountTxns.some(tx => tx.notes && tx.notes.includes(uniqueId));

    if (alreadyProcessed) {
      console.log(`⏭️ Skipping: ${uniqueId} already exists in Actual.`);
      await Actual.shutdown();
      return res.json({ success: true, message: 'Duplicate transaction skipped' });
    }

    // 4. Add the transaction matching your exact parameters
    await Actual.addTransactions(accountId, [{
      date: transaction.date,
      payee_name: transaction.payee,
      amount: transaction.amount,
      account: accountId,
      cleared: false,
      notes: `Sync-ID: ${req.body.messageId}`,
    }]);

    // 5. Sync updates back to the Unraid instance
    console.log('🔄 Syncing changes back to server...');
    await Actual.sync();
    console.log(`✅ Staged and Synced: ${transaction.payee}`);

    // 6. Graceful close
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