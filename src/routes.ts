import { Router, Request, Response } from 'express';
import { config } from './config.js';
import { intentStore } from './store.js';
import { oracle } from './oracle.js';
import { processOctToEthSubmission, processEthToOctSubmission } from './solver.js';
import { fetchOctraTransaction, getEscrowBalance as getOctEscrowBalance } from './octra.js';
import { getEscrowAddress, getHotWalletBalance, fetchSepoliaTransaction, getAddressBalance, getTxReceiptStatus } from './sepolia.js';
import type { QuoteResponse, SubmitOctToEthRequest, StatusResponse } from './types.js';

// ETH→OCT submit request (only txHash, payload is in tx.input)
interface SubmitEthToOctRequest {
  sepoliaTxHash: string;
}

export const router = Router();

// =============================================================================
// HELPERS
// =============================================================================

/**
 * Format number to fixed decimal string without scientific notation
 * Handles very small numbers like 0.000000015
 */
function formatAmount(num: number, decimals: number = 18): string {
  if (num === 0) return '0';
  // Use toFixed to avoid scientific notation, then remove trailing zeros
  const fixed = num.toFixed(decimals);
  // Remove trailing zeros but keep at least one decimal place for small numbers
  return fixed.replace(/\.?0+$/, '') || '0';
}

/**
 * Format number for JSON response - returns number type but safe from scientific notation
 * For very small numbers, we keep more precision
 */
function safeNumber(num: number): number {
  if (num === 0) return 0;
  // Convert to string with fixed decimals then back to number
  // This ensures JSON.stringify won't use scientific notation for reasonable values
  const str = num.toFixed(18).replace(/\.?0+$/, '');
  return parseFloat(str);
}

// =============================================================================
// SECURITY: Input Validation Helpers
// =============================================================================

// Validate Octra transaction hash format
function isValidOctraTxHash(hash: string): boolean {
  // Octra tx hashes are typically 64 hex chars
  return typeof hash === 'string' && /^[a-fA-F0-9]{64}$/.test(hash);
}

// Validate Ethereum transaction hash format
function isValidEthTxHash(hash: string): boolean {
  return typeof hash === 'string' && /^0x[a-fA-F0-9]{64}$/.test(hash);
}

// Validate intent ID format (UUID)
function isValidIntentId(id: string): boolean {
  return typeof id === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(id);
}

// Validate address format
function isValidAddress(address: string): boolean {
  if (!address || typeof address !== 'string') return false;
  // Octra address or EVM address
  return address.startsWith('oct') || /^0x[a-fA-F0-9]{40}$/.test(address);
}

// =============================================================================
// QUOTE ENDPOINTS
// =============================================================================

/**
 * GET /quote
 * Get quote for OCT → ETH or ETH → OCT
 */
router.get('/quote', async (req: Request, res: Response) => {
  const { from, to, amount, slippageBps: slippageParam } = req.query;
  
  console.log('\n[QUOTE] GET /quote', { from, to, amount, slippageBps: slippageParam });
  
  const amountIn = parseFloat(amount as string);
  if (isNaN(amountIn) || amountIn <= 0) {
    res.status(400).json({ error: 'Invalid amount' });
    return;
  }
  
  // Parse slippage (default 0.5% = 50 bps)
  const slippageBps = slippageParam ? parseInt(slippageParam as string) : 50;
  const slippageMultiplier = 1 - slippageBps / 10000;
  
  const { rate } = oracle.getRate();
  
  if (from === 'OCT' && to === 'ETH') {
    // Security: Check swap limits
    if (amountIn < config.minSwapOct) {
      res.status(400).json({ error: `Minimum swap amount is ${config.minSwapOct} OCT` });
      return;
    }
    if (amountIn > config.maxSwapOct) {
      res.status(400).json({ error: `Maximum swap amount is ${config.maxSwapOct} OCT` });
      return;
    }
    
    // OCT → ETH
    const estimatedOut = oracle.calculateEthOut(amountIn, config.feeBps);
    const minAmountOut = estimatedOut * slippageMultiplier;
    
    // Check ETH liquidity
    let liquidityAvailable: number | null = null;
    let hasLiquidity = true;
    try {
      const ethBalanceStr = await getHotWalletBalance();
      liquidityAvailable = parseFloat(ethBalanceStr);
      hasLiquidity = liquidityAvailable >= minAmountOut;
    } catch (err) {
      console.error('[QUOTE] Failed to check ETH liquidity:', err);
    }
    
    const quote = {
      from: 'OCT',
      to: 'ETH',
      amountIn: safeNumber(amountIn),
      estimatedOut: safeNumber(estimatedOut),
      minAmountOut: safeNumber(minAmountOut),
      rate: safeNumber(rate),
      feeBps: config.feeBps,
      slippageBps,
      expiresIn: config.quoteExpirySeconds,
      escrowAddress: config.octraEscrowAddress,
      network: 'ethereum_sepolia',
      liquidity: {
        available: liquidityAvailable !== null ? safeNumber(liquidityAvailable) : null,
        required: safeNumber(minAmountOut),
        sufficient: hasLiquidity,
      },
    };
    
    console.log('[QUOTE] OCT→ETH:', { amountIn, estimatedOut, minAmountOut, hasLiquidity, liquidityAvailable });
    res.json(quote);
    
  } else if (from === 'ETH' && to === 'OCT') {
    // Security: Check swap limits
    if (amountIn < config.minSwapEth) {
      res.status(400).json({ error: `Minimum swap amount is ${config.minSwapEth} ETH` });
      return;
    }
    if (amountIn > config.maxSwapEth) {
      res.status(400).json({ error: `Maximum swap amount is ${config.maxSwapEth} ETH` });
      return;
    }
    
    // ETH → OCT
    const estimatedOut = oracle.calculateOctOut(amountIn, config.feeBps);
    const minAmountOut = estimatedOut * slippageMultiplier;
    const inverseRate = 1 / rate;
    
    // Check OCT liquidity
    let liquidityAvailable: number | null = null;
    let hasLiquidity = true;
    try {
      liquidityAvailable = await getOctEscrowBalance();
      hasLiquidity = liquidityAvailable >= minAmountOut;
    } catch (err) {
      console.error('[QUOTE] Failed to check OCT liquidity:', err);
    }
    
    const quote = {
      from: 'ETH',
      to: 'OCT',
      amountIn: safeNumber(amountIn),
      estimatedOut: safeNumber(estimatedOut),
      minAmountOut: safeNumber(minAmountOut),
      rate: safeNumber(inverseRate),
      feeBps: config.feeBps,
      slippageBps,
      expiresIn: config.quoteExpirySeconds,
      escrowAddress: getEscrowAddress(),
      network: 'octra_mainnet',
      liquidity: {
        available: liquidityAvailable !== null ? safeNumber(liquidityAvailable) : null,
        required: safeNumber(minAmountOut),
        sufficient: hasLiquidity,
      },
    };
    
    console.log('[QUOTE] ETH→OCT:', { amountIn, estimatedOut, minAmountOut, hasLiquidity, liquidityAvailable });
    res.json(quote);
    
  } else {
    res.status(400).json({ error: 'Only OCT ⇄ ETH swaps supported' });
  }
});

// =============================================================================
// SWAP ENDPOINTS
// =============================================================================

/**
 * POST /swap/submit
 * Submit OCT → ETH swap (legacy endpoint, kept for compatibility)
 */
router.post('/swap/submit', async (req: Request, res: Response) => {
  const { octraTxHash } = req.body as SubmitOctToEthRequest;
  
  console.log('\n[SUBMIT] POST /swap/submit (OCT→ETH)');
  
  if (!octraTxHash) {
    res.status(400).json({ error: 'octraTxHash is required' });
    return;
  }
  
  // Security: Validate tx hash format
  if (!isValidOctraTxHash(octraTxHash)) {
    res.status(400).json({ error: 'Invalid transaction hash format' });
    return;
  }
  
  try {
    const result = await processOctToEthSubmission(octraTxHash);
    res.status(result.status === 'REJECTED' ? 400 : 200).json(result);
  } catch (error) {
    console.error('[SUBMIT] Error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * POST /swap/oct-to-eth
 * Submit OCT → ETH swap
 */
router.post('/swap/oct-to-eth', async (req: Request, res: Response) => {
  const { octraTxHash } = req.body as SubmitOctToEthRequest;
  
  console.log('\n[SUBMIT] POST /swap/oct-to-eth');
  
  if (!octraTxHash) {
    res.status(400).json({ error: 'octraTxHash is required' });
    return;
  }
  
  // Security: Validate tx hash format
  if (!isValidOctraTxHash(octraTxHash)) {
    res.status(400).json({ error: 'Invalid transaction hash format' });
    return;
  }
  
  try {
    const result = await processOctToEthSubmission(octraTxHash);
    res.status(result.status === 'REJECTED' ? 400 : 200).json(result);
  } catch (error) {
    console.error('[SUBMIT] Error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * POST /swap/eth-to-oct
 * Submit ETH → OCT swap
 * Intent payload is parsed from tx.input (hex encoded JSON)
 */
router.post('/swap/eth-to-oct', async (req: Request, res: Response) => {
  const { sepoliaTxHash } = req.body as SubmitEthToOctRequest;

  console.log('\n[SUBMIT] POST /swap/eth-to-oct');

  if (!sepoliaTxHash) {
    res.status(400).json({ error: 'sepoliaTxHash is required' });
    return;
  }

  // Security: Validate tx hash format
  if (!isValidEthTxHash(sepoliaTxHash)) {
    res.status(400).json({ error: 'Invalid transaction hash format' });
    return;
  }

  try {
    const result = await processEthToOctSubmission(sepoliaTxHash);
    res.status(result.status === 'REJECTED' ? 400 : 200).json(result);
  } catch (error) {
    console.error('[SUBMIT] Error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * GET /swap/:intentId
 * Get intent status
 */
router.get('/swap/:intentId', (req: Request, res: Response) => {
  const { intentId } = req.params;
  
  // Security: Validate intent ID format
  if (!isValidIntentId(intentId)) {
    res.status(400).json({ error: 'Invalid intent ID format' });
    return;
  }
  
  const intent = intentStore.get(intentId);
  if (!intent) {
    res.status(404).json({ error: 'Intent not found' });
    return;
  }
  
  const response: StatusResponse = {
    intentId: intent.intentId,
    direction: intent.direction,
    status: intent.status,
    sourceAddress: intent.sourceAddress,
    sourceTxHash: intent.sourceTxHash,
    targetAddress: intent.targetAddress,
    targetTxHash: intent.targetTxHash,
    amountIn: intent.amountIn,
    amountOut: intent.amountOut,
  };
  
  res.json(response);
});

// =============================================================================
// ORACLE ENDPOINTS
// =============================================================================

/**
 * GET /oracle/price
 * Get current OCT/ETH rate
 */
router.get('/oracle/price', (_req: Request, res: Response) => {
  const { rate, updatedAt } = oracle.getRate();
  const inverse = oracle.getInverseRate();
  
  res.json({
    pair: 'OCT/ETH',
    rate,
    inverseRate: inverse.rate,
    updatedAt,
    feeBps: config.feeBps,
  });
});

/**
 * GET /oracle/price/history
 * Get price history
 */
router.get('/oracle/price/history', (req: Request, res: Response) => {
  const limit = parseInt(req.query.limit as string) || 100;
  const history = oracle.getHistory(limit);
  
  res.json({
    count: history.length,
    history,
  });
});

/**
 * GET /oracle/stats
 * Get oracle stats (volume, price impact)
 */
router.get('/oracle/stats', (_req: Request, res: Response) => {
  const stats = oracle.getStats();
  res.json(stats);
});

// =============================================================================
// PROXY ENDPOINTS (for CORS bypass)
// =============================================================================

/**
 * GET /octra/tx/:txHash
 * Proxy to Octra RPC
 */
router.get('/octra/tx/:txHash', async (req: Request, res: Response) => {
  const { txHash } = req.params;
  
  try {
    const tx = await fetchOctraTransaction(txHash);
    if (!tx) {
      res.status(404).json({ error: 'Transaction not found' });
      return;
    }
    res.json(tx);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch transaction' });
  }
});

/**
 * GET /octra/status
 * Proxy to Octra RPC /status
 */
router.get('/octra/status', async (_req: Request, res: Response) => {
  try {
    const response = await fetch(`${config.octraRpcUrl}/status`);
    if (!response.ok) {
      res.status(response.status).json({ error: 'Failed to fetch status' });
      return;
    }
    const data = await response.json();
    res.json(data);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch status' });
  }
});

/**
 * GET /sepolia/tx/:txHash
 * Proxy to Sepolia RPC - get transaction details
 */
router.get('/sepolia/tx/:txHash', async (req: Request, res: Response) => {
  const { txHash } = req.params;
  
  if (!isValidEthTxHash(txHash)) {
    res.status(400).json({ error: 'Invalid transaction hash format' });
    return;
  }
  
  try {
    const tx = await fetchSepoliaTransaction(txHash);
    if (!tx) {
      res.status(404).json({ error: 'Transaction not found' });
      return;
    }
    res.json(tx);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch transaction' });
  }
});

/**
 * GET /sepolia/tx/:txHash/status
 * Get Sepolia transaction receipt status
 */
router.get('/sepolia/tx/:txHash/status', async (req: Request, res: Response) => {
  const { txHash } = req.params;
  
  if (!isValidEthTxHash(txHash)) {
    res.status(400).json({ error: 'Invalid transaction hash format' });
    return;
  }
  
  try {
    const result = await getTxReceiptStatus(txHash);
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch transaction status' });
  }
});

/**
 * GET /sepolia/balance/:address
 * Get ETH balance for an address
 */
router.get('/sepolia/balance/:address', async (req: Request, res: Response) => {
  const { address } = req.params;
  
  if (!isValidAddress(address)) {
    res.status(400).json({ error: 'Invalid address format' });
    return;
  }
  
  try {
    const balance = await getAddressBalance(address);
    res.json({
      address,
      balance: parseFloat(balance),
      balanceWei: balance,
      network: 'sepolia',
    });
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch balance' });
  }
});

// =============================================================================
// UTILITY ENDPOINTS
// =============================================================================

/**
 * GET /health
 */
router.get('/health', (_req: Request, res: Response) => {
  const { rate } = oracle.getRate();
  res.json({
    status: 'ok',
    timestamp: Date.now(),
    version: '2.0.0',
    oracleRate: rate,
  });
});

/**
 * GET /liquidity
 * Check escrow liquidity for both directions
 */
router.get('/liquidity', async (_req: Request, res: Response) => {
  try {
    // Get OCT escrow balance (for ETH→OCT swaps)
    const octBalance = await getOctEscrowBalance();
    
    // Get ETH escrow balance (for OCT→ETH swaps)
    const ethBalanceStr = await getHotWalletBalance();
    const ethBalance = parseFloat(ethBalanceStr);
    
    // Define minimum liquidity thresholds
    const minOctLiquidity = config.minSwapOct * 10; // At least 10x min swap
    const minEthLiquidity = config.minSwapEth * 10; // At least 10x min swap
    
    const octSufficient = octBalance >= minOctLiquidity;
    const ethSufficient = ethBalance >= minEthLiquidity;
    
    res.json({
      oct: {
        balance: octBalance,
        minRequired: minOctLiquidity,
        sufficient: octSufficient,
      },
      eth: {
        balance: ethBalance,
        minRequired: minEthLiquidity,
        sufficient: ethSufficient,
      },
      canSwapOctToEth: ethSufficient,
      canSwapEthToOct: octSufficient,
      operational: octSufficient && ethSufficient,
    });
  } catch (error) {
    console.error('[LIQUIDITY] Error checking liquidity:', error);
    res.status(500).json({ error: 'Failed to check liquidity' });
  }
});

/**
 * GET /intents
 * List all intents (debug) - ONLY available in debug mode
 */
router.get('/intents', (_req: Request, res: Response) => {
  // Security: Only allow in debug mode
  if (!config.debugMode) {
    res.status(403).json({ error: 'Debug endpoint disabled in production' });
    return;
  }
  
  const intents = intentStore.getAll();
  res.json({
    count: intents.length,
    intents: intents.map(i => ({
      intentId: i.intentId,
      direction: i.direction,
      status: i.status,
      amountIn: i.amountIn,
      amountOut: i.amountOut,
      sourceAddress: i.sourceAddress,
      targetAddress: i.targetAddress,
      createdAt: i.createdAt,
    })),
  });
});

/**
 * GET /explorer
 * Public explorer - list all swaps with pagination
 */
router.get('/explorer', (req: Request, res: Response) => {
  const page = Math.max(1, parseInt(req.query.page as string) || 1);
  const limit = Math.min(100, Math.max(1, parseInt(req.query.limit as string) || 20));
  const status = req.query.status as string;
  const direction = req.query.direction as string;
  
  console.log(`\n[EXPLORER] GET /explorer page=${page} limit=${limit}`);
  
  let intents = intentStore.getAll();
  
  // Filter by status if provided
  if (status && ['PENDING', 'FULFILLED', 'FAILED', 'REJECTED'].includes(status.toUpperCase())) {
    intents = intents.filter(i => i.status === status.toUpperCase());
  }
  
  // Filter by direction if provided
  if (direction && ['OCT_TO_ETH', 'ETH_TO_OCT'].includes(direction.toUpperCase())) {
    intents = intents.filter(i => i.direction === direction.toUpperCase());
  }
  
  // Sort by createdAt descending (newest first)
  intents.sort((a, b) => b.createdAt - a.createdAt);
  
  const total = intents.length;
  const totalPages = Math.ceil(total / limit);
  const offset = (page - 1) * limit;
  const paginatedIntents = intents.slice(offset, offset + limit);
  
  // Get stats
  const stats = {
    totalSwaps: intentStore.getAll().length,
    fulfilled: intentStore.getAll().filter(i => i.status === 'FULFILLED').length,
    pending: intentStore.getAll().filter(i => i.status === 'PENDING').length,
    failed: intentStore.getAll().filter(i => i.status === 'FAILED' || i.status === 'REJECTED').length,
  };
  
  const swaps = paginatedIntents.map(i => ({
    id: i.intentId,
    direction: i.direction,
    status: i.status,
    sourceAddress: i.sourceAddress,
    targetAddress: i.targetAddress,
    sourceTxHash: i.sourceTxHash,
    targetTxHash: i.targetTxHash,
    amountIn: i.amountIn,
    amountOut: i.amountOut,
    createdAt: i.createdAt,
    fulfilledAt: i.fulfilledAt,
  }));
  
  res.json({
    page,
    limit,
    total,
    totalPages,
    stats,
    swaps,
  });
});

/**
 * GET /history/:address
 * Get swap history for a user address (Octra or EVM)
 */
router.get('/history/:address', (req: Request, res: Response) => {
  const { address } = req.params;
  const limit = Math.min(100, Math.max(1, parseInt(req.query.limit as string) || 50));
  
  console.log(`\n[HISTORY] GET /history/${address}`);
  
  if (!address) {
    res.status(400).json({ error: 'Address is required' });
    return;
  }
  
  // Security: Validate address format
  if (!isValidAddress(address)) {
    res.status(400).json({ error: 'Invalid address format' });
    return;
  }
  
  const intents = intentStore.getByUserAddress(address, limit);
  
  console.log(`[HISTORY] Found ${intents.length} intents`);
  intents.forEach(i => {
    console.log(`[HISTORY]   ${i.intentId}: ${i.direction} ${i.status} sourceTx=${i.sourceTxHash?.slice(0,10)} targetTx=${i.targetTxHash?.slice(0,10) || 'null'}`);
  });
  
  const history = intents.map(i => ({
    id: i.intentId,
    direction: i.direction,
    status: i.status.toLowerCase(),
    payload: {
      fromAsset: i.direction === 'OCT_TO_ETH' ? 'OCT' : 'ETH',
      toAsset: i.direction === 'OCT_TO_ETH' ? 'ETH' : 'OCT',
      amountIn: i.amountIn,
      minAmountOut: i.payload.minAmountOut,
      targetAddress: i.targetAddress,
    },
    sourceTxHash: i.sourceTxHash,
    targetTxHash: i.targetTxHash,
    amountOut: i.amountOut,
    createdAt: i.createdAt,
    fulfilledAt: i.fulfilledAt,
    error: i.error,
  }));
  
  res.json({
    address,
    count: history.length,
    swaps: history,
  });
});
