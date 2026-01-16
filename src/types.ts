/**
 * Octra Intents API Types
 * Supports bidirectional swaps: OCT ⇄ ETH
 */

// Intent Status
export type IntentStatus = 'OPEN' | 'PENDING' | 'FULFILLED' | 'EXPIRED' | 'REJECTED' | 'FAILED';

// Swap Direction
export type SwapDirection = 'OCT_TO_ETH' | 'ETH_TO_OCT';

// Quote Response (OCT → ETH)
export interface QuoteResponse {
  from: 'OCT' | 'ETH';
  to: 'ETH' | 'OCT';
  amountIn: number;
  estimatedOut: number;
  rate: number;
  feeBps: number;
  expiresIn: number;
  escrowAddress: string;
  network: 'ethereum_sepolia' | 'octra_mainnet';
}

// Swap Intent Payload (Canonical - OCT → ETH)
export interface SwapIntentPayload {
  version: 1;
  intentType: 'swap';
  fromAsset: 'OCT' | 'ETH';
  toAsset: 'ETH' | 'OCT';
  amountIn: number;
  minAmountOut: number;
  targetChain: 'ethereum_sepolia' | 'octra_mainnet';
  targetAddress: string;
  expiry: number;
  nonce: string;
}

// Intent Record (Persisted) - Unified for both directions
export interface Intent {
  intentId: string;
  direction: SwapDirection;
  // Source info
  sourceAddress: string;      // OCT address (OCT→ETH) or ETH address (ETH→OCT)
  sourceTxHash: string;       // Octra tx (OCT→ETH) or Sepolia tx (ETH→OCT)
  amountIn: number;
  // Target info
  targetAddress: string;      // ETH address (OCT→ETH) or OCT address (ETH→OCT)
  targetTxHash?: string;      // Sepolia tx (OCT→ETH) or Octra tx (ETH→OCT)
  amountOut?: number;
  minAmountOut: number;
  // Status
  status: IntentStatus;
  expiry: number;
  createdAt: number;
  fulfilledAt?: number;
  error?: string;             // Error message if failed/rejected
  // Original payload
  payload: SwapIntentPayload;
}

// Submit Request (OCT → ETH)
export interface SubmitOctToEthRequest {
  octraTxHash: string;
}

// Submit Request (ETH → OCT) - only txHash needed, targetOctraAddress is parsed from tx.input
export interface SubmitEthToOctRequest {
  sepoliaTxHash: string;
}

// Submit Response
export interface SubmitResponse {
  intentId: string;
  status: IntentStatus;
  message: string;
}

// Status Response
export interface StatusResponse {
  intentId: string;
  direction: SwapDirection;
  status: IntentStatus;
  sourceAddress: string;
  sourceTxHash: string;
  targetAddress: string;
  targetTxHash?: string;
  amountIn: number;
  amountOut?: number;
}

// Octra Transaction (from RPC)
export interface OctraTransaction {
  hash: string;
  from: string;
  to: string;
  amount: number;
  message?: string;
  status: 'pending' | 'confirmed' | 'failed';
  blockHeight?: number;
}

// Sepolia Transaction (from RPC)
export interface SepoliaTransaction {
  hash: string;
  from: string;
  to: string;
  value: string;  // wei
  status: 'pending' | 'confirmed' | 'failed';
  blockNumber?: number;
  input?: string; // calldata for memo
}
