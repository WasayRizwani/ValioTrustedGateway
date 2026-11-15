import "./setup-db.js";
import test, { beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { Need, Offer } from "@tta/shared";

const { getDb } = await import("../src/audit/chain.js");
const { createOrderIntent, commitOrder, getIntent, approveOrder } = await import("../src/orders/store.js");
const { createQuote, getQuote, expireQuotes } = await import("../src/orders/quotes.js");
const { verifyClaim } = await import("../src/claims/sign.js");
const { getMandate, resetMandate } = await import("../src/auth/customers.js");

const C = "HOTEL-001";
const realFetch = globalThis.fetch;
let live = { unitPrice: 1, salesBlock: false, available: 1000 };

globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
  const body = JSON.parse(String(init?.body));
  const ids: string[] = body.products;
  const json = String(url).endsWith("/api/price")
    ? { currency: "EUR", products: ids.map((id) => ({ productId: id, catalogPrice: { value: live.unitPrice } })) }
    : { products: ids.map((id) => ({ productId: id, salesBlock: live.salesBlock, scheduleLines: [{ availableAmount: live.available, availableDate: "2030-01-01", salesUnit: "pack" }] })) };
  return new Response(JSON.stringify(json), { status: 200, headers: { "content-type": "application/json" } });
}) as typeof fetch;
after(() => { globalThis.fetch = realFetch; });

const need: Need = { productIntent: "lactose-free milk", quantity: 10, unit: "litre", neededBy: "2030-01-02", constraints: { lactoseFree: true } };
const offer = {
  productId: "P1", productName: "Lactose-free milk 1L", brand: null, category: null, packSize: 1, packUnit: "litre", requiredPacks: 10,
  totalQuantity: 10, quantityUnit: "litre", unitPrice: 1, totalPrice: 10, comparisonPrice: null, comparisonUnit: null, availableQuantity: 1000,
  availableDate: "2030-01-01", canFulfil: true, shortfall: null, deliveryReliability: 0.9, carbonKgPerKg: null, score: 1, scoreReasons: [],
  labels: [], isSubstitution: false, allergens: [], mayContain: [], certifications: [], origin: null, producer: null, claims: [],
} as unknown as Offer;

const auditTypes = async (runId: string) =>
  (await getDb().query<{ type: string }>(`SELECT type FROM audit_events WHERE run_id = $1`, [runId])).map((r) => r.type);
const quote = (customer = C) => createQuote(customer, need, { offers: [offer] });
const intentFrom = async (quoteId: string, customer = C) => {
  const r = await createOrderIntent({ customerId: customer, mandate: (await getMandate(customer))!, need, quoteId });
  return r.intent;
};
/** Make the intent committable regardless of how the mandate rated it. */
async function readyIntent(id: string) {
  const i = (await getIntent(id, C))!;
  if (i.status === "pending_approval") {
    await approveOrder(id, C, i.snapshotHash, { authorizeMandateOverride: true, acknowledgedRules: i.policy.failingRules });
  }
}
const commit = (intentId: string) => commitOrder({ intentId, customerId: C, idempotencyKey: randomUUID() });

beforeEach(async () => {
  live = { unitPrice: 1, salesBlock: false, available: 1000 };
  await resetMandate(C);
});

test("issue: firm quote with signed claims, 30 min window, availability not held, audited", async () => {
  const q = await quote();
  assert.match(q.quoteId, /^QUO-/);
  assert.equal(q.status, "open");
  assert.equal(q.availabilityHeld, false);
  assert.equal(q.totalPrice, 10);
  const window = new Date(q.validUntil).getTime() - new Date(q.issuedAt).getTime();
  assert.equal(window, 30 * 60_000);
  assert.equal(q.claims.length, 1);
  assert.deepEqual(verifyClaim(q.claims[0], { subject: { quoteId: q.quoteId } }), { valid: true });
  assert.ok((await auditTypes(q.runId!)).includes("quote_issued"));
  assert.deepEqual(await getQuote(q.quoteId, C), q);
});

test("accept: intent takes lines and price from the quote, links it, audits quote_accepted, consumes it", async () => {
  const q = await quote();
  live.unitPrice = 1.5; // live price moved: the intent must still carry the quoted price
  const intent = await intentFrom(q.quoteId);
  assert.equal(intent.totalPrice, 10);
  assert.equal(intent.basket[0].unitPrice, 1);
  assert.equal(intent.meta?.quoteId, q.quoteId);
  assert.equal((await getQuote(q.quoteId, C))!.status, "used");
  assert.equal((await getQuote(q.quoteId, C))!.intentId, intent.id);
  assert.ok((await auditTypes(intent.runId)).includes("quote_accepted"));
});

test("expired quote is refused", async () => {
  const q = await quote();
  await getDb().execute(`UPDATE quotes SET valid_until = $1 WHERE id = $2`, [new Date(Date.now() - 1000).toISOString(), q.quoteId]);
  await assert.rejects(intentFrom(q.quoteId), /quote_expired/);
  assert.equal((await getQuote(q.quoteId, C))!.status, "expired");
  assert.equal(await expireQuotes(C), 0);
});

test("a quote cannot be used twice", async () => {
  const q = await quote();
  await intentFrom(q.quoteId);
  await assert.rejects(intentFrom(q.quoteId), /quote_already_used/);
});

test("another customer cannot read or use the quote", async () => {
  const q = await quote();
  assert.equal(await getQuote(q.quoteId, "SCHOOL-001"), null);
  await assert.rejects(intentFrom(q.quoteId, "SCHOOL-001"), /quote_not_found/);
  assert.equal((await getQuote(q.quoteId, C))!.status, "open");
});

test("price honoured at commit when the live price rises inside the firm window", async () => {
  const q = await quote();
  const intent = await intentFrom(q.quoteId);
  await readyIntent(intent.id);
  live.unitPrice = 1.5; // +50%, far beyond drift tolerance
  const done = await commit(intent.id);
  assert.equal(done.status, "committed");
  assert.equal(done.totalPrice, 10);
  assert.equal(done.basket[0].unitPrice, 1);
  const types = await auditTypes(done.runId);
  assert.ok(types.includes("quote_price_honoured"));
  assert.ok(!types.includes("stale_offer"));
});

test("availability drop still invalidates a quoted order", async () => {
  const q = await quote();
  const intent = await intentFrom(q.quoteId);
  await readyIntent(intent.id);
  live.available = 3;
  await assert.rejects(commit(intent.id), /availability dropped/);
  assert.equal((await getIntent(intent.id, C))!.status, "stale_invalidated");
});

test("after the firm window the quoted price is no longer guaranteed", async () => {
  const q = await quote();
  const intent = await intentFrom(q.quoteId);
  await readyIntent(intent.id);
  await getDb().execute(`UPDATE quotes SET valid_until = $1 WHERE id = $2`, [new Date(Date.now() - 1000).toISOString(), q.quoteId]);
  live.unitPrice = 1.5;
  await assert.rejects(commit(intent.id), /price_drift_exceeded|reapproval_required/);
});
