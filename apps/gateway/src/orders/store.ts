import { randomUUID } from "node:crypto";
import type { BasketLine, Mandate, Need, PolicyVerdict } from "@tta/shared";
import { getDb, appendAudit } from "../audit/chain.js";
import { snapshotHash } from "../claims/sign.js";
import { evaluatePolicy, offerToBasketLine } from "../policy/engine.js";
import { computeSpend } from "../policy/spend.js";
import { buildOffers } from "../catalog/offers.js";
import { getAvailability, getPrices } from "../valio/client.js";
import type { Offer } from "@tta/shared";
import { recordCommittedOrder } from "../hotel/kitchen.js";
import { withAgent } from "../agents/context.js";
import { getMandate } from "../auth/customers.js";
import { getQuote, markQuoteUsed } from "./quotes.js";

export type OrderIntent = {
  id: string;
  customerId: string;
  runId: string;
  status: string;
  need: Need;
  basket: BasketLine[];
  snapshotHash: string;
  policy: PolicyVerdict;
  totalPrice: number;
  neededBy: string;
  expiresAt: string;
  approvalSnapshotHash: string | null;
  idempotencyKey: string | null;
  committedOrderId: string | null;
  createdAt: string;
  updatedAt: string;
  selectedOffer?: Offer;
  /** Why the agent picked this, and what else was on the table (for the human decision). */
  meta?: IntentMeta;
};

export type Alternative = {
  productId: string;
  productName: string;
  totalPrice: number;
  deltaEur: number;
  availableDate: string | null;
  deliveryReliability: number | null;
  canFulfil: boolean;
  isSubstitution: boolean;
  certifications: string[];
  origin: string | null;
  note: string;
};
export type IntentMeta = {
  rationale: string[];
  alternatives: Alternative[];
  consideredOffers: number;
  /** Set when the intent was created from a firm-price quote. */
  quoteId?: string;
  quoteValidUntil?: string;
};

function rowToIntent(row: Record<string, unknown>): OrderIntent {
  return {
    id: String(row.id),
    customerId: String(row.customer_id),
    runId: String(row.run_id),
    status: String(row.status),
    need: JSON.parse(String(row.need_json)),
    basket: JSON.parse(String(row.basket_json)),
    snapshotHash: String(row.snapshot_hash),
    policy: JSON.parse(String(row.policy_json)),
    totalPrice: Number(row.total_price),
    neededBy: String(row.needed_by),
    expiresAt: String(row.expires_at),
    approvalSnapshotHash: row.approval_snapshot_hash
      ? String(row.approval_snapshot_hash)
      : null,
    idempotencyKey: row.idempotency_key ? String(row.idempotency_key) : null,
    committedOrderId: row.committed_order_id
      ? String(row.committed_order_id)
      : null,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    meta: row.meta_json ? JSON.parse(String(row.meta_json)) : undefined,
  };
}

function saveIntent(intent: OrderIntent) {
  getDb()
    .prepare(
      `INSERT INTO order_intents (
        id, customer_id, run_id, status, need_json, basket_json, snapshot_hash,
        policy_json, total_price, needed_by, expires_at, approval_snapshot_hash,
        idempotency_key, committed_order_id, created_at, updated_at, meta_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        status=excluded.status,
        basket_json=excluded.basket_json,
        snapshot_hash=excluded.snapshot_hash,
        policy_json=excluded.policy_json,
        total_price=excluded.total_price,
        approval_snapshot_hash=excluded.approval_snapshot_hash,
        idempotency_key=excluded.idempotency_key,
        committed_order_id=excluded.committed_order_id,
        updated_at=excluded.updated_at,
        meta_json=COALESCE(excluded.meta_json, order_intents.meta_json)`,
    )
    .run(
      intent.id,
      intent.customerId,
      intent.runId,
      intent.status,
      JSON.stringify(intent.need),
      JSON.stringify(intent.basket),
      intent.snapshotHash,
      JSON.stringify(intent.policy),
      intent.totalPrice,
      intent.neededBy,
      intent.expiresAt,
      intent.approvalSnapshotHash,
      intent.idempotencyKey,
      intent.committedOrderId,
      intent.createdAt,
      intent.updatedAt,
      intent.meta ? JSON.stringify(intent.meta) : null,
    );
}

export function getIntent(id: string, customerId: string): OrderIntent | null {
  const row = getDb()
    .prepare(`SELECT * FROM order_intents WHERE id = ? AND customer_id = ?`)
    .get(id, customerId) as Record<string, unknown> | undefined;
  return row ? rowToIntent(row) : null;
}

/** Intents past their expiry can never be committed — close them so queues stay honest. */
export function expireStaleIntents(customerId: string): number {
  const now = new Date().toISOString();
  const rows = getDb()
    .prepare(
      `SELECT id, run_id FROM order_intents
       WHERE customer_id = ? AND expires_at < ?
         AND status IN ('pending_approval','auto_eligible','approved','intent_created')`,
    )
    .all(customerId, now) as Array<{ id: string; run_id: string }>;
  for (const r of rows) {
    getDb()
      .prepare(`UPDATE order_intents SET status = 'expired', updated_at = ? WHERE id = ?`)
      .run(now, r.id);
    appendAudit(r.run_id, customerId, "intent_expired", { intentId: r.id });
  }
  return rows.length;
}

export function listPending(customerId: string): OrderIntent[] {
  expireStaleIntents(customerId);
  const rows = getDb()
    .prepare(
      `SELECT * FROM order_intents WHERE customer_id = ? AND status = 'pending_approval' ORDER BY created_at DESC`,
    )
    .all(customerId) as Array<Record<string, unknown>>;
  return rows.map(rowToIntent);
}

export function listOrders(customerId: string): OrderIntent[] {
  expireStaleIntents(customerId);
  const rows = getDb()
    .prepare(
      `SELECT * FROM order_intents WHERE customer_id = ? ORDER BY created_at DESC LIMIT 100`,
    )
    .all(customerId) as Array<Record<string, unknown>>;
  return rows.map(rowToIntent);
}

function findOpenDuplicate(
  customerId: string,
  need: Need,
  productId: string,
): OrderIntent | null {
  const rows = getDb()
    .prepare(
      `SELECT * FROM order_intents
       WHERE customer_id = ? AND needed_by = ? AND expires_at > ?
         AND status IN ('pending_approval','auto_eligible','approved')
       ORDER BY created_at DESC`,
    )
    .all(customerId, need.neededBy, new Date().toISOString()) as Array<Record<string, unknown>>;
  for (const row of rows) {
    const i = rowToIntent(row);
    if (
      i.basket.some((l) => l.productId === productId) &&
      i.need.quantity === need.quantity &&
      i.need.unit === need.unit
    ) {
      return i;
    }
  }
  return null;
}

/** Demo helper: clear a customer's intents (audit chain is kept — append-only). */
export function resetIntents(customerId: string, source: string | null = null): number {
  const ids = (getDb().prepare(`SELECT id FROM order_intents WHERE customer_id = ?`).all(customerId) as Array<{ id: string }>).map((r) => r.id);
  const res = getDb()
    .prepare(`DELETE FROM order_intents WHERE customer_id = ?`)
    .run(customerId);
  appendAudit(randomUUID(), customerId, "demo_reset", { removedIntents: res.changes, intentIds: ids.slice(0, 200), source });
  return res.changes;
}

function buildMeta(selected: Offer, offers: Offer[], need: Need): IntentMeta {
  const onTime = (o: Offer) => !o.availableDate || o.availableDate <= need.neededBy;
  // Only compare like with like: same catalogue category as the chosen product.
  const comparable = offers.filter((o) => !selected.category || !o.category || o.category === selected.category);
  const deliverable = comparable.filter((o) => o.canFulfil && onTime(o));
  const cheapest = deliverable.slice().sort((a, b) => a.totalPrice - b.totalPrice)[0];
  const rationale: string[] = [];
  if (cheapest && cheapest.productId === selected.productId) {
    rationale.push(`Cheapest of ${deliverable.length} deliverable offers that meet your constraints (€${selected.totalPrice.toFixed(2)}).`);
  } else if (cheapest) {
    rationale.push(
      `Not the cheapest: ${cheapest.productName.slice(0, 48)} is €${(selected.totalPrice - cheapest.totalPrice).toFixed(2)} cheaper${
        selected.isSubstitution ? "" : ", but this one was chosen on delivery, reliability or availability"
      }.`,
    );
  }
  if (selected.canFulfil && onTime(selected)) rationale.push(`Arrives ${selected.availableDate ?? "on time"} — by your ${need.neededBy} deadline.`);
  else if (!selected.canFulfil) rationale.push(`Only partly available (short ${selected.shortfall ?? "?"} packs).`);
  else rationale.push(`Arrives ${selected.availableDate}, after your ${need.neededBy} deadline.`);
  if (selected.deliveryReliability != null) rationale.push(`${Math.round(selected.deliveryReliability * 100)}% on-time delivery history.`);
  else rationale.push("No delivery-reliability history for this product.");
  if (selected.substitutionSource === "valio_catalog") rationale.push(`Valio lists it as a substitute for "${selected.substituteFor}".`);
  if (selected.certifications.length) rationale.push(`Certified: ${selected.certifications.join(", ")}.`);

  const alternatives: Alternative[] = comparable
    .filter((o) => o.productId !== selected.productId)
    .sort((a, b) => Number(b.canFulfil && onTime(b)) - Number(a.canFulfil && onTime(a)) || a.totalPrice - b.totalPrice)
    .slice(0, 3)
    .map((o) => ({
      productId: o.productId,
      productName: o.productName,
      totalPrice: o.totalPrice,
      deltaEur: Math.round((o.totalPrice - selected.totalPrice) * 100) / 100,
      availableDate: o.availableDate,
      deliveryReliability: o.deliveryReliability,
      canFulfil: o.canFulfil,
      isSubstitution: o.isSubstitution,
      certifications: o.certifications,
      origin: o.origin,
      note: !o.canFulfil ? "partly available" : !onTime(o) ? `arrives ${o.availableDate} (late)` : o.totalPrice < selected.totalPrice ? "cheaper" : "pricier",
    }));
  return { rationale, alternatives, consideredOffers: offers.length };
}

export function createOrderIntent(params: CreateIntentParams) {
  return withAgent("procurement", () => createOrderIntentImpl(params));
}

type CreateIntentParams = {
  customerId: string;
  mandate: Mandate;
  need: Need;
  runId?: string;
  offerProductId?: string;
  includeSubstitutions?: boolean;
  /** Mark the chosen offer as a substitution (recipe-compatible alternative). */
  markSubstitution?: boolean;
  substitutionLabel?: "good" | "better" | "best";
  /** Build the intent from this firm-price quote instead of re-pricing live. */
  quoteId?: string;
};

async function createOrderIntentImpl(params: CreateIntentParams): Promise<{
  intent: OrderIntent;
  offers: Offer[];
  explanation: string;
  deduplicated?: boolean;
}> {
  const runId = params.runId ?? randomUUID();
  if (params.quoteId) return createIntentFromQuote(params, params.quoteId);
  appendAudit(runId, params.customerId, "need_validated", params.need);

  // Comparing offers is the Sourcing agent's job; the Procurement agent only decides what to do with the result.
  const offers = await withAgent("sourcing", async () => {
    const found = await buildOffers(params.customerId, params.need, {
      includeSubstitutions: params.includeSubstitutions ?? true,
    });
    appendAudit(runId, params.customerId, "offers_built", {
      count: found.length,
      top: found.slice(0, 5).map((o) => ({
        productId: o.productId,
        totalPrice: o.totalPrice,
        canFulfil: o.canFulfil,
        score: o.score,
      })),
    });
    return found;
  });

  const selected =
    (params.offerProductId
      ? offers.find((o) => o.productId === params.offerProductId)
      : offers.find((o) => o.canFulfil)) ?? offers[0];

  if (!selected) {
    throw new Error("No offers available for this need");
  }
  if (params.markSubstitution) {
    selected.isSubstitution = true;
    selected.substitutionLabel = params.substitutionLabel ?? selected.substitutionLabel;
  }

  // Idempotency: an identical open intent (same product, qty, date) is reused, not duplicated.
  const open = findOpenDuplicate(params.customerId, params.need, selected.productId);
  if (open) {
    appendAudit(runId, params.customerId, "intent_deduplicated", {
      reusedIntentId: open.id,
      productId: selected.productId,
    });
    return {
      intent: { ...open, selectedOffer: selected },
      offers,
      explanation: `Reused existing open intent ${open.id} (${open.status}) for the identical request instead of creating a duplicate.`,
      deduplicated: true,
    };
  }

  const meta = buildMeta(selected, offers, params.need);
  const basket = [offerToBasketLine(selected)];
  const snap = {
    basket,
    neededBy: params.need.neededBy,
    customerId: params.customerId,
  };
  const hash = snapshotHash(snap);
  const now = new Date().toISOString();
  const intentId = randomUUID();

  // A newer proposal for the very same need replaces older unapproved ones (no stacked duplicates).
  // Supersede before computeSpend so a replaced auto_eligible intent is never double-counted.
  const replaced = getDb()
    .prepare(
      `SELECT id, run_id FROM order_intents
       WHERE customer_id = ? AND needed_by = ? AND status IN ('pending_approval', 'auto_eligible')
        AND json_extract(need_json,'$.productIntent') = ?
        AND json_extract(need_json,'$.quantity') = ?
        AND json_extract(need_json,'$.unit') = ?`,
    )
    .all(params.customerId, params.need.neededBy, params.need.productIntent, params.need.quantity, params.need.unit) as Array<{ id: string; run_id: string }>;
  for (const r of replaced) {
    getDb().prepare(`UPDATE order_intents SET status='superseded', updated_at=? WHERE id=?`).run(now, r.id);
    appendAudit(r.run_id, params.customerId, "intent_superseded", { intentId: r.id, by: intentId });
  }

  const policy = evaluatePolicy(params.mandate, params.need, basket, {
    isSubstitution: selected.isSubstitution,
    partialFulfil: !selected.canFulfil,
    spend: computeSpend(params.customerId),
  });

  let status = "intent_created";
  if (policy.decision === "auto_commit") status = "auto_eligible";
  else if (policy.decision === "pending_approval") status = "pending_approval";
  else status = "blocked";

  const intent: OrderIntent = {
    id: intentId,
    customerId: params.customerId,
    runId,
    status,
    need: params.need,
    basket,
    snapshotHash: hash,
    policy,
    totalPrice: selected.totalPrice,
    neededBy: params.need.neededBy,
    expiresAt: new Date(Date.now() + 60 * 60_000).toISOString(),
    approvalSnapshotHash: null,
    idempotencyKey: null,
    committedOrderId: null,
    createdAt: now,
    updatedAt: now,
    selectedOffer: selected,
    meta,
  };

  saveIntent(intent);
  appendAudit(runId, params.customerId, "intent_created", {
    intentId: intent.id,
    snapshotHash: hash,
    productId: selected.productId,
    productName: selected.productName,
    totalPrice: selected.totalPrice,
    why: meta.rationale.slice(0, 3),
    alternatives: meta.alternatives.length,
  });
  appendAudit(runId, params.customerId, "policy_evaluated", policy);

  const explanation = [
    `Selected ${selected.productName}.`,
    `Total €${selected.totalPrice.toFixed(2)} for ${selected.requiredPacks} packs.`,
    `Policy: ${policy.decision}.`,
    ...policy.reasons,
  ].join(" ");

  return { intent, offers, explanation };
}

/** Quote -> intent: lines and prices come from the quote (no re-pricing). The quote is consumed atomically. */
function createIntentFromQuote(params: CreateIntentParams, quoteId: string) {
  const customerId = params.customerId;
  const quote = getQuote(quoteId, customerId); // scoped by owner: another customer's quote looks like "not found"
  if (!quote) throw new Error("quote_not_found: no such quote for this customer");
  if (quote.status === "used") throw new Error(`quote_already_used: quote ${quoteId} was already turned into an order intent`);
  if (quote.status !== "open") throw new Error(`quote_${quote.status}: quote ${quoteId} can no longer be used; request a new quote`);
  const chosen = params.offerProductId ? quote.lines.find((l) => l.productId === params.offerProductId) : quote.lines.find((l) => (l.availableQuantity ?? Infinity) >= l.packs) ?? quote.lines[0];
  if (!chosen) throw new Error(`quote_line_not_found: ${params.offerProductId} is not on quote ${quoteId}`);

  const runId = params.runId ?? quote.runId ?? randomUUID();
  const need = quote.need;
  const basket: BasketLine[] = [{ ...chosen }];
  const hash = snapshotHash({ basket, neededBy: need.neededBy, customerId });
  const partial = chosen.availableQuantity != null && chosen.availableQuantity < chosen.packs;
  const now = new Date().toISOString();
  const intentId = randomUUID();

  const others = quote.lines.filter((l) => l.productId !== chosen.productId);
  const meta: IntentMeta = {
    rationale: [`Built from firm-price quote ${quoteId}: prices fixed until ${quote.validUntil}; availability is re-checked at commit.`],
    alternatives: others.map((l) => ({
      productId: l.productId, productName: l.productName, totalPrice: l.totalPrice,
      deltaEur: Math.round((l.totalPrice - chosen.totalPrice) * 100) / 100, availableDate: l.availableDate,
      deliveryReliability: l.deliveryReliability, canFulfil: (l.availableQuantity ?? Infinity) >= l.packs, isSubstitution: l.isSubstitution,
      certifications: l.certifications, origin: l.origin, note: "also on the quote",
    })),
    consideredOffers: quote.lines.length,
    quoteId,
    quoteValidUntil: quote.validUntil,
  };
  const db = getDb();
  const commitQuoteToIntent = db.transaction(() => {
    if (!markQuoteUsed(quoteId, customerId, intentId)) {
      throw new Error(`quote_expired: quote ${quoteId} is no longer open (used or past its firm window)`);
    }
    const replaced = db
      .prepare(
        `SELECT id, run_id FROM order_intents
         WHERE customer_id = ? AND needed_by = ? AND status IN ('pending_approval', 'auto_eligible')
           AND json_extract(need_json,'$.productIntent') = ? AND json_extract(need_json,'$.quantity') = ? AND json_extract(need_json,'$.unit') = ?`,
      )
      .all(customerId, need.neededBy, need.productIntent, need.quantity, need.unit) as Array<{ id: string; run_id: string }>;
    for (const r of replaced) {
      db.prepare(`UPDATE order_intents SET status='superseded', updated_at=? WHERE id=?`).run(now, r.id);
      appendAudit(r.run_id, customerId, "intent_superseded", { intentId: r.id, by: intentId });
    }
    const policy = evaluatePolicy(params.mandate, need, basket, {
      isSubstitution: chosen.isSubstitution,
      partialFulfil: partial,
      spend: computeSpend(customerId),
    });
    const status = policy.decision === "auto_commit" ? "auto_eligible" : policy.decision === "pending_approval" ? "pending_approval" : "blocked";
    const intent: OrderIntent = {
      id: intentId, customerId, runId, status, need, basket, snapshotHash: hash, policy,
      totalPrice: chosen.totalPrice, neededBy: need.neededBy,
      expiresAt: new Date(Date.now() + 60 * 60_000).toISOString(),
      approvalSnapshotHash: null, idempotencyKey: null, committedOrderId: null, createdAt: now, updatedAt: now, meta,
    };
    saveIntent(intent);
    return { intent, policy };
  });
  const { intent, policy } = commitQuoteToIntent();

  appendAudit(runId, customerId, "quote_accepted", { quoteId, intentId, productId: chosen.productId, totalPrice: chosen.totalPrice, validUntil: quote.validUntil });
  appendAudit(runId, customerId, "intent_created", { intentId, snapshotHash: hash, productId: chosen.productId, productName: chosen.productName, totalPrice: chosen.totalPrice, quoteId, why: meta.rationale, alternatives: meta.alternatives.length });
  appendAudit(runId, customerId, "policy_evaluated", policy);
  return Promise.resolve({
    intent,
    offers: [] as Offer[],
    explanation: `Used firm quote ${quoteId}: ${chosen.productName}, total €${chosen.totalPrice.toFixed(2)} (price fixed until ${quote.validUntil}). Policy: ${policy.decision}. ${policy.reasons.join(" ")}`.trim(),
  });
}

export function approveOrder(
  intentId: string,
  customerId: string,
  snapshotHash: string,
  options?: {
    authorizeMandateOverride?: boolean;
    acknowledgedRules?: string[];
  },
): OrderIntent {
  const intent = getIntent(intentId, customerId);
  if (!intent) throw new Error("Intent not found");
  if (intent.status !== "pending_approval" && intent.status !== "auto_eligible") {
    throw new Error(`Cannot approve from status ${intent.status}`);
  }
  if (new Date(intent.expiresAt).getTime() < Date.now()) {
    intent.status = "expired";
    intent.updatedAt = new Date().toISOString();
    saveIntent(intent);
    appendAudit(intent.runId, customerId, "intent_expired", { intentId: intent.id });
    throw new Error("intent_expired: Order intent has expired");
  }
  if (snapshotHash !== intent.snapshotHash) {
    intent.status = "stale_invalidated";
    intent.updatedAt = new Date().toISOString();
    saveIntent(intent);
    appendAudit(intent.runId, customerId, "approval_rejected_snapshot_mismatch", {
      expected: intent.snapshotHash,
      got: snapshotHash,
    });
    throw new Error("Approval snapshot mismatch — basket changed; approval invalidated");
  }

  const failing = intent.policy.failingRules ?? [];
  const needsOverride =
    intent.policy.decision === "pending_approval" && failing.length > 0;

  if (needsOverride) {
    if (!options?.authorizeMandateOverride) {
      appendAudit(intent.runId, customerId, "approval_blocked_no_override", {
        intentId,
        failingRules: failing,
      });
      throw new Error(
        "mandate_override_required: this order violates the purchasing mandate. Authorize an explicit override or raise the mandate before approval.",
      );
    }
    const acked = new Set(options.acknowledgedRules ?? []);
    const missing = failing.filter((r) => !acked.has(r));
    if (missing.length > 0) {
      appendAudit(intent.runId, customerId, "approval_blocked_incomplete_ack", {
        intentId,
        missing,
      });
      throw new Error(
        `mandate_override_incomplete: acknowledge failing rules: ${missing.join(", ")}`,
      );
    }
  }

  intent.status = "approved";
  intent.approvalSnapshotHash = snapshotHash;
  intent.updatedAt = new Date().toISOString();
  saveIntent(intent);
  appendAudit(intent.runId, customerId, "human_approved", {
    intentId,
    snapshotHash,
    mandateOverride: needsOverride,
    authorizedOverride: needsOverride ? true : false,
    acknowledgedRules: options?.acknowledgedRules ?? [],
  });
  return intent;
}

export function rejectOrder(
  intentId: string,
  customerId: string,
  snapshotHash: string,
  reason?: string,
): OrderIntent {
  const intent = getIntent(intentId, customerId);
  if (!intent) throw new Error("Intent not found");
  if (intent.status === "committed") {
    throw new Error("order_already_committed: Cannot reject a committed order");
  }
  if (snapshotHash !== intent.snapshotHash) {
    throw new Error("Snapshot mismatch");
  }
  intent.status = "rejected";
  intent.updatedAt = new Date().toISOString();
  saveIntent(intent);
  appendAudit(intent.runId, customerId, "human_rejected", {
    intentId,
    reason: reason ?? null,
  });
  return intent;
}

export function commitOrder(params: CommitParams) {
  return withAgent("procurement", () => commitOrderImpl(params));
}

type CommitParams = {
  intentId: string;
  customerId: string;
  idempotencyKey: string;
  priceToleranceEur?: number;
};

// Concurrent commits: one in-flight promise per intent, so a double-submit resolves to a single order.
const inFlightCommits = new Map<string, { key: string; customerId: string; promise: Promise<OrderIntent> }>();

const round2 = (n: number) => Math.round(n * 100) / 100;

/** Optional mandate field (default 2%) — read defensively; the shared schema may not declare it yet. */
function driftTolerancePct(mandate: Mandate): number {
  const raw = (mandate as unknown as Record<string, unknown>).priceDriftTolerancePct;
  const v = raw == null ? NaN : Number(raw);
  return Number.isFinite(v) && v >= 0 ? v : 2;
}

function mandateRevoked(mandate: Mandate): boolean {
  const m = mandate as unknown as Record<string, unknown>;
  return m.revoked === true || m.status === "revoked" || Boolean(m.revokedAt);
}

function commitOrderImpl(params: CommitParams): Promise<OrderIntent> {
  // Everything up to the first await runs synchronously, so the check-and-set below cannot interleave.
  const key = params.idempotencyKey;

  const bound = getDb()
    .prepare(`SELECT * FROM order_intents WHERE idempotency_key = ?`)
    .get(key) as Record<string, unknown> | undefined;
  if (bound) {
    const b = rowToIntent(bound);
    if (b.id !== params.intentId || b.customerId !== params.customerId) {
      const target = getIntent(params.intentId, params.customerId);
      if (target) appendAudit(target.runId, target.customerId, "idempotency_key_conflict", { intentId: target.id, idempotencyKey: key });
      return Promise.reject(
        new Error(`idempotency_key_conflict: idempotency key "${key}" is already bound to a different order intent; use a fresh key per intent`),
      );
    }
    return Promise.resolve(b); // same key, same intent → replay the stored result
  }

  const running = inFlightCommits.get(params.intentId);
  if (running) {
    if (running.customerId !== params.customerId) {
      return Promise.reject(new Error("Intent not found"));
    }
    return running.promise; // join the in-flight commit: still exactly one order
  }
  for (const [otherId, r] of inFlightCommits) {
    if (r.key === key && otherId !== params.intentId) {
      return Promise.reject(new Error(`idempotency_key_conflict: idempotency key "${key}" is in use by a different order intent`));
    }
  }

  const intent = getIntent(params.intentId, params.customerId);
  if (!intent) return Promise.reject(new Error("Intent not found"));
  if (intent.status === "committed") return Promise.resolve(intent); // already placed — never double-commit
  if (intent.status === "blocked" || intent.status === "rejected") {
    return Promise.reject(new Error(`Cannot commit status ${intent.status}`));
  }
  if (intent.status === "pending_approval") {
    return Promise.reject(new Error("Human approval required before commit"));
  }
  if (intent.status !== "approved" && intent.status !== "auto_eligible") {
    return Promise.reject(new Error(`Cannot commit from status ${intent.status}`));
  }
  if (new Date(intent.expiresAt).getTime() < Date.now()) {
    intent.status = "expired";
    intent.updatedAt = new Date().toISOString();
    saveIntent(intent);
    return Promise.reject(new Error("Order intent expired"));
  }
  if (intent.status === "auto_eligible") intent.approvalSnapshotHash = intent.snapshotHash; // auto path

  // Claim the intent (check-and-set) before any await.
  const priorStatus = intent.status;
  intent.status = "revalidating";
  intent.updatedAt = new Date().toISOString();
  saveIntent(intent);
  const promise = doCommit(intent, params, priorStatus).finally(() => inFlightCommits.delete(intent.id));
  inFlightCommits.set(intent.id, { key, customerId: params.customerId, promise });
  return promise;
}

function refuse(intent: OrderIntent, status: string, auditType: string, payload: Record<string, unknown>, message: string): never {
  intent.status = status;
  intent.updatedAt = new Date().toISOString();
  saveIntent(intent);
  appendAudit(intent.runId, intent.customerId, auditType, { intentId: intent.id, ...payload });
  throw new Error(message);
}

async function doCommit(intent: OrderIntent, params: CommitParams, priorStatus: string): Promise<OrderIntent> {
  const customerId = params.customerId;
  appendAudit(intent.runId, customerId, "revalidating", { intentId: intent.id });

  try {
    // 1. The CURRENT mandate must still authorise this purchase.
    const mandate = getMandate(customerId);
    if (!mandate || mandateRevoked(mandate) || new Date(mandate.expiresAt).getTime() < Date.now()) {
      const reason = !mandate ? "mandate_missing" : mandateRevoked(mandate) ? "mandate_revoked" : "mandate_expired";
      refuse(intent, "blocked", "commit_refused_policy", { reason, failingRules: [reason] }, `mandate_invalid: ${reason} — commit refused`);
    }

    // 2. Re-quote against the live Valio backend.
    const productIds = intent.basket.map((l) => l.productId);
    const [prices, avails] = await Promise.all([
      getPrices(customerId, intent.neededBy, productIds),
      getAvailability(customerId, intent.neededBy, productIds),
    ]);

    // A quote still inside its firm window fixes the price: live drift is recorded, not enforced.
    const quoteId = intent.meta?.quoteId;
    const quote = quoteId ? getQuote(quoteId, customerId) : null;
    const firm = !!quote && new Date(quote.validUntil).getTime() >= Date.now();

    const tol = params.priceToleranceEur ?? 0.01;
    const tolPct = driftTolerancePct(mandate);
    const newLines = intent.basket.map((l) => ({ ...l }));
    const changes: Array<{ productId: string; was: number; now: number; pct: number }> = [];
    for (const line of newLines) {
      const price = prices.find((p) => p.productId === line.productId);
      const avail = avails.find((a) => a.productId === line.productId);
      const livePrice = price && price.unitPrice != null && !price.error ? price.unitPrice : null;
      if (livePrice == null && !firm) {
        refuse(intent, "stale_invalidated", "stale_offer", { reason: "price_missing", productId: line.productId }, `stale_offer: price missing for ${line.productId}`);
      }
      if (!avail || avail.salesBlock) {
        refuse(intent, "stale_invalidated", "stale_offer", { reason: "sales_block", productId: line.productId }, `stale_offer: sales block for ${line.productId}`);
      }
      if (avail.availableDate) {
        line.availableDate = avail.availableDate.slice(0, 10);
      }
      const approvedPartial =
        (priorStatus === "approved" || intent.status === "approved") &&
        (intent.policy.failingRules ?? []).includes("partial_fulfil");
      const minRequiredAvail = approvedPartial
        ? Math.max(1, line.availableQuantity ?? line.packs)
        : line.packs;
      if (avail.availableAmount != null && avail.availableAmount < minRequiredAvail && avail.availableAmount < 999999) {
        refuse(
          intent, "stale_invalidated", "stale_offer",
          { reason: "qty_change", productId: line.productId, was: minRequiredAvail, now: avail.availableAmount },
          `stale_offer: availability dropped for ${line.productId}`,
        );
      }
      if (firm) {
        if (livePrice != null && Math.abs(livePrice - line.unitPrice) > tol) {
          appendAudit(intent.runId, customerId, "quote_price_honoured", {
            intentId: intent.id, quoteId, productId: line.productId, quotedUnitPrice: line.unitPrice, liveUnitPrice: livePrice, validUntil: quote!.validUntil,
          });
        }
        continue;
      }
      if (livePrice == null) continue;
      if (Math.abs(livePrice - line.unitPrice) > tol) {
        const was = line.unitPrice;
        const now = livePrice;
        const pct = was > 0 ? round2(((now - was) / was) * 100) : 100;
        changes.push({ productId: line.productId, was, now, pct });
        line.totalPrice = round2(was > 0 ? (line.totalPrice * now) / was : now * line.packs);
        line.unitPrice = now;
        const liveClaims = [price?.claim?.signature ?? "", avail?.claim?.signature ?? ""].filter(Boolean);
        if (liveClaims.length) line.claimIds = liveClaims;
      }
    }

    const rises = changes.filter((c) => c.now > c.was);
    const worstRise = rises.reduce((m, c) => Math.max(m, c.pct), 0);
    const newTotal = round2(newLines.reduce((s, l) => s + l.totalPrice, 0));

    // 3. Re-evaluate policy on the (possibly repriced) basket.
    const verdict = evaluatePolicy(mandate, intent.need, newLines, {
      isSubstitution: newLines.some((l) => l.isSubstitution),
      partialFulfil: (intent.policy.failingRules ?? []).includes("partial_fulfil"),
      spend: computeSpend(customerId),
    });
    if (verdict.decision === "blocked") {
      refuse(intent, "blocked", "commit_refused_policy", { reason: "policy_blocked", failingRules: verdict.failingRules, reasons: verdict.reasons },
        `policy_blocked: ${verdict.reasons.join("; ")}`);
    }
    // Rules a human already acknowledged at approval time stay acknowledged (approveOrder required the override to
    // cover every failing rule); anything new needs a fresh human decision.
    const acknowledged = new Set(intent.policy.failingRules ?? []);
    const newFailing = verdict.failingRules.filter((r) => !acknowledged.has(r));

    const driftBeyond = worstRise > tolPct;
    const driftNeedsApproval = driftBeyond && mandate.requireApprovalFor.includes("price_change_on_revalidate");
    const driftDetail = changes.map((c) => `${c.productId} was ${c.was} now ${c.now} (${c.pct >= 0 ? "+" : ""}${c.pct}%)`).join(", ");
    if (driftBeyond) {
      const msg = `price_drift_exceeded: ${driftDetail}; tolerance ${tolPct}%`;
      const payload = { changes, tolerancePct: tolPct, was: intent.totalPrice, now: newTotal };
      if (!driftNeedsApproval) {
        refuse(intent, "stale_invalidated", "stale_offer", { reason: "price_change", ...payload }, `stale_offer: ${msg}; re-quote required`);
      }
      newFailing.push("price_change_on_revalidate");
      verdict.failingRules = [...new Set([...verdict.failingRules, "price_change_on_revalidate"])];
      verdict.decision = "pending_approval";
      verdict.reasons = [...verdict.reasons, msg];
    }

    if (newFailing.length > 0) {
      // Back to a fresh human decision at the current basket and price.
      intent.basket = newLines;
      intent.totalPrice = newTotal;
      intent.policy = verdict;
      intent.snapshotHash = snapshotHash({ basket: newLines, neededBy: intent.neededBy, customerId });
      intent.approvalSnapshotHash = null;
      refuse(intent, "pending_approval", "commit_requires_reapproval", { newFailingRules: newFailing, changes, now: newTotal },
        `reapproval_required: commit-time checks failed rules not acknowledged at approval (${newFailing.join(", ")})${changes.length ? `; ${driftDetail}` : ""}`);
    }

    // 4. Within tolerance (or an improvement): proceed at the live price.
    for (const c of changes) {
      appendAudit(intent.runId, customerId, c.now < c.was ? "price_improved" : "price_drift_accepted", {
        intentId: intent.id, productId: c.productId, was: c.was, now: c.now, pct: c.pct, tolerancePct: tolPct,
      });
    }
    if (changes.length) {
      intent.basket = newLines;
      intent.totalPrice = newTotal;
      intent.snapshotHash = snapshotHash({ basket: newLines, neededBy: intent.neededBy, customerId });
    }

    const orderId = `ORD-${randomUUID().slice(0, 8).toUpperCase()}`;
    intent.status = "committed";
    intent.idempotencyKey = params.idempotencyKey;
    intent.committedOrderId = orderId;
    intent.updatedAt = new Date().toISOString();
    saveIntent(intent);
    const line = intent.basket[0];
    recordCommittedOrder(customerId, {
      orderId,
      intentId: intent.id,
      ingredientId: intent.need.ingredientId,
      productName: line?.productName ?? intent.need.productIntent,
      quantity:
        intent.need.ingredientQuantity ??
        (intent.basket.reduce((s, l) => s + l.totalQuantity, 0) || intent.need.quantity),
      unit: intent.need.ingredientUnit ?? intent.need.unit,
      totalEur: intent.totalPrice,
    });
    appendAudit(intent.runId, customerId, "committed", {
      orderId,
      intentId: intent.id,
      basket: intent.basket,
      totalPrice: intent.totalPrice,
      confirmedAt: intent.updatedAt,
    });
    return intent;
  } catch (err) {
    // A backend/network failure mid-revalidation must not strand the intent in "revalidating".
    const cur = getIntent(intent.id, customerId);
    if (cur && cur.status === "revalidating") {
      cur.status = priorStatus;
      cur.updatedAt = new Date().toISOString();
      saveIntent(cur);
    }
    throw err;
  }
}
