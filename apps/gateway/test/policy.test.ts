import "./setup-db.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import type { BasketLine, Mandate, Need } from "@tta/shared";
import { evaluatePolicy, isDairyText } from "../src/policy/engine.js";

const mandate: Mandate = {
  mandateId: "M1",
  customerId: "C1",
  allowedCategories: ["dairy"],
  maxOrderValueEur: 500,
  maxQuantity: { unit: "litre", value: 1000 },
  maxQuantities: { litre: 1000, kg: 100, each: 500, pack: 50 },
  allowedBrands: ["*"],
  allowedSubstitutions: false,
  allergenRestrictions: ["must_be_lactose_free"],
  autoPurchaseIf: { deliveryOnOrBeforeNeededBy: true, withinMaxOrderValue: true, reliabilityUnknownOk: true },
  requireApprovalFor: ["over_spend", "late_delivery", "substitution", "partial_fulfil", "over_quantity"],
  expiresAt: "2999-01-01T00:00:00Z",
};

const line = (over: Partial<BasketLine> = {}): BasketLine => ({
  productId: "p1",
  productName: "Valio Eila milk 10 l lactose free",
  packs: 1,
  packSize: 10,
  packUnit: "L",
  totalQuantity: 10,
  quantityUnit: "L",
  unitPrice: 30,
  totalPrice: 30,
  comparisonPrice: null,
  comparisonUnit: null,
  availableQuantity: 100,
  availableDate: "2026-11-16",
  deliveryReliability: null,
  claimIds: [],
  isSubstitution: false,
  labels: ["lactose-free"],
  allergens: [],
  mayContain: [],
  certifications: [],
  origin: "FI",
  producer: "Valio Oy",
  ...over,
});
const need = (over: Partial<Need> = {}): Need => ({
  productIntent: "milk",
  quantity: 10,
  unit: "litre",
  neededBy: "2026-11-16",
  constraints: {},
  ...over,
});

test("a small in-mandate order is auto-committed", () => {
  assert.equal(evaluatePolicy(mandate, need(), [line()]).decision, "auto_commit");
});

test("lactose rule applies to dairy only — bananas are not flagged", () => {
  const v = evaluatePolicy(mandate, need({ productIntent: "banana", unit: "kg" }), [
    line({ productName: "BANANA 4.5KG", labels: [] }),
  ]);
  assert.equal(v.decision, "auto_commit");
});

test("non-lactose-free dairy needs a human", () => {
  const v = evaluatePolicy(mandate, need(), [line({ productName: "Regular milk 1 l", labels: [] })]);
  assert.equal(v.decision, "pending_approval");
  assert.ok(v.failingRules.includes("allergen_restrictions"));
});

test("spend over the mandate escalates", () => {
  const v = evaluatePolicy(mandate, need(), [line({ totalPrice: 3131 })]);
  assert.ok(v.failingRules.includes("over_spend"));
  assert.equal(v.decision, "pending_approval");
});

test("quantity caps are per unit, not litres-only", () => {
  const v = evaluatePolicy(mandate, need({ productIntent: "flour", unit: "kg", quantity: 500 }), [
    line({ productName: "Flour 25 kg", labels: [] }),
  ]);
  assert.ok(v.failingRules.includes("over_quantity"));
});

test("substitutions are never silent", () => {
  const v = evaluatePolicy(mandate, need(), [line({ isSubstitution: true })]);
  assert.ok(v.failingRules.includes("substitution"));
});

test("late delivery escalates", () => {
  const v = evaluatePolicy(mandate, need(), [line({ availableDate: "2026-11-20" })]);
  assert.ok(v.failingRules.includes("late_delivery"));
});

test("an excluded allergen declared as CONTAINS escalates", () => {
  const v = evaluatePolicy(mandate, need({ constraints: { excludeAllergens: ["nuts"] } }), [line({ allergens: ["hazelnut"] })]);
  assert.ok(v.failingRules.includes("allergen_restrictions"));
});

test("'may contain' counts too — cross-contamination matters for schools and hospitals", () => {
  const v = evaluatePolicy(mandate, need({ constraints: { excludeAllergens: ["gluten"] } }), [line({ mayContain: ["oats"] })]);
  assert.ok(v.failingRules.includes("allergen_restrictions"));
  assert.ok(v.reasons.join(" ").includes("may contain"));
});

test("a product without the excluded allergen passes", () => {
  const v = evaluatePolicy(mandate, need({ constraints: { excludeAllergens: ["nuts"] } }), [line({ allergens: ["milk"] })]);
  assert.equal(v.decision, "auto_commit");
});

test("'low lactose' is NOT lactose-free", () => {
  const v = evaluatePolicy(mandate, need(), [line({ productName: "Valio Eila low lactose milk 1 l", labels: ["low-lactose"] })]);
  assert.ok(v.failingRules.includes("allergen_restrictions"));
});

test("expired mandate blocks", () => {
  assert.equal(evaluatePolicy({ ...mandate, expiresAt: "2000-01-01T00:00:00Z" }, need(), [line()]).decision, "blocked");
});

// ---- category / brand / unit price ----
import { getProduct } from "../src/catalog/index.js";
import type { SpendSummary } from "../src/policy/spend.js";

test("category: unknown-to-catalog lines are not judged; known product outside categories escalates", () => {
  const m = { ...mandate, allowedCategories: ["zzz-nothing"] };
  assert.equal(evaluatePolicy(m, need(), [line()]).decision, "auto_commit"); // p1 not in catalog
  const real = getProduct("460000"); // potato salad
  assert.ok(real);
  const v = evaluatePolicy(m, need(), [line({ productId: "460000", productName: real!.name, labels: ["lactose-free"] })]);
  assert.ok(v.failingRules.includes("category_not_allowed"));
  assert.equal(v.decision, "pending_approval");
});

test("category: '*' allows all", () => {
  const real = getProduct("460000")!;
  const v = evaluatePolicy({ ...mandate, allowedCategories: ["*"] }, need({ productIntent: "salad" }), [
    line({ productId: "460000", productName: real.name, labels: ["lactose-free"] }),
  ]);
  assert.ok(!v.failingRules.includes("category_not_allowed"));
});

test("brand: restricted list rejects other brand, accepts matching and '*'", () => {
  const real = getProduct("460000")!;
  const l = line({ productId: "460000", productName: "Salad", labels: [] });
  const base = { ...mandate, allowedCategories: ["*"] };
  const n = need({ productIntent: "salad" });
  assert.ok(evaluatePolicy({ ...base, allowedBrands: ["Valio"] }, n, [l]).failingRules.includes("brand_not_allowed"));
  assert.ok(!evaluatePolicy({ ...base, allowedBrands: [real.brand!.toUpperCase()] }, n, [l]).failingRules.includes("brand_not_allowed"));
  assert.ok(!evaluatePolicy(base, n, [l]).failingRules.includes("brand_not_allowed"));
});

test("maxPricePerUnit: over escalates, under passes", () => {
  const l = line({ totalPrice: 30, totalQuantity: 10, comparisonPrice: null });
  const over = evaluatePolicy(mandate, need({ constraints: { maxPricePerUnit: 2 } }), [l]);
  assert.ok(over.failingRules.includes("over_unit_price"));
  const ok = evaluatePolicy(mandate, need({ constraints: { maxPricePerUnit: 3 } }), [l]);
  assert.ok(!ok.failingRules.includes("over_unit_price"));
  const cmp = evaluatePolicy(mandate, need({ constraints: { maxPricePerUnit: 3 } }), [line({ comparisonPrice: 4 })]);
  assert.ok(cmp.failingRules.includes("over_unit_price"));
});

// ---- cumulative spend ----
const spend = (o: Partial<SpendSummary> = {}): SpendSummary => ({ day: 0, week: 0, month: 0, ordersToday: 0, recent24h: [], ...o });
const capped = { ...mandate, maxDailySpendEur: 100, maxWeeklySpendEur: 300, maxMonthlySpendEur: 1000, maxOrdersPerDay: 3 };

test("daily/weekly/monthly caps count the current order", () => {
  assert.equal(evaluatePolicy(capped, need(), [line()], { spend: spend({ day: 70 }) }).decision, "auto_commit"); // 70+30 = 100, not over
  assert.ok(evaluatePolicy(capped, need(), [line()], { spend: spend({ day: 71 }) }).failingRules.includes("over_daily_spend"));
  assert.ok(evaluatePolicy(capped, need(), [line()], { spend: spend({ week: 271 }) }).failingRules.includes("over_weekly_spend"));
  assert.ok(evaluatePolicy(capped, need(), [line()], { spend: spend({ month: 971 }) }).failingRules.includes("over_monthly_spend"));
  assert.equal(evaluatePolicy(capped, need(), [line()], { spend: spend({ week: 270, month: 970 }) }).decision, "auto_commit");
});

test("no spend options or no caps: nothing enforced", () => {
  assert.equal(evaluatePolicy(capped, need(), [line()]).decision, "auto_commit");
  assert.equal(evaluatePolicy(mandate, need(), [line()], { spend: spend({ day: 1e6, ordersToday: 99 }) }).decision, "auto_commit");
});

test("order velocity: the Nth+1 order today escalates", () => {
  assert.equal(evaluatePolicy(capped, need(), [line()], { spend: spend({ ordersToday: 2 }) }).decision, "auto_commit");
  assert.ok(evaluatePolicy(capped, need(), [line()], { spend: spend({ ordersToday: 3 }) }).failingRules.includes("over_order_velocity"));
});

test("order splitting: 3 orders in 24h each >80% of the cap is flagged", () => {
  const big = line({ totalPrice: 450, unitPrice: 450 });
  const v = evaluatePolicy(mandate, need(), [big], { spend: spend({ recent24h: [420, 450] }) });
  assert.ok(v.failingRules.includes("order_splitting_suspected"));
  assert.equal(v.decision, "pending_approval");
  // only two big orders in total, or current order is small -> not flagged
  assert.ok(!evaluatePolicy(mandate, need(), [big], { spend: spend({ recent24h: [450] }) }).failingRules.includes("order_splitting_suspected"));
  assert.ok(!evaluatePolicy(mandate, need(), [line()], { spend: spend({ recent24h: [420, 450] }) }).failingRules.includes("order_splitting_suspected"));
  assert.ok(!evaluatePolicy(mandate, need(), [big], { spend: spend({ recent24h: [420, 100] }) }).failingRules.includes("order_splitting_suspected"));
});

test("isDairyText matches Finnish 'voi'/'voita' as whole words without matching English 'voi' substrings", () => {
  assert.equal(isDairyText("Valio voi 500 g"), true);
  assert.equal(isDairyText("Luomu voita 250g"), true);
  for (const word of ["avoid", "voice", "invoice", "savoiardi"]) {
    assert.equal(isDairyText(word), false, `expected '${word}' not to match isDairyText`);
  }
});

test("autoPurchaseIf flags: disabling withinMaxOrderValue or deliveryOnOrBeforeNeededBy routes to pending_approval with failingRules", () => {
  const noAutoSpend = evaluatePolicy(
    { ...mandate, autoPurchaseIf: { ...mandate.autoPurchaseIf, withinMaxOrderValue: false } },
    need(),
    [line()],
  );
  assert.equal(noAutoSpend.decision, "pending_approval");
  assert.ok(noAutoSpend.failingRules.length > 0);

  const noAutoDelivery = evaluatePolicy(
    { ...mandate, autoPurchaseIf: { ...mandate.autoPurchaseIf, deliveryOnOrBeforeNeededBy: false } },
    need(),
    [line()],
  );
  assert.equal(noAutoDelivery.decision, "pending_approval");
  assert.ok(noAutoDelivery.failingRules.length > 0);
});
