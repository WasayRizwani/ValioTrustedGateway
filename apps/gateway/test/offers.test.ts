import "./setup-db.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import type { Need, Offer } from "@tta/shared";
import {
  cutoffInfo,
  isOnTime,
  computeCriteria,
  markPareto,
  normalizePreferences,
} from "../src/catalog/offers.js";
import { parseClosingTime } from "../src/valio/client.js";

const NOW = Date.parse("2026-11-14T10:00:00Z");
const need = { productIntent: "x", quantity: 10, unit: "kg", neededBy: "2026-11-16", constraints: {} } as unknown as Need;

function offer(id: string, o: Partial<Offer>): Offer {
  return {
    productId: id, productName: id, brand: null, category: "c", packSize: 1, packUnit: "kg",
    requiredPacks: 10, totalQuantity: 10, quantityUnit: "KG", unitPrice: 1, totalPrice: 10,
    comparisonPrice: null, comparisonUnit: null, availableQuantity: 100, availableDate: "2026-11-16",
    canFulfil: true, shortfall: null, deliveryReliability: 0.9, carbonKgPerKg: 2, score: 0,
    scoreReasons: [], labels: [], isSubstitution: false, allergens: [], mayContain: [], certifications: [],
    origin: null, producer: null, claims: [], ...o,
  } as Offer;
}

test("cut-off: parses Valio offsets, flags passed and imminent", () => {
  assert.equal(parseClosingTime("2026-11-12T15:00:00+0200"), "2026-11-12T13:00:00.000Z");
  assert.equal(parseClosingTime("garbage"), null);
  assert.deepEqual(cutoffInfo(null, NOW), { orderByAt: null, passed: false, risk: false });
  const passed = cutoffInfo("2026-11-14T09:00:00Z", NOW);
  assert.ok(passed.passed && passed.risk);
  const soon = cutoffInfo("2026-11-14T11:30:00Z", NOW);
  assert.ok(!soon.passed && soon.risk);
  const later = cutoffInfo("2026-11-14T20:00:00Z", NOW);
  assert.ok(!later.passed && !later.risk);
});

test("cut-off passed means not on time, even with a good delivery date", () => {
  assert.equal(isOnTime(offer("a", { orderByAt: "2026-11-14T09:00:00Z" }), need.neededBy, NOW), false);
  assert.equal(isOnTime(offer("b", { orderByAt: "2026-11-14T20:00:00Z" }), need.neededBy, NOW), true);
  assert.equal(isOnTime(offer("c", { availableDate: "2026-11-17" }), need.neededBy, NOW), false);
});

test("pareto flags: dominated offers are false, trade-offs stay true, unfulfilable/late excluded", () => {
  const cheapDirty = offer("cheapDirty", { totalPrice: 5, carbonKgPerKg: 6, deliveryReliability: 0.8 });
  const pricyGreen = offer("pricyGreen", { totalPrice: 9, carbonKgPerKg: 1, deliveryReliability: 0.8 });
  const dominated = offer("dominated", { totalPrice: 10, carbonKgPerKg: 7, deliveryReliability: 0.7 });
  const partial = offer("partial", { totalPrice: 1, canFulfil: false });
  const cutOff = offer("cutOff", { totalPrice: 1, carbonKgPerKg: 0.1, deliveryReliability: 1, orderByAt: "2026-11-14T09:00:00Z" });
  const all = [cheapDirty, pricyGreen, dominated, partial, cutOff];
  markPareto(all, need, NOW);
  assert.equal(cheapDirty.paretoOptimal, true);
  assert.equal(pricyGreen.paretoOptimal, true);
  assert.equal(dominated.paretoOptimal, false);
  assert.equal(partial.paretoOptimal, false);
  assert.equal(cutOff.paretoOptimal, false);
});

test("criteriaScores are 0..1 with best = 1", () => {
  const a = offer("a", { totalPrice: 5, carbonKgPerKg: 1 });
  const b = offer("b", { totalPrice: 10, carbonKgPerKg: 5 });
  computeCriteria([a, b], need, NOW);
  assert.equal(a.criteriaScores!.price, 1);
  assert.equal(b.criteriaScores!.price, 0.5);
  assert.equal(a.criteriaScores!.carbon, 1);
  assert.equal(b.criteriaScores!.carbon, 0);
  assert.equal(a.criteria!.price, 5);
});

test("preferences: validated and normalised; absent/zero means default", () => {
  assert.equal(normalizePreferences(undefined), null);
  assert.equal(normalizePreferences({}), null);
  assert.equal(normalizePreferences({ carbon: 0 }), null);
  const p = normalizePreferences({ price: 1, carbon: 3 })!;
  assert.equal(p.carbon, 0.75);
  assert.equal(p.price, 0.25);
  assert.throws(() => normalizePreferences({ price: -1 }));
});

test("buildOffers: carbon-heavy preferences change ranking, defaults do not (stubbed Valio)", async () => {
  const { searchProducts, getCarbon } = await import("../src/catalog/index.js");
  const { buildOffers } = await import("../src/catalog/offers.js");
  const prods = searchProducts({ q: "milk", limit: 40 }).filter((p) => getCarbon(p.productId) != null).slice(0, 6);
  if (prods.length < 2) return; // catalog without carbon data: nothing to compare
  const ids = prods.map((p) => p.productId);
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string, init: { body: string }) => {
    const body = JSON.parse(init.body);
    const isPrice = String(url).endsWith("/api/price");
    // Price inversely related to greenness so price-first and carbon-first disagree.
    const products = (body.products as string[]).map((id) => {
      const c = getCarbon(id) ?? 3;
      return isPrice
        ? { productId: id, catalogPrice: { value: 5 + (10 - Math.min(c, 10)) * 3 } }
        : { productId: id, salesBlock: false, scheduleLines: [{ availableAmount: 999999, availableDate: "2026-11-10", salesUnit: "KI" }] };
    });
    return new Response(JSON.stringify({ currency: "EUR", products }), { status: 200 });
  }) as unknown as typeof fetch;
  try {
    const n: Need = { ...need, unit: "litre", neededBy: "2026-11-16" };
    const base1 = await buildOffers("HOTEL-001", n, { productIds: ids, now: new Date(NOW) });
    const base2 = await buildOffers("HOTEL-001", n, { productIds: ids, now: new Date(NOW), preferences: {} });
    assert.deepEqual(base1.map((o) => o.productId), base2.map((o) => o.productId));
    const huge = await buildOffers("HOTEL-001", { ...n, quantity: 1_000_000_000 }, { productIds: ids, now: new Date(NOW) });
    assert.ok(huge.length > 0);
    assert.ok(huge.every((o) => o.availabilityUnknown && o.canFulfil), "999999 is unknown, not a stock cap");
    const green = await buildOffers("HOTEL-001", n, { productIds: ids, now: new Date(NOW), preferences: { carbon: 1 } });
    const cheap = await buildOffers("HOTEL-001", n, { productIds: ids, now: new Date(NOW), preferences: { price: 1 } });
    const fulfil = (l: typeof green) => l.filter((o) => o.canFulfil);
    const lowestCarbon = Math.min(...fulfil(green).map((o) => o.carbonKgPerKg ?? Infinity));
    assert.equal(fulfil(green)[0].carbonKgPerKg, lowestCarbon);
    const lowestPrice = Math.min(...fulfil(cheap).map((o) => o.totalPrice));
    assert.equal(fulfil(cheap)[0].totalPrice, lowestPrice);
    assert.ok(green[0].criteriaScores && typeof green[0].paretoOptimal === "boolean");
  } finally {
    globalThis.fetch = realFetch;
  }
});
