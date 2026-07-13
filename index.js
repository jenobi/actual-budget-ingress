const express = require('express');
const Actual = require('@actual-app/api');
const path = require('path');
const fs = require('fs').promises;
const crypto = require('crypto');

// 1. Hierarchical Logger Setup
const LEVELS = { debug: 0, info: 1, warn: 2, error: 3 };
const LOG_LEVEL = (process.env.LOG_LEVEL || 'info').toLowerCase().trim();
const CURRENT_WEIGHT = LEVELS[LOG_LEVEL] !== undefined ? LEVELS[LOG_LEVEL] : 1;

const logger = {
  debug: (...args) => { if (CURRENT_WEIGHT <= 0) console.log('🔍 [DEBUG]', ...args); },
  info:  (...args) => { if (CURRENT_WEIGHT <= 1) console.log('ℹ️ [INFO]',  ...args); },
  warn:  (...args) => { if (CURRENT_WEIGHT <= 2) console.warn('⚠️ [WARN]',  ...args); },
  error: (...args) => { if (CURRENT_WEIGHT <= 3) console.error('❌ [ERROR]', ...args); }
};

// Intercept known Actual API package unhandled rejections to prevent Express crashes
process.on('unhandledRejection', (reason, promise) => {
  logger.warn('Intercepted an unhandled promise rejection (Actual API package limitation):', reason);
});

const app = express();
app.use(express.json());

// 2. Configuration Parameters via Environment Variables
const PORT = process.env.PORT || 3000;
const DATA_DIR = process.env.ACTUAL_DATA_DIR || '/tmp/actual-api-data';
const ACTUAL_SERVER_URL = (process.env.ACTUAL_SERVER_URL || '').trim();
const ACTUAL_PASSWORD = (process.env.ACTUAL_PASSWORD || '').trim();
const SYNC_ID = (process.env.ACTUAL_SYNC_ID || '').trim();
const DEFAULT_ACCOUNT = process.env.DEFAULT_ACCOUNT || '';
const INGRESS_API_KEY = process.env.INGRESS_API_KEY || '';

if (process.env.NODE_ENV === 'production' && !INGRESS_API_KEY) {
  logger.warn('INGRESS_API_KEY is not set in production environment. The bridge gateway is open!');
}

/**
 * Dynamically resolves an account friendly name to its unique system UUID
 */
async function resolveAccountId(friendlyName) {
  const accounts = await Actual.getAccounts();
  const searchName = friendlyName ? friendlyName.toLowerCase().trim() : '';

  if (!searchName) {
    if (DEFAULT_ACCOUNT) {
      logger.debug(`Empty account name provided. Falling back to configured default account.`);
      const defaultAcc = accounts.find(a => a.name.toLowerCase() === DEFAULT_ACCOUNT.toLowerCase());
      if (defaultAcc) return defaultAcc.id;
    }
    throw new Error('Could not resolve account: No name provided and no valid default fallback exists.');
  }

  // 1. First Pass: Look for a clean exact match
  let account = accounts.find(a => a.name.toLowerCase() === searchName);
  
  // 2. Second Pass: If no exact match, try a fuzzy partial match (.includes)
  if (!account) {
    account = accounts.find(a => a.name.toLowerCase().includes(searchName));
    if (account) {
      logger.debug(`Fuzzy match found: Mapping "${friendlyName}" to system account "${account.name}"`);
    }
  }

  // 3. Final Pass: Drop back to configured default account if both passes failed
  if (!account && DEFAULT_ACCOUNT) {
    logger.warn(`No exact or fuzzy match for "${friendlyName}". Defaulting to: ${DEFAULT_ACCOUNT}`);
    account = accounts.find(a => a.name.toLowerCase() === DEFAULT_ACCOUNT.toLowerCase());
  }

  if (!account) {
    throw new Error(`Could not resolve account matching "${friendlyName}" across exact, fuzzy, or default profiles.`);
  }

  return account.id;
}

/**
 * Structural setup and sync initialization for the local budget instance
 */
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
    logger.info('Budget file not found locally. Downloading from server...');
    await Actual.downloadBudget(SYNC_ID);
  } else {
    logger.debug(`Loading local cached budget copy: ${existing.id}`);
    await Actual.loadBudget(existing.id);
  }
}

// 3. Central Ingress Endpoints
app.post('/transaction', async (req, res) => {

  // Enforce API key restriction header verification if configured
  if (INGRESS_API_KEY) {
    const inboundKey = req.headers['x-api-key'];
    if (!inboundKey || inboundKey !== INGRESS_API_KEY) {
      logger.warn(`Blocked unauthorized request attempt.`);
      return res.status(401).json({ error: 'Unauthorized: Invalid or missing X-Api-Key configuration' });
    }
  }
  
  const { transaction, messageId } = req.body; 

  // Basic Guardrails: Enforce top-level payload structure integrity
  if (!messageId || !transaction) {
    logger.warn('Rejected request matching bad payload topology: Missing messageId or transaction block');
    return res.status(400).json({ 
      success: false, 
      error: 'Missing required fields: messageId and transaction objects are mandatory.' 
    });
  }

  try {
    await initActual();

    // Resolve target ledger account UUID
    const accountId = await resolveAccountId(transaction.targetAccount);

    // Duplicate Check Window: Scan recent records to check if our deterministic target ID already exists
    const startSearch = new Date(transaction.date);
    startSearch.setDate(startSearch.getDate() - 4); // Safely cover the ingestion window
    const startDate = startSearch.toISOString().split('T')[0];
    const endDate = new Date().toISOString().split('T')[0];

    const accountTxns = await Actual.getTransactions(accountId, startDate, endDate);
    
    // Determine target primary keys for exact duplication validation matching
    const targetKey = transaction.type === 'internal_transfer' 
      ? `${messageId}-inflow` 
      : messageId;

    const alreadyProcessed = accountTxns.some(tx => tx.id === targetKey);

    if (alreadyProcessed) {
      logger.info(`Skipping duplicate request tracking Sync-ID: ${messageId}`);
      await Actual.shutdown();
      return res.json({ success: true, message: 'Duplicate transaction injection skipped' });
    }

    const transactionsToInsert = [];
    const automationNote = '🤖 Automated Entry';

    // Branching Processing Topology based on execution metadata type
    if (transaction.type === 'internal_transfer') {
      logger.info(`Processing linked double-entry transfer from "${transaction.payee}" to "${transaction.targetAccount}"`);
      
      const sourceAccountId = await resolveAccountId(transaction.payee);
      const destinationAccountId = accountId;
      
      // CRITICAL GUARD: Prevent circular loop transfer failure
      if (sourceAccountId === destinationAccountId) {
        throw new Error(`Transfer aborted: Source and Destination accounts both resolved to the same ledger ID (${sourceAccountId}). Verify payload names.`);
      }

      logger.debug(`Resolved transfer accounts -> Source UUID: ${sourceAccountId} | Destination UUID: ${destinationAccountId}`);
      
      const payeesList = await Actual.getPayees();
      const sourceTransferPayee = payeesList.find(p => p.transfer_acct === sourceAccountId);
      const destinationTransferPayee = payeesList.find(p => p.transfer_acct === destinationAccountId);

      if (!sourceTransferPayee || !destinationTransferPayee) {
        throw new Error('Failed structural integrity check: Missing corresponding system-managed transfer payees.');
      }

      logger.debug(`Resolved system transfer payees -> Source Payee ID: ${sourceTransferPayee.id} | Destination Payee ID: ${destinationTransferPayee.id}`);

      // Generate deterministic keys derived directly from the messageId to cleanly bind legs without table collisions
      const idA = `${messageId}-inflow`;
      const idB = `${messageId}-outflow`;

      // Leg A: Destination Account ledger write layer (Inflow/Positive)
      transactionsToInsert.push({
        id: idA,
        transfer_id: idB,
        date: transaction.date,
        amount: transaction.amount,
        account: destinationAccountId,
        payee: sourceTransferPayee.id,
        cleared: false,
        notes: automationNote
      });

      // Leg B: Source Account ledger write layer (Outflow/Inverted Negative)
      transactionsToInsert.push({
        id: idB,
        transfer_id: idA,
        date: transaction.date,
        amount: -transaction.amount,
        account: sourceAccountId,
        payee: destinationTransferPayee.id,
        cleared: false,
        notes: automationNote
      });

      logger.debug(`Injecting explicit transfer pairs via addTransactions engine. Payloads:`, JSON.stringify(transactionsToInsert, null, 2));
      const [legA, legB] = transactionsToInsert;
      await Actual.addTransactions(legA.account, [legA]);
      await Actual.addTransactions(legB.account, [legB]);

    } else {
      logger.info(`Processing standard transaction record entry for payee: "${transaction.payee}"`);
      
      const standardPayload = {
        id: messageId, // Anchor the primary key to the immutable messageId
        date: transaction.date,
        amount: transaction.amount,
        account: accountId,
        payee_name: transaction.payee || null,
        payee: null,
        cleared: false,
        notes: automationNote
      };

      logger.debug(`Injecting standard single entry via addTransactions engine. Payload:`, JSON.stringify(standardPayload, null, 2));
      await Actual.addTransactions(accountId, [standardPayload]);
    }

    logger.debug('Synchronizing data delta changes to remote instance...');
    await Actual.sync();
    logger.info(`Successfully staged and synchronized transaction metrics.`);

    await Actual.shutdown();
    return res.json({ success: true, message: 'Transaction datasets processed and synced safely' });

  } catch (error) {
    logger.error('Failure intercepted inside endpoint execution runtime:', error);
    try { await Actual.shutdown(); } catch (_) {}
    return res.status(500).json({ error: error.message });
  }
});

app.listen(PORT, () => {
  logger.info(`Active configured logging filtering threshold: ${LOG_LEVEL}`);
  logger.info(`Actual Budget integration engine gateway operating on port ${PORT}`);
});