import { ethers } from 'ethers';
import { config } from './config.js';
import type { SepoliaTransaction } from './types.js';

/**
 * Sepolia ETH Operations
 * - Send ETH to fulfill OCT→ETH intents
 * - Fetch/verify transactions for ETH→OCT intents
 */

let provider: ethers.JsonRpcProvider | null = null;
let wallet: ethers.Wallet | null = null;

export function initSepolia(): boolean {
  if (!config.sepoliaPrivateKey) {
    console.warn('[Sepolia] No private key configured - fulfillment disabled');
    return false;
  }
  
  try {
    provider = new ethers.JsonRpcProvider(config.sepoliaRpcUrl);
    wallet = new ethers.Wallet(config.sepoliaPrivateKey, provider);
    console.log(`[Sepolia] Initialized with address: ${wallet.address}`);
    return true;
  } catch (error) {
    console.error('[Sepolia] Failed to initialize:', error);
    return false;
  }
}

export function getEscrowAddress(): string {
  return wallet?.address || config.sepoliaEscrowAddress;
}

// Balance cache
let cachedBalance: string | null = null;
let balanceCacheTime: number = 0;
const BALANCE_CACHE_TTL = 15000; // 15 seconds

/**
 * Get hot wallet balance (cached for quotes)
 */
export async function getHotWalletBalance(): Promise<string> {
  if (!provider || !wallet) return '0';

  // Return cached balance if still valid
  const now = Date.now();
  if (cachedBalance !== null && now - balanceCacheTime < BALANCE_CACHE_TTL) {
    return cachedBalance;
  }

  try {
    const balance = await provider.getBalance(wallet.address);
    cachedBalance = ethers.formatEther(balance);
    balanceCacheTime = now;
    return cachedBalance;
  } catch {
    return cachedBalance || '0';
  }
}

/**
 * Get hot wallet balance FRESH (bypass cache) - use for submit validation
 */
export async function getHotWalletBalanceFresh(): Promise<string> {
  if (!provider || !wallet) return '0';

  try {
    const balance = await provider.getBalance(wallet.address);
    const balanceStr = ethers.formatEther(balance);
    // Also update cache
    cachedBalance = balanceStr;
    balanceCacheTime = Date.now();
    return balanceStr;
  } catch {
    return '0';
  }
}

export async function sendETH(
  toAddress: string,
  amountEth: number
): Promise<{ success: boolean; txHash?: string; error?: string }> {
  if (!provider || !wallet) {
    return { success: false, error: 'Sepolia not initialized' };
  }
  
  try {
    if (!ethers.isAddress(toAddress)) {
      return { success: false, error: 'Invalid recipient address' };
    }
    
    // Fix precision: Convert to wei directly to avoid parseEther issues with scientific notation
    // ETH has 18 decimals, multiply by 10^18 and floor to get wei as bigint
    const amountWei = BigInt(Math.floor(amountEth * 1e18));
    
    const balance = await provider.getBalance(wallet.address);
    if (balance < amountWei) {
      return { success: false, error: 'Insufficient hot wallet balance' };
    }
    
    const tx = await wallet.sendTransaction({
      to: toAddress,
      value: amountWei,
    });
    
    console.log(`[Sepolia] Sent ${amountEth} ETH to ${toAddress}, tx: ${tx.hash}`);
    
    const receipt = await tx.wait();
    
    if (receipt?.status === 1) {
      return { success: true, txHash: tx.hash };
    } else {
      return { success: false, error: 'Transaction failed' };
    }
  } catch (error) {
    console.error('[Sepolia] Send error:', error);
    return { success: false, error: (error as Error).message };
  }
}

/**
 * Fetch Sepolia transaction for ETH→OCT verification
 */
export async function fetchSepoliaTransaction(txHash: string): Promise<SepoliaTransaction | null> {
  if (!provider) {
    // Try to create a read-only provider
    try {
      provider = new ethers.JsonRpcProvider(config.sepoliaRpcUrl);
    } catch {
      console.error('[Sepolia] Cannot create provider');
      return null;
    }
  }
  
  try {
    console.log('[Sepolia] Fetching tx:', txHash);
    
    const tx = await provider.getTransaction(txHash);
    if (!tx) {
      console.log('[Sepolia] Transaction not found');
      return null;
    }
    
    const receipt = await provider.getTransactionReceipt(txHash);
    
    const result: SepoliaTransaction = {
      hash: tx.hash,
      from: tx.from,
      to: tx.to || '',
      value: tx.value.toString(),
      status: receipt ? (receipt.status === 1 ? 'confirmed' : 'failed') : 'pending',
      blockNumber: receipt?.blockNumber,
      input: tx.data,
    };
    
    console.log('[Sepolia] Transaction:', result);
    return result;
  } catch (error) {
    console.error('[Sepolia] Fetch error:', error);
    return null;
  }
}

export async function verifyTransaction(txHash: string): Promise<{
  confirmed: boolean;
  value?: string;
  to?: string;
}> {
  if (!provider) return { confirmed: false };
  
  try {
    const receipt = await provider.getTransactionReceipt(txHash);
    if (!receipt || receipt.status !== 1) {
      return { confirmed: false };
    }
    
    const tx = await provider.getTransaction(txHash);
    return {
      confirmed: true,
      value: tx ? ethers.formatEther(tx.value) : undefined,
      to: tx?.to || undefined,
    };
  } catch {
    return { confirmed: false };
  }
}

/**
 * Get ETH balance for any address
 */
export async function getAddressBalance(address: string): Promise<string> {
  if (!provider) {
    // Try to create a read-only provider
    try {
      provider = new ethers.JsonRpcProvider(config.sepoliaRpcUrl);
    } catch {
      console.error('[Sepolia] Cannot create provider');
      return '0';
    }
  }
  
  try {
    if (!ethers.isAddress(address)) {
      return '0';
    }
    const balance = await provider.getBalance(address);
    return ethers.formatEther(balance);
  } catch (error) {
    console.error('[Sepolia] Balance fetch error:', error);
    return '0';
  }
}

/**
 * Get transaction receipt status
 */
export async function getTxReceiptStatus(txHash: string): Promise<{
  found: boolean;
  status: 'pending' | 'confirmed' | 'failed';
}> {
  if (!provider) {
    try {
      provider = new ethers.JsonRpcProvider(config.sepoliaRpcUrl);
    } catch {
      return { found: false, status: 'pending' };
    }
  }
  
  try {
    const receipt = await provider.getTransactionReceipt(txHash);
    if (!receipt) {
      // Check if tx exists but not mined yet
      const tx = await provider.getTransaction(txHash);
      if (tx) {
        return { found: true, status: 'pending' };
      }
      return { found: false, status: 'pending' };
    }
    
    return {
      found: true,
      status: receipt.status === 1 ? 'confirmed' : 'failed',
    };
  } catch {
    return { found: false, status: 'pending' };
  }
}
