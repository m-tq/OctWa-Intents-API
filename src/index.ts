import express from 'express';
import cors from 'cors';
import { config } from './config.js';
import { router } from './routes.js';
import { oracle } from './oracle.js';
import { initSepolia, getHotWalletBalance, getEscrowAddress } from './sepolia.js';
import { initOctraEscrow, getEscrowBalance } from './octra.js';
import { startExpiryChecker } from './solver.js';
import { initDatabase, closeDatabase } from './db.js';

const app = express();

// Security: CORS configuration
const corsOptions: cors.CorsOptions = {
  origin: (origin, callback) => {
    // Allow requests with no origin (direct browser access, curl, mobile apps, server-to-server)
    // This is safe because CORS only protects browser-based cross-origin requests
    if (!origin) {
      callback(null, true);
      return;
    }
    
    // If no allowed origins configured, allow all (dev mode)
    if (config.allowedOrigins.length === 0) {
      callback(null, true);
      return;
    }
    
    // Check if origin is in whitelist
    if (config.allowedOrigins.includes(origin)) {
      callback(null, true);
    } else {
      console.warn(`[CORS] Blocked request from origin: ${origin}`);
      callback(new Error('CORS: Origin not allowed'));
    }
  },
  credentials: true,
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type'],
};

// Middleware
app.use(cors(corsOptions));
app.use(express.json({ limit: '10kb' })); // Limit body size

// Routes
app.use('/', router);

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('\n[Server] Shutting down...');
  closeDatabase();
  process.exit(0);
});

process.on('SIGTERM', () => {
  console.log('\n[Server] Shutting down...');
  closeDatabase();
  process.exit(0);
});

// Start server
async function start() {
  // Initialize SQLite database
  initDatabase();
  
  // Initialize Sepolia (for OCT→ETH)
  const sepoliaReady = initSepolia();
  let ethBalance = '0';
  let ethEscrow = 'not configured';
  
  if (sepoliaReady) {
    ethBalance = await getHotWalletBalance();
    ethEscrow = getEscrowAddress();
  }
  
  // Initialize Octra escrow (for ETH→OCT)
  const octraReady = await initOctraEscrow();
  let octBalance = '0';
  
  if (octraReady) {
    octBalance = (await getEscrowBalance()).toFixed(4);
  }
  
  // Get oracle rate
  const { rate } = oracle.getRate();
  
  // Start expiry checker
  startExpiryChecker();
  
  app.listen(config.port, () => {
    const securityStatus = {
      cors: config.allowedOrigins.length > 0 ? `✓ (${config.allowedOrigins.length} origins)` : '✗ (all origins)',
    };
    
    console.log(`
╔═══════════════════════════════════════════════════════════════╗
║              Octra Intents API v2.0.0                         ║
║              Bidirectional: OCT ⇄ ETH                         ║
╠═══════════════════════════════════════════════════════════════╣
║  SECURITY:                                                    ║
║    CORS Whitelist: ${securityStatus.cors}
╠═══════════════════════════════════════════════════════════════╣
║  SWAP ENDPOINTS:                                              ║
║    GET  /quote?from=OCT&to=ETH&amount=100                     ║
║    GET  /quote?from=ETH&to=OCT&amount=0.1                     ║
║    POST /swap/oct-to-eth  { octraTxHash }                     ║
║    POST /swap/eth-to-oct  { sepoliaTxHash }                   ║
║    POST /swap/submit      { octraTxHash } (legacy)            ║
║    GET  /swap/:intentId                                       ║
╠═══════════════════════════════════════════════════════════════╣
║  CONFIG:                                                      ║
║    Oracle Rate: 1 OCT = ${rate} ETH
║    Fee: ${config.feeBps} bps (${config.feeBps / 100}%)
║  OCT→ETH:
║    OCT Escrow: ${config.octraEscrowAddress}
║    ETH Hot Wallet: ${ethEscrow}
║    ETH Balance: ${ethBalance} ETH
║  ETH→OCT:
║    ETH Escrow: ${config.sepoliaEscrowAddress || 'not configured'}
║    OCT Escrow: ${config.octraEscrowAddress}
║    OCT Balance: ${octBalance} OCT
╚═══════════════════════════════════════════════════════════════╝

Server running on http://localhost:${config.port}
    `);
  });
}

start().catch(console.error);
