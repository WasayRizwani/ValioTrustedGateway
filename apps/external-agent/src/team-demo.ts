/**
 * The agent TEAM, end to end — every call goes through the open gateway API with a different,
 * narrowly scoped credential. Run with the gateway up:  npm run demo:team  (add `-- --reset` to wipe demo data first)
 *
 *   Sourcing   finds & compares            (cannot order)
 *   Planner    works out what's needed     (cannot spend)
 *   Procurement places orders in mandate   (cannot approve)
 *   Valio      watches your usual products (cannot see your kitchen)
 *   Buyer      the only one who can approve
 */
const G = process.env.GATEWAY_PUBLIC_URL ?? "http://localhost:8787";
const KEYS = {
  sourcing: "hotel_sourcing_key_001",
  planner: "hotel_planner_key_001",
  procurement: "hotel_procurement_key_001",
  valio: "valio_account_key_001",
  buyer: "hotel_buyer_key_001",
} as const;
type Who = keyof typeof KEYS;

async function call(who: Who, method: string, path: string, body?: unknown) {
  try {
    const res = await fetch(`${G}${path}`, {
      method,
      headers: { "Content-Type": "application/json", "X-API-Key": KEYS[who] },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let json: any;
    try {
      json = JSON.parse(text);
    } catch {
      json = { error: text };
    }
    return { status: res.status, json };
  } catch (e: any) {
    return { status: 0, json: { error: e.message || String(e) } };
  }
}
const line = (s = "") => console.log(s);
const expect = (label: string, who: Who, r: { status: number }, want: number) =>
  console.log(`  ${r.status === want ? "✓" : "✗ UNEXPECTED"} ${who.padEnd(11)} ${label.padEnd(44)} → ${r.status}${r.status === 403 ? " (refused, as designed)" : ""}`);

function monday() {
  const d = new Date();
  d.setDate(d.getDate() + ((8 - d.getDay()) % 7 || 7));
  return d.toISOString().slice(0, 10);
}

// Wiping the running demo is opt-in: only with --reset (it deletes every order on the gateway you point this at).
if (process.argv.includes("--reset")) {
  const r = await fetch(`${G}/v1/admin/demo-reset`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-API-Key": KEYS.buyer, "X-Demo-Reset": "confirm", "X-Reset-Source": "team-demo --reset" },
  });
  console.log(`demo data reset (${r.status})`);
} else {
  console.log("(not resetting demo data — pass --reset for a clean slate; this will add orders to the live demo)");
}
const need = { productIntent: "lactose-free milk", quantity: 100, unit: "litre", neededBy: monday(), constraints: { lactoseFree: true } };

line("1. SOURCING compares live offers (and is refused when it tries to order)");
const rank = await call("sourcing", "POST", "/v1/offers/rank", { need });
expect("compare offers", "sourcing", rank, 200);
const top = rank.json.offers[0];
line(`     best: ${top.productName.slice(0, 54)} · €${top.totalPrice.toFixed(2)} · origin ${top.origin} · ${top.certifications.join(", ") || "no certificates"}`);
expect("place an order", "sourcing", await call("sourcing", "POST", "/v1/orders/intent", { need }), 403);
expect("read the kitchen's inventory", "sourcing", await call("sourcing", "GET", "/v1/kitchen/inventory"), 403);

line("\n2. PLANNER reads the kitchen and plans (but cannot spend)");
expect("read inventory", "planner", await call("planner", "GET", "/v1/kitchen/inventory"), 200);
expect("plan a menu", "planner", await call("planner", "POST", "/v1/kitchen/plan", { neededBy: monday(), recipes: [{ recipeId: "rcp-pancake", batches: 3 }] }), 200);
expect("plan AND create orders", "planner", await call("planner", "POST", "/v1/kitchen/plan", { neededBy: monday(), createIntents: true }), 403);

line("\n3. PROCUREMENT orders inside the mandate (but cannot approve or overreach)");
const intent = await call("procurement", "POST", "/v1/orders/intent", { need });
expect("propose 100 L order", "procurement", intent, 200);
const i = intent.json.intent;
line(`     ${i.status}: ${i.basket[0].productName.slice(0, 50)} · €${i.totalPrice.toFixed(2)}`);
if (i.status === "auto_eligible") expect("commit (within mandate)", "procurement", await call("procurement", "POST", `/v1/orders/${i.id}/commit`, { idempotencyKey: `team-demo-${Date.now()}` }), 200);
expect("approve an order", "procurement", await call("procurement", "POST", `/v1/orders/${i.id}/approve`, { snapshotHash: i.snapshotHash }), 403);
expect("read recipes", "procurement", await call("procurement", "GET", "/v1/kitchen/recipes"), 403);

line("\n4. VALIO's own agent — a different company's agent, with a privacy boundary");
expect("read buyer's inventory", "valio", await call("valio", "GET", "/v1/kitchen/inventory"), 403);
expect("read buyer's recipes", "valio", await call("valio", "GET", "/v1/kitchen/recipes"), 403);
expect("place an order for the buyer", "valio", await call("valio", "POST", "/v1/orders/intent", { need }), 403);
const pid = i.basket[0].productId;
line(`\n   ⚠ Simulating a supplier stock-out of product ${pid} …`);
await call("buyer", "POST", "/v1/admin/simulate-stockout", { productId: pid });
try {
  const run = await call("valio", "POST", "/v1/valio-agent/run", {});
  expect("run its account check", "valio", run, 200);
  for (const s of run.json.created ?? []) line(`     📣 ${s.title}\n        ${s.body}`);

  line("\n5. BUYER accepts — Procurement acts, the mandate still decides");
  const sug = run.json.created?.[0];
  if (sug) {
    expect("Valio accepts its own suggestion", "valio", await call("valio", "POST", `/v1/suggestions/${sug.id}/accept`, {}), 403);
    const acc = await call("buyer", "POST", `/v1/suggestions/${sug.id}/accept`, {});
    expect("buyer accepts the substitute", "buyer", acc, 200);
    line(`     → ${acc.json.intent.status}: ${acc.json.intent.policy.reasons.join("; ")}`);
  }
  const act = await call("buyer", "GET", "/v1/agents");
  line("\n6. Who did what (from the tamper-evident audit log)");
  for (const a of act.json.agents ?? []) line(`   ${a.short.padEnd(12)} ${String(a.actions24h).padStart(3)} actions · ${a.last?.text?.slice(0, 80) ?? "—"}`);
} finally {
  await call("buyer", "POST", "/v1/admin/simulate-stockout", { productId: pid, active: false });
}
