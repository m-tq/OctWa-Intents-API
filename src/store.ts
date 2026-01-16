import type { Intent, SwapDirection } from './types.js';
import * as db from './db.js';

/**
 * Intent Store - SQLite backed
 * Provides same interface as before but with persistence
 */
class IntentStore {
  add(intent: Intent): void {
    db.addIntent(intent);
    db.addNonce(intent.payload.nonce);
  }

  get(intentId: string): Intent | undefined {
    return db.getIntent(intentId);
  }

  getByTxHash(txHash: string): Intent | undefined {
    return db.getIntentByTxHash(txHash);
  }

  getByUserAddress(address: string, limit: number = 50): Intent[] {
    return db.getIntentsByUser(address, limit);
  }

  update(intentId: string, updates: Partial<Intent>): Intent | undefined {
    return db.updateIntent(intentId, updates);
  }

  isNonceUsed(nonce: string): boolean {
    return db.isNonceUsed(nonce);
  }

  getOpenIntents(): Intent[] {
    return db.getOpenIntents();
  }

  getPendingIntents(): Intent[] {
    return db.getPendingIntents();
  }

  getByDirection(direction: SwapDirection): Intent[] {
    return db.getIntentsByDirection(direction);
  }

  getAll(): Intent[] {
    return db.getAllIntents();
  }

  getRecentVolume(windowMs: number = 60 * 60 * 1000): { octToEth: number; ethToOct: number } {
    return db.getRecentVolume(windowMs);
  }
}

export const intentStore = new IntentStore();
