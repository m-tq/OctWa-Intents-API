/**
 * Cryptographic utilities for payload verification
 */

import { createHash } from 'crypto';
import type { SwapIntentPayload } from './types.js';

/**
 * Create SHA-256 hash of payload
 * Must match the frontend implementation exactly
 */
export function hashPayload(payload: SwapIntentPayload): string {
  const jsonString = JSON.stringify(payload);
  return createHash('sha256').update(jsonString).digest('hex');
}

/**
 * Verify payload hash matches
 */
export function verifyPayloadHash(payload: SwapIntentPayload, expectedHash: string): boolean {
  const actualHash = hashPayload(payload);
  return actualHash === expectedHash;
}

/**
 * Parse and verify envelope from Octra tx message
 * Supports:
 * - v2: Base64({ payload, hash, timestamp, v: 2 })
 * - v1/legacy: JSON({ payload, hash, timestamp })
 */
export function parseAndVerifyOctraEnvelope(message: string): {
  valid: boolean;
  payload?: SwapIntentPayload;
  error?: string;
} {
  try {
    let envelope: Record<string, unknown>;
    
    // Try to detect if it's Base64 encoded (v2)
    // Base64 strings don't start with '{' and contain only valid Base64 chars
    const isBase64 = !message.trim().startsWith('{') && /^[A-Za-z0-9+/=]+$/.test(message.trim());
    
    if (isBase64) {
      // v2: Base64 encoded
      const decoded = Buffer.from(message, 'base64').toString('utf8');
      envelope = JSON.parse(decoded);
      console.log('[CRYPTO] Decoded Base64 envelope (v2)');
    } else {
      // v1/legacy: Plain JSON
      envelope = JSON.parse(message);
      console.log('[CRYPTO] Parsed JSON envelope (v1/legacy)');
    }
    
    // Support both old format (just payload) and new format (with hash)
    const payload = (envelope.payload || envelope) as SwapIntentPayload;
    const hash = envelope.hash as string | undefined;
    
    // If hash is present, verify it
    if (hash) {
      if (!verifyPayloadHash(payload, hash)) {
        return { valid: false, error: 'Payload hash mismatch - data may have been tampered' };
      }
      console.log('[CRYPTO] ✅ Payload hash verified');
    } else {
      console.log('[CRYPTO] ⚠️ No hash in envelope (legacy format)');
    }
    
    return { valid: true, payload };
  } catch (error) {
    return { valid: false, error: 'Failed to parse envelope' };
  }
}

/**
 * Parse and verify envelope from EVM tx.input (hex encoded)
 * Supports:
 * - v2: 0x + hex(Base64({ payload, hash, timestamp, v: 2 }))
 * - v1/legacy: 0x + hex(JSON({ payload, hash, timestamp }))
 */
export function parseAndVerifyEvmEnvelope(txInput: string): {
  valid: boolean;
  payload?: {
    targetAddress: string;
    minAmountOut: number;
    expiry: number;
    nonce: string;
  };
  error?: string;
} {
  if (!txInput || txInput === '0x' || txInput.length < 4) {
    return { valid: false, error: 'No payload in tx.input' };
  }

  try {
    // Remove 0x prefix and decode hex to string
    const hexData = txInput.startsWith('0x') ? txInput.slice(2) : txInput;
    const decodedHex = Buffer.from(hexData, 'hex').toString('utf8');
    
    let envelope: Record<string, unknown>;
    
    // Try to detect if the decoded hex is Base64 (v2) or JSON (v1)
    const isBase64 = !decodedHex.trim().startsWith('{') && /^[A-Za-z0-9+/=]+$/.test(decodedHex.trim());
    
    if (isBase64) {
      // v2: hex → Base64 → JSON
      const jsonString = Buffer.from(decodedHex, 'base64').toString('utf8');
      envelope = JSON.parse(jsonString);
      console.log('[CRYPTO] Decoded EVM envelope (v2: hex→base64→json)');
    } else {
      // v1/legacy: hex → JSON
      envelope = JSON.parse(decodedHex);
      console.log('[CRYPTO] Parsed EVM envelope (v1: hex→json)');
    }
    
    const payload = (envelope.payload || envelope) as Record<string, unknown>;
    const hash = envelope.hash as string | undefined;
    
    // If hash is present, verify it
    if (hash) {
      // For EVM envelope, we need to verify the full SwapIntentPayload
      const fullPayload: SwapIntentPayload = {
        version: 1 as const,
        intentType: 'swap' as const,
        fromAsset: (payload.fromAsset as 'ETH' | 'OCT') || 'ETH',
        toAsset: (payload.toAsset as 'ETH' | 'OCT') || 'OCT',
        amountIn: payload.amountIn as number,
        minAmountOut: payload.minAmountOut as number,
        targetChain: (payload.targetChain as 'octra_mainnet' | 'ethereum_sepolia') || 'octra_mainnet',
        targetAddress: payload.targetAddress as string,
        expiry: payload.expiry as number,
        nonce: payload.nonce as string,
      };
      
      if (!verifyPayloadHash(fullPayload, hash)) {
        return { valid: false, error: 'Payload hash mismatch - data may have been tampered' };
      }
      console.log('[CRYPTO] ✅ EVM payload hash verified');
    } else {
      console.log('[CRYPTO] ⚠️ No hash in EVM envelope (legacy format)');
    }
    
    // Validate required fields
    if (
      !payload.targetAddress ||
      typeof payload.minAmountOut !== 'number' ||
      typeof payload.expiry !== 'number' ||
      !payload.nonce
    ) {
      return { valid: false, error: 'Invalid payload structure' };
    }
    
    return {
      valid: true,
      payload: {
        targetAddress: payload.targetAddress as string,
        minAmountOut: payload.minAmountOut as number,
        expiry: payload.expiry as number,
        nonce: payload.nonce as string,
      },
    };
  } catch (error) {
    return { valid: false, error: 'Failed to parse EVM envelope' };
  }
}
