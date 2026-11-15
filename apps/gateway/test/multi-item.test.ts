import "./setup-db.js";
import test, { after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

const { parseComplexNeedFromText, parseNeedFromText } = await import("../src/need/parse.js");
const { needFromArgs } = await import("../src/agent/tools.js");
const { runHeuristicAgent } = await import("../src/agent/chat.js");
const { resolveUnifiedKitchenPrompt } = await import("../src/agent/unifiedAssistant.js");
const { createMultiItemQuote } = await import("../src/orders/quotes.js");
const { createOrderIntent, commitOrder } = await import("../src/orders/store.js");
const { getMandate, resetMandate } = await import("../src/auth/customers.js");
const { getOrderHistory, resetKitchen } = await import("../src/hotel/kitchen.js");
const { resetIntents } = await import("../src/orders/store.js");

const CUSTOMER = "HOTEL-001";
const realFetch = globalThis.fetch;

globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
  const u = String(url);
  const body = init?.body ? JSON.parse(String(init.body)) : { products: [] };
  const ids: string[] = Array.isArray(body.products) ? body.products : [];
  if (u.endsWith("/api/price")) {
    return new Response(
      JSON.stringify({
        currency: "EUR",
        products: ids.map((id) => ({
          productId: id,
          catalogPrice: { value: 1.5 },
        })),
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }
  return new Response(
    JSON.stringify({
      products: ids.map((id) => ({
        productId: id,
        salesBlock: false,
        scheduleLines: [
          {
            availableAmount: 500,
            availableDate: "2026-11-15",
            salesUnit: "pack",
          },
        ],
      })),
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}) as typeof fetch;

after(() => {
  globalThis.fetch = realFetch;
});

beforeEach(async () => {
  await resetMandate(CUSTOMER);
  await resetIntents(CUSTOMER, "multi-item-test");
  await resetKitchen(CUSTOMER);
});

test("parseComplexNeedFromText parses multi-item prompt with implicit countable item and shared date", () => {
  const prompt = "100 litres of lactose-free milk  and 10 bananas by Monday";
  const parsed = parseComplexNeedFromText(prompt);
  assert.ok(!("clarificationRequired" in parsed), "should parse without clarification");
  assert.equal(parsed.isMultiItem, true);
  assert.equal(parsed.needs.length, 2);

  const [milk, bananas] = parsed.needs;
  assert.equal(milk.quantity, 100);
  assert.equal(milk.unit, "litre");
  assert.equal(milk.constraints.lactoseFree, true);
  assert.match(milk.productIntent, /milk/i);

  assert.equal(bananas.quantity, 10);
  assert.equal(bananas.unit, "each");
  assert.equal(bananas.constraints.lactoseFree, undefined);
  assert.match(bananas.productIntent, /banana/i);
  assert.equal(bananas.neededBy, milk.neededBy);
});

test("parseComplexNeedFromText splits newline lists and flags incomplete secondary items", () => {
  const newlineParsed = parseComplexNeedFromText("20 L whipping cream\n5 kg butter\n30 eggs");
  assert.ok(!("clarificationRequired" in newlineParsed));
  assert.equal(newlineParsed.needs.length, 3);
  assert.equal(newlineParsed.needs[2].quantity, 30);
  assert.equal(newlineParsed.needs[2].unit, "each");

  const incomplete = parseComplexNeedFromText("100 litres of lactose-free milk and butter");
  assert.ok("clarificationRequired" in incomplete, "missing quantity on second item must trigger clarification");
  if ("clarificationRequired" in incomplete) {
    assert.match(incomplete.clarificationRequired, /butter/i);
  }
});

test("needFromArgs binds each item in a multi-item prompt to its own trusted quantity, unit, and constraints", () => {
  const prompt = "100 litres of lactose-free milk and 10 bananas by 2026-11-16";
  const trustedNeed = parseNeedFromText(prompt);
  const trustedComplexNeed = parseComplexNeedFromText(prompt);

  const ctx = {
    trustedUserText: prompt,
    trustedNeed,
    trustedComplexNeed,
  };

  // Even if LLM attempts to mutate banana quantity to 999 kg, needFromArgs pins it to 10 each (NOT 100 litre!)
  const boundBanana = needFromArgs(
    {
      productIntent: "banana",
      quantity: 999,
      unit: "kg",
      neededBy: "2026-12-31",
      constraints: {},
    },
    ctx,
  );
  assert.ok("quantity" in boundBanana);
  assert.equal(boundBanana.quantity, 10);
  assert.equal(boundBanana.unit, "each");
  assert.equal(boundBanana.neededBy, "2026-11-16");
  assert.equal(boundBanana.constraints.lactoseFree, undefined);

  const boundMilk = needFromArgs(
    {
      productIntent: "milk",
      quantity: 5,
      unit: "litre",
      neededBy: "2026-12-31",
      constraints: {},
    },
    ctx,
  );
  assert.ok("quantity" in boundMilk);
  assert.equal(boundMilk.quantity, 100);
  assert.equal(boundMilk.unit, "litre");
  assert.equal(boundMilk.constraints.lactoseFree, true);
});

test("multi-item quote -> intent -> commit preserves all lines and passes non-dairy lactose policy", async () => {
  const parsed = parseComplexNeedFromText("50 litres of lactose-free milk and 10 bananas by 2026-11-16");
  assert.ok(!("clarificationRequired" in parsed));

  const quote = await createMultiItemQuote(
    CUSTOMER,
    parsed.needs.map((need) => ({ need })),
  );
  assert.equal(quote.isMultiItemBasket, true);
  assert.equal(quote.lines.length, 2);

  const mandate = {
    ...(await getMandate(CUSTOMER))!,
    autoPurchaseIf: {
      withinMaxOrderValue: true,
      deliveryOnOrBeforeNeededBy: true,
      reliabilityUnknownOk: true,
    },
  };
  const { intent } = await createOrderIntent({
    customerId: CUSTOMER,
    mandate,
    quoteId: quote.quoteId,
  });

  assert.equal(intent.basket.length, 2);
  assert.ok(
    !intent.policy.failingRules.includes("allergen_or_lactose_violation"),
    "non-dairy bananas must not fail must_be_lactose_free",
  );
  assert.equal(intent.status, "auto_eligible");

  const committed = await commitOrder({
    intentId: intent.id,
    customerId: CUSTOMER,
    idempotencyKey: randomUUID(),
  });
  assert.equal(committed.status, "committed");
  assert.equal(committed.basket.length, 2);

  const history = await getOrderHistory(CUSTOMER);
  const latest = history?.orders.find((o) => o.orderId === committed.committedOrderId);
  assert.ok(latest, "committed multi-item order recorded in kitchen order history");
  assert.equal(latest.lines.length, 2);
});

test("runHeuristicAgent bundles and orders all items in a multi-item prompt", async () => {
  const res = await runHeuristicAgent(
    CUSTOMER,
    "Order 40 litres of lactose-free milk and 10 bananas by 2026-11-16",
    "buyer",
  );
  const createTrace = res.toolTrace.find((t) => t.name === "create_order_intent");
  assert.ok(createTrace?.ok, "create_order_intent must succeed");
  assert.match(res.reply, /milk/i);
  assert.match(res.reply, /banana/i);
});

test("resolveUnifiedKitchenPrompt handles multi-item bundles, saved recipes, and pantry restock", async () => {
  const multi = await resolveUnifiedKitchenPrompt({
    customerId: CUSTOMER,
    text: "100 litres of lactose-free milk and 10 bananas by 2026-11-16",
  });
  assert.equal(multi.mode, "bundle");
  assert.equal(multi.sourceKind, "multi");
  assert.equal(multi.bundleItems?.length, 2);
  assert.ok((multi.bundleItems?.[0]?.offers.length ?? 0) > 0);
  assert.ok((multi.bundleItems?.[1]?.offers.length ?? 0) > 0);

  const recipe = await resolveUnifiedKitchenPrompt({
    customerId: CUSTOMER,
    text: "Order ingredients for 4 batches of buttermilk pancakes by 2026-11-16",
  });
  assert.equal(recipe.mode, "bundle");
  assert.equal(recipe.sourceKind, "recipe");
  assert.ok((recipe.bundleItems?.length ?? 0) >= 2, "recipe shortfall bundle has needed ingredients");

  const restock = await resolveUnifiedKitchenPrompt({
    customerId: CUSTOMER,
    text: "What is running low in our pantry this week?",
  });
  assert.equal(restock.mode, "bundle");
  assert.equal(restock.sourceKind, "restock");
  assert.ok((restock.bundleItems?.length ?? 0) >= 1);
});
