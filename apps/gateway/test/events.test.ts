import "./setup-db.js";
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { batchesFor, schedule, daysBetween, addDays, buildRequest, readinessOf, type EventRecord } from "../src/hotel/events.js";

test("batches: enough portions for every guest plus the safety margin, never zero", () => {
  assert.equal(batchesFor(150, 0, 50), 3);
  assert.equal(batchesFor(150, 10, 50), 4, "150 guests + 10% = 165 portions → 4 batches of 50");
  assert.equal(batchesFor(1, 0, 50), 1);
  assert.equal(batchesFor(0, 10, 50), 0);
});

test("schedule works backwards: order by = on-site date minus Valio's lead time", () => {
  assert.deepEqual(schedule("2026-11-28", 1, 2), { deliverBy: "2026-11-27", orderBy: "2026-11-25" });
  assert.deepEqual(schedule("2026-12-01", 0, 3), { deliverBy: "2026-12-01", orderBy: "2026-11-28" }, "crosses month boundary");
  assert.equal(daysBetween("2026-11-14", "2026-11-28"), 14);
  assert.equal(addDays("2026-12-30", 3), "2027-01-02");
});

test("an event becomes a plan request: delivery by the prep day, baseline kept until the event, extras added", () => {
  const idx = new Map([
    ["rcp-a", { servingsPerBatch: 50, name: "A" }],
    ["rcp-b", { servingsPerBatch: 25, name: "B" }],
  ]);
  const req = buildRequest(
    { name: "Wedding", date: "2026-11-28", guests: 100, bufferPct: 10, prepDays: 1, recipes: [{ recipeId: "rcp-a", servings: 100 }, { recipeId: "rcp-b", servings: 40 }], extras: [{ ingredientId: "ing-x", qty: 5 }] },
    idx,
  );
  assert.equal(req.neededBy, "2026-11-27");
  assert.equal(req.baselineUntil, "2026-11-28");
  assert.deepEqual(req.recipes, [{ recipeId: "rcp-a", batches: 3 }, { recipeId: "rcp-b", batches: 2 }]);
  assert.deepEqual(req.extras, [{ ingredientId: "ing-x", qty: 5 }]);
  assert.throws(() => buildRequest({ name: "x", date: "2026-11-28", guests: 1, bufferPct: 0, prepDays: 1, recipes: [{ recipeId: "nope" }], extras: [] }, idx), /unknown recipe/);
});

const futureDate = (daysAhead: number) => new Date(Date.now() + daysAhead * 86400_000).toISOString().slice(0, 10);

const ev = (over: Partial<EventRecord> = {}): EventRecord => ({
  id: "E", customerId: "C", name: "n", date: futureDate(30), guests: 10, recipes: [], extras: [], bufferPct: 10, autoOrder: true, leadDays: 2, prepDays: 1,
  notes: "", status: "planned", createdAt: "", orders: null, plan: null, ...over,
});
const line = (shortfall: number, status = "sourced") => ({ ingredientId: "i", name: "i", unit: "kg", required: 1, onHand: 0, onOrder: 0, shortfall, usedBy: [], status, substitutes: [], explanation: "" }) as never;
const plan = (lines: unknown[], canMeetDate = true) => ({ lines, flags: [], estTotal: 1, canMeetDate, at: "", neededBy: "", runId: "", summary: "" }) as never;

test("readiness: covered / ready to order / at risk / ordered / past", () => {
  const today = new Date().toISOString().slice(0, 10);
  const past = new Date(Date.now() - 10 * 86400_000).toISOString().slice(0, 10);
  assert.equal(readinessOf(ev(), today), "unplanned");
  assert.equal(readinessOf(ev({ plan: plan([line(0, "covered")]) }), today), "covered");
  assert.equal(readinessOf(ev({ plan: plan([line(5)]) }), today), "ready_to_order");
  assert.equal(readinessOf(ev({ plan: plan([line(5, "unsourceable")]) }), today), "at_risk");
  assert.equal(readinessOf(ev({ plan: plan([line(5, "partial")]) }), today), "at_risk");
  assert.equal(readinessOf(ev({ plan: plan([line(5)], false) }), today), "at_risk");
  assert.equal(readinessOf(ev({ status: "ordered", plan: plan([line(5)]) }), today), "ordered");
  assert.equal(readinessOf(ev({ date: past }), today), "past");
});

// ---- permissions ----
let app: { request: (path: string, init?: RequestInit) => Promise<Response> };
before(async () => {
  app = (await import("../src/routes/api.js")).createApi() as typeof app;
});
const call = (key: string, method: string, path: string, body?: unknown) =>
  app.request(path, { method, headers: { "content-type": "application/json", "x-api-key": key }, body: body ? JSON.stringify(body) : undefined });

test("only the buyer can create, change, order or cancel events", async () => {
  for (const key of ["hotel_demo_key_001", "hotel_planner_key_001", "hotel_procurement_key_001", "hotel_sourcing_key_001", "valio_account_key_001"]) {
    assert.equal((await call(key, "POST", "/v1/events", { name: "x" })).status, 403, `${key} POST`);
    assert.equal((await call(key, "POST", "/v1/events/E/order")).status, 403, `${key} order`);
    assert.equal((await call(key, "DELETE", "/v1/events/E")).status, 403, `${key} delete`);
  }
});

test("the Planner can READ events (it needs them to plan); Valio, Sourcing and Procurement cannot", async () => {
  assert.equal((await call("hotel_planner_key_001", "GET", "/v1/events")).status, 200);
  assert.equal((await call("hotel_buyer_key_001", "GET", "/v1/events")).status, 200);
  for (const key of ["valio_account_key_001", "hotel_sourcing_key_001", "hotel_procurement_key_001"]) assert.equal((await call(key, "GET", "/v1/events")).status, 403, key);
});

test("event validation rejects nonsense before touching Valio", async () => {
  const validFuture = futureDate(14);
  const bad = async (body: unknown) => (await call("hotel_buyer_key_001", "POST", "/v1/events", body)).status;
  assert.equal(await bad({ name: "", date: validFuture, guests: 10, recipes: [{ recipeId: "rcp-pancake" }] }), 400);
  assert.equal(await bad({ name: "x", date: "tomorrow", guests: 10, recipes: [{ recipeId: "rcp-pancake" }] }), 400);
  assert.equal(await bad({ name: "x", date: validFuture, guests: 0, recipes: [{ recipeId: "rcp-pancake" }] }), 400);
  assert.equal(await bad({ name: "x", date: validFuture, guests: 10, recipes: [] }), 400);
  assert.equal(await bad({ name: "x", date: validFuture, guests: 10, recipes: [{ recipeId: "does-not-exist" }] }), 400);
});
