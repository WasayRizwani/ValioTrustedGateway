/**
 * External purchasing agent demo — talks ONLY to the Agent Gateway REST API
 * (same capabilities as MCP). This is the "someone else's agent" client.
 *
 * Scenario A: 100 L lactose-free milk → within mandate → auto commit
 * Scenario B: 3000 L → over spend / approval → pending_approval
 */

const GATEWAY = process.env.GATEWAY_PUBLIC_URL ?? "http://localhost:8787";
const API_KEY = process.env.DEMO_API_KEY_HOTEL ?? "hotel_demo_key_001";

async function api(path: string, init?: RequestInit) {
  const res = await fetch(`${GATEWAY}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      "X-API-Key": API_KEY,
      ...(init?.headers ?? {}),
    },
  });
  const text = await res.text();
  let json: any;
  try {
    json = JSON.parse(text);
  } catch {
    json = { error: text };
  }
  if (!res.ok) {
    throw new Error(`${path} → ${res.status}: ${JSON.stringify(json)}`);
  }
  return json;
}

function localDate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function nextMonday(): string {
  const d = new Date();
  const day = d.getDay();
  let delta = (1 - day + 7) % 7;
  if (delta === 0) delta = 7;
  d.setDate(d.getDate() + delta);
  return localDate(d);
}

async function runScenario(scenario: "a" | "b") {
  const neededBy = nextMonday();
  const quantity = scenario === "a" ? 100 : 3000;
  console.log(`\n=== EXTERNAL purchasing agent (not the desk chat) ===`);
  console.log(`Scenario ${scenario.toUpperCase()} · ${quantity} L lactose-free milk`);
  console.log(`Gateway REST: ${GATEWAY}  (same surface as MCP)`);
  console.log(`Proves: lookup → firm quote → intent → policy → commit/audit without an in-house chatbot.`);

  const me = await api("/v1/me");
  console.log("Authenticated customer:", me.customerId);
  console.log("Mandate max €:", me.mandate?.maxOrderValueEur);

  const need = {
    productIntent: "lactose-free milk",
    quantity,
    unit: "litre",
    neededBy,
    constraints: { lactoseFree: true, keywords: ["lactose-free", "milk"] },
  };

  const search = await api("/v1/products/search", {
    method: "POST",
    body: JSON.stringify({ need, limit: 10 }),
  });
  console.log(
    "Catalog shortlist:",
    search.products.map((p: { productId: string; name: string }) => `${p.productId} ${p.name}`),
  );

  const ranked = await api("/v1/offers/rank", {
    method: "POST",
    body: JSON.stringify({ need }),
  });
  console.log("Explanation:", ranked.explanation);
  console.log(
    "Top offers:",
    ranked.offers.slice(0, 3).map((o: { productId: string; totalPrice: number; canFulfil: boolean }) => ({
      productId: o.productId,
      total: o.totalPrice,
      canFulfil: o.canFulfil,
    })),
  );

  if (ranked.offers[0]?.priceClaim) {
    const v = await api("/v1/claims/verify", {
      method: "POST",
      body: JSON.stringify({ claim: ranked.offers[0].priceClaim }),
    });
    console.log("Price claim verify:", v);
  }

  // Inquiry -> commitment: lock a firm price for the chosen SKU, then build the intent from that quote.
  const best = ranked.offers.find((o: { canFulfil: boolean }) => o.canFulfil) ?? ranked.offers[0];
  const quote = await api("/v1/quotes", {
    method: "POST",
    body: JSON.stringify({ need, productIds: best ? [best.productId] : undefined }),
  });
  console.log("Quote:", {
    quoteId: quote.quoteId,
    total: quote.totalPrice,
    currency: quote.currency,
    firmUntil: quote.validUntil,
    availabilityHeld: quote.availabilityHeld,
    status: quote.status,
  });

  const intentRes = await api("/v1/orders/intent", {
    method: "POST",
    body: JSON.stringify({ quoteId: quote.quoteId }),
  });
  const intent = intentRes.intent;
  console.log("Intent:", {
    id: intent.id,
    status: intent.status,
    total: intent.totalPrice,
    policy: intent.policy.decision,
    failing: intent.policy.failingRules,
    snapshotHash: intent.snapshotHash,
  });

  if (intent.status === "auto_eligible") {
    const commit = await api(`/v1/orders/${intent.id}/commit`, {
      method: "POST",
      body: JSON.stringify({ idempotencyKey: `demo-${scenario}-${intent.id}` }),
    });
    console.log("COMMITTED:", commit.confirmation);
  } else if (intent.status === "pending_approval") {
    console.log(
      "→ Pending human approval. Open React desk, approve snapshot, then commit.",
    );
    console.log(`   Intent ID: ${intent.id}`);
    console.log(`   Snapshot:  ${intent.snapshotHash}`);
    console.log(`   Run ID:    ${intent.runId}`);
  } else {
    console.log("Blocked/other status:", intent.status);
  }

  const audit = await api(`/v1/audit/${intent.runId}`);
  console.log(
    "Audit chain valid:",
    audit.verification.valid,
    "events:",
    audit.events.length,
  );
}

const scenario = process.argv.includes("b") || process.argv.includes("--scenario") && process.argv[process.argv.indexOf("--scenario") + 1] === "b"
  ? "b"
  : process.argv.includes("--scenario") && process.argv[process.argv.indexOf("--scenario") + 1] === "a"
    ? "a"
    : process.argv.includes("a")
      ? "a"
      : "a";

runScenario(scenario as "a" | "b").catch((e) => {
  console.error(e);
  process.exit(1);
});
