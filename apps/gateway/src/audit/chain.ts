import { createHash } from "node:crypto";
import Database from "better-sqlite3";
import { config } from "../config.js";
import { mkdirSync } from "node:fs";
import { currentAgent } from "../agents/context.js";
import { dirname } from "node:path";

export type AuditEvent = {
  id: number;
  runId: string;
  customerId: string;
  type: string;
  payload: unknown;
  prevHash: string;
  hash: string;
  createdAt: string;
};

let db: Database.Database | null = null;

function getDb() {
  if (db) return db;
  mkdirSync(dirname(config.dbPath), { recursive: true });
  db = new Database(config.dbPath);
  db.exec(`
    CREATE TABLE IF NOT EXISTS audit_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id TEXT NOT NULL,
      customer_id TEXT NOT NULL,
      type TEXT NOT NULL,
      payload TEXT NOT NULL,
      prev_hash TEXT NOT NULL,
      hash TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS order_intents (
      id TEXT PRIMARY KEY,
      customer_id TEXT NOT NULL,
      run_id TEXT NOT NULL,
      status TEXT NOT NULL,
      need_json TEXT NOT NULL,
      basket_json TEXT NOT NULL,
      snapshot_hash TEXT NOT NULL,
      policy_json TEXT NOT NULL,
      total_price REAL NOT NULL,
      needed_by TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      approval_snapshot_hash TEXT,
      idempotency_key TEXT,
      committed_order_id TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_idempotency
      ON order_intents(idempotency_key)
      WHERE idempotency_key IS NOT NULL;
    CREATE TABLE IF NOT EXISTS quotes (
      id TEXT PRIMARY KEY,
      customer_id TEXT NOT NULL,
      run_id TEXT NOT NULL,
      status TEXT NOT NULL,
      need_json TEXT NOT NULL,
      lines_json TEXT NOT NULL,
      claims_json TEXT NOT NULL,
      total_price REAL NOT NULL,
      currency TEXT NOT NULL,
      issued_at TEXT NOT NULL,
      valid_until TEXT NOT NULL,
      intent_id TEXT
    );
  `);
  try {
    db.exec(`ALTER TABLE order_intents ADD COLUMN meta_json TEXT`);
  } catch {
    /* column already exists */
  }
  return db;
}

function hashEvent(
  prevHash: string,
  type: string,
  payload: unknown,
  createdAt: string,
): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        prevHash,
        type,
        payload,
        createdAt,
      }),
    )
    .digest("hex");
}

export function appendAudit(
  runId: string,
  customerId: string,
  type: string,
  payload: unknown,
): AuditEvent {
  const agent = currentAgent();
  if (agent && payload && typeof payload === "object" && !Array.isArray(payload) && !("agent" in (payload as object))) {
    payload = { ...(payload as Record<string, unknown>), agent };
  }
  const database = getDb();
  const tx = database.transaction(() => {
    const last = database
      .prepare(
        `SELECT hash FROM audit_events WHERE run_id = ? AND customer_id = ? ORDER BY id DESC LIMIT 1`,
      )
      .get(runId, customerId) as { hash: string } | undefined;
    const prevHash = last?.hash ?? "GENESIS";
    const createdAt = new Date().toISOString();
    const hash = hashEvent(prevHash, type, payload, createdAt);
    const info = database
      .prepare(
        `INSERT INTO audit_events (run_id, customer_id, type, payload, prev_hash, hash, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        runId,
        customerId,
        type,
        JSON.stringify(payload),
        prevHash,
        hash,
        createdAt,
      );
    return {
      id: Number(info.lastInsertRowid),
      runId,
      customerId,
      type,
      payload,
      prevHash,
      hash,
      createdAt,
    };
  });
  return tx();
}

export function getAuditTrail(runId: string, customerId: string): AuditEvent[] {
  const rows = getDb()
    .prepare(
      `SELECT * FROM audit_events WHERE run_id = ? AND customer_id = ? ORDER BY id ASC`,
    )
    .all(runId, customerId) as Array<{
    id: number;
    run_id: string;
    customer_id: string;
    type: string;
    payload: string;
    prev_hash: string;
    hash: string;
    created_at: string;
  }>;
  return rows.map((r) => ({
    id: r.id,
    runId: r.run_id,
    customerId: r.customer_id,
    type: r.type,
    payload: JSON.parse(r.payload),
    prevHash: r.prev_hash,
    hash: r.hash,
    createdAt: r.created_at,
  }));
}

export function verifyAuditChain(
  runId: string,
  customerId: string,
): { valid: boolean; brokenAt?: number; headHash?: string } {
  const events = getAuditTrail(runId, customerId);
  let prev = "GENESIS";
  for (const e of events) {
    if (e.prevHash !== prev) {
      return { valid: false, brokenAt: e.id };
    }
    const expected = hashEvent(e.prevHash, e.type, e.payload, e.createdAt);
    if (expected !== e.hash) {
      return { valid: false, brokenAt: e.id };
    }
    prev = e.hash;
  }
  return { valid: true, headHash: events.at(-1)?.hash };
}

export { getDb };
