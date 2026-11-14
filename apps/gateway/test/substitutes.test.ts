import "./setup-db.js";
import { test, before } from "node:test";
import assert from "node:assert/strict";
import type { Need } from "@tta/shared";
import {
  clearSubstituteJudgeCache,
  isDeterministicallyCompatible,
  judgeRecipeSubstitutesWithLlm,
} from "../src/catalog/substituteJudge.js";

let cat: typeof import("../src/catalog/index.js");
let planner: typeof import("../src/hotel/planner.js");
let customers: typeof import("../src/auth/customers.js");
let kitchen: typeof import("../src/hotel/kitchen.js");

before(async () => {
  cat = await import("../src/catalog/index.js");
  planner = await import("../src/hotel/planner.js");
  customers = await import("../src/auth/customers.js");
  kitchen = await import("../src/hotel/kitchen.js");
  cat.loadCatalog();
});

test("Stage 1 (Bananas): blocks Alpro strawberry-banana soya, fruit puree, banana leaves, shallots, and plantains", () => {
  const need: Need = {
    productIntent: "banana",
    quantity: 50,
    unit: "kg",
    neededBy: "2026-11-23",
    constraints: {},
  };
  const cands = cat.searchFromNeed(need, 20);
  assert.ok(cands.length >= 3, `expected at least 3 real banana SKUs, got ${cands.length}`);
  for (const c of cands) {
    assert.equal(c.category, "17413", `expected fresh banana category 17413, got ${c.category} (${c.name})`);
    assert.ok(!/alpro|soya|puree|piltti|bananaleave|plantain|shalot/i.test(c.name), `unexpected non-banana candidate: ${c.name}`);
  }
});

test("Stage 1 (Butter): blocks hamburger butter brioche, croissants, and butter spreaders", () => {
  const need: Need = {
    productIntent: "lactose-free butter",
    quantity: 10,
    unit: "kg",
    neededBy: "2026-11-23",
    constraints: { lactoseFree: true },
  };
  const cands = cat.searchFromNeed(need, 20);
  assert.ok(cands.length >= 3, `expected at least 3 real butter SKUs, got ${cands.length}`);
  for (const c of cands) {
    assert.equal(c.category, "10500", `expected butter category 10500, got ${c.category} (${c.name})`);
    assert.ok(!/brioche|croissant|butterbun|spreader|dish/i.test(c.name), `unexpected non-butter candidate: ${c.name}`);
  }
});

test("Stage 1 (Lactose-free milk): anchors on liquid milk (10400) and blocks 15% cooking cream / vegetable fat mixes", () => {
  const need: Need = {
    productIntent: "lactose-free milk",
    quantity: 148,
    unit: "litre",
    neededBy: "2026-11-23",
    constraints: { lactoseFree: true, keywords: ["lactose-free", "milk"] },
  };
  const cands = cat.searchFromNeed(need, 20, ["eila milk"]);
  assert.ok(cands.length >= 5, `expected >= 5 liquid milk SKUs, got ${cands.length}`);
  for (const c of cands) {
    assert.equal(c.category, "10400", `expected liquid milk category 10400, got ${c.category} (${c.name})`);
    assert.ok(!/vegetable mix|kasvirasvasekoite|cooking cream/i.test(c.name), `unexpected cream/blend in milk: ${c.name}`);
  }
});

test("Stage 1 (Yogurt): matches both 'yogurt' and 'yoghurt' spellings while blocking peach Benecol and berry yoghurts", () => {
  const need: Need = {
    productIntent: "lactose-free yogurt",
    quantity: 40,
    unit: "kg",
    neededBy: "2026-11-23",
    constraints: { lactoseFree: true },
  };
  const cands = cat.searchFromNeed(need, 20);
  assert.ok(cands.length >= 5, `expected >= 5 plain lactose-free yogurt/yoghurt SKUs, got ${cands.length}`);
  assert.ok(
    cands.some((c) => /yoghurt/i.test(c.name)),
    "should match British-spelled 'yoghurt' SKUs in Valio's catalog",
  );
  for (const c of cands) {
    assert.equal(c.category, "10412", `expected dairy yogurt category 10412, got ${c.category} (${c.name})`);
    assert.ok(
      !/benecol|peach|strawberry|raspberry|blueberry|mango|vanilla|granola|muesli|lassi|smoothie/i.test(c.name),
      `unexpected flavoured yogurt for plain yogurt need: ${c.name}`,
    );
  }
});

test("Stage 1 (Rolled oats + extra hints): finds wholegrain oat flakes and blocks apple-cinnamon or barley flakes", () => {
  const need: Need = {
    productIntent: "rolled oats",
    quantity: 8,
    unit: "kg",
    neededBy: "2026-11-23",
    constraints: {},
  };
  const cands = cat.searchFromNeed(need, 20, ["oat flakes", "kaurahiutale"]);
  assert.ok(cands.length >= 3, `expected multiple oat flake SKUs, got ${cands.length}`);
  assert.ok(
    cands.some((c) => /oat flakes/i.test(c.name)),
    "extraSearchHints should surface wholegrain oat flakes alongside steel-cut oats",
  );
  for (const c of cands) {
    assert.equal(c.category, "21370");
    assert.ok(!/apple|cinnamon|raspberry|blueberry|barley|rye|buckwheat/i.test(c.name), `unexpected grain/flavour: ${c.name}`);
  }
});

test("Stage 1 (Eggs): returns chicken shell eggs (10590) and blocks eggplants, egg noodles, chocolate eggs, and quail eggs", () => {
  const need: Need = {
    productIntent: "egg",
    quantity: 120,
    unit: "each",
    neededBy: "2026-11-23",
    constraints: {},
  };
  const cands = cat.searchFromNeed(need, 20);
  assert.ok(cands.length >= 4);
  for (const c of cands) {
    assert.equal(c.category, "10590", `expected shell eggs 10590, got ${c.category} (${c.name})`);
    assert.ok(!/eggplant|noodle|pasta|chocolate|mignon|viiriäis|quail|cutter/i.test(c.name), `unexpected non-egg: ${c.name}`);
  }
});

test("Stage 1 preserves explicit flavoured or bakery requests ('strawberry yoghurt', 'butter croissants')", () => {
  const strawNeed: Need = {
    productIntent: "strawberry yoghurt",
    quantity: 5,
    unit: "kg",
    neededBy: "2026-11-23",
    constraints: {},
  };
  const straw = cat.searchFromNeed(strawNeed, 10);
  assert.ok(straw.length > 0 && straw.every((c) => /strawberry/i.test(c.name)));

  const croissantCheck = isDeterministicallyCompatible({
    queryText: "butter croissants",
    anchorCategory: "41764",
    candidate: {
      productId: "460884",
      name: "Reuter & Stolt Croissant butter 18 % 80 x 90g deepfrozen",
      category: "41764",
    },
  });
  assert.equal(croissantCheck.ok, true);
});

test("Stage 2 (Batched LLM Culinary Judge): vets entire plan in 1 LLM call, vetoes subtle mismatches, caches, ignores hallucinations, and falls back safely", async () => {
  clearSubstituteJudgeCache();
  let llmCallCount = 0;

  // Stub Valio upstream + LLM endpoint
  const realFetch = globalThis.fetch;
  const mockLlmFetch: typeof fetch = (async (_url: RequestInfo | URL, init?: RequestInit) => {
    llmCallCount++;
    const reqBody = JSON.parse(String(init?.body ?? "{}"));
    const userPayload = JSON.parse(reqBody.messages[1].content);
    const decisions = userPayload.ingredients.map((ing: { ingredientId: string; candidates: Array<{ productId: string; productName: string }> }) => ({
      ingredientId: ing.ingredientId,
      decisions: [
        // Inject a hallucinated SKU to verify strict allowlist filtering
        { productId: "999999-HALLUCINATED", approved: true, note: "Hallucinated SKU" },
        ...ing.candidates.map((c) => {
          const isLaminating = /laminating/i.test(c.productName);
          return {
            productId: c.productId,
            approved: !isLaminating,
            note: isLaminating ? "Pastry sheet butter only" : "Verified kitchen match",
          };
        }),
      ],
    }));
    return new Response(
      JSON.stringify({
        choices: [{ message: { content: JSON.stringify({ ingredients: decisions }) } }],
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  }) as typeof fetch;

  globalThis.fetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
    const u = String(url);
    const body = JSON.parse(String(init?.body ?? "{}"));
    if (u.endsWith("/api/price")) {
      return new Response(
        JSON.stringify({
          currency: "EUR",
          products: (body.products as string[]).map((id, idx) => ({
            productId: id,
            catalogPrice: { value: 3.5 + idx * 0.4 },
          })),
        }),
        { status: 200 },
      );
    }
    if (u.endsWith("/api/availability")) {
      return new Response(
        JSON.stringify({
          products: (body.products as string[]).map((id) => ({
            productId: id,
            salesBlock: false,
            scheduleLines: [{ availableAmount: 999999, availableDate: "2026-11-16", salesUnit: "KG" }],
          })),
        }),
        { status: 200 },
      );
    }
    throw new Error(`Unexpected fetch URL in test: ${u}`);
  }) as typeof fetch;

  try {
    kitchen.resetKitchen("HOTEL-001");
    const mandate = customers.getMandate("HOTEL-001")!;
    const plan = await planner.planSourcing("HOTEL-001", mandate, {
      neededBy: "2026-11-23",
      baselineUntil: "2026-11-24",
      recipes: [
        { recipeId: "rcp-breakfast-bowl", batches: 6 },
        { recipeId: "rcp-pancake", batches: 5 },
        { recipeId: "rcp-smoothie", batches: 5 },
      ],
      judgeOptions: { fetchImpl: mockLlmFetch },
    });

    // Multi-ingredient plan should invoke the LLM judge in ONE single batched request
    assert.equal(llmCallCount, 1, "all shortfall ingredients must be judged in 1 batched LLM call");

    const bananaLine = plan.lines.find((l) => l.ingredientId === "ing-banana")!;
    assert.ok(bananaLine && bananaLine.substitutes.length > 0);
    for (const s of bananaLine.substitutes) {
      assert.ok(!/alpro|soya|puree|999999/i.test(s.productName));
      assert.equal(s.verifiedBy, "llm_judge");
      assert.equal(s.culinaryNote, "Verified kitchen match");
    }

    const butterLine = plan.lines.find((l) => l.ingredientId === "ing-butter")!;
    assert.ok(butterLine);
    assert.ok(
      !butterLine.substitutes.some((s) => /laminating|brioche|999999/i.test(s.productName)),
      "LLM judge vetoed laminating butter and Stage 1 blocked brioche",
    );

    // Fallback check: when LLM judge errors out (HTTP 500), Stage-1 deterministic candidates survive cleanly
    const brokenJudge = await judgeRecipeSubstitutesWithLlm(
      [
        {
          ingredientId: "ing-banana",
          ingredientName: "Bananas",
          unit: "kg",
          requiredQty: 20,
          recipes: ["Lobby banana smoothie"],
          primary: { productId: "460947", productName: "BANANA KG GT/CR", category: "17413" },
          candidates: [
            {
              productId: "461010",
              productName: "BANANA 4.5KG GT/CR",
              category: "17413",
              packSize: 4.5,
              packUnit: "KG",
              totalPrice: 22,
            },
          ],
        },
      ],
      {
        fetchImpl: (async () => new Response("server error", { status: 500 })) as unknown as typeof fetch,
      },
    );
    assert.equal(brokenJudge.source, "deterministic_fallback");
    assert.ok(brokenJudge.byIngredient.get("ing-banana")?.approvedIds.has("461010"));
  } finally {
    globalThis.fetch = realFetch;
  }
});
