/**
 * OCT Price Oracle
 * Dynamic pricing based on supply/demand simulation
 * 
 * Configuration via environment variables:
 * - ORACLE_INITIAL_RATE: Initial OCT/ETH rate (default: 0.001)
 * - ORACLE_ADJUSTMENT_FACTOR: % adjustment per threshold (default: 0.01 = 1%)
 * - ORACLE_VOLUME_THRESHOLD: OCT volume to trigger adjustment (default: 100)
 * - ORACLE_MAX_ADJUSTMENT: Max % deviation from base (default: 0.10 = 10%)
 * - ORACLE_WINDOW_HOURS: Volume window duration in hours (default: 1)
 * - ORACLE_MIN_RATE_PERCENT: Min rate as % of initial (default: 50)
 * - ORACLE_MAX_RATE_PERCENT: Max rate as % of initial (default: 200)
 */

import * as db from './db.js';

interface PriceRecord {
  rate: number;
  timestamp: number;
  reason: 'auto_adjust' | 'initial';
}

interface VolumeWindow {
  octSold: number;      // OCT → ETH volume
  octBought: number;    // ETH → OCT volume
  windowStart: number;
}

// Get configuration from environment
const INITIAL_RATE = parseFloat(process.env.ORACLE_INITIAL_RATE || '0.001');
const ADJUSTMENT_FACTOR = parseFloat(process.env.ORACLE_ADJUSTMENT_FACTOR || '0.01');
const VOLUME_THRESHOLD = parseFloat(process.env.ORACLE_VOLUME_THRESHOLD || '100');
const MAX_ADJUSTMENT = parseFloat(process.env.ORACLE_MAX_ADJUSTMENT || '0.10');
const WINDOW_HOURS = parseFloat(process.env.ORACLE_WINDOW_HOURS || '1');
const MIN_RATE_PERCENT = parseFloat(process.env.ORACLE_MIN_RATE_PERCENT || '50');
const MAX_RATE_PERCENT = parseFloat(process.env.ORACLE_MAX_RATE_PERCENT || '200');

// Configuration
const ORACLE_CONFIG = {
  baseRate: INITIAL_RATE,
  adjustmentFactor: ADJUSTMENT_FACTOR,       // % adjustment per threshold
  volumeThreshold: VOLUME_THRESHOLD,         // OCT volume threshold
  maxAdjustment: MAX_ADJUSTMENT,             // Max ±% from base
  windowDurationMs: WINDOW_HOURS * 60 * 60 * 1000,
  minRate: INITIAL_RATE * (MIN_RATE_PERCENT / 100),
  maxRate: INITIAL_RATE * (MAX_RATE_PERCENT / 100),
};

class PriceOracle {
  private currentRate: number;
  private baseRate: number;
  private priceHistory: PriceRecord[] = [];
  private volumeWindow: VolumeWindow;

  constructor() {
    this.baseRate = ORACLE_CONFIG.baseRate;
    this.currentRate = this.baseRate;
    this.volumeWindow = {
      octSold: 0,
      octBought: 0,
      windowStart: Date.now(),
    };
    
    // Record initial price
    this.recordPrice(this.currentRate, 'initial');
    
    console.log('[ORACLE] Initialized with config:');
    console.log('[ORACLE]   Initial rate: 1 OCT =', this.currentRate, 'ETH');
    console.log('[ORACLE]   Adjustment factor:', (ORACLE_CONFIG.adjustmentFactor * 100).toFixed(1) + '%');
    console.log('[ORACLE]   Volume threshold:', ORACLE_CONFIG.volumeThreshold, 'OCT');
    console.log('[ORACLE]   Max adjustment:', (ORACLE_CONFIG.maxAdjustment * 100).toFixed(1) + '%');
    console.log('[ORACLE]   Window duration:', ORACLE_CONFIG.windowDurationMs / 3600000, 'hours');
    console.log('[ORACLE]   Rate bounds:', ORACLE_CONFIG.minRate, '-', ORACLE_CONFIG.maxRate);
  }

  /**
   * Get current OCT/ETH rate
   */
  getRate(): { rate: number; updatedAt: number } {
    return {
      rate: this.currentRate,
      updatedAt: this.priceHistory[this.priceHistory.length - 1]?.timestamp || Date.now(),
    };
  }

  /**
   * Get inverse rate (ETH/OCT) for reverse swaps
   */
  getInverseRate(): { rate: number; updatedAt: number } {
    return {
      rate: 1 / this.currentRate,
      updatedAt: this.priceHistory[this.priceHistory.length - 1]?.timestamp || Date.now(),
    };
  }

  /**
   * Calculate ETH output for given OCT input
   */
  calculateEthOut(octAmount: number, feeBps: number): number {
    const grossOut = octAmount * this.currentRate;
    const fee = grossOut * (feeBps / 10000);
    return grossOut - fee;
  }

  /**
   * Calculate OCT output for given ETH input
   */
  calculateOctOut(ethAmount: number, feeBps: number): number {
    const grossOut = ethAmount / this.currentRate;
    const fee = grossOut * (feeBps / 10000);
    return grossOut - fee;
  }

  /**
   * Record a swap and adjust price automatically
   */
  recordSwap(direction: 'OCT_TO_ETH' | 'ETH_TO_OCT', octAmount: number): void {
    this.resetWindowIfExpired();

    if (direction === 'OCT_TO_ETH') {
      this.volumeWindow.octSold += octAmount;
      console.log('[ORACLE] Recorded OCT sell:', octAmount, 'Total sold:', this.volumeWindow.octSold);
    } else {
      this.volumeWindow.octBought += octAmount;
      console.log('[ORACLE] Recorded OCT buy:', octAmount, 'Total bought:', this.volumeWindow.octBought);
    }

    this.autoAdjustPrice();
  }

  /**
   * Get price history
   */
  getHistory(limit: number = 100): PriceRecord[] {
    return this.priceHistory.slice(-limit);
  }

  /**
   * Get volume stats
   */
  getStats(): {
    currentRate: number;
    baseRate: number;
    minRate: number;
    maxRate: number;
    volumeWindow: VolumeWindow;
    netFlow: number;
    priceImpact: number;
    adjustmentFactor: number;
    volumeThreshold: number;
  } {
    this.resetWindowIfExpired();
    
    const netFlow = this.volumeWindow.octSold - this.volumeWindow.octBought;
    const priceImpact = (netFlow / ORACLE_CONFIG.volumeThreshold) * ORACLE_CONFIG.adjustmentFactor;

    return {
      currentRate: this.currentRate,
      baseRate: this.baseRate,
      minRate: ORACLE_CONFIG.minRate,
      maxRate: ORACLE_CONFIG.maxRate,
      volumeWindow: { ...this.volumeWindow },
      netFlow,
      priceImpact,
      adjustmentFactor: ORACLE_CONFIG.adjustmentFactor,
      volumeThreshold: ORACLE_CONFIG.volumeThreshold,
    };
  }

  // ============ Private Methods ============

  private autoAdjustPrice(): void {
    const netSellVolume = this.volumeWindow.octSold - this.volumeWindow.octBought;
    
    // Calculate price impact
    // Positive netSellVolume = more selling = price goes down
    // Negative netSellVolume = more buying = price goes up
    let priceImpact = (netSellVolume / ORACLE_CONFIG.volumeThreshold) * ORACLE_CONFIG.adjustmentFactor;
    
    // Cap adjustment to max
    priceImpact = Math.max(-ORACLE_CONFIG.maxAdjustment, Math.min(ORACLE_CONFIG.maxAdjustment, priceImpact));
    
    // Calculate new rate (more selling = lower price)
    let newRate = this.baseRate * (1 - priceImpact);
    
    // Apply absolute bounds
    newRate = Math.max(ORACLE_CONFIG.minRate, Math.min(ORACLE_CONFIG.maxRate, newRate));
    
    // Only update if changed significantly (> 0.01%)
    if (Math.abs(newRate - this.currentRate) / this.currentRate > 0.0001) {
      const oldRate = this.currentRate;
      this.currentRate = newRate;
      this.recordPrice(newRate, 'auto_adjust');
      console.log('[ORACLE] Auto-adjusted rate:', oldRate.toFixed(6), '→', newRate.toFixed(6), '(impact:', (priceImpact * 100).toFixed(2) + '%)');
    }
  }

  private resetWindowIfExpired(): void {
    const now = Date.now();
    if (now - this.volumeWindow.windowStart > ORACLE_CONFIG.windowDurationMs) {
      console.log('[ORACLE] Resetting volume window (1 hour passed)');
      this.volumeWindow = {
        octSold: 0,
        octBought: 0,
        windowStart: now,
      };
    }
  }

  private recordPrice(rate: number, reason: PriceRecord['reason']): void {
    this.priceHistory.push({
      rate,
      timestamp: Date.now(),
      reason,
    });

    // Persist to database (only if not initial - db may not be ready yet)
    if (reason !== 'initial') {
      try {
        db.addOracleRate(rate);
      } catch {
        // Database not ready yet, skip
      }
    }

    // Keep only last 1000 records in memory
    if (this.priceHistory.length > 1000) {
      this.priceHistory = this.priceHistory.slice(-1000);
    }
  }
}

// Singleton instance - lazy initialization
let oracleInstance: PriceOracle | null = null;

export function getOracle(): PriceOracle {
  if (!oracleInstance) {
    oracleInstance = new PriceOracle();
  }
  return oracleInstance;
}

// For backward compatibility
export const oracle = {
  getRate: () => getOracle().getRate(),
  getInverseRate: () => getOracle().getInverseRate(),
  calculateEthOut: (octAmount: number, feeBps: number) => getOracle().calculateEthOut(octAmount, feeBps),
  calculateOctOut: (ethAmount: number, feeBps: number) => getOracle().calculateOctOut(ethAmount, feeBps),
  recordSwap: (direction: 'OCT_TO_ETH' | 'ETH_TO_OCT', octAmount: number) => getOracle().recordSwap(direction, octAmount),
  getHistory: (limit?: number) => getOracle().getHistory(limit),
  getStats: () => getOracle().getStats(),
};
