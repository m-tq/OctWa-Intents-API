import { config } from './config.js';
import type { OctraTransaction, SwapIntentPayload } from './types.js';
import nacl from 'tweetnacl';

/**
 * Octra Chain Operations
 * - Fetch and validate transactions
 * - Send OCT for ETH→OCT fulfillment
 */

const MU_FACTOR = 1_000_000; // 1 OCT = 1,000,000 micro units

// Escrow wallet state
let escrowAddress: string | null = null;
let escrowPrivateKey: Uint8Array | null = null;
let escrowPublicKey: Uint8Array | null = null;
let currentNonce: number = 0;

/**
 * Initialize Octra escrow wallet for sending OCT
 */
export async function initOctraEscrow(): Promise<boolean> {
  if (!config.octraPrivateKey) {
    console.warn('[OCTRA] No private key configured - ETH→OCT fulfillment disabled');
    return false;
  }

  try {
    // Decode base64 private key (32 bytes seed)
    escrowPrivateKey = new Uint8Array(Buffer.from(config.octraPrivateKey, 'base64'));
    
    // Derive keypair from seed
    const keyPair = nacl.sign.keyPair.fromSeed(escrowPrivateKey);
    escrowPublicKey = keyPair.publicKey;
    
    // Use configured escrow address
    escrowAddress = config.octraEscrowAddress;
    
    // Fetch current nonce
    await refreshNonce();
    
    console.log('[OCTRA] Escrow wallet initialized');
    console.log('[OCTRA]   Address:', escrowAddress);
    console.log('[OCTRA]   Nonce:', currentNonce);
    
    return true;
  } catch (error) {
    console.error('[OCTRA] Failed to initialize escrow:', error);
    return false;
  }
}

/**
 * Refresh nonce from chain
 */
async function refreshNonce(): Promise<void> {
  if (!escrowAddress) return;
  
  try {
    const response = await fetch(`${config.octraRpcUrl}/balance/${escrowAddress}`);
    if (response.ok) {
      const data = await response.json() as { nonce?: number };
      currentNonce = data.nonce || 0;
      console.log('[OCTRA] Refreshed nonce:', currentNonce);
    }
  } catch (error) {
    console.warn('[OCTRA] Failed to refresh nonce:', error);
  }
}

// Balance cache
let cachedOctBalance: number | null = null;
let octBalanceCacheTime: number = 0;
const OCT_BALANCE_CACHE_TTL = 15000; // 15 seconds

/**
 * Get escrow wallet balance (cached for quotes)
 */
export async function getEscrowBalance(): Promise<number> {
  if (!escrowAddress) return 0;

  // Return cached balance if still valid
  const now = Date.now();
  if (cachedOctBalance !== null && now - octBalanceCacheTime < OCT_BALANCE_CACHE_TTL) {
    return cachedOctBalance;
  }

  try {
    const response = await fetch(`${config.octraRpcUrl}/balance/${escrowAddress}`);
    if (response.ok) {
      const data = (await response.json()) as { balance?: string };
      cachedOctBalance = parseFloat(data.balance || '0') || 0;
      octBalanceCacheTime = now;
      return cachedOctBalance;
    }
  } catch (error) {
    console.error('[OCTRA] Failed to get balance:', error);
  }
  return cachedOctBalance || 0;
}

/**
 * Get escrow wallet balance FRESH (bypass cache) - use for submit validation
 */
export async function getEscrowBalanceFresh(): Promise<number> {
  if (!escrowAddress) return 0;

  try {
    const response = await fetch(`${config.octraRpcUrl}/balance/${escrowAddress}`);
    if (response.ok) {
      const data = (await response.json()) as { balance?: string };
      const balance = parseFloat(data.balance || '0') || 0;
      // Also update cache
      cachedOctBalance = balance;
      octBalanceCacheTime = Date.now();
      return balance;
    }
  } catch (error) {
    console.error('[OCTRA] Failed to get fresh balance:', error);
  }
  return 0;
}

/**
 * Send OCT to fulfill ETH→OCT swap
 * Waits for transaction confirmation before returning
 */
export async function sendOCT(
  toAddress: string,
  amount: number,
  message?: string
): Promise<{ success: boolean; txHash?: string; error?: string }> {
  if (!escrowAddress || !escrowPrivateKey || !escrowPublicKey) {
    return { success: false, error: 'Octra escrow not initialized' };
  }

  try {
    // Validate recipient address
    if (!toAddress.startsWith('oct')) {
      return { success: false, error: 'Invalid Octra address format' };
    }

    // Refresh nonce before sending
    await refreshNonce();
    const txNonce = currentNonce + 1;

    // Convert amount to micro units
    const amountMu = Math.floor(amount * MU_FACTOR);

    // Create transaction object
    const timestamp = Date.now() / 1000;
    const ou = amount < 1000 ? '10000' : '30000';

    const transaction: Record<string, unknown> = {
      from: escrowAddress,
      to_: toAddress,
      amount: amountMu.toString(),
      nonce: txNonce,
      ou,
      timestamp,
    };

    if (message) {
      transaction.message = message;
    }

    // Create signing data (exclude message field like CLI does)
    const signingObject = {
      from: transaction.from,
      to_: transaction.to_,
      amount: transaction.amount,
      nonce: transaction.nonce,
      ou: transaction.ou,
      timestamp: transaction.timestamp,
    };
    const signingData = JSON.stringify(signingObject);

    // Create secret key for nacl (64 bytes: 32 private + 32 public)
    const secretKey = new Uint8Array(64);
    secretKey.set(escrowPrivateKey, 0);
    secretKey.set(escrowPublicKey, 32);

    // Sign the transaction
    const signature = nacl.sign.detached(new TextEncoder().encode(signingData), secretKey);

    // Add signature and public key
    transaction.signature = Buffer.from(signature).toString('base64');
    transaction.public_key = Buffer.from(escrowPublicKey).toString('base64');

    console.log('[OCTRA] Sending transaction:');
    console.log('[OCTRA]   from:', escrowAddress);
    console.log('[OCTRA]   to:', toAddress);
    console.log('[OCTRA]   amount:', amount, 'OCT');
    console.log('[OCTRA]   nonce:', txNonce);

    // Send to Octra RPC
    const response = await fetch(`${config.octraRpcUrl}/send-tx`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(transaction),
    });

    const result = await response.json() as { hash?: string; tx_hash?: string; txHash?: string; error?: string };

    if (!response.ok) {
      console.error('[OCTRA] ❌ Transaction failed:', result);
      return { success: false, error: result.error || 'Transaction failed' };
    }

    const txHash = result.hash || result.tx_hash || result.txHash;
    
    if (!txHash) {
      console.error('[OCTRA] ❌ No transaction hash in response');
      return { success: false, error: 'No transaction hash returned' };
    }
    
    console.log('[OCTRA] Transaction submitted:', txHash);

    // Update local nonce
    currentNonce = txNonce;

    // Wait for confirmation
    console.log('[OCTRA] Waiting for confirmation...');
    const confirmed = await waitForOctraConfirmation(txHash);
    
    if (confirmed) {
      console.log('[OCTRA] ✅ Transaction confirmed:', txHash);
      return { success: true, txHash };
    } else {
      console.log('[OCTRA] ❌ Transaction not confirmed:', txHash);
      return { success: false, txHash, error: 'Transaction not confirmed' };
    }
  } catch (error) {
    console.error('[OCTRA] ❌ Send error:', error);
    return { success: false, error: (error as Error).message };
  }
}

/**
 * Wait for Octra transaction confirmation
 * Uses epoch-based confirmation: if epoch changes and tx still pending, it failed
 */
async function waitForOctraConfirmation(
  txHash: string,
  timeoutMs: number = 120000,
  pollIntervalMs: number = 5000
): Promise<boolean> {
  const startTime = Date.now();
  
  // Get initial epoch
  let initialEpoch: number | null = null;
  try {
    const statusResponse = await fetch(`${config.octraRpcUrl}/status`);
    if (statusResponse.ok) {
      const statusData = await statusResponse.json() as { current_epoch?: number; epoch?: number };
      initialEpoch = statusData.current_epoch || statusData.epoch || null;
    }
  } catch {
    console.warn('[OCTRA] Could not get initial epoch');
  }
  
  console.log('[OCTRA] Initial epoch:', initialEpoch);
  
  while (Date.now() - startTime < timeoutMs) {
    try {
      // Check tx status
      const tx = await fetchOctraTransaction(txHash);
      
      if (tx?.status === 'confirmed') {
        return true;
      }
      
      if (tx?.status === 'failed') {
        return false;
      }
      
      // Check if epoch changed (tx missed the block)
      if (initialEpoch !== null) {
        const statusResponse = await fetch(`${config.octraRpcUrl}/status`);
        if (statusResponse.ok) {
          const statusData = await statusResponse.json() as { current_epoch?: number; epoch?: number };
          const currentEpoch = statusData.current_epoch || statusData.epoch || null;
          
          if (currentEpoch !== null && currentEpoch > initialEpoch) {
            // Epoch changed, check one more time
            const finalTx = await fetchOctraTransaction(txHash);
            if (finalTx?.status === 'confirmed') {
              return true;
            }
            console.log('[OCTRA] Epoch changed but tx not confirmed - failed');
            return false;
          }
        }
      }
      
      console.log('[OCTRA] Tx status:', tx?.status || 'unknown', '- waiting...');
    } catch (error) {
      console.warn('[OCTRA] Error checking tx status:', error);
    }
    
    await new Promise(resolve => setTimeout(resolve, pollIntervalMs));
  }
  
  console.log('[OCTRA] Timeout waiting for confirmation');
  return false;
}

export async function fetchOctraTransaction(txHash: string): Promise<OctraTransaction | null> {
  const url = `${config.octraRpcUrl}/tx/${txHash}`;
  console.log('[OCTRA] Fetching transaction:', url);
  
  try {
    const response = await fetch(url);
    
    if (!response.ok) {
      console.error(`[OCTRA] ❌ Failed to fetch tx ${txHash}: ${response.status}`);
      return null;
    }
    
    const data = await response.json() as Record<string, unknown>;
    console.log('[OCTRA] Raw response:', JSON.stringify(data, null, 2));
    
    const tx: OctraTransaction = {
      hash: (data.hash as string) || txHash,
      from: (data.from as string) || (data.sender as string) || '',
      to: (data.to as string) || (data.recipient as string) || '',
      amount: parseFloat(data.amount as string) || 0,
      message: (data.message as string) || (data.memo as string) || undefined,
      status: data.status === 'confirmed' ? 'confirmed' :
              data.status === 'failed' ? 'failed' : 'pending',
      blockHeight: (data.blockHeight as number) || (data.block_height as number),
    };
    
    console.log('[OCTRA] Parsed transaction:', tx);
    return tx;
  } catch (error) {
    console.error(`[OCTRA] ❌ Error fetching tx ${txHash}:`, error);
    return null;
  }
}

export function parseIntentPayload(message: string | undefined): SwapIntentPayload | null {
  console.log('[OCTRA] Parsing intent payload from message...');
  
  if (!message) {
    console.log('[OCTRA] ❌ No message in transaction');
    return null;
  }
  
  try {
    // Message format: { payload: SwapIntentPayload, signature: string }
    // Or just the payload directly
    console.log('[OCTRA] Raw message:', message);
    
    const parsed = JSON.parse(message);
    const payload = parsed.payload || parsed;
    
    console.log('[OCTRA] Parsed payload:', payload);
    
    // Validate required fields
    if (
      payload.version !== 1 ||
      payload.intentType !== 'swap' ||
      payload.fromAsset !== 'OCT' ||
      payload.toAsset !== 'ETH' ||
      typeof payload.amountIn !== 'number' ||
      typeof payload.minAmountOut !== 'number' ||
      payload.targetChain !== 'ethereum_sepolia' ||
      typeof payload.targetAddress !== 'string' ||
      typeof payload.expiry !== 'number' ||
      typeof payload.nonce !== 'string'
    ) {
      console.log('[OCTRA] ❌ Invalid payload structure');
      console.log('[OCTRA]   version:', payload.version, '(expected 1)');
      console.log('[OCTRA]   intentType:', payload.intentType, '(expected swap)');
      console.log('[OCTRA]   fromAsset:', payload.fromAsset, '(expected OCT)');
      console.log('[OCTRA]   toAsset:', payload.toAsset, '(expected ETH)');
      return null;
    }
    
    console.log('[OCTRA] ✅ Payload validated');
    return payload as SwapIntentPayload;
  } catch (error) {
    console.error('[OCTRA] ❌ Failed to parse message:', error);
    return null;
  }
}

export function validateIntentPayload(
  payload: SwapIntentPayload,
  tx: OctraTransaction,
  escrowAddress: string
): { valid: boolean; error?: string } {
  console.log('[OCTRA] Validating intent payload...');
  
  // 1. Check tx.to == escrowAddress
  console.log('[OCTRA]   Check 1: tx.to == escrowAddress');
  console.log('[OCTRA]     tx.to:', tx.to);
  console.log('[OCTRA]     escrowAddress:', escrowAddress);
  
  if (tx.to !== escrowAddress) {
    return { valid: false, error: `Transaction not sent to escrow address. Expected: ${escrowAddress}, Got: ${tx.to}` };
  }
  console.log('[OCTRA]   ✅ Escrow address matches');
  
  // 2. Check tx.amount == payload.amountIn
  console.log('[OCTRA]   Check 2: tx.amount == payload.amountIn');
  console.log('[OCTRA]     tx.amount:', tx.amount);
  console.log('[OCTRA]     payload.amountIn:', payload.amountIn);
  
  if (Math.abs(tx.amount - payload.amountIn) > 0.000001) {
    return { valid: false, error: `Transaction amount does not match intent. Expected: ${payload.amountIn}, Got: ${tx.amount}` };
  }
  console.log('[OCTRA]   ✅ Amount matches');
  
  // 3. Check expiry
  console.log('[OCTRA]   Check 3: expiry');
  console.log('[OCTRA]     now:', Date.now());
  console.log('[OCTRA]     expiry:', payload.expiry);
  
  if (Date.now() > payload.expiry) {
    return { valid: false, error: 'Intent has expired' };
  }
  console.log('[OCTRA]   ✅ Not expired');
  
  // 4. Validate target address format
  console.log('[OCTRA]   Check 4: targetAddress format');
  console.log('[OCTRA]     targetAddress:', payload.targetAddress);
  
  if (!/^0x[a-fA-F0-9]{40}$/.test(payload.targetAddress)) {
    return { valid: false, error: 'Invalid target EVM address format' };
  }
  console.log('[OCTRA]   ✅ Valid EVM address');
  
  console.log('[OCTRA] ✅ All validations passed');
  return { valid: true };
}
