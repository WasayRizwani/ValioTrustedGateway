import "./setup-db.js";
import test from "node:test";
import assert from "node:assert/strict";
import { adjustStock, getKitchen, recommendRestock, receiveDelivery, recordCommittedOrder, resetKitchen } from "../src/hotel/kitchen.js";
import { useFirstFor, nextMondayIso } from "../src/hotel/optimizer.js";

const C = "HOTEL-001";

test("seeded stock carries expiry and flags what will not be used in time", async () => {
  await resetKitchen(C);
  const rec = (await recommendRestock(C))!.recommendations;
  const cream = rec.find((r) => r.ingredientId === "ing-cream-lf")!;
  assert.equal(cream.daysToExpiry, 2);
  assert.ok((cream.atRiskQty ?? 0) > 0, "cream expires before it is all used");
  const milk = rec.find((r) => r.ingredientId === "ing-milk-lf")!;
  assert.equal(milk.atRiskQty, 0);
});

test("use-first lists expiring stock with recipes, and slow-moving stock", async () => {
  await resetKitchen(C);
  const items = await useFirstFor(C);
  const cream = items.find((u) => u.ingredientId === "ing-cream-lf")!;
  assert.equal(cream.kind, "expiring");
  assert.ok(cream.recipes.length > 0);
  const oats = items.find((u) => u.ingredientId === "ing-oats")!;
  assert.equal(oats.kind, "slow_moving");
});

test("a delivery into an empty shelf sets a new expiry from shelf life; usage stamps last-used", async () => {
  await resetKitchen(C);
  await adjustStock(C, { ingredientId: "ing-banana", onHand: 0 });
  await recordCommittedOrder(C, { orderId: "ORD-T1", intentId: "i1", ingredientId: "ing-banana", productName: "Banana", quantity: 10, unit: "kg", totalEur: 15 });
  await receiveDelivery(C, "ORD-T1");
  const b = (await getKitchen(C))!.inventory.find((i) => i.ingredientId === "ing-banana")!;
  assert.ok(b.expiresOn && b.expiresOn > new Date().toISOString().slice(0, 10));
});

test("expiry can be corrected and must be a real date", async () => {
  await resetKitchen(C);
  await adjustStock(C, { ingredientId: "ing-butter", expiresOn: "2030-01-31" });
  assert.equal((await getKitchen(C))!.inventory.find((i) => i.ingredientId === "ing-butter")!.expiresOn, "2030-01-31");
  await assert.rejects(() => adjustStock(C, { ingredientId: "ing-butter", expiresOn: "soon" }));
});

test("next order day is a Monday in the future", () => {
  const d = new Date(`${nextMondayIso()}T12:00:00`);
  assert.equal(d.getDay(), 1);
  assert.ok(d.getTime() > Date.now());
});
