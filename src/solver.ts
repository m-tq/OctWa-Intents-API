import { v4 as uuidv4 } from 'uuid';
import { config } from './config.js';
import { intentStore } from './store.js';
import { oracle } from './oracle.js';
import {
  fetchOctraTransaction,
  parseIntentPayload,
  validateIntentPayload,
  sendOCT,
  getEscrowBalanceFresh,
} from './octra.js';
import { sendETH, fetchSepoliaTransaction, getHotWalletBalanceFresh } from './sepolia.js';
import { parseAndVerifyEvmEnvelope } from './crypto.js';
import type { Intent, SubmitResponse } from './types.js';

// Liquidity buffer - require 10% extra to handle concurrent swaps
const LIQUIDITY_BUFFER = 1.1;

/**
 * Intent Solver
 * Verifies intents and fulfills them
 * Supports: OCT → ETH and ETH → OCT
 */

// =============================================================================
// OCT → ETH SWAP
// =============================================================================

export async function processOctToEthSubmission(octraTxHash: string): Promise<SubmitResponse> {
  console.log('\n[SOLVER] ========== OCT → ETH SUBMISSION ==========');
  console.log('[SOLVER] octraTxHash:', octraTxHash);
  
  // Check if already processed
  const existing = intentStore.getByTxHash(octraTxHash);
  if (existing) {
    console.log('[SOLVER] ⚠️ Intent already exists:', existing.intentId);
    return {
      intentId: existing.intentId,
      status: existing.status,
      message: 'Intent already submitted',
    };
  }
  
  // Step 1: Fetch Octra transaction
  console.log('\n[SOLVER] Step 1: Fetching tx from Octra RPC...');
  const tx = await fetchOctraTransaction(octraTxHash);
  if (!tx) {
    return { intentId: '', status: 'REJECTED', message: 'Transaction not found on Octra chain' };
  }
  
  console.log('[SOLVER] ✅ Transaction found:', { from: tx.from, to: tx.to, amount: tx.amount, status: tx.status });
  
  // Step 2: Check confirmed
  if (tx.status !== 'confirmed') {
    return { intentId: '', status: 'REJECTED', message: `Transaction not confirmed: ${tx.status}` };
  }
  
  // Step 3: Parse intent payload
  console.log('\n[SOLVER] Step 3: Parsing intent payload...');
  const payload = parseIntentPayload(tx.message);
  if (!payload) {
    return { intentId: '', status: 'REJECTED', message: 'Invalid intent payload in transaction' };
  }
  
  console.log('[SOLVER] ✅ Payload:', { amountIn: payload.amountIn.toFixed(18), targetAddress: payload.targetAddress });
  
  // Step 4: Validate intent
  const validation = validateIntentPayload(payload, tx, config.octraEscrowAddress);
  if (!validation.valid) {
    return { intentId: '', status: 'REJECTED', message: validation.error || 'Validation failed' };
  }

  // Step 5: Check nonce
  if (intentStore.isNonceUsed(payload.nonce)) {
    return { intentId: '', status: 'REJECTED', message: 'Nonce already used' };
  }

  // Step 6: Calculate ETH output using oracle
  const ethOut = oracle.calculateEthOut(payload.amountIn, config.feeBps);
  console.log('[SOLVER] ETH output:', ethOut.toFixed(18), '(min:', payload.minAmountOut.toFixed(18), ')');

  if (ethOut < payload.minAmountOut) {
    return {
      intentId: '',
      status: 'REJECTED',
      message: `Output ${ethOut} ETH below minimum ${payload.minAmountOut} ETH`,
    };
  }

  // Step 6.5: Check ETH liquidity (FRESH - no cache)
  const ethBalance = parseFloat(await getHotWalletBalanceFresh());
  const requiredEth = ethOut * LIQUIDITY_BUFFER;
  console.log('[SOLVER] ETH liquidity check (fresh):', { available: ethBalance, required: requiredEth });

  const hasLiquidity = ethBalance >= requiredEth;
  if (!hasLiquidity) {
    console.log('[SOLVER] ⚠️ Insufficient liquidity, will queue for retry');
  } else {
    console.log('[SOLVER] ✅ ETH liquidity sufficient');
  }

  // Step 7: Create intent (even if liquidity insufficient - user already sent funds)
  const intentId = uuidv4();
  const intent: Intent = {
    intentId,
    direction: 'OCT_TO_ETH',
    sourceAddress: tx.from,
    sourceTxHash: octraTxHash,
    amountIn: payload.amountIn,
    targetAddress: payload.targetAddress,
    minAmountOut: payload.minAmountOut,
    status: hasLiquidity ? 'OPEN' : 'PENDING',
    expiry: payload.expiry,
    createdAt: Date.now(),
    payload,
  };

  intentStore.add(intent);
  console.log('[SOLVER] ✅ Intent created:', intentId, 'status:', intent.status);

  // Step 8: Fulfill if liquidity available, otherwise queue for retry
  if (hasLiquidity) {
    fulfillOctToEth(intentId, ethOut);
    return { intentId, status: 'OPEN', message: 'Intent submitted, fulfillment in progress' };
  } else {
    return {
      intentId,
      status: 'PENDING',
      message: 'Intent queued - waiting for liquidity. Will be fulfilled automatically when available.',
    };
  }
}

async function fulfillOctToEth(intentId: string, ethOut: number): Promise<void> {
  console.log('\n[FULFILL] Sending ETH for intent:', intentId);

  const intent = intentStore.get(intentId);
  if (!intent || (intent.status !== 'OPEN' && intent.status !== 'PENDING')) return;

  if (Date.now() > intent.expiry) {
    intentStore.update(intentId, { status: 'EXPIRED' });
    return;
  }
  
  const result = await sendETH(intent.targetAddress, ethOut);
  
  if (result.success && result.txHash) {
    console.log('[FULFILL] ✅ ETH sent:', result.txHash);
    intentStore.update(intentId, {
      status: 'FULFILLED',
      targetTxHash: result.txHash,
      amountOut: ethOut,
      fulfilledAt: Date.now(),
    });
    
    // Record swap for oracle price adjustment
    oracle.recordSwap('OCT_TO_ETH', intent.amountIn);
  } else {
    console.log('[FULFILL] ❌ Failed:', result.error);
  }
}

// =============================================================================
// ETH → OCT SWAP
// =============================================================================

export async function processEthToOctSubmission(sepoliaTxHash: string): Promise<SubmitResponse> {
  console.log('\n[SOLVER] ========== ETH → OCT SUBMISSION ==========');
  console.log('[SOLVER] sepoliaTxHash:', sepoliaTxHash);

  // Check if already processed
  const existing = intentStore.getByTxHash(sepoliaTxHash);
  if (existing) {
    return {
      intentId: existing.intentId,
      status: existing.status,
      message: 'Intent already submitted',
    };
  }

  // Step 1: Fetch Sepolia transaction
  console.log('\n[SOLVER] Step 1: Fetching tx from Sepolia...');
  const tx = await fetchSepoliaTransaction(sepoliaTxHash);
  if (!tx) {
    return { intentId: '', status: 'REJECTED', message: 'Transaction not found on Sepolia' };
  }

  console.log('[SOLVER] ✅ Transaction found:', {
    from: tx.from,
    to: tx.to,
    value: tx.value,
    status: tx.status,
    hasInput: tx.input && tx.input !== '0x',
  });

  // Step 2: Check confirmed
  if (tx.status !== 'confirmed') {
    return { intentId: '', status: 'REJECTED', message: `Transaction not confirmed: ${tx.status}` };
  }

  // Step 3: Validate tx.to is our escrow
  if (tx.to.toLowerCase() !== config.sepoliaEscrowAddress.toLowerCase()) {
    return {
      intentId: '',
      status: 'REJECTED',
      message: `Transaction not sent to ETH escrow. Expected: ${config.sepoliaEscrowAddress}, Got: ${tx.to}`,
    };
  }

  // Step 4: Parse and verify intent payload from tx.input (with hash verification)
  console.log('\n[SOLVER] Step 4: Parsing and verifying intent payload from tx.input...');
  const verifyResult = parseAndVerifyEvmEnvelope(tx.input || '');
  
  if (!verifyResult.valid) {
    return { intentId: '', status: 'REJECTED', message: verifyResult.error || 'Invalid payload' };
  }
  
  const intentData = verifyResult.payload!;
  console.log('[SOLVER] ✅ Intent data verified:', intentData);

  // Step 5: Validate target Octra address format
  if (!intentData.targetAddress.startsWith('oct')) {
    return { intentId: '', status: 'REJECTED', message: 'Invalid Octra address format' };
  }

  // Step 6: Check expiry
  if (Date.now() > intentData.expiry) {
    return { intentId: '', status: 'REJECTED', message: 'Intent has expired' };
  }

  // Step 7: Check nonce not used
  if (intentStore.isNonceUsed(intentData.nonce)) {
    return { intentId: '', status: 'REJECTED', message: 'Nonce already used' };
  }

  // Step 8: Parse ETH amount (wei to ETH)
  const ethAmount = parseFloat(tx.value) / 1e18;
  console.log('[SOLVER] ETH amount:', ethAmount.toFixed(18));

  if (ethAmount <= 0) {
    return { intentId: '', status: 'REJECTED', message: 'Invalid ETH amount' };
  }

  // Step 9: Calculate OCT output using oracle
  const octOut = oracle.calculateOctOut(ethAmount, config.feeBps);
  console.log('[SOLVER] OCT output:', octOut.toFixed(6), '(min:', intentData.minAmountOut.toFixed(6), ')');

  if (octOut < intentData.minAmountOut) {
    return {
      intentId: '',
      status: 'REJECTED',
      message: `Output ${octOut} OCT below minimum ${intentData.minAmountOut} OCT`,
    };
  }

  // Step 9.5: Check OCT liquidity (FRESH - no cache)
  const octBalance = await getEscrowBalanceFresh();
  const requiredOct = octOut * LIQUIDITY_BUFFER;
  console.log('[SOLVER] OCT liquidity check (fresh):', { available: octBalance, required: requiredOct });

  const hasLiquidity = octBalance >= requiredOct;
  if (!hasLiquidity) {
    console.log('[SOLVER] ⚠️ Insufficient liquidity, will queue for retry');
  } else {
    console.log('[SOLVER] ✅ OCT liquidity sufficient');
  }

  // Step 10: Create intent (even if liquidity insufficient - user already sent funds)
  const intentId = uuidv4();

  const payload = {
    version: 1 as const,
    intentType: 'swap' as const,
    fromAsset: 'ETH' as const,
    toAsset: 'OCT' as const,
    amountIn: ethAmount,
    minAmountOut: intentData.minAmountOut,
    targetChain: 'octra_mainnet' as const,
    targetAddress: intentData.targetAddress,
    expiry: intentData.expiry,
    nonce: intentData.nonce,
  };

  const intent: Intent = {
    intentId,
    direction: 'ETH_TO_OCT',
    sourceAddress: tx.from,
    sourceTxHash: sepoliaTxHash,
    amountIn: ethAmount,
    targetAddress: intentData.targetAddress,
    minAmountOut: intentData.minAmountOut,
    status: hasLiquidity ? 'OPEN' : 'PENDING',
    expiry: intentData.expiry,
    createdAt: Date.now(),
    payload,
  };

  intentStore.add(intent);
  console.log('[SOLVER] ✅ Intent created:', intentId, 'status:', intent.status);

  // Step 11: Fulfill if liquidity available, otherwise queue for retry
  if (hasLiquidity) {
    fulfillEthToOct(intentId, octOut);
    return { intentId, status: 'OPEN', message: 'Intent submitted, fulfillment in progress' };
  } else {
    return {
      intentId,
      status: 'PENDING',
      message: 'Intent queued - waiting for liquidity. Will be fulfilled automatically when available.',
    };
  }
}

async function fulfillEthToOct(intentId: string, octOut: number): Promise<void> {
  console.log('\n[FULFILL] Sending OCT for intent:', intentId);

  const intent = intentStore.get(intentId);
  if (!intent || (intent.status !== 'OPEN' && intent.status !== 'PENDING')) return;

  if (Date.now() > intent.expiry) {
    intentStore.update(intentId, { status: 'EXPIRED' });
    return;
  }

  // Send OCT to target address
  const result = await sendOCT(intent.targetAddress, octOut);

  if (result.success && result.txHash) {
    console.log('[FULFILL] ✅ OCT sent:', result.txHash);
    intentStore.update(intentId, {
      status: 'FULFILLED',
      targetTxHash: result.txHash,
      amountOut: octOut,
      fulfilledAt: Date.now(),
    });
    
    // Record swap for oracle price adjustment
    oracle.recordSwap('ETH_TO_OCT', octOut);
  } else {
    console.log('[FULFILL] ❌ Failed to send OCT:', result.error);
    // Keep as OPEN for retry or manual intervention
  }
}

// =============================================================================
// EXPIRY & RETRY CHECKER
// =============================================================================

export function startExpiryChecker(): void {
  console.log('[CHECKER] Starting expiry & retry checker (every 30s)');

  setInterval(async () => {
    const now = Date.now();

    // Check expired intents
    const openIntents = intentStore.getOpenIntents();
    for (const intent of openIntents) {
      if (now > intent.expiry) {
        console.log('[EXPIRY] Intent expired:', intent.intentId);
        intentStore.update(intent.intentId, { status: 'EXPIRED' });
      }
    }

    // Retry PENDING intents (waiting for liquidity)
    const pendingIntents = intentStore.getPendingIntents();
    for (const intent of pendingIntents) {
      // Skip if expired
      if (now > intent.expiry) {
        console.log('[RETRY] Pending intent expired:', intent.intentId);
        intentStore.update(intent.intentId, { status: 'EXPIRED' });
        continue;
      }

      console.log('[RETRY] Checking liquidity for pending intent:', intent.intentId);

      if (intent.direction === 'OCT_TO_ETH') {
        const ethOut = oracle.calculateEthOut(intent.amountIn, config.feeBps);
        const ethBalance = parseFloat(await getHotWalletBalanceFresh());
        const requiredEth = ethOut * LIQUIDITY_BUFFER;

        if (ethBalance >= requiredEth) {
          console.log('[RETRY] ✅ Liquidity available, fulfilling OCT→ETH intent:', intent.intentId);
          intentStore.update(intent.intentId, { status: 'OPEN' });
          fulfillOctToEth(intent.intentId, ethOut);
        } else {
          console.log('[RETRY] Still waiting for ETH liquidity:', { available: ethBalance, required: requiredEth });
        }
      } else if (intent.direction === 'ETH_TO_OCT') {
        const octOut = oracle.calculateOctOut(intent.amountIn, config.feeBps);
        const octBalance = await getEscrowBalanceFresh();
        const requiredOct = octOut * LIQUIDITY_BUFFER;

        if (octBalance >= requiredOct) {
          console.log('[RETRY] ✅ Liquidity available, fulfilling ETH→OCT intent:', intent.intentId);
          intentStore.update(intent.intentId, { status: 'OPEN' });
          fulfillEthToOct(intent.intentId, octOut);
        } else {
          console.log('[RETRY] Still waiting for OCT liquidity:', { available: octBalance, required: requiredOct });
        }
      }
    }
  }, 30000);
}
