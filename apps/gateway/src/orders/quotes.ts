import { randomUUID } from "node:crypto";
import type { BasketLine, Need, Offer, Quote, SignedClaim } from "@tta/shared";
import { getDb, appendAudit } from "../audit/chain.js";
import { config } from "../config.js";
import { buildOffers, buildOffersBatch } from "../catalog/offers.js";
import { offerToBasketLine } from "../policy/engine.js";
import { signClaim } from "../claims/sign.js";
import { withAgent } from "../agents/context.js";

export const QUOTE_AVAILABILITY_NOTE =
  "Price is firm until validUntil. Availability is NOT held: it is re-checked when the order is committed.";

const round2 = (n: number) => Math.round(n * 100) / 100;

function rowToQuote(row: Record<string, unknown>): Quote {
  const lines = JSON.parse(String(row.lines_json)) as BasketLine[];
  const meta = row.meta_json
    ? (JSON.parse(String(row.meta_json)) as { itemNeeds?: Need[]; isMultiItemBasket?: boolean })
    : undefined;
  return {
    quoteId: String(row.id),
    customerId: String(row.customer_id),
    need: JSON.parse(String(row.need_json)),
    ...(meta?.itemNeeds ? { itemNeeds: meta.itemNeeds } : {}),
    ...(meta?.isMultiItemBasket ? { isMultiItemBasket: true } : {}),
    lines,
    totalPrice: Number(row.total_price),
    currency: String(row.currency),
    issuedAt: String(row.issued_at),
    validUntil: String(row.valid_until),
    claims: JSON.parse(String(row.claims_json)),
    status: String(row.status) as Quote["status"],
    availabilityHeld: false,
    availabilityNote: QUOTE_AVAILABILITY_NOTE,
    intentId: row.intent_id ? String(row.intent_id) : null,
    runId: String(row.run_id),
  };
}

/** Reads a quote scoped to its owner; lazily flips an open quote past its window to "expired". */
export function getQuote(quoteId: string, customerId: string): Quote | null {
  const row = getDb().prepare(`SELECT * FROM quotes WHERE id = ? AND customer_id = ?`).get(quoteId, customerId) as
    | Record<string, unknown>
    | undefined;
  if (!row) return null;
  if (row.status === "open" && String(row.valid_until) < new Date().toISOString()) {
    expireQuotes(customerId);
    row.status = "expired";
  }
  return rowToQuote(row);
}

/** Closes every open quote of the customer (or all customers) whose firm window has ended. */
export function expireQuotes(customerId?: string): number {
  const now = new Date().toISOString();
  const rows = getDb()
    .prepare(
      `SELECT id, run_id, customer_id FROM quotes WHERE status = 'open' AND valid_until < ? ${customerId ? "AND customer_id = ?" : ""}`,
    )
    .all(...(customerId ? [now, customerId] : [now])) as Array<{ id: string; run_id: string; customer_id: string }>;
  for (const r of rows) {
    const res = getDb().prepare(`UPDATE quotes SET status = 'expired' WHERE id = ? AND status = 'open'`).run(r.id);
    if (res.changes) appendAudit(r.run_id, r.customer_id, "quote_expired", { quoteId: r.id });
  }
  return rows.length;
}

/** Atomic open -> used transition (single use). Returns false if the quote was not open and in-window. */
export function markQuoteUsed(quoteId: string, customerId: string, intentId: string): boolean {
  const res = getDb()
    .prepare(
      `UPDATE quotes SET status = 'used', intent_id = ? WHERE id = ? AND customer_id = ? AND status = 'open' AND valid_until >= ?`,
    )
    .run(intentId, quoteId, customerId, new Date().toISOString());
  return res.changes === 1;
}

export function withdrawQuote(quoteId: string, customerId: string): boolean {
  const q = getQuote(quoteId, customerId);
  if (!q) return false;
  const res = getDb().prepare(`UPDATE quotes SET status = 'withdrawn' WHERE id = ? AND status = 'open'`).run(quoteId);
  if (res.changes) appendAudit(q.runId ?? quoteId, customerId, "quote_withdrawn", { quoteId });
  return res.changes === 1;
}

/**
 * Issue a firm-price quote from live offers for the shortlisted SKUs only (never a bulk catalog query).
 * With `productIds` those SKUs are priced; with `offers` (already ranked by the caller) those are frozen as-is;
 * with neither, the best fulfilable offer for the need is quoted.
 */
export async function createQuote(
  customerId: string,
  need: Need,
  source?: { productIds?: string[]; offers?: Offer[]; runId?: string; includeSubstitutions?: boolean },
): Promise<Quote> {
  const runId = source?.runId ?? randomUUID();
  let offers: Offer[];
  if (source?.offers?.length) offers = source.offers;
  else {
    offers = await withAgent("sourcing", () =>
      buildOffers(customerId, need, {
        productIds: source?.productIds?.length ? source.productIds : undefined,
        includeSubstitutions: source?.includeSubstitutions ?? true,
      }),
    );
    if (!source?.productIds?.length) {
      const best = offers.find((o) => o.canFulfil) ?? offers[0];
      offers = best ? [best] : [];
    }
  }
  if (offers.length === 0) throw new Error("No offers available for this need — nothing to quote");

  const quoteId = `QUO-${randomUUID().slice(0, 8).toUpperCase()}`;
  const issuedAt = new Date();
  const validUntil = new Date(issuedAt.getTime() + config.quoteTtlMinutes * 60_000).toISOString();
  const lines = offers.map(offerToBasketLine);
  const currency = offers[0].priceClaim?.claim.currency ?? "EUR";
  const claims: SignedClaim[] = offers.map((o) =>
    signClaim(
      {
        customerId,
        productId: o.productId,
        unitPrice: o.unitPrice,
        currency,
        availableQuantity: o.availableQuantity,
        availabilityUnknown: o.availabilityUnknown,
        salesUnit: o.packUnit,
        availableDate: o.availableDate,
        comparisonPrice: o.comparisonPrice,
        comparisonUnit: o.comparisonUnit,
        validUntil,
        claimType: "combined",
      },
      { subject: { quoteId } },
    ),
  );
  lines.forEach((l, i) => (l.claimIds = [claims[i].claimId ?? claims[i].signature]));
  const totalPrice = round2(lines[0].totalPrice);

  getDb()
    .prepare(
      `INSERT INTO quotes (id, customer_id, run_id, status, need_json, lines_json, claims_json, total_price, currency, issued_at, valid_until, intent_id)
       VALUES (?, ?, ?, 'open', ?, ?, ?, ?, ?, ?, ?, NULL)`,
    )
    .run(quoteId, customerId, runId, JSON.stringify(need), JSON.stringify(lines), JSON.stringify(claims), totalPrice, currency, issuedAt.toISOString(), validUntil);

  appendAudit(runId, customerId, "quote_issued", {
    quoteId,
    totalPrice,
    currency,
    validUntil,
    lines: lines.map((l) => ({ productId: l.productId, packs: l.packs, unitPrice: l.unitPrice, totalPrice: l.totalPrice })),
    availabilityHeld: false,
  });
  return getQuote(quoteId, customerId)!;
}

export type MultiQuoteItemInput = {
  need: Need;
  productId?: string;
  offer?: Offer;
};

/**
 * Issue a consolidated firm-price quote across multiple requested items.
 * Each line represents the chosen (or top fulfilable) SKU for its corresponding Need,
 * with combined totalPrice equal to the sum of all lines.
 */
export async function createMultiItemQuote(
  customerId: string,
  items: MultiQuoteItemInput[],
  source?: { runId?: string; includeSubstitutions?: boolean },
): Promise<Quote> {
  if (items.length === 0) {
    throw new Error("No items provided for multi-item quote");
  }
  if (items.length === 1) {
    const single = items[0]!;
    return createQuote(customerId, single.need, {
      productIds: single.productId ? [single.productId] : undefined,
      offers: single.offer ? [single.offer] : undefined,
      runId: source?.runId,
      includeSubstitutions: source?.includeSubstitutions,
    });
  }

  const runId = source?.runId ?? randomUUID();
  const chosenOffers: Offer[] = [];
  const itemNeeds: Need[] = [];

  // Use batch ranking for items without pre-selected offers/productIds, or targeted buildOffers when productId is given
  const needsOnly = items.map((it) => it.need);
  const batch = await withAgent("sourcing", () =>
    buildOffersBatch(customerId, needsOnly, {
      includeSubstitutions: source?.includeSubstitutions ?? true,
    }),
  );

  for (let i = 0; i < items.length; i++) {
    const req = items[i]!;
    let chosen: Offer | undefined = req.offer;
    if (!chosen && req.productId) {
      chosen = batch.items[i]?.offers.find((o) => o.productId === req.productId);
      if (!chosen) {
        const direct = await withAgent("sourcing", () =>
          buildOffers(customerId, req.need, {
            productIds: [req.productId!],
            includeSubstitutions: source?.includeSubstitutions ?? true,
          }),
        );
        chosen = direct[0];
      }
    }
    if (!chosen) {
      const pool = batch.items[i]?.offers ?? [];
      chosen = pool.find((o) => o.canFulfil) ?? pool[0];
    }
    if (!chosen) {
      throw new Error(
        `No offers available for "${req.need.productIntent}" (${req.need.quantity} ${req.need.unit}) — nothing to quote`,
      );
    }
    chosenOffers.push(chosen);
    itemNeeds.push(req.need);
  }

  const quoteId = `QUO-${randomUUID().slice(0, 8).toUpperCase()}`;
  const issuedAt = new Date();
  const validUntil = new Date(issuedAt.getTime() + config.quoteTtlMinutes * 60_000).toISOString();
  const lines = chosenOffers.map(offerToBasketLine);
  const currency = chosenOffers[0]?.priceClaim?.claim.currency ?? "EUR";
  const claims: SignedClaim[] = chosenOffers.map((o) =>
    signClaim(
      {
        customerId,
        productId: o.productId,
        unitPrice: o.unitPrice,
        currency,
        availableQuantity: o.availableQuantity,
        availabilityUnknown: o.availabilityUnknown,
        salesUnit: o.packUnit,
        availableDate: o.availableDate,
        comparisonPrice: o.comparisonPrice,
        comparisonUnit: o.comparisonUnit,
        validUntil,
        claimType: "combined",
      },
      { subject: { quoteId } },
    ),
  );
  lines.forEach((l, i) => (l.claimIds = [claims[i]!.claimId ?? claims[i]!.signature]));
  const totalPrice = round2(lines.reduce((s, l) => s + l.totalPrice, 0));

  const earliestNeededBy = itemNeeds
    .map((n) => n.neededBy)
    .sort()[0]!;
  const summaryNeed: Need = {
    ...itemNeeds[0]!,
    neededBy: earliestNeededBy,
  };
  const metaJson = JSON.stringify({
    itemNeeds,
    isMultiItemBasket: true,
  });

  getDb()
    .prepare(
      `INSERT INTO quotes (id, customer_id, run_id, status, need_json, lines_json, claims_json, total_price, currency, issued_at, valid_until, intent_id, meta_json)
       VALUES (?, ?, ?, 'open', ?, ?, ?, ?, ?, ?, ?, NULL, ?)`,
    )
    .run(
      quoteId,
      customerId,
      runId,
      JSON.stringify(summaryNeed),
      JSON.stringify(lines),
      JSON.stringify(claims),
      totalPrice,
      currency,
      issuedAt.toISOString(),
      validUntil,
      metaJson,
    );

  appendAudit(runId, customerId, "quote_issued", {
    quoteId,
    isMultiItemBasket: true,
    itemCount: lines.length,
    totalPrice,
    currency,
    validUntil,
    lines: lines.map((l) => ({
      productId: l.productId,
      packs: l.packs,
      unitPrice: l.unitPrice,
      totalPrice: l.totalPrice,
    })),
    availabilityHeld: false,
  });
  return getQuote(quoteId, customerId)!;
}
