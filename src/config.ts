import dotenv from 'dotenv';
dotenv.config();

export const config = {
  port: parseInt(process.env.PORT || '3001', 10),
  
  // Octra Chain
  octraRpcUrl: process.env.OCTRA_RPC_URL || 'https://octra.network',
  octraEscrowAddress: process.env.OCTRA_ESCROW_ADDRESS || 'octra1escrow',
  octraPrivateKey: process.env.OCTRA_PRIVATE_KEY || '', // For sending OCT in ETH→OCT swaps
  
  // Sepolia Chain
  sepoliaRpcUrl: process.env.SEPOLIA_RPC_URL || 'https://sepolia.infura.io/v3/demo',
  sepoliaPrivateKey: process.env.SEPOLIA_PRIVATE_KEY || '',
  sepoliaEscrowAddress: process.env.SEPOLIA_ESCROW_ADDRESS || '', // ETH escrow for ETH→OCT
  
  // Pricing (now managed by oracle, these are fallbacks)
  feeBps: parseInt(process.env.FEE_BPS || '50', 10), // 0.5% fee
  
  // Timing
  quoteExpirySeconds: 30,
  intentExpiryMs: 5 * 60 * 1000, // 5 minutes
  
  // Oracle
  oracleAdminPassword: process.env.ORACLE_ADMIN_PASSWORD || 'admin123',
  
  // Security: Swap limits
  minSwapOct: parseFloat(process.env.MIN_SWAP_OCT || '1'), // Minimum 1 OCT
  maxSwapOct: parseFloat(process.env.MAX_SWAP_OCT || '100000'), // Maximum 100,000 OCT
  minSwapEth: parseFloat(process.env.MIN_SWAP_ETH || '0.0001'), // Minimum 0.0001 ETH
  maxSwapEth: parseFloat(process.env.MAX_SWAP_ETH || '10'), // Maximum 10 ETH
  
  // Security: Debug mode (disable in production)
  debugMode: process.env.DEBUG_MODE === 'true',
  
  // Security: CORS allowed origins (comma-separated)
  allowedOrigins: (process.env.ALLOWED_ORIGINS || '').split(',').filter(Boolean),
};
