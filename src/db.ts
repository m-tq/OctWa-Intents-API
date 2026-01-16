import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import type { Intent, SwapDirection, IntentStatus } from './types.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = path.join(__dirname, '..', 'data', 'intents.db');

let db: Database.Database;

export function initDatabase(): void {
  // Ensure data directory exists (sync)
  const dataDir = path.dirname(DB_PATH);
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }

  db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');

  // Create tables
  db.exec(`
    CREATE TABLE IF NOT EXISTS intents (
      intent_id TEXT PRIMARY KEY,
      direction TEXT NOT NULL,
      source_address TEXT NOT NULL,
      source_tx_hash TEXT NOT NULL,
      amount_in REAL NOT NULL,
      target_address TEXT NOT NULL,
      target_tx_hash TEXT,
      amount_out REAL,
      min_amount_out REAL NOT NULL,
      status TEXT NOT NULL,
      expiry INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      fulfilled_at INTEGER,
      error TEXT,
      payload TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_intents_source_address ON intents(source_address);
    CREATE INDEX IF NOT EXISTS idx_intents_target_address ON intents(target_address);
    CREATE INDEX IF NOT EXISTS idx_intents_source_tx_hash ON intents(source_tx_hash);
    CREATE INDEX IF NOT EXISTS idx_intents_status ON intents(status);
    CREATE INDEX IF NOT EXISTS idx_intents_created_at ON intents(created_at);

    CREATE TABLE IF NOT EXISTS nonces (
      nonce TEXT PRIMARY KEY
    );

    CREATE TABLE IF NOT EXISTS oracle_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      rate REAL NOT NULL,
      timestamp INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_oracle_history_timestamp ON oracle_history(timestamp);
  `);

  console.log('[DB] SQLite database initialized at:', DB_PATH);
}


// =============================================================================
// Intent Operations
// =============================================================================

export function addIntent(intent: Intent): void {
  const stmt = db.prepare(`
    INSERT INTO intents (
      intent_id, direction, source_address, source_tx_hash, amount_in,
      target_address, target_tx_hash, amount_out, min_amount_out,
      status, expiry, created_at, fulfilled_at, error, payload
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  stmt.run(
    intent.intentId,
    intent.direction,
    intent.sourceAddress.toLowerCase(),
    intent.sourceTxHash,
    intent.amountIn,
    intent.targetAddress.toLowerCase(),
    intent.targetTxHash || null,
    intent.amountOut || null,
    intent.minAmountOut,
    intent.status,
    intent.expiry,
    intent.createdAt,
    intent.fulfilledAt || null,
    intent.error || null,
    JSON.stringify(intent.payload)
  );
}

export function getIntent(intentId: string): Intent | undefined {
  const stmt = db.prepare('SELECT * FROM intents WHERE intent_id = ?');
  const row = stmt.get(intentId) as IntentRow | undefined;
  return row ? rowToIntent(row) : undefined;
}

export function getIntentByTxHash(txHash: string): Intent | undefined {
  const stmt = db.prepare('SELECT * FROM intents WHERE source_tx_hash = ?');
  const row = stmt.get(txHash) as IntentRow | undefined;
  return row ? rowToIntent(row) : undefined;
}

export function getIntentsByUser(address: string, limit: number = 50): Intent[] {
  const addr = address.toLowerCase();
  const stmt = db.prepare(`
    SELECT * FROM intents 
    WHERE source_address = ? OR target_address = ?
    ORDER BY created_at DESC
    LIMIT ?
  `);
  const rows = stmt.all(addr, addr, limit) as IntentRow[];
  return rows.map(rowToIntent);
}

export function updateIntent(intentId: string, updates: Partial<Intent>): Intent | undefined {
  const existing = getIntent(intentId);
  if (!existing) return undefined;

  const updated = { ...existing, ...updates };
  
  const stmt = db.prepare(`
    UPDATE intents SET
      target_tx_hash = ?,
      amount_out = ?,
      status = ?,
      fulfilled_at = ?,
      error = ?
    WHERE intent_id = ?
  `);

  stmt.run(
    updated.targetTxHash || null,
    updated.amountOut || null,
    updated.status,
    updated.fulfilledAt || null,
    updated.error || null,
    intentId
  );

  return updated;
}

export function getAllIntents(): Intent[] {
  const stmt = db.prepare('SELECT * FROM intents ORDER BY created_at DESC');
  const rows = stmt.all() as IntentRow[];
  return rows.map(rowToIntent);
}

export function getOpenIntents(): Intent[] {
  const stmt = db.prepare('SELECT * FROM intents WHERE status = ? ORDER BY created_at ASC');
  const rows = stmt.all('OPEN') as IntentRow[];
  return rows.map(rowToIntent);
}

export function getPendingIntents(): Intent[] {
  const stmt = db.prepare('SELECT * FROM intents WHERE status = ? ORDER BY created_at ASC');
  const rows = stmt.all('PENDING') as IntentRow[];
  return rows.map(rowToIntent);
}

export function getIntentsByDirection(direction: SwapDirection): Intent[] {
  const stmt = db.prepare('SELECT * FROM intents WHERE direction = ? ORDER BY created_at DESC');
  const rows = stmt.all(direction) as IntentRow[];
  return rows.map(rowToIntent);
}

export function getRecentVolume(windowMs: number = 60 * 60 * 1000): { octToEth: number; ethToOct: number } {
  const cutoff = Date.now() - windowMs;
  
  const stmt = db.prepare(`
    SELECT direction, SUM(amount_in) as total_in, SUM(amount_out) as total_out
    FROM intents
    WHERE created_at >= ? AND status = 'FULFILLED'
    GROUP BY direction
  `);
  
  const rows = stmt.all(cutoff) as Array<{ direction: string; total_in: number; total_out: number }>;
  
  let octToEth = 0;
  let ethToOct = 0;
  
  for (const row of rows) {
    if (row.direction === 'OCT_TO_ETH') {
      octToEth = row.total_in || 0;
    } else {
      ethToOct = row.total_out || 0;
    }
  }
  
  return { octToEth, ethToOct };
}

// =============================================================================
// Nonce Operations
// =============================================================================

export function isNonceUsed(nonce: string): boolean {
  const stmt = db.prepare('SELECT 1 FROM nonces WHERE nonce = ?');
  return stmt.get(nonce) !== undefined;
}

export function addNonce(nonce: string): void {
  const stmt = db.prepare('INSERT OR IGNORE INTO nonces (nonce) VALUES (?)');
  stmt.run(nonce);
}

// =============================================================================
// Oracle History Operations
// =============================================================================

export function addOracleRate(rate: number): void {
  const stmt = db.prepare('INSERT INTO oracle_history (rate, timestamp) VALUES (?, ?)');
  stmt.run(rate, Date.now());
}

export function getOracleHistory(limit: number = 100): Array<{ rate: number; timestamp: number }> {
  const stmt = db.prepare('SELECT rate, timestamp FROM oracle_history ORDER BY timestamp DESC LIMIT ?');
  return stmt.all(limit) as Array<{ rate: number; timestamp: number }>;
}

export function getLatestOracleRate(): { rate: number; timestamp: number } | undefined {
  const stmt = db.prepare('SELECT rate, timestamp FROM oracle_history ORDER BY timestamp DESC LIMIT 1');
  return stmt.get() as { rate: number; timestamp: number } | undefined;
}

// =============================================================================
// Helpers
// =============================================================================

interface IntentRow {
  intent_id: string;
  direction: string;
  source_address: string;
  source_tx_hash: string;
  amount_in: number;
  target_address: string;
  target_tx_hash: string | null;
  amount_out: number | null;
  min_amount_out: number;
  status: string;
  expiry: number;
  created_at: number;
  fulfilled_at: number | null;
  error: string | null;
  payload: string;
}

function rowToIntent(row: IntentRow): Intent {
  return {
    intentId: row.intent_id,
    direction: row.direction as SwapDirection,
    sourceAddress: row.source_address,
    sourceTxHash: row.source_tx_hash,
    amountIn: row.amount_in,
    targetAddress: row.target_address,
    targetTxHash: row.target_tx_hash || undefined,
    amountOut: row.amount_out || undefined,
    minAmountOut: row.min_amount_out,
    status: row.status as IntentStatus,
    expiry: row.expiry,
    createdAt: row.created_at,
    fulfilledAt: row.fulfilled_at || undefined,
    error: row.error || undefined,
    payload: JSON.parse(row.payload),
  };
}

export function closeDatabase(): void {
  if (db) {
    db.close();
    console.log('[DB] Database closed');
  }
}
