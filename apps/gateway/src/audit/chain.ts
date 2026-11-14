import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import Database from "better-sqlite3";
import { config } from "../config.js";
import { mkdirSync } from "node:fs";
import { currentAgent } from "../agents/context.js";
import { dirname } from "node:path";

export const auditBus = new EventEmitter();
auditBus.setMaxListeners(100);

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
  try {
    db.exec(`ALTER TABLE quotes ADD COLUMN meta_json TEXT`);
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
  const created = tx();
  auditBus.emit("audit", created);
  return created;
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

export function simulateAuditTamper(runId: string, customerId: string) {
  const originalEvents = getAuditTrail(runId, customerId);
  if (originalEvents.length === 0) {
    throw new Error(`No audit events found for run ${runId}`);
  }
  const originalValid = verifyAuditChain(runId, customerId).valid;
  const mutatedIndex = Math.min(
    originalEvents.length - 1,
    Math.max(0, Math.floor((originalEvents.length - 1) / 2)),
  );
  const target = originalEvents[mutatedIndex]!;
  const clonedPayload: Record<string, unknown> =
    target.payload && typeof target.payload === "object" && !Array.isArray(target.payload)
      ? JSON.parse(JSON.stringify(target.payload))
      : { value: JSON.parse(JSON.stringify(target.payload ?? null)) };

  let fieldMutated = "tamperedAmountEur";
  let originalValue: unknown = clonedPayload.tamperedAmountEur ?? null;
  let tamperedValue: unknown = 0.01;

  if ("totalPrice" in clonedPayload) {
    fieldMutated = "totalPrice";
    originalValue = clonedPayload.totalPrice;
    tamperedValue = clonedPayload.totalPrice === 0.01 ? 0.02 : 0.01;
  } else if ("estTotal" in clonedPayload) {
    fieldMutated = "estTotal";
    originalValue = clonedPayload.estTotal;
    tamperedValue = clonedPayload.estTotal === 0.01 ? 0.02 : 0.01;
  } else if ("decision" in clonedPayload) {
    fieldMutated = "decision";
    originalValue = clonedPayload.decision;
    tamperedValue = clonedPayload.decision === "auto_commit" ? "tampered_bypass" : "auto_commit";
  } else if ("quantity" in clonedPayload) {
    fieldMutated = "quantity";
    originalValue = clonedPayload.quantity;
    tamperedValue = 99999;
  }
  clonedPayload[fieldMutated] = tamperedValue;

  let prev = "GENESIS";
  let mutatedComputedHash = "";
  const evaluatedEvents = originalEvents.map((ev, idx) => {
    const isMutated = idx === mutatedIndex;
    const payloadToHash = isMutated ? clonedPayload : ev.payload;
    const computedHash = hashEvent(prev, ev.type, payloadToHash, ev.createdAt);
    const intact = prev === ev.prevHash && computedHash === ev.hash;
    if (isMutated) {
      mutatedComputedHash = computedHash;
    }
    prev = computedHash;
    return {
      id: ev.id,
      type: ev.type,
      prevHash: ev.prevHash,
      hash: ev.hash,
      computedHash,
      recomputedHash: computedHash,
      intact,
      mutated: isMutated,
    };
  });

  const downstreamBrokenCount = evaluatedEvents
    .slice(mutatedIndex + 1)
    .filter((e) => !e.intact).length;
  const restoredClean = verifyAuditChain(runId, customerId).valid;

  return {
    runId,
    originalValid,
    tamperedValid: evaluatedEvents.every((e) => e.intact),
    restoredClean,
    mutatedIndex,
    mutatedEventId: target.id,
    tamperedEventId: target.id,
    brokenAt: target.id,
    fieldMutated,
    originalValue,
    tamperedValue,
    expectedHash: target.hash,
    computedHash: mutatedComputedHash,
    downstreamBrokenCount,
    mutationSummary: `Mutated "${fieldMutated}" (${JSON.stringify(originalValue)} → ${JSON.stringify(tamperedValue)}) in event #${target.id} (${target.type}) — SHA-256 mismatch cascaded across ${downstreamBrokenCount} downstream block(s).`,
    originalSnippet: JSON.stringify(target.payload),
    tamperedSnippet: JSON.stringify(clonedPayload),
    events: evaluatedEvents,
  };
}

export { getDb };
