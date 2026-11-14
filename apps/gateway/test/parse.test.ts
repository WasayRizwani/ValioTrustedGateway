import "./setup-db.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseNeedFromText, extractQuantity, extractDate } from "../src/need/parse.js";
import { agentToolDefs, executeAgentTool, needFromArgs } from "../src/agent/tools.js";

test("the hackathon example: 1,000 litres is 1000, not 1", () => {
  const n = parseNeedFromText(
    "I need 1,000 litres of lactose-free milk by Monday. Find an option that meets our requirements based on price and availability.",
  );
  assert.ok("quantity" in n);
  assert.equal(n.quantity, 1000);
  assert.equal(n.unit, "litre");
  assert.equal(n.constraints.lactoseFree, true);
});

test("thousands and decimal separators", () => {
  assert.deepEqual(extractQuantity("1 000 l of milk"), { quantity: 1000, unit: "litre" });
  assert.deepEqual(extractQuantity("2,5 kg of butter"), { quantity: 2.5, unit: "kg" });
  assert.deepEqual(extractQuantity("0.5 kg"), { quantity: 0.5, unit: "kg" });
  assert.deepEqual(extractQuantity("12,000 kg flour"), { quantity: 12000, unit: "kg" });
  assert.deepEqual(extractQuantity("1,50 kg"), { quantity: 1.5, unit: "kg" });
});

test("a word that merely starts with 'l' is not a unit", () => {
  assert.equal(extractQuantity("20 lactose-free milk"), null);
  const n = parseNeedFromText("order 20 lactose-free milk");
  assert.ok("clarificationRequired" in n, "must ask for a unit instead of guessing 20 litres");
});

test("a correction does not keep the superseded quantity or unit", () => {
  const n = parseNeedFromText("I need 20 litres. No, I need 20 lactose-free milk by Monday.");
  assert.ok("clarificationRequired" in n, "ask for the corrected request's missing unit");
  if ("clarificationRequired" in n) assert.match(n.clarificationRequired, /corrected request/i);
});

test("trusted parser captures allergen exclusions and strict per-unit price caps", () => {
  const n = parseNeedFromText("Find 10 kg granola excluding peanuts and tree nuts, strict max €5/kg, do not order");
  assert.ok("constraints" in n);
  assert.equal(n.productIntent, "granola");
  assert.deepEqual(n.constraints.excludeAllergens, ["tree nuts", "peanut"]);
  assert.equal(n.constraints.maxPricePerUnit, 5);
});

test("model-supplied need cannot drop trusted hard constraints", async () => {
  const trusted = parseNeedFromText("Find 10 kg granola excluding peanuts, max €5/kg by Monday");
  assert.ok("quantity" in trusted);
  const bound = needFromArgs(
    { ...trusted, constraints: { keywords: ["granola"] }, neededBy: "2026-06-08", quantity: 1 },
    { trustedUserText: "Find 10 kg granola excluding peanuts, max €5/kg by Monday", trustedNeed: trusted },
  );
  assert.ok("quantity" in bound);
  assert.equal(bound.quantity, 10);
  assert.equal(bound.constraints.maxPricePerUnit, 5);
  assert.deepEqual(bound.constraints.excludeAllergens, ["peanut"]);
});

test("explicit read-only requests refuse quote and order tools server-side", async () => {
  for (const tool of ["create_order_intent", "request_quote"]) {
    const { result, trace } = await executeAgentTool("HOTEL-001", tool, {}, { readOnlyRequest: true });
    assert.equal(trace.ok, true);
    assert.equal((result as { refused: boolean }).refused, true);
  }
});

test("pieces and packs", () => {
  assert.deepEqual(extractQuantity("60 pieces of egg"), { quantity: 60, unit: "each" });
  assert.deepEqual(extractQuantity("3 packs"), { quantity: 3, unit: "pack" });
});

test("dates: ISO, weekday names, tomorrow", () => {
  assert.equal(extractDate("by 2026-12-01"), "2026-12-01");
  const fri = extractDate("need it by friday");
  assert.ok(fri && new Date(`${fri}T12:00:00`).getDay() === 5);
  assert.ok(extractDate("tomorrow"));
  assert.equal(extractDate("whenever"), undefined);
});

test("explicit neededBy hint wins over words in the text", () => {
  const n = parseNeedFromText("10 kg bananas by friday", "2026-11-20");
  assert.ok("neededBy" in n);
  assert.equal(n.neededBy, "2026-11-20");
});

test("agent parse_need does not let a model-invented date override the request", async () => {
  const parseTool = agentToolDefs.find((tool) => tool.function.name === "parse_need");
  const properties = parseTool?.function.parameters.properties as Record<string, unknown>;
  assert.equal(properties.neededBy, undefined, "the model should not supply a separate date hint");

  const originalPrompt = "Find offers for 10 kg granola needed by next Monday";
  const expectedDate = (parseNeedFromText(originalPrompt) as { neededBy: string }).neededBy;
  const { result, trace } = await executeAgentTool("HOTEL-001", "parse_need", {
    // Simulate the model appending a stale date to the buyer's relative date.
    text: `${originalPrompt} (2026-06-08)`,
  }, {
    trustedUserText: originalPrompt,
    trustedNeed: parseNeedFromText(originalPrompt),
  });
  assert.equal(trace.ok, true);
  assert.equal((result as { neededBy: string }).neededBy, expectedDate);
});
