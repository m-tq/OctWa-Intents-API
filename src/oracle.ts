/**
 * OCT Price Oracle - Enhanced Version
 * 
 * Combines multiple pricing strategies:
 * 1. Virtual AMM (Constant Product) - for realistic price impact
 * 2. TWAP (Time-Weighted Average Price) - manipulation resistance
 * 3. EMA (Exponential Moving Average) - price smoothing
 * 4. Liquidity depth consideration
 * 5. Circuit breakers for extreme volatility
 * 
 * Configuration via environment variables:
 * - ORACLE_INITIAL_RATE: Initial OCT/ETH rate (default: 0.001)
 * - ORACLE_VIRTUAL_OCT_RESERVE: Virtual OCT liquidity (default: 1000000)
 * - ORACLE_VIRTUAL_ETH_RESERVE: Virtual ETH liquidity (default: 1000)
 * - ORACLE_EMA_ALPHA: EMA smoothing factor 0-1 (default: 0.1)
 * - ORACLE_TWAP_WINDOW_MINUTES: TWAP window (default: 15)
 * - ORACLE_MAX_PRICE_CHANGE_PERCENT: Circuit breaker % (default: 10)
 * - ORACLE_MIN_RATE_PERCENT: Min rate as % of initial (default: 50)
 * - ORACLE_MAX_RATE_PERCENT: Max rate as % of initial (default: 200)
 */

import * as db from './db.js';

// =============================================================================
// ETH/USD PRICE FETCHER
// =============================================================================

interface EthUsdPrice {
  price: number;
  updatedAt: number;
  source: string;
}

let ethUsdCache: EthUsdPrice = {
  price: 0,
  updatedAt: 0,
  source: 'none',
};

const ETH_USD_FETCH_INTERVAL = 60 * 1000; // Fetch every 1 minute (Chainlink is fast)

// Chainlink ETH/USD Price Feed addresses
const CHAINLINK_ETH_USD_MAINNET = '0x5f4eC3Df9cbd43714FE2740f5E3616155c5b8419';
const CHAINLINK_ETH_USD_SEPOLIA = '0x694AA1769357215DE4FAC081bf1f309aDC325306';

// ABI selector for latestRoundData()
const CHAINLINK_LATEST_ROUND_SELECTOR = '0xfeaf968c';

/**
 * Fetch ETH/USD from Chainlink Price Feed via RPC
 */
async function fetchEthUsdFromChainlink(): Promise<number | null> {
  const sepoliaRpc = process.env.SEPOLIA_RPC_URL;
  if (!sepoliaRpc) {
    return null;
  }

  // Try mainnet first (more accurate), fallback to Sepolia
  const mainnetRpc = sepoliaRpc.replace('sepolia', 'mainnet');
  const useMainnet = mainnetRpc !== sepoliaRpc;
  
  const feedAddress = useMainnet ? CHAINLINK_ETH_USD_MAINNET : CHAINLINK_ETH_USD_SEPOLIA;
  const rpcUrl = useMainnet ? mainnetRpc : sepoliaRpc;

  try {
    const response = await fetch(rpcUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'eth_call',
        params: [{ to: feedAddress, data: CHAINLINK_LATEST_ROUND_SELECTOR }, 'latest'],
      }),
      signal: AbortSignal.timeout(5000),
    });

    if (!response.ok) return null;

    const data = await response.json() as { result?: string; error?: unknown };
    if (!data.result || data.error) return null;

    // Decode: latestRoundData returns (roundId, answer, startedAt, updatedAt, answeredInRound)
    // answer is at position 1 (bytes 32-64), with 8 decimals
    const result = data.result;
    if (result.length < 130) return null;

    const answerHex = '0x' + result.slice(66, 130);
    const price = Number(BigInt(answerHex)) / 1e8;

    // Sanity check
    if (price > 100 && price < 100000) {
      return price;
    }
    return null;
  } catch (err) {
    console.error('[ORACLE] Chainlink fetch failed:', err);
    return null;
  }
}

/**
 * Fetch ETH/USD price from CoinGecko
 */
async function fetchEthUsdFromCoinGecko(): Promise<number | null> {
  try {
    const response = await fetch(
      'https://api.coingecko.com/api/v3/simple/price?ids=ethereum&vs_currencies=usd',
      { signal: AbortSignal.timeout(5000) }
    );
    if (!response.ok) return null;
    const data = await response.json() as { ethereum?: { usd?: number } };
    return data?.ethereum?.usd ?? null;
  } catch (err) {
    console.error('[ORACLE] CoinGecko fetch failed:', err);
    return null;
  }
}

/**
 * Fetch ETH/USD price from Coinbase
 */
async function fetchEthUsdFromCoinbase(): Promise<number | null> {
  try {
    const response = await fetch(
      'https://api.coinbase.com/v2/prices/ETH-USD/spot',
      { signal: AbortSignal.timeout(5000) }
    );
    if (!response.ok) return null;
    const data = await response.json() as { data?: { amount?: string } };
    return data?.data?.amount ? parseFloat(data.data.amount) : null;
  } catch (err) {
    console.error('[ORACLE] Coinbase fetch failed:', err);
    return null;
  }
}

/**
 * Fetch ETH/USD with fallback sources
 */
async function fetchEthUsdPrice(): Promise<void> {
  // Try Chainlink first (on-chain, most reliable)
  let price = await fetchEthUsdFromChainlink();
  let source = 'chainlink';

  // Fallback to CoinGecko
  if (!price) {
    price = await fetchEthUsdFromCoinGecko();
    source = 'coingecko';
  }
  
  // Fallback to Coinbase
  if (!price) {
    price = await fetchEthUsdFromCoinbase();
    source = 'coinbase';
  }
  
  if (price && price > 0) {
    ethUsdCache = {
      price,
      updatedAt: Date.now(),
      source,
    };
    console.log(`[ORACLE] ETH/USD updated: $${price.toFixed(2)} (${source})`);
  }
}

/**
 * Get cached ETH/USD price
 */
export function getEthUsdPrice(): EthUsdPrice {
  return { ...ethUsdCache };
}

/**
 * Start ETH/USD price fetcher
 */
export function startEthUsdFetcher(): void {
  // Fetch immediately on start
  fetchEthUsdPrice();
  
  // Then fetch every 1 minute
  setInterval(fetchEthUsdPrice, ETH_USD_FETCH_INTERVAL);
  
  console.log('[ORACLE] ETH/USD price fetcher started (Chainlink primary, interval: 1 min)');
}

// =============================================================================
// TYPES
// =============================================================================

interface PriceRecord {
  rate: number;
  timestamp: number;
  reason: 'swap' | 'initial' | 'ema_update' | 'circuit_breaker';
  volume?: number;
  direction?: 'OCT_TO_ETH' | 'ETH_TO_OCT';
}

interface TWAPDataPoint {
  price: number;
  timestamp: number;
  weight: number; // Duration this price was active
}

interface VirtualReserves {
  octReserve: number;
  ethReserve: number;
  k: number; // Constant product (oct * eth = k)
}

interface OracleStats {
  // Current prices
  spotPrice: number;
  emaPrice: number;
  twapPrice: number;
  
  // USD prices
  ethUsd: number;
  octUsd: number;
  
  // Reserves
  virtualReserves: VirtualReserves;
  
  // Bounds
  minRate: number;
  maxRate: number;
  
  // Volume (24h)
  volume24h: {
    octToEth: number;
    ethToOct: number;
    totalOct: number;
  };
  
  // Health
  priceDeviation: number; // % difference between spot and TWAP
  circuitBreakerActive: boolean;
  lastUpdate: number;
}

// =============================================================================
// CONFIGURATION
// =============================================================================

const INITIAL_RATE = parseFloat(process.env.ORACLE_INITIAL_RATE || '0.001');
const VIRTUAL_OCT_RESERVE = parseFloat(process.env.ORACLE_VIRTUAL_OCT_RESERVE || '1000000');
const VIRTUAL_ETH_RESERVE = parseFloat(process.env.ORACLE_VIRTUAL_ETH_RESERVE || '1000');
const EMA_ALPHA = parseFloat(process.env.ORACLE_EMA_ALPHA || '0.1'); // 0.1 = slow, 0.9 = fast
const TWAP_WINDOW_MS = parseFloat(process.env.ORACLE_TWAP_WINDOW_MINUTES || '15') * 60 * 1000;
const MAX_PRICE_CHANGE_PERCENT = parseFloat(process.env.ORACLE_MAX_PRICE_CHANGE_PERCENT || '10');
const MIN_RATE_PERCENT = parseFloat(process.env.ORACLE_MIN_RATE_PERCENT || '50');
const MAX_RATE_PERCENT = parseFloat(process.env.ORACLE_MAX_RATE_PERCENT || '200');
const FEE_BPS = parseInt(process.env.FEE_BPS || '50', 10);

const CONFIG = {
  initialRate: INITIAL_RATE,
  minRate: INITIAL_RATE * (MIN_RATE_PERCENT / 100),
  maxRate: INITIAL_RATE * (MAX_RATE_PERCENT / 100),
  emaAlpha: EMA_ALPHA,
  twapWindowMs: TWAP_WINDOW_MS,
  maxPriceChangePercent: MAX_PRICE_CHANGE_PERCENT,
  feeBps: FEE_BPS,
};

// =============================================================================
// ORACLE CLASS
// =============================================================================

class PriceOracle {
  // Virtual AMM reserves
  private reserves: VirtualReserves;
  
  // Price tracking
  private spotPrice: number;
  private emaPrice: number;
  private twapDataPoints: TWAPDataPoint[] = [];
  private priceHistory: PriceRecord[] = [];
  
  // Volume tracking (24h rolling)
  private volumeHistory: Array<{
    timestamp: number;
    octAmount: number;
    direction: 'OCT_TO_ETH' | 'ETH_TO_OCT';
  }> = [];
  
  // Circuit breaker
  private circuitBreakerActive = false;
  private lastCircuitBreakerReset = 0;
  
  constructor() {
    // Initialize virtual reserves based on initial rate
    // If rate = ETH/OCT = 0.001, then 1 OCT = 0.001 ETH
    // For AMM: price = ethReserve / octReserve
    // So: 0.001 = ethReserve / octReserve
    // With octReserve = 1,000,000: ethReserve = 1,000
    this.reserves = {
      octReserve: VIRTUAL_OCT_RESERVE,
      ethReserve: VIRTUAL_ETH_RESERVE,
      k: VIRTUAL_OCT_RESERVE * VIRTUAL_ETH_RESERVE,
    };
    
    this.spotPrice = this.calculateSpotPrice();
    this.emaPrice = this.spotPrice;
    
    // Initialize TWAP
    this.twapDataPoints.push({
      price: this.spotPrice,
      timestamp: Date.now(),
      weight: 0,
    });
    
    this.recordPrice(this.spotPrice, 'initial');
    
    console.log('[ORACLE] ═══════════════════════════════════════════════');
    console.log('[ORACLE] Enhanced Price Oracle Initialized');
    console.log('[ORACLE] ═══════════════════════════════════════════════');
    console.log('[ORACLE] Initial Rate: 1 OCT =', this.spotPrice.toFixed(8), 'ETH');
    console.log('[ORACLE] Virtual Reserves:');
    console.log('[ORACLE]   OCT:', this.reserves.octReserve.toLocaleString());
    console.log('[ORACLE]   ETH:', this.reserves.ethReserve.toLocaleString());
    console.log('[ORACLE]   K:', this.reserves.k.toExponential(4));
    console.log('[ORACLE] EMA Alpha:', CONFIG.emaAlpha);
    console.log('[ORACLE] TWAP Window:', CONFIG.twapWindowMs / 60000, 'minutes');
    console.log('[ORACLE] Circuit Breaker:', CONFIG.maxPriceChangePercent + '%');
    console.log('[ORACLE] Rate Bounds:', CONFIG.minRate.toFixed(8), '-', CONFIG.maxRate.toFixed(8));
    console.log('[ORACLE] ═══════════════════════════════════════════════');
  }

  // ===========================================================================
  // PUBLIC: Price Getters
  // ===========================================================================

  /**
   * Get current OCT/ETH rate (uses EMA for stability)
   */
  getRate(): { rate: number; updatedAt: number } {
    this.updateTWAP();
    return {
      rate: this.getEffectivePrice(),
      updatedAt: Date.now(),
    };
  }

  /**
   * Get inverse rate (ETH/OCT)
   */
  getInverseRate(): { rate: number; updatedAt: number } {
    return {
      rate: 1 / this.getEffectivePrice(),
      updatedAt: Date.now(),
    };
  }

  /**
   * Get all price metrics
   */
  getPrices(): { spot: number; ema: number; twap: number; effective: number } {
    this.updateTWAP();
    return {
      spot: this.spotPrice,
      ema: this.emaPrice,
      twap: this.calculateTWAP(),
      effective: this.getEffectivePrice(),
    };
  }

  // ===========================================================================
  // PUBLIC: Swap Calculations
  // ===========================================================================

  /**
   * Calculate ETH output for OCT input (with price impact)
   */
  calculateEthOut(octAmount: number, feeBps: number = CONFIG.feeBps): number {
    // Use constant product formula: (x + Δx)(y - Δy) = k
    // Δy = y - k/(x + Δx)
    const newOctReserve = this.reserves.octReserve + octAmount;
    const newEthReserve = this.reserves.k / newOctReserve;
    const grossEthOut = this.reserves.ethReserve - newEthReserve;
    
    // Apply fee
    const fee = grossEthOut * (feeBps / 10000);
    const netEthOut = grossEthOut - fee;
    
    return Math.max(0, netEthOut);
  }

  /**
   * Calculate OCT output for ETH input (with price impact)
   */
  calculateOctOut(ethAmount: number, feeBps: number = CONFIG.feeBps): number {
    // Use constant product formula
    const newEthReserve = this.reserves.ethReserve + ethAmount;
    const newOctReserve = this.reserves.k / newEthReserve;
    const grossOctOut = this.reserves.octReserve - newOctReserve;
    
    // Apply fee
    const fee = grossOctOut * (feeBps / 10000);
    const netOctOut = grossOctOut - fee;
    
    return Math.max(0, netOctOut);
  }

  /**
   * Calculate price impact for a trade
   */
  calculatePriceImpact(
    direction: 'OCT_TO_ETH' | 'ETH_TO_OCT',
    amount: number
  ): { priceImpactPercent: number; effectivePrice: number; spotPrice: number } {
    const spotPrice = this.spotPrice;
    
    if (direction === 'OCT_TO_ETH') {
      const ethOut = this.calculateEthOut(amount, 0); // Without fee for pure impact
      const effectivePrice = ethOut / amount;
      const priceImpactPercent = ((spotPrice - effectivePrice) / spotPrice) * 100;
      return { priceImpactPercent, effectivePrice, spotPrice };
    } else {
      const octOut = this.calculateOctOut(amount, 0);
      const effectivePrice = amount / octOut; // ETH per OCT
      const priceImpactPercent = ((effectivePrice - spotPrice) / spotPrice) * 100;
      return { priceImpactPercent, effectivePrice, spotPrice };
    }
  }

  // ===========================================================================
  // PUBLIC: Record Swap
  // ===========================================================================

  /**
   * Record a completed swap and update reserves
   */
  recordSwap(direction: 'OCT_TO_ETH' | 'ETH_TO_OCT', amount: number): void {
    const oldSpot = this.spotPrice;
    
    // Update virtual reserves
    if (direction === 'OCT_TO_ETH') {
      // OCT in, ETH out
      const ethOut = this.calculateEthOut(amount, 0);
      this.reserves.octReserve += amount;
      this.reserves.ethReserve -= ethOut;
      
      // Record volume
      this.volumeHistory.push({
        timestamp: Date.now(),
        octAmount: amount,
        direction,
      });
    } else {
      // ETH in, OCT out
      const octOut = this.calculateOctOut(amount, 0);
      // amount here is ETH, convert to OCT equivalent for volume
      this.reserves.ethReserve += amount;
      this.reserves.octReserve -= octOut;
      
      this.volumeHistory.push({
        timestamp: Date.now(),
        octAmount: octOut,
        direction,
      });
    }
    
    // Recalculate K to prevent drift (optional: can keep K constant for pure AMM)
    // this.reserves.k = this.reserves.octReserve * this.reserves.ethReserve;
    
    // Update spot price
    this.spotPrice = this.calculateSpotPrice();
    
    // Check circuit breaker
    const priceChange = Math.abs((this.spotPrice - oldSpot) / oldSpot) * 100;
    if (priceChange > CONFIG.maxPriceChangePercent) {
      this.triggerCircuitBreaker(oldSpot);
    }
    
    // Update EMA
    this.updateEMA();
    
    // Update TWAP
    this.updateTWAP();
    
    // Apply bounds
    this.applyPriceBounds();
    
    // Record
    this.recordPrice(this.spotPrice, 'swap', amount, direction);
    
    // Cleanup old volume data
    this.cleanupVolumeHistory();
    
    console.log('[ORACLE] Swap recorded:', direction);
    console.log('[ORACLE]   Amount:', amount.toFixed(6), direction === 'OCT_TO_ETH' ? 'OCT' : 'ETH');
    console.log('[ORACLE]   Price:', oldSpot.toFixed(8), '→', this.spotPrice.toFixed(8));
    console.log('[ORACLE]   EMA:', this.emaPrice.toFixed(8));
    console.log('[ORACLE]   Reserves: OCT=', this.reserves.octReserve.toFixed(2), 'ETH=', this.reserves.ethReserve.toFixed(4));
  }

  // ===========================================================================
  // PUBLIC: Stats & History
  // ===========================================================================

  /**
   * Get comprehensive oracle stats
   */
  getStats(): OracleStats {
    this.updateTWAP();
    const twap = this.calculateTWAP();
    const volume24h = this.getVolume24h();
    const ethUsd = ethUsdCache.price;
    const octUsd = ethUsd > 0 ? this.spotPrice * ethUsd : 0;
    
    return {
      spotPrice: this.spotPrice,
      emaPrice: this.emaPrice,
      twapPrice: twap,
      ethUsd,
      octUsd,
      virtualReserves: { ...this.reserves },
      minRate: CONFIG.minRate,
      maxRate: CONFIG.maxRate,
      volume24h,
      priceDeviation: Math.abs((this.spotPrice - twap) / twap) * 100,
      circuitBreakerActive: this.circuitBreakerActive,
      lastUpdate: Date.now(),
    };
  }

  /**
   * Get price history
   */
  getHistory(limit: number = 100): PriceRecord[] {
    return this.priceHistory.slice(-limit);
  }

  // ===========================================================================
  // PRIVATE: Price Calculations
  // ===========================================================================

  private calculateSpotPrice(): number {
    // AMM spot price = ethReserve / octReserve
    return this.reserves.ethReserve / this.reserves.octReserve;
  }

  private getEffectivePrice(): number {
    // Use weighted average of EMA and TWAP for stability
    // EMA responds faster, TWAP is more manipulation-resistant
    const twap = this.calculateTWAP();
    
    // If circuit breaker is active, use TWAP (more stable)
    if (this.circuitBreakerActive) {
      return twap;
    }
    
    // Normal: 70% EMA, 30% TWAP
    return this.emaPrice * 0.7 + twap * 0.3;
  }

  private updateEMA(): void {
    // EMA = α * current + (1 - α) * previous
    this.emaPrice = CONFIG.emaAlpha * this.spotPrice + (1 - CONFIG.emaAlpha) * this.emaPrice;
  }

  private updateTWAP(): void {
    const now = Date.now();
    const windowStart = now - CONFIG.twapWindowMs;
    
    // Update weight of last data point
    if (this.twapDataPoints.length > 0) {
      const last = this.twapDataPoints[this.twapDataPoints.length - 1];
      last.weight = now - last.timestamp;
    }
    
    // Add current price as new data point
    this.twapDataPoints.push({
      price: this.spotPrice,
      timestamp: now,
      weight: 0,
    });
    
    // Remove old data points outside window
    this.twapDataPoints = this.twapDataPoints.filter(dp => dp.timestamp >= windowStart);
    
    // Ensure at least one data point
    if (this.twapDataPoints.length === 0) {
      this.twapDataPoints.push({
        price: this.spotPrice,
        timestamp: now,
        weight: 0,
      });
    }
  }

  private calculateTWAP(): number {
    if (this.twapDataPoints.length === 0) return this.spotPrice;
    
    let totalWeight = 0;
    let weightedSum = 0;
    
    for (const dp of this.twapDataPoints) {
      if (dp.weight > 0) {
        weightedSum += dp.price * dp.weight;
        totalWeight += dp.weight;
      }
    }
    
    if (totalWeight === 0) return this.spotPrice;
    return weightedSum / totalWeight;
  }

  // ===========================================================================
  // PRIVATE: Circuit Breaker
  // ===========================================================================

  private triggerCircuitBreaker(previousPrice: number): void {
    console.log('[ORACLE] ⚠️ CIRCUIT BREAKER TRIGGERED');
    console.log('[ORACLE]   Previous:', previousPrice.toFixed(8));
    console.log('[ORACLE]   Current:', this.spotPrice.toFixed(8));
    console.log('[ORACLE]   Change:', (Math.abs((this.spotPrice - previousPrice) / previousPrice) * 100).toFixed(2) + '%');
    
    this.circuitBreakerActive = true;
    this.lastCircuitBreakerReset = Date.now();
    
    // Revert to EMA price (more stable)
    this.spotPrice = this.emaPrice;
    
    // Reset circuit breaker after 5 minutes
    setTimeout(() => {
      this.circuitBreakerActive = false;
      console.log('[ORACLE] Circuit breaker reset');
    }, 5 * 60 * 1000);
  }

  private applyPriceBounds(): void {
    const oldPrice = this.spotPrice;
    
    if (this.spotPrice < CONFIG.minRate) {
      this.spotPrice = CONFIG.minRate;
      console.log('[ORACLE] Price bounded to minimum:', CONFIG.minRate);
    } else if (this.spotPrice > CONFIG.maxRate) {
      this.spotPrice = CONFIG.maxRate;
      console.log('[ORACLE] Price bounded to maximum:', CONFIG.maxRate);
    }
    
    // Also bound EMA
    this.emaPrice = Math.max(CONFIG.minRate, Math.min(CONFIG.maxRate, this.emaPrice));
    
    // Adjust reserves if price was bounded
    if (this.spotPrice !== oldPrice) {
      // Recalculate reserves to match bounded price while keeping K
      // price = ethReserve / octReserve
      // k = octReserve * ethReserve
      // octReserve = sqrt(k / price)
      // ethReserve = sqrt(k * price)
      this.reserves.octReserve = Math.sqrt(this.reserves.k / this.spotPrice);
      this.reserves.ethReserve = Math.sqrt(this.reserves.k * this.spotPrice);
    }
  }

  // ===========================================================================
  // PRIVATE: Volume Tracking
  // ===========================================================================

  private getVolume24h(): { octToEth: number; ethToOct: number; totalOct: number } {
    const oneDayAgo = Date.now() - 24 * 60 * 60 * 1000;
    
    let octToEth = 0;
    let ethToOct = 0;
    
    for (const v of this.volumeHistory) {
      if (v.timestamp >= oneDayAgo) {
        if (v.direction === 'OCT_TO_ETH') {
          octToEth += v.octAmount;
        } else {
          ethToOct += v.octAmount;
        }
      }
    }
    
    return {
      octToEth,
      ethToOct,
      totalOct: octToEth + ethToOct,
    };
  }

  private cleanupVolumeHistory(): void {
    const oneDayAgo = Date.now() - 24 * 60 * 60 * 1000;
    this.volumeHistory = this.volumeHistory.filter(v => v.timestamp >= oneDayAgo);
  }

  // ===========================================================================
  // PRIVATE: Recording
  // ===========================================================================

  private recordPrice(
    rate: number,
    reason: PriceRecord['reason'],
    volume?: number,
    direction?: 'OCT_TO_ETH' | 'ETH_TO_OCT'
  ): void {
    this.priceHistory.push({
      rate,
      timestamp: Date.now(),
      reason,
      volume,
      direction,
    });

    // Persist to database
    if (reason !== 'initial') {
      try {
        db.addOracleRate(rate);
      } catch {
        // Database not ready yet
      }
    }

    // Keep only last 1000 records in memory
    if (this.priceHistory.length > 1000) {
      this.priceHistory = this.priceHistory.slice(-1000);
    }
  }
}

// =============================================================================
// SINGLETON EXPORT
// =============================================================================

let oracleInstance: PriceOracle | null = null;

export function getOracle(): PriceOracle {
  if (!oracleInstance) {
    oracleInstance = new PriceOracle();
  }
  return oracleInstance;
}

// Backward compatible export
export const oracle = {
  getRate: () => getOracle().getRate(),
  getInverseRate: () => getOracle().getInverseRate(),
  getPrices: () => getOracle().getPrices(),
  calculateEthOut: (octAmount: number, feeBps?: number) => getOracle().calculateEthOut(octAmount, feeBps),
  calculateOctOut: (ethAmount: number, feeBps?: number) => getOracle().calculateOctOut(ethAmount, feeBps),
  calculatePriceImpact: (direction: 'OCT_TO_ETH' | 'ETH_TO_OCT', amount: number) => 
    getOracle().calculatePriceImpact(direction, amount),
  recordSwap: (direction: 'OCT_TO_ETH' | 'ETH_TO_OCT', amount: number) => 
    getOracle().recordSwap(direction, amount),
  getHistory: (limit?: number) => getOracle().getHistory(limit),
  getStats: () => getOracle().getStats(),
  getEthUsd: () => getEthUsdPrice(),
};
