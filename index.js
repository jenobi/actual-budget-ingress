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

  // 1. Guard Clause: Validate required top-level fields FIRST
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

  const uniqueId = messageId;

  try {
    // 2. Connect and ensure budget is loaded
    await initActual();

    const isMissingPayee = transaction.payee === null;
    const sourceAccountName = transaction.payee;              // e.g., "MS BERNADETTE MARIE GRACEY" or "Smile"
    const destinationAccountName = transaction.targetAccount;  // e.g., "Direct Debits"

    // Fetch master payee records to see if the source string matches a system transfer account
    const payeesList = await Actual.getPayees();
    const isInternalSource = sourceAccountName && payeesList.some(p => 
      p.transfer_acct && p.name.toLowerCase().includes(sourceAccountName.toLowerCase())
    );

    // FIX 1: Only look up transfer mappings if the transaction payee string represents an internal account
    const transferPayeeId = (isInternalSource && !isMissingPayee) 
      ? await getTransferPayeeId(sourceAccountName) 
      : null;

    // Resolve the physical account ledger we are writing this transaction into (the Destination)
    const accountId = await resolveAccountId(destinationAccountName);

    // FIX 2 (Deep Circular Guard): Validate that the resolved source account mapping doesn't match the resolved destination ledger
    const systemAccounts = await Actual.getAccounts();
    const resolvedLedger = systemAccounts.find(a => a.id === accountId);
    
    if (resolvedLedger && isInternalSource) {
      const resolvedTransferPayee = payeesList.find(p => p.id === transferPayeeId);
      if (resolvedTransferPayee && resolvedTransferPayee.transfer_acct === resolvedLedger.id) {
        console.warn(`⚠️ Rejected request: Circular reference detected. Resolved source account matches resolved destination ledger ("${resolvedLedger.name}")`);
        await Actual.shutdown();
        return res.status(400).json({
          success: false,
          error: 'Invalid transaction: Source account and destination ledger cannot be the same.'
        });
      }
    }

    // 5. Check for duplicates in a 4-day window
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

    // 6. Import the transaction using the reconciliation engine
    console.log('📥 Injecting transaction via import engine...');
    const importResult = await Actual.importTransactions(accountId, [{
      date: transaction.date,
      payee: transferPayeeId || null, 
      payee_name: (transferPayeeId || isMissingPayee) ? null : transaction.payee,
      amount: transaction.amount,
      account: accountId,
      cleared: false, 
      notes: `Sync-ID: ${req.body.messageId}`,
      imported_id: `${uniqueId}`,
    }], {
      defaultCleared: false 
    });

    console.log(`📋 Import engine output: Added ${importResult.added.length}, Updated ${importResult.updated.length}`);

    // 7. Sync updates back to the instance
    console.log('🔄 Syncing changes back to server...');
    await Actual.sync();
    console.log(`✅ Staged and Synced: ${transaction.payee}`);

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