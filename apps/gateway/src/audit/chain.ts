import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { currentAgent } from "../agents/context.js";
import { closeDb, getDb, getDbBackendInfo, initDb, type DbClient } from "../db/postgres.js";

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

export async function appendAudit(
  runId: string,
  customerId: string,
  type: string,
  payload: unknown,
): Promise<AuditEvent> {
  const agent = currentAgent();
  if (
    agent &&
    payload &&
    typeof payload === "object" &&
    !Array.isArray(payload) &&
    !("agent" in (payload as object))
  ) {
    payload = { ...(payload as Record<string, unknown>), agent };
  }
  const database = getDb();
  const created = await database.withTransaction(async (tx) => {
    await tx.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`${runId}:${customerId}`]);
    const last = await tx.queryOne<{ hash: string }>(
      `SELECT hash FROM audit_events WHERE run_id = $1 AND customer_id = $2 ORDER BY id DESC LIMIT 1`,
      [runId, customerId],
    );
    const prevHash = last?.hash ?? "GENESIS";
    const createdAt = new Date().toISOString();
    const hash = hashEvent(prevHash, type, payload, createdAt);
    const inserted = await tx.queryOne<{ id: number }>(
      `INSERT INTO audit_events (run_id, customer_id, type, payload, prev_hash, hash, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING id`,
      [
        runId,
        customerId,
        type,
        JSON.stringify(payload),
        prevHash,
        hash,
        createdAt,
      ],
    );
    return {
      id: Number(inserted!.id),
      runId,
      customerId,
      type,
      payload,
      prevHash,
      hash,
      createdAt,
    };
  });
  auditBus.emit("audit", created);
  return created;
}

export async function getAuditTrail(runId: string, customerId: string): Promise<AuditEvent[]> {
  const rows = await getDb().query<{
    id: number;
    run_id: string;
    customer_id: string;
    type: string;
    payload: string;
    prev_hash: string;
    hash: string;
    created_at: string;
  }>(
    `SELECT * FROM audit_events WHERE run_id = $1 AND customer_id = $2 ORDER BY id ASC`,
    [runId, customerId],
  );
  return rows.map((r) => ({
    id: Number(r.id),
    runId: r.run_id,
    customerId: r.customer_id,
    type: r.type,
    payload: JSON.parse(r.payload),
    prevHash: r.prev_hash,
    hash: r.hash,
    createdAt: r.created_at,
  }));
}

export async function verifyAuditChain(
  runId: string,
  customerId: string,
): Promise<{ valid: boolean; brokenAt?: number; headHash?: string }> {
  const events = await getAuditTrail(runId, customerId);
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

export async function simulateAuditTamper(runId: string, customerId: string) {
  const originalEvents = await getAuditTrail(runId, customerId);
  if (originalEvents.length === 0) {
    throw new Error(`No audit events found for run ${runId}`);
  }
  const originalValid = (await verifyAuditChain(runId, customerId)).valid;
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
  const restoredClean = (await verifyAuditChain(runId, customerId)).valid;

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

export { closeDb, getDb, getDbBackendInfo, initDb, type DbClient };
