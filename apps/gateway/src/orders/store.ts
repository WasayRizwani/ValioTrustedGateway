import { randomUUID } from "node:crypto";
import type {
  BasketLine,
  DetachedBuyerSignatureInput,
  Mandate,
  Need,
  Offer,
  PolicyVerdict,
  TradeReceipt,
} from "@tta/shared";
import { getDb, appendAudit, verifyAuditChain } from "../audit/chain.js";
import { getTradeReceipt, issueTradeReceipt, saveTradeReceipt } from "../claims/receipt.js";
import { snapshotHash } from "../claims/sign.js";
import { evaluatePolicy, offerToBasketLine } from "../policy/engine.js";
import { computeSpend } from "../policy/spend.js";
import { buildOffers, buildOffersBatch } from "../catalog/offers.js";
import { getAvailability, getPrices } from "../valio/client.js";
import { recordCommittedOrder } from "../hotel/kitchen.js";
import { currentAgent, withAgent } from "../agents/context.js";
import { getMandate } from "../auth/customers.js";
import { verifyHumanSignature, type HumanSignatureProof } from "../auth/humanProof.js";
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
export type AuthorizedFallback = {
  productId: string;
  productName?: string;
  maxTotalPrice?: number;
};

export type CascadeExecuted = {
  droppedProductId: string;
  droppedProductName: string;
  backupProductId: string;
  backupProductName: string;
  newTotalPrice: number;
  at: string;
};

export type IntentMeta = {
  rationale: string[];
  alternatives: Alternative[];
  consideredOffers: number;
  /** Per-line needs when this order intent represents a consolidated multi-item basket. */
  itemNeeds?: Need[];
  isMultiItemBasket?: boolean;
  /** Set when the intent was created from a firm-price quote. */
  quoteId?: string;
  quoteValidUntil?: string;
  /** Cryptographic proof attached when buyer signs an override with Passkey / ECDSA P-256. */
  humanSignatureProof?: HumanSignatureProof;
  humanSignatureRaw?: Record<string, unknown>;
  receiptId?: string;
  receiptHash?: string;
  /** Pre-authorized backup SKU for autonomous stock-out cascade at commit time. */
  authorizedFallback?: AuthorizedFallback;
  /** Recorded when the primary SKU stocked out at commit and cascaded to `authorizedFallback`. */
  cascadeExecuted?: CascadeExecuted;
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

async function saveIntent(intent: OrderIntent): Promise<void> {
  await getDb().execute(
    `INSERT INTO order_intents (
      id, customer_id, run_id, status, need_json, basket_json, snapshot_hash,
      policy_json, total_price, needed_by, expires_at, approval_snapshot_hash,
      idempotency_key, committed_order_id, created_at, updated_at, meta_json
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)
    ON CONFLICT (id) DO UPDATE SET
      status = excluded.status,
      basket_json = excluded.basket_json,
      snapshot_hash = excluded.snapshot_hash,
      policy_json = excluded.policy_json,
      total_price = excluded.total_price,
      approval_snapshot_hash = excluded.approval_snapshot_hash,
      idempotency_key = excluded.idempotency_key,
      committed_order_id = excluded.committed_order_id,
      updated_at = excluded.updated_at,
      meta_json = COALESCE(excluded.meta_json, order_intents.meta_json)`,
    [
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
    ],
  );
}

export async function getIntent(id: string, customerId: string): Promise<OrderIntent | null> {
  const row = await getDb().queryOne<Record<string, unknown>>(
    `SELECT * FROM order_intents WHERE id = $1 AND customer_id = $2`,
    [id, customerId],
  );
  return row ? rowToIntent(row) : null;
}

/** Intents past their expiry can never be committed — close them so queues stay honest. */
export async function expireStaleIntents(customerId: string): Promise<number> {
  const now = new Date().toISOString();
  const rows = await getDb().query<{ id: string; run_id: string }>(
    `SELECT id, run_id FROM order_intents
     WHERE customer_id = $1 AND expires_at < $2
       AND status IN ('pending_approval','auto_eligible','approved','intent_created')`,
    [customerId, now],
  );
  for (const r of rows) {
    await getDb().execute(
      `UPDATE order_intents SET status = 'expired', updated_at = $1 WHERE id = $2`,
      [now, r.id],
    );
    await appendAudit(r.run_id, customerId, "intent_expired", { intentId: r.id });
  }
  return rows.length;
}

export async function listPending(customerId: string): Promise<OrderIntent[]> {
  await expireStaleIntents(customerId);
  const rows = await getDb().query<Record<string, unknown>>(
    `SELECT * FROM order_intents WHERE customer_id = $1 AND status = 'pending_approval' ORDER BY created_at DESC`,
    [customerId],
  );
  return rows.map(rowToIntent);
}

export async function listOrders(customerId: string): Promise<OrderIntent[]> {
  await expireStaleIntents(customerId);
  const rows = await getDb().query<Record<string, unknown>>(
    `SELECT * FROM order_intents WHERE customer_id = $1 ORDER BY created_at DESC LIMIT 100`,
    [customerId],
  );
  return rows.map(rowToIntent);
}

async function findOpenDuplicate(
  customerId: string,
  need: Need,
  productId: string,
): Promise<OrderIntent | null> {
  const rows = await getDb().query<Record<string, unknown>>(
    `SELECT * FROM order_intents
     WHERE customer_id = $1 AND needed_by = $2 AND expires_at > $3
       AND status IN ('pending_approval','auto_eligible','approved')
     ORDER BY created_at DESC`,
    [customerId, need.neededBy, new Date().toISOString()],
  );
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
export async function resetIntents(customerId: string, source: string | null = null): Promise<number> {
  const ids = (
    await getDb().query<{ id: string }>(`SELECT id FROM order_intents WHERE customer_id = $1`, [customerId])
  ).map((r) => r.id);
  const res = await getDb().execute(`DELETE FROM order_intents WHERE customer_id = $1`, [customerId]);
  await appendAudit(randomUUID(), customerId, "demo_reset", { removedIntents: res.rowCount, intentIds: ids.slice(0, 200), source });
  return res.rowCount;
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

export type MultiIntentItemInput = {
  need: Need;
  offerProductId?: string;
};

type CreateIntentParams = {
  customerId: string;
  mandate: Mandate;
  need?: Need;
  /** Consolidated multi-item basket items (when ordering 2+ products together). */
  items?: MultiIntentItemInput[];
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
  if (params.items && params.items.length > 1) {
    return createMultiItemIntentImpl({ ...params, runId }, params.items);
  }
  const singleNeed = params.items?.[0]?.need ?? params.need;
  const singleOfferProductId = params.items?.[0]?.offerProductId ?? params.offerProductId;
  if (!singleNeed) {
    throw new Error("Need or items required to create order intent");
  }
  const resolvedParams = { ...params, need: singleNeed, offerProductId: singleOfferProductId };
  await appendAudit(runId, resolvedParams.customerId, "need_validated", resolvedParams.need);

  // Comparing offers is the Sourcing agent's job; the Procurement agent only decides what to do with the result.
  const offers = await withAgent("sourcing", async () => {
    const found = await buildOffers(resolvedParams.customerId, resolvedParams.need, {
      includeSubstitutions: resolvedParams.includeSubstitutions ?? true,
      mandate: resolvedParams.mandate,
    });
    await appendAudit(runId, resolvedParams.customerId, "offers_built", {
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
    (resolvedParams.offerProductId
      ? offers.find((o) => o.productId === resolvedParams.offerProductId)
      : offers.find((o) => o.canFulfil)) ?? offers[0];

  if (!selected) {
    throw new Error("No offers available for this need");
  }
  if (resolvedParams.markSubstitution) {
    selected.isSubstitution = true;
    selected.substitutionLabel = resolvedParams.substitutionLabel ?? selected.substitutionLabel;
  }

  // Idempotency: an identical open intent (same product, qty, date) is reused, not duplicated.
  const open = await findOpenDuplicate(resolvedParams.customerId, resolvedParams.need, selected.productId);
  if (open) {
    await appendAudit(runId, resolvedParams.customerId, "intent_deduplicated", {
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

  const meta = buildMeta(selected, offers, resolvedParams.need);
  const basket = [offerToBasketLine(selected)];
  const snap = {
    basket,
    neededBy: resolvedParams.need.neededBy,
    customerId: resolvedParams.customerId,
  };
  const hash = snapshotHash(snap);
  const now = new Date().toISOString();
  const intentId = randomUUID();

  // A newer proposal for the very same need replaces older unapproved ones (no stacked duplicates).
  // Supersede before computeSpend so a replaced auto_eligible intent is never double-counted.
  const replaced = await getDb().query<{ id: string; run_id: string }>(
    `SELECT id, run_id FROM order_intents
     WHERE customer_id = $1 AND needed_by = $2 AND status IN ('pending_approval', 'auto_eligible')
       AND (need_json::jsonb)->>'productIntent' = $3
       AND ((need_json::jsonb)->>'quantity')::double precision = $4
       AND (need_json::jsonb)->>'unit' = $5`,
    [
      resolvedParams.customerId,
      resolvedParams.need.neededBy,
      resolvedParams.need.productIntent,
      resolvedParams.need.quantity,
      resolvedParams.need.unit,
    ],
  );
  for (const r of replaced) {
    await getDb().execute(`UPDATE order_intents SET status = 'superseded', updated_at = $1 WHERE id = $2`, [now, r.id]);
    await appendAudit(r.run_id, resolvedParams.customerId, "intent_superseded", { intentId: r.id, by: intentId });
  }

  const policy = evaluatePolicy(resolvedParams.mandate, resolvedParams.need, basket, {
    isSubstitution: selected.isSubstitution,
    partialFulfil: !selected.canFulfil,
    spend: await computeSpend(resolvedParams.customerId),
  });

  let status = "intent_created";
  if (policy.decision === "auto_commit") status = "auto_eligible";
  else if (policy.decision === "pending_approval") status = "pending_approval";
  else status = "blocked";

  const intent: OrderIntent = {
    id: intentId,
    customerId: resolvedParams.customerId,
    runId,
    status,
    need: resolvedParams.need,
    basket,
    snapshotHash: hash,
    policy,
    totalPrice: selected.totalPrice,
    neededBy: resolvedParams.need.neededBy,
    expiresAt: new Date(Date.now() + 60 * 60_000).toISOString(),
    approvalSnapshotHash: null,
    idempotencyKey: null,
    committedOrderId: null,
    createdAt: now,
    updatedAt: now,
    selectedOffer: selected,
    meta,
  };

  await saveIntent(intent);
  await appendAudit(runId, resolvedParams.customerId, "intent_created", {
    intentId: intent.id,
    snapshotHash: hash,
    productId: selected.productId,
    productName: selected.productName,
    totalPrice: selected.totalPrice,
    why: meta.rationale.slice(0, 3),
    alternatives: meta.alternatives.length,
  });
  await appendAudit(runId, resolvedParams.customerId, "policy_evaluated", policy);

  const explanation = [
    `Selected ${selected.productName}.`,
    `Total €${selected.totalPrice.toFixed(2)} for ${selected.requiredPacks} packs.`,
    `Policy: ${policy.decision}.`,
    ...policy.reasons,
  ].join(" ");

  return { intent, offers, explanation };
}

async function createMultiItemIntentImpl(
  params: CreateIntentParams & { runId: string },
  items: MultiIntentItemInput[],
): Promise<{
  intent: OrderIntent;
  offers: Offer[];
  explanation: string;
}> {
  const { customerId, mandate, runId } = params;
  const itemNeeds = items.map((it) => it.need);
  await appendAudit(runId, customerId, "need_validated", {
    isMultiItem: true,
    itemCount: itemNeeds.length,
    needs: itemNeeds,
    quantity: itemNeeds[0]!.quantity,
    unit: itemNeeds[0]!.unit,
    productIntent: itemNeeds.map((n) => `${n.quantity} ${n.unit} ${n.productIntent}`).join(" + "),
    neededBy: itemNeeds.map((n) => n.neededBy).sort()[0]!,
  });

  const batch = await withAgent("sourcing", async () => {
    const res = await buildOffersBatch(customerId, itemNeeds, {
      includeSubstitutions: params.includeSubstitutions ?? true,
      mandate,
    });
    await appendAudit(runId, customerId, "offers_built", {
      isMultiItem: true,
      count: res.items.reduce((s, it) => s + it.offers.length, 0),
      perItemCounts: res.items.map((it) => ({
        productIntent: it.need.productIntent,
        count: it.offers.length,
      })),
    });
    return res;
  });

  const selectedOffers: Offer[] = [];
  let totalConsidered = 0;
  for (let i = 0; i < items.length; i++) {
    const req = items[i]!;
    const pool = batch.items[i]?.offers ?? [];
    totalConsidered += pool.length;
    let chosen = req.offerProductId
      ? pool.find((o) => o.productId === req.offerProductId)
      : pool.find((o) => o.canFulfil) ?? pool[0];
    if (!chosen && req.offerProductId) {
      const direct = await withAgent("sourcing", () =>
        buildOffers(customerId, req.need, {
          productIds: [req.offerProductId!],
          includeSubstitutions: params.includeSubstitutions ?? true,
          mandate,
        }),
      );
      chosen = direct[0];
    }
    if (!chosen) {
      throw new Error(
        `No offers available for "${req.need.productIntent}" (${req.need.quantity} ${req.need.unit})`,
      );
    }
    selectedOffers.push(chosen);
  }

  const basket = selectedOffers.map(offerToBasketLine);
  const totalPrice = round2(basket.reduce((s, l) => s + l.totalPrice, 0));
  const earliestNeededBy = itemNeeds.map((n) => n.neededBy).sort()[0]!;
  const summaryNeed: Need = {
    ...itemNeeds[0]!,
    neededBy: earliestNeededBy,
  };
  const hash = snapshotHash({ basket, neededBy: earliestNeededBy, customerId });
  const now = new Date().toISOString();
  const intentId = randomUUID();

  const rationale = selectedOffers.map(
    (o, idx) =>
      `Item ${idx + 1} (${itemNeeds[idx]!.quantity} ${itemNeeds[idx]!.unit} ${itemNeeds[idx]!.productIntent}): ${o.productName} (${o.requiredPacks} × ${o.packSize} ${o.packUnit}) — €${o.totalPrice.toFixed(2)}`,
  );

  const meta: IntentMeta = {
    rationale,
    alternatives: [],
    consideredOffers: totalConsidered,
    itemNeeds,
    isMultiItemBasket: true,
  };

  const policy = evaluatePolicy(mandate, summaryNeed, basket, {
    isSubstitution: selectedOffers.some((o) => o.isSubstitution),
    partialFulfil: selectedOffers.some((o) => !o.canFulfil),
    spend: await computeSpend(customerId),
    lineNeeds: itemNeeds,
  });

  let status = "intent_created";
  if (policy.decision === "auto_commit") status = "auto_eligible";
  else if (policy.decision === "pending_approval") status = "pending_approval";
  else status = "blocked";

  const intent: OrderIntent = {
    id: intentId,
    customerId,
    runId,
    status,
    need: summaryNeed,
    basket,
    snapshotHash: hash,
    policy,
    totalPrice,
    neededBy: earliestNeededBy,
    expiresAt: new Date(Date.now() + 60 * 60_000).toISOString(),
    approvalSnapshotHash: null,
    idempotencyKey: null,
    committedOrderId: null,
    createdAt: now,
    updatedAt: now,
    selectedOffer: selectedOffers[0],
    meta,
  };

  await saveIntent(intent);
  await appendAudit(runId, customerId, "intent_created", {
    intentId: intent.id,
    snapshotHash: hash,
    isMultiItemBasket: true,
    itemCount: basket.length,
    productId: basket[0]!.productId,
    productName: basket.map((b) => b.productName).join(" + "),
    totalPrice,
    why: rationale,
    alternatives: 0,
  });
  await appendAudit(runId, customerId, "policy_evaluated", policy);

  const explanation = [
    `Prepared ${basket.length}-item basket (${basket.map((b) => `${b.packs}× ${b.productName}`).join(" + ")}).`,
    `Combined total €${totalPrice.toFixed(2)}.`,
    `Policy: ${policy.decision}.`,
    ...policy.reasons,
  ].join(" ");

  return { intent, offers: selectedOffers, explanation };
}

/** Quote -> intent: lines and prices come from the quote (no re-pricing). The quote is consumed atomically. */
async function createIntentFromQuote(params: CreateIntentParams, quoteId: string) {
  const customerId = params.customerId;
  const quote = await getQuote(quoteId, customerId); // scoped by owner: another customer's quote looks like "not found"
  if (!quote) throw new Error("quote_not_found: no such quote for this customer");
  if (quote.status === "used") throw new Error(`quote_already_used: quote ${quoteId} was already turned into an order intent`);
  if (quote.status !== "open") throw new Error(`quote_${quote.status}: quote ${quoteId} can no longer be used; request a new quote`);

  // Multi-item consolidated basket quote
  if (quote.isMultiItemBasket && quote.lines.length > 1) {
    const runId = params.runId ?? quote.runId ?? randomUUID();
    const need = quote.need;
    const itemNeeds = quote.itemNeeds;
    const basket: BasketLine[] = quote.lines.map((l) => ({ ...l }));
    const totalPrice = round2(basket.reduce((s, l) => s + l.totalPrice, 0));
    const hash = snapshotHash({ basket, neededBy: need.neededBy, customerId });
    const partial = basket.some((l) => l.availableQuantity != null && l.availableQuantity < l.packs);
    const now = new Date().toISOString();
    const intentId = randomUUID();
    const validWindowLabel = quote.validUntil.includes("T")
      ? `${quote.validUntil.slice(11, 16)} UTC`
      : quote.validUntil;
    const quoteRationale: string[] = [
      `Locked firm Valio contract prices across ${basket.length} items (€${totalPrice.toFixed(2)} total)`,
      ...basket.map(
        (l, idx) =>
          `Item ${idx + 1}: ${l.packs} × ${l.productName} (€${l.totalPrice.toFixed(2)})${l.availableDate ? ` · Arrives ${l.availableDate}` : ""}`,
      ),
      `Prices guaranteed under quote ${quoteId} until ${validWindowLabel}; live stock is re-verified at commit.`,
    ];
    const meta: IntentMeta = {
      rationale: quoteRationale,
      alternatives: [],
      consideredOffers: basket.length,
      itemNeeds,
      isMultiItemBasket: true,
      quoteId,
      quoteValidUntil: quote.validUntil,
    };
    const db = getDb();
    const { intent, policy } = await db.withTransaction(async () => {
      if (!(await markQuoteUsed(quoteId, customerId, intentId))) {
        throw new Error(`quote_expired: quote ${quoteId} is no longer open (used or past its firm window)`);
      }
      const policy = evaluatePolicy(params.mandate, need, basket, {
        isSubstitution: basket.some((l) => l.isSubstitution),
        partialFulfil: partial,
        spend: await computeSpend(customerId),
        lineNeeds: itemNeeds,
      });
      const status =
        policy.decision === "auto_commit"
          ? "auto_eligible"
          : policy.decision === "pending_approval"
            ? "pending_approval"
            : "blocked";
      const intent: OrderIntent = {
        id: intentId,
        customerId,
        runId,
        status,
        need,
        basket,
        snapshotHash: hash,
        policy,
        totalPrice,
        neededBy: need.neededBy,
        expiresAt: new Date(Date.now() + 60 * 60_000).toISOString(),
        approvalSnapshotHash: null,
        idempotencyKey: null,
        committedOrderId: null,
        createdAt: now,
        updatedAt: now,
        meta,
      };
      await saveIntent(intent);
      return { intent, policy };
    });

    await appendAudit(runId, customerId, "quote_accepted", {
      quoteId,
      intentId,
      isMultiItemBasket: true,
      itemCount: basket.length,
      productId: basket[0]!.productId,
      totalPrice,
      validUntil: quote.validUntil,
    });
    await appendAudit(runId, customerId, "intent_created", {
      intentId,
      snapshotHash: hash,
      isMultiItemBasket: true,
      itemCount: basket.length,
      productId: basket[0]!.productId,
      productName: basket.map((b) => b.productName).join(" + "),
      totalPrice,
      quoteId,
      why: meta.rationale,
      alternatives: 0,
    });
    await appendAudit(runId, customerId, "policy_evaluated", policy);
    return {
      intent,
      offers: [] as Offer[],
      explanation: `Used firm multi-item quote ${quoteId}: ${basket.length} items (${basket.map((b) => b.productName).join(" + ")}), total €${totalPrice.toFixed(2)} (price fixed until ${quote.validUntil}). Policy: ${policy.decision}. ${policy.reasons.join(" ")}`.trim(),
    };
  }

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
  const onTimeQuote = (d: string | null) => !d || d <= need.neededBy;
  const arrivalStr = chosen.availableDate ?? need.neededBy;
  const relStr =
    chosen.deliveryReliability != null
      ? ` · ${Math.round(chosen.deliveryReliability * 100)}% on-time delivery history`
      : "";
  const validWindowLabel = quote.validUntil.includes("T")
    ? `${quote.validUntil.slice(11, 16)} UTC`
    : quote.validUntil;
  const quoteRationale: string[] = [
    `Locked firm Valio contract price (€${chosen.totalPrice.toFixed(2)}) · Arrives ${arrivalStr}${relStr}`,
    `Price guaranteed under quote ${quoteId} until ${validWindowLabel}; live stock is re-verified at commit.`,
  ];
  if (chosen.certifications?.length) {
    quoteRationale.push(`Certified: ${chosen.certifications.join(", ")}.`);
  }
  const meta: IntentMeta = {
    rationale: quoteRationale,
    alternatives: others.map((l) => {
      const canFulfil = Boolean(l.availabilityUnknown) || (l.availableQuantity ?? Infinity) >= l.packs;
      const note = !canFulfil
        ? "partly available"
        : !onTimeQuote(l.availableDate)
          ? `arrives ${l.availableDate} (late)`
          : l.isSubstitution
            ? "substitute"
            : l.totalPrice < chosen.totalPrice
              ? "cheaper"
              : l.totalPrice > chosen.totalPrice
                ? "pricier"
                : "same price";
      return {
        productId: l.productId,
        productName: l.productName,
        totalPrice: l.totalPrice,
        deltaEur: Math.round((l.totalPrice - chosen.totalPrice) * 100) / 100,
        availableDate: l.availableDate,
        deliveryReliability: l.deliveryReliability,
        canFulfil,
        isSubstitution: l.isSubstitution,
        certifications: l.certifications,
        origin: l.origin,
        note,
      };
    }),
    consideredOffers: quote.lines.length,
    quoteId,
    quoteValidUntil: quote.validUntil,
  };
  const db = getDb();
  const { intent, policy } = await db.withTransaction(async (tx) => {
    if (!(await markQuoteUsed(quoteId, customerId, intentId))) {
      throw new Error(`quote_expired: quote ${quoteId} is no longer open (used or past its firm window)`);
    }
    const replaced = await tx.query<{ id: string; run_id: string }>(
      `SELECT id, run_id FROM order_intents
       WHERE customer_id = $1 AND needed_by = $2 AND status IN ('pending_approval', 'auto_eligible')
         AND (need_json::jsonb)->>'productIntent' = $3
         AND ((need_json::jsonb)->>'quantity')::double precision = $4
         AND (need_json::jsonb)->>'unit' = $5`,
      [customerId, need.neededBy, need.productIntent, need.quantity, need.unit],
    );
    for (const r of replaced) {
      await tx.execute(`UPDATE order_intents SET status = 'superseded', updated_at = $1 WHERE id = $2`, [now, r.id]);
      await appendAudit(r.run_id, customerId, "intent_superseded", { intentId: r.id, by: intentId });
    }
    const policy = evaluatePolicy(params.mandate, need, basket, {
      isSubstitution: chosen.isSubstitution,
      partialFulfil: partial,
      spend: await computeSpend(customerId),
    });
    const status = policy.decision === "auto_commit" ? "auto_eligible" : policy.decision === "pending_approval" ? "pending_approval" : "blocked";
    const intent: OrderIntent = {
      id: intentId, customerId, runId, status, need, basket, snapshotHash: hash, policy,
      totalPrice: chosen.totalPrice, neededBy: need.neededBy,
      expiresAt: new Date(Date.now() + 60 * 60_000).toISOString(),
      approvalSnapshotHash: null, idempotencyKey: null, committedOrderId: null, createdAt: now, updatedAt: now, meta,
    };
    await saveIntent(intent);
    return { intent, policy };
  });

  await appendAudit(runId, customerId, "quote_accepted", { quoteId, intentId, productId: chosen.productId, totalPrice: chosen.totalPrice, validUntil: quote.validUntil });
  await appendAudit(runId, customerId, "intent_created", { intentId, snapshotHash: hash, productId: chosen.productId, productName: chosen.productName, totalPrice: chosen.totalPrice, quoteId, why: meta.rationale, alternatives: meta.alternatives.length });
  await appendAudit(runId, customerId, "policy_evaluated", policy);
  return {
    intent,
    offers: [] as Offer[],
    explanation: `Used firm quote ${quoteId}: ${chosen.productName}, total €${chosen.totalPrice.toFixed(2)} (price fixed until ${quote.validUntil}). Policy: ${policy.decision}. ${policy.reasons.join(" ")}`.trim(),
  };
}

export async function approveOrder(
  intentId: string,
  customerId: string,
  snapshotHash: string,
  options?: {
    authorizeMandateOverride?: boolean;
    acknowledgedRules?: string[];
    humanSignature?: unknown;
    authorizedFallback?: AuthorizedFallback;
  },
): Promise<OrderIntent> {
  const intent = await getIntent(intentId, customerId);
  if (!intent) throw new Error("Intent not found");
  if (intent.status !== "pending_approval" && intent.status !== "auto_eligible") {
    throw new Error(`Cannot approve from status ${intent.status}`);
  }
  if (new Date(intent.expiresAt).getTime() < Date.now()) {
    intent.status = "expired";
    intent.updatedAt = new Date().toISOString();
    await saveIntent(intent);
    await appendAudit(intent.runId, customerId, "intent_expired", { intentId: intent.id });
    throw new Error("intent_expired: Order intent has expired");
  }
  if (snapshotHash !== intent.snapshotHash) {
    intent.status = "stale_invalidated";
    intent.updatedAt = new Date().toISOString();
    await saveIntent(intent);
    await appendAudit(intent.runId, customerId, "approval_rejected_snapshot_mismatch", {
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
      await appendAudit(intent.runId, customerId, "approval_blocked_no_override", {
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
      await appendAudit(intent.runId, customerId, "approval_blocked_incomplete_ack", {
        intentId,
        missing,
      });
      throw new Error(
        `mandate_override_incomplete: acknowledge failing rules: ${missing.join(", ")}`,
      );
    }
  }

  const humanSignatureProof =
    options?.humanSignature != null ? verifyHumanSignature(intent, options.humanSignature) : undefined;
  const humanSignatureRaw =
    humanSignatureProof && typeof options?.humanSignature === "object" && options.humanSignature !== null
      ? (options.humanSignature as Record<string, unknown>)
      : undefined;
  const authorizedFallback =
    options?.authorizedFallback && typeof options.authorizedFallback.productId === "string" && options.authorizedFallback.productId.trim()
      ? {
          productId: options.authorizedFallback.productId.trim(),
          ...(options.authorizedFallback.productName ? { productName: String(options.authorizedFallback.productName) } : {}),
          ...(options.authorizedFallback.maxTotalPrice != null ? { maxTotalPrice: Number(options.authorizedFallback.maxTotalPrice) } : {}),
        }
      : undefined;

  if (humanSignatureProof || authorizedFallback) {
    const baseMeta: IntentMeta = intent.meta ?? { rationale: [], alternatives: [], consideredOffers: 1 };
    intent.meta = {
      ...baseMeta,
      ...(humanSignatureProof ? { humanSignatureProof } : {}),
      ...(humanSignatureRaw ? { humanSignatureRaw } : {}),
      ...(authorizedFallback ? { authorizedFallback } : {}),
    };
  }

  intent.status = "approved";
  intent.approvalSnapshotHash = snapshotHash;
  intent.updatedAt = new Date().toISOString();
  await saveIntent(intent);
  await appendAudit(intent.runId, customerId, "human_approved", {
    intentId,
    snapshotHash,
    mandateOverride: needsOverride,
    authorizedOverride: needsOverride ? true : false,
    acknowledgedRules: options?.acknowledgedRules ?? [],
    ...(humanSignatureProof ? { humanSignatureProof } : {}),
    ...(authorizedFallback ? { authorizedFallback } : {}),
  });
  return intent;
}

export async function rejectOrder(
  intentId: string,
  customerId: string,
  snapshotHash: string,
  reason?: string,
): Promise<OrderIntent> {
  const intent = await getIntent(intentId, customerId);
  if (!intent) throw new Error("Intent not found");
  if (intent.status === "committed") {
    throw new Error("order_already_committed: Cannot reject a committed order");
  }
  if (snapshotHash !== intent.snapshotHash) {
    throw new Error("Snapshot mismatch");
  }
  intent.status = "rejected";
  intent.updatedAt = new Date().toISOString();
  await saveIntent(intent);
  await appendAudit(intent.runId, customerId, "human_rejected", {
    intentId,
    reason: reason ?? null,
  });
  return intent;
}

export function commitOrder(params: CommitParams) {
  return withAgent("procurement", () => commitOrderImpl(params));
}

export type CommitParams = {
  intentId: string;
  customerId: string;
  idempotencyKey: string;
  priceToleranceEur?: number;
  buyerSignature?: DetachedBuyerSignatureInput;
};

// Concurrent commits: one in-flight promise per (customerId, intentId), so a double-submit resolves to a single order.
const inFlightCommits = new Map<string, { intentId: string; key: string; customerId: string; promise: Promise<OrderIntent> }>();

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
  // Synchronously deduplicate concurrent commits BEFORE the first await.
  const key = params.idempotencyKey;
  const mapKey = `${params.customerId}:${params.intentId}`;

  const running = inFlightCommits.get(mapKey);
  if (running) {
    return running.promise; // join the in-flight commit: still exactly one order
  }
  for (const [, r] of inFlightCommits) {
    if (r.key === key && (r.intentId !== params.intentId || r.customerId !== params.customerId)) {
      return Promise.reject(
        new Error(`idempotency_key_conflict: idempotency key "${key}" is in use by a different order intent`),
      );
    }
  }

  const promise = runCommitFlow(params).finally(() => inFlightCommits.delete(mapKey));
  inFlightCommits.set(mapKey, { intentId: params.intentId, key, customerId: params.customerId, promise });
  return promise;
}

async function runCommitFlow(params: CommitParams): Promise<OrderIntent> {
  const key = params.idempotencyKey;

  const bound = await getDb().queryOne<Record<string, unknown>>(
    `SELECT * FROM order_intents WHERE idempotency_key = $1`,
    [key],
  );
  if (bound) {
    const b = rowToIntent(bound);
    if (b.id !== params.intentId || b.customerId !== params.customerId) {
      const target = await getIntent(params.intentId, params.customerId);
      if (target) {
        await appendAudit(target.runId, target.customerId, "idempotency_key_conflict", {
          intentId: target.id,
          idempotencyKey: key,
        });
      }
      throw new Error(
        `idempotency_key_conflict: idempotency key "${key}" is already bound to a different order intent; use a fresh key per intent`,
      );
    }
    return b; // same key, same intent → replay the stored result
  }

  const intent = await getIntent(params.intentId, params.customerId);
  if (!intent) throw new Error("Intent not found");
  if (intent.status === "committed") return intent; // already placed — never double-commit
  if (intent.status === "blocked" || intent.status === "rejected") {
    throw new Error(`Cannot commit status ${intent.status}`);
  }
  if (intent.status === "pending_approval") {
    throw new Error("Human approval required before commit");
  }
  if (intent.status !== "approved" && intent.status !== "auto_eligible") {
    throw new Error(`Cannot commit from status ${intent.status}`);
  }
  if (new Date(intent.expiresAt).getTime() < Date.now()) {
    intent.status = "expired";
    intent.updatedAt = new Date().toISOString();
    await saveIntent(intent);
    throw new Error("Order intent expired");
  }
  if (intent.status === "auto_eligible") intent.approvalSnapshotHash = intent.snapshotHash; // auto path

  const priorStatus = intent.status;
  intent.status = "revalidating";
  intent.updatedAt = new Date().toISOString();
  await saveIntent(intent);
  return doCommit(intent, params, priorStatus);
}

async function refuse(
  intent: OrderIntent,
  status: string,
  auditType: string,
  payload: Record<string, unknown>,
  message: string,
): Promise<never> {
  intent.status = status;
  intent.updatedAt = new Date().toISOString();
  await saveIntent(intent);
  await appendAudit(intent.runId, intent.customerId, auditType, { intentId: intent.id, ...payload });
  throw new Error(message);
}

async function doCommit(intent: OrderIntent, params: CommitParams, priorStatus: string): Promise<OrderIntent> {
  const customerId = params.customerId;
  await appendAudit(intent.runId, customerId, "revalidating", { intentId: intent.id });

  try {
    // 1. The CURRENT mandate must still authorise this purchase.
    const mandate = await getMandate(customerId);
    if (!mandate || mandateRevoked(mandate) || new Date(mandate.expiresAt).getTime() < Date.now()) {
      const reason = !mandate ? "mandate_missing" : mandateRevoked(mandate) ? "mandate_revoked" : "mandate_expired";
      return await refuse(intent, "blocked", "commit_refused_policy", { reason, failingRules: [reason] }, `mandate_invalid: ${reason} — commit refused`);
    }

    // 2. Re-quote against the live Valio backend.
    const productIds = intent.basket.map((l) => l.productId);
    const [prices, avails] = await Promise.all([
      getPrices(customerId, intent.neededBy, productIds),
      getAvailability(customerId, intent.neededBy, productIds),
    ]);

    // A quote still inside its firm window fixes the price: live drift is recorded, not enforced.
    const quoteId = intent.meta?.quoteId;
    const quote = quoteId ? await getQuote(quoteId, customerId) : null;
    const firm = !!quote && new Date(quote.validUntil).getTime() >= Date.now();

    const tol = params.priceToleranceEur ?? 0.01;
    const tolPct = driftTolerancePct(mandate);
    let newLines = intent.basket.map((l) => ({ ...l }));
    const changes: Array<{ productId: string; was: number; now: number; pct: number }> = [];
    let cascaded = false;
    for (const line of newLines) {
      const price = prices.find((p) => p.productId === line.productId);
      const avail = avails.find((a) => a.productId === line.productId);
      const livePrice = price && price.unitPrice != null && !price.error ? price.unitPrice : null;
      if (livePrice == null && !firm) {
        await refuse(intent, "stale_invalidated", "stale_offer", { reason: "price_missing", productId: line.productId }, `stale_offer: price missing for ${line.productId}`);
      }
      const approvedPartial =
        (priorStatus === "approved" || intent.status === "approved") &&
        (intent.policy.failingRules ?? []).includes("partial_fulfil");
      const minRequiredAvail = approvedPartial
        ? Math.max(1, line.availableQuantity ?? line.packs)
        : line.packs;
      const salesBlocked = !avail || avail.salesBlock;
      const qtyDropped =
        !salesBlocked &&
        avail.availableAmount != null &&
        avail.availableAmount < minRequiredAvail &&
        avail.availableAmount < 999999;

      if (salesBlocked || qtyDropped) {
        const fb = intent.meta?.authorizedFallback;
        if (fb?.productId && !cascaded) {
          const fbOffers = await buildOffers(customerId, intent.need, {
            productIds: [fb.productId],
            includeSubstitutions: true,
          });
          const fbOffer = fbOffers[0];
          if (
            fbOffer &&
            fbOffer.canFulfil &&
            (fb.maxTotalPrice == null || fbOffer.totalPrice <= fb.maxTotalPrice * 1.02)
          ) {
            const fbLine = offerToBasketLine(fbOffer);
            const fbVerdict = evaluatePolicy(mandate, intent.need, [fbLine], {
              isSubstitution: fbLine.isSubstitution,
              partialFulfil: false,
              spend: await computeSpend(customerId),
            });
            if (fbVerdict.decision !== "blocked") {
              newLines = [fbLine];
              const cascadeExecuted: CascadeExecuted = {
                droppedProductId: line.productId,
                droppedProductName: line.productName,
                backupProductId: fbOffer.productId,
                backupProductName: fbOffer.productName,
                newTotalPrice: fbOffer.totalPrice,
                at: new Date().toISOString(),
              };
              const baseMeta: IntentMeta = intent.meta ?? { rationale: [], alternatives: [], consideredOffers: 1 };
              intent.meta = { ...baseMeta, cascadeExecuted };
              cascaded = true;
              await appendAudit(intent.runId, customerId, "fallback_cascade_executed", {
                intentId: intent.id,
                ...cascadeExecuted,
                trigger: salesBlocked ? "sales_block" : "qty_change",
              });
              break;
            }
          }
        }
        if (salesBlocked) {
          return await refuse(intent, "stale_invalidated", "stale_offer", { reason: "sales_block", productId: line.productId }, `stale_offer: sales block for ${line.productId}`);
        }
        return await refuse(
          intent, "stale_invalidated", "stale_offer",
          { reason: "qty_change", productId: line.productId, was: minRequiredAvail, now: avail!.availableAmount },
          `stale_offer: availability dropped for ${line.productId}`,
        );
      }
      if (avail.availableDate) {
        line.availableDate = avail.availableDate.slice(0, 10);
      }
      if (firm) {
        if (livePrice != null && Math.abs(livePrice - line.unitPrice) > tol) {
          await appendAudit(intent.runId, customerId, "quote_price_honoured", {
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

    // 3. Re-evaluate policy on the (possibly repriced / cascaded) basket.
    const verdict = evaluatePolicy(mandate, intent.need, newLines, {
      isSubstitution: newLines.some((l) => l.isSubstitution),
      partialFulfil: !cascaded && (intent.policy.failingRules ?? []).includes("partial_fulfil"),
      spend: await computeSpend(customerId),
      lineNeeds: intent.meta?.itemNeeds,
    });
    if (verdict.decision === "blocked") {
      await refuse(intent, "blocked", "commit_refused_policy", { reason: "policy_blocked", failingRules: verdict.failingRules, reasons: verdict.reasons },
        `policy_blocked: ${verdict.reasons.join("; ")}`);
    }
    // Rules a human already acknowledged at approval time stay acknowledged (approveOrder required the override to
    // cover every failing rule); when a human explicitly pre-authorized `authorizedFallback`, substitution & cap within
    // `maxTotalPrice` are pre-authorized too; anything else new needs a fresh human decision.
    const acknowledged = new Set(intent.policy.failingRules ?? []);
    if (cascaded) {
      acknowledged.add("substitution");
      const fbMax = intent.meta?.authorizedFallback?.maxTotalPrice;
      if (fbMax == null || newTotal <= fbMax * 1.02) {
        acknowledged.add("over_spend");
      }
    }
    const newFailing = verdict.failingRules.filter((r) => !acknowledged.has(r));

    const driftBeyond = worstRise > tolPct;
    const driftNeedsApproval = driftBeyond && mandate.requireApprovalFor.includes("price_change_on_revalidate");
    const driftDetail = changes.map((c) => `${c.productId} was ${c.was} now ${c.now} (${c.pct >= 0 ? "+" : ""}${c.pct}%)`).join(", ");
    if (driftBeyond) {
      const msg = `price_drift_exceeded: ${driftDetail}; tolerance ${tolPct}%`;
      const payload = { changes, tolerancePct: tolPct, was: intent.totalPrice, now: newTotal };
      if (!driftNeedsApproval) {
        await refuse(intent, "stale_invalidated", "stale_offer", { reason: "price_change", ...payload }, `stale_offer: ${msg}; re-quote required`);
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
      await refuse(intent, "pending_approval", "commit_requires_reapproval", { newFailingRules: newFailing, changes, now: newTotal },
        `reapproval_required: commit-time checks failed rules not acknowledged at approval (${newFailing.join(", ")})${changes.length ? `; ${driftDetail}` : ""}`);
    }

    // 4. Within tolerance (or an improvement / pre-authorized cascade): proceed at the live price.
    for (const c of changes) {
      await appendAudit(intent.runId, customerId, c.now < c.was ? "price_improved" : "price_drift_accepted", {
        intentId: intent.id, productId: c.productId, was: c.was, now: c.now, pct: c.pct, tolerancePct: tolPct,
      });
    }
    if (changes.length || cascaded) {
      intent.basket = newLines;
      intent.totalPrice = newTotal;
      intent.snapshotHash = snapshotHash({ basket: newLines, neededBy: intent.neededBy, customerId });
    }

    const orderId = `ORD-${randomUUID().slice(0, 8).toUpperCase()}`;
    const committedAt = new Date().toISOString();
    const chainHead = (await verifyAuditChain(intent.runId, customerId)).headHash ?? null;
    let receipt: TradeReceipt;
    try {
      receipt = issueTradeReceipt({
        orderId,
        intent: { ...intent, updatedAt: committedAt },
        mandate,
        actingAgentId: currentAgent() ?? "procurement",
        auditHeadHash: chainHead,
        detachedBuyerSignature: params.buyerSignature,
      });
    } catch (sigErr) {
      if (sigErr instanceof Error && sigErr.message.startsWith("invalid_buyer_signature")) {
        await appendAudit(intent.runId, customerId, "commit_refused_buyer_signature", {
          intentId: intent.id,
          reason: sigErr.message,
        });
      }
      throw sigErr;
    }

    const baseMeta: IntentMeta = intent.meta ?? { rationale: [], alternatives: [], consideredOffers: 1 };
    intent.meta = {
      ...baseMeta,
      receiptId: receipt.receiptId,
      receiptHash: receipt.receiptHash,
    };
    intent.status = "committed";
    intent.idempotencyKey = params.idempotencyKey;
    intent.committedOrderId = orderId;
    intent.updatedAt = committedAt;
    await saveIntent(intent);
    await saveTradeReceipt(receipt);
    const line = intent.basket[0];
    const itemNeeds = intent.meta?.itemNeeds;
    await recordCommittedOrder(customerId, {
      orderId,
      intentId: intent.id,
      ingredientId: intent.need.ingredientId,
      productName: line?.productName ?? intent.need.productIntent,
      quantity:
        intent.need.ingredientQuantity ??
        (intent.basket.reduce((s, l) => s + l.totalQuantity, 0) || intent.need.quantity),
      unit: intent.need.ingredientUnit ?? intent.need.unit,
      totalEur: intent.totalPrice,
      lines:
        intent.basket.length > 1
          ? intent.basket.map((b, idx) => {
              const ln = itemNeeds?.[idx];
              return {
                ingredientId: ln?.ingredientId,
                productName: b.productName,
                quantity: ln?.ingredientQuantity ?? b.totalQuantity,
                unit: ln?.ingredientUnit ?? b.quantityUnit.toLowerCase(),
                totalEur: b.totalPrice,
              };
            })
          : undefined,
    });
    await appendAudit(intent.runId, customerId, "committed", {
      orderId,
      intentId: intent.id,
      basket: intent.basket,
      totalPrice: intent.totalPrice,
      confirmedAt: intent.updatedAt,
    });
    await appendAudit(intent.runId, customerId, "bilateral_receipt_issued", {
      receiptId: receipt.receiptId,
      orderId,
      intentId: intent.id,
      receiptHash: receipt.receiptHash,
      mandateHash: receipt.buyer.payload.mandateHash,
      quoteId: receipt.buyer.payload.quoteId,
      authorityMode: receipt.buyer.payload.authorityMode,
      buyerAlgorithm: receipt.buyer.algorithm,
      buyerKeyId: receipt.buyer.keyId,
      supplierKeyId: receipt.supplier.keyId,
    });
    return intent;
  } catch (err) {
    // A backend/network failure mid-revalidation must not strand the intent in "revalidating".
    const cur = await getIntent(intent.id, customerId);
    if (cur && cur.status === "revalidating") {
      cur.status = priorStatus;
      cur.updatedAt = new Date().toISOString();
      await saveIntent(cur);
    }
    throw err;
  }
}

export async function ensureReceiptForCommittedOrder(
  idOrOrderId: string,
  customerId: string,
): Promise<TradeReceipt | null> {
  const existing = await getTradeReceipt(idOrOrderId, customerId);
  if (existing) return existing;

  const normalizedOrderId = idOrOrderId.startsWith("VTR-")
    ? `ORD-${idOrOrderId.slice(4)}`
    : idOrOrderId;
  const row = await getDb().queryOne<Record<string, unknown>>(
    `SELECT * FROM order_intents
     WHERE customer_id = $2 AND (id = $1 OR committed_order_id = $1 OR committed_order_id = $3)
     ORDER BY created_at DESC
     LIMIT 1`,
    [idOrOrderId, customerId, normalizedOrderId],
  );
  if (!row) return null;

  const intent = rowToIntent(row);
  if (intent.status !== "committed" || !intent.committedOrderId) {
    return null;
  }

  const mandate = await getMandate(customerId);
  if (!mandate) return null;

  const chainHead = (await verifyAuditChain(intent.runId, customerId)).headHash ?? null;
  const receipt = issueTradeReceipt({
    orderId: intent.committedOrderId,
    intent,
    mandate,
    actingAgentId: "procurement",
    auditHeadHash: chainHead,
  });
  await saveTradeReceipt(receipt);
  return receipt;
}
