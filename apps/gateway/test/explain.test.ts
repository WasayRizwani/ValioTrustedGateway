import "./setup-db.js";
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { getDb, appendAudit, verifyAuditChain } from "../src/audit/chain.js";
import { configureRateLimits } from "../src/middleware/ratelimit.js";
import { explainOrder } from "../src/ops/explain.js";
import { mcpToolAllowed, agentAllows } from "../src/agents/registry.js";

let app: { request: (path: string, init?: RequestInit) => Promise<Response> };
const runId = randomUUID();
const intentId = randomUUID();
const otherRun = randomUUID();
const otherId = randomUUID();

async function seed(id: string, run: string, customer: string, status: string, policy: object, extra: { approve?: boolean; commit?: boolean } = {}) {
  const need = { productIntent: "milk", quantity: 800, unit: "litre", neededBy: "2030-01-10", constraints: {} };
  const basket = [{ productId: "P1", productName: "Valio milk 1 l", packs: 800, packSize: 1, packUnit: "L", totalQuantity: 800, quantityUnit: "L", unitPrice: 1, totalPrice: 800, comparisonPrice: null, comparisonUnit: null, availableQuantity: 5000, availableDate: "2030-01-08", deliveryReliability: 0.97, claimIds: ["sigA", "sigB"], isSubstitution: false, labels: [], allergens: [], mayContain: [], certifications: [], origin: null, producer: null }];
  const meta = { rationale: ["Cheapest offer that arrives in time."], consideredOffers: 3, alternatives: [{ productId: "P2", productName: "Pricey milk", totalPrice: 900, deltaEur: 100, availableDate: "2030-01-08", deliveryReliability: 0.9, canFulfil: true, isSubstitution: false, certifications: [], origin: null, note: "" }] };
  const now = new Date().toISOString();
  await getDb().execute(
    `INSERT INTO order_intents (id,customer_id,run_id,status,need_json,basket_json,snapshot_hash,policy_json,total_price,needed_by,expires_at,created_at,updated_at,meta_json)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
    [id, customer, run, status, JSON.stringify(need), JSON.stringify(basket), "h", JSON.stringify(policy), 800, "2030-01-10", "2999-01-01T00:00:00Z", now, now, JSON.stringify(meta)],
  );
  await appendAudit(run, customer, "need_validated", need);
  await appendAudit(run, customer, "offers_built", { count: 3, top: [] });
  await appendAudit(run, customer, "intent_created", { intentId: id, productName: "Valio milk 1 l", totalPrice: 800, why: meta.rationale, alternatives: 1 });
  await appendAudit(run, customer, "policy_evaluated", policy);
  if (extra.approve) await appendAudit(run, customer, "human_approved", { intentId: id, mandateOverride: true, acknowledgedRules: ["over_spend"] });
  if (extra.commit) {
    await appendAudit(run, customer, "revalidating", { intentId: id });
    await appendAudit(run, customer, "committed", { orderId: "ORD-1", intentId: id, totalPrice: 800 });
  }
}

before(async () => {
  configureRateLimits({ generalPerMin: 1000, sensitivePerMin: 1000 });
  const pol = { decision: "pending_approval", reasons: ["Total €800.00 exceeds mandate max €500"], failingRules: ["over_spend"] };
  await seed(intentId, runId, "HOTEL-001", "committed", pol, { approve: true, commit: true });
  await seed(otherId, otherRun, "SCHOOL-001", "pending_approval", pol);
  const { createApi } = await import("../src/routes/api.js");
  app = createApi() as typeof app;
});

const get = (key: string, path: string) => app.request(path, { headers: { "x-api-key": key } });

test("explain: plain-English summary, timeline, decision and facts", async () => {
  const x = (await explainOrder(intentId, "HOTEL-001"))!;
  assert.ok(x);
  assert.match(x.summary, /milk/);
  assert.match(x.summary, /overrode/);
  assert.equal(x.decision.by, "human");
  assert.deepEqual(x.decision.rulesOverridden, ["over_spend"]);
  assert.deepEqual(x.decision.rulesFailed, []);
  assert.ok(x.decision.rulesChecked.some((r) => r.rule === "late_delivery" && r.result === "passed"));
  assert.ok(x.timeline.length >= 5 && x.timeline.every((t) => t.at && t.event && t.why));
  assert.equal(x.timeline.filter((t) => t.actor === "human").length, 1);
  assert.equal(x.offers.alternatives[0].productId, "P2");
  assert.match(x.offers.alternatives[0].whyNotChosen, /€100\.00 more/);
  assert.equal(x.facts[0].claimVerification.status, "revalidated_before_commit");
  assert.equal(x.audit.chainValid, true);
});

test("explain: REST endpoint, tenant isolation and 404", async () => {
  const ok = await get("hotel_procurement_key_001", `/v1/orders/${intentId}/explain`);
  assert.equal(ok.status, 200);
  assert.equal((await ok.json()).intentId, intentId);
  assert.equal((await get("hotel_procurement_key_001", `/v1/orders/${otherId}/explain`)).status, 404, "other customer's order is invisible");
  assert.equal((await get("hotel_buyer_key_001", `/v1/orders/nope/explain`)).status, 404);
});

test("explain: allowed for roles that can read orders, refused for others (REST + MCP)", async () => {
  assert.equal(agentAllows("procurement", "GET", `/v1/orders/${intentId}/explain`).allowed, true);
  assert.equal(agentAllows("sourcing", "GET", `/v1/orders/${intentId}/explain`).allowed, false);
  assert.equal((await get("hotel_sourcing_key_001", `/v1/orders/${intentId}/explain`)).status, 403);
  assert.equal(mcpToolAllowed({ role: "agent", agentId: "procurement" }, "explain_order"), true);
  assert.equal(mcpToolAllowed({ role: "agent", agentId: "sourcing" }, "explain_order"), false);
  assert.equal(mcpToolAllowed({ role: "agent", agentId: "valio-account" }, "explain_order"), false);
  assert.equal(mcpToolAllowed({ role: "buyer" }, "explain_order"), true);
});

test("explain: tampering with an audit event's payload in Postgres invalidates verifyAuditChain", async () => {
  const db = getDb();
  const row = await db.queryOne<{ id: number; payload: string }>(
    `SELECT id, payload FROM audit_events WHERE run_id = $1 ORDER BY id ASC LIMIT 1`,
    [runId],
  );
  assert.ok(row);
  try {
    await db.execute(`UPDATE audit_events SET payload = $1 WHERE id = $2`, [
      JSON.stringify({ tampered: true }),
      row.id,
    ]);
    const verify = await verifyAuditChain(runId, "HOTEL-001");
    assert.equal(verify.valid, false);
    assert.equal(verify.brokenAt, Number(row.id));
  } finally {
    await db.execute(`UPDATE audit_events SET payload = $1 WHERE id = $2`, [row.payload, row.id]);
  }
  assert.equal((await verifyAuditChain(runId, "HOTEL-001")).valid, true);
});
