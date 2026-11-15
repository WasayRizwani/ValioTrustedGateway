import "./setup-db.js";
import test, { beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { BasketLine, Need } from "@tta/shared";

const { getDb } = await import("../src/audit/chain.js");
const { commitOrder, getIntent } = await import("../src/orders/store.js");
const { getMandate, setMandate, resetMandate } = await import("../src/auth/customers.js");

const C = "HOTEL-001";
const realFetch = globalThis.fetch;
let live = { unitPrice: 1, salesBlock: false, available: 1000 };
let fetchDelayMs = 0;

globalThis.fetch = (async (url: string | URL | Request, _init?: RequestInit) => {
  const u = String(url);
  if (fetchDelayMs) await new Promise((r) => setTimeout(r, fetchDelayMs));
  const body = JSON.parse(String((_init as RequestInit).body));
  const ids: string[] = body.products;
  const json = u.endsWith("/api/price")
    ? { currency: "EUR", products: ids.map((id) => ({ productId: id, catalogPrice: { value: live.unitPrice } })) }
    : { products: ids.map((id) => ({ productId: id, salesBlock: live.salesBlock, scheduleLines: [{ availableAmount: live.available, availableDate: "2030-01-01", salesUnit: "pack" }] })) };
  return new Response(JSON.stringify(json), { status: 200, headers: { "content-type": "application/json" } });
}) as typeof fetch;
after(() => { globalThis.fetch = realFetch; });

const need: Need = { productIntent: "lactose-free milk", quantity: 10, unit: "litre", neededBy: "2030-01-02", constraints: { lactoseFree: true } };
const line: BasketLine = {
  productId: "P1", productName: "Lactose-free milk 1L", packs: 10, packSize: 1, packUnit: "litre", totalQuantity: 10, quantityUnit: "litre",
  unitPrice: 1, totalPrice: 10, comparisonPrice: null, comparisonUnit: null, availableQuantity: 1000, availableDate: "2030-01-01",
  deliveryReliability: 0.9, claimIds: [], isSubstitution: false, labels: ["lactose-free"], allergens: [], mayContain: [], certifications: [], origin: null, producer: null,
} as unknown as BasketLine;

async function makeIntent(status = "auto_eligible", failingRules: string[] = [], lineOver: Partial<BasketLine> = {}): Promise<string> {
  const id = randomUUID();
  const now = new Date().toISOString();
  const basketLine = { ...line, ...lineOver };
  await getDb().execute(
    `INSERT INTO order_intents (id, customer_id, run_id, status, need_json, basket_json, snapshot_hash, policy_json, total_price, needed_by, expires_at, approval_snapshot_hash, idempotency_key, committed_order_id, created_at, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,NULL,NULL,$13,$14)`,
    [
      id,
      C,
      randomUUID(),
      status,
      JSON.stringify(need),
      JSON.stringify([basketLine]),
      "hash",
      JSON.stringify({ decision: failingRules.length ? "pending_approval" : "auto_commit", reasons: [], failingRules }),
      10,
      need.neededBy,
      new Date(Date.now() + 3600_000).toISOString(),
      status === "approved" ? "hash" : null,
      now,
      now,
    ],
  );
  return id;
}
const auditTypes = async (runId: string) =>
  (await getDb().query<{ type: string }>(`SELECT type FROM audit_events WHERE run_id = $1`, [runId])).map((r) => r.type);
const commit = (intentId: string, key = randomUUID()) => commitOrder({ intentId, customerId: C, idempotencyKey: key });

beforeEach(async () => {
  live = { unitPrice: 1, salesBlock: false, available: 1000 };
  fetchDelayMs = 0;
  await resetMandate(C);
});

test("normal commit places the order", async () => {
  const id = await makeIntent();
  const res = await commit(id);
  assert.equal(res.status, "committed");
  assert.match(res.committedOrderId ?? "", /^ORD-/);
});

test("price drop proceeds at the lower price and is audited", async () => {
  const id = await makeIntent();
  live.unitPrice = 0.9;
  const res = await commit(id);
  assert.equal(res.status, "committed");
  assert.equal(res.totalPrice, 9);
  assert.equal(res.basket[0].unitPrice, 0.9);
  assert.ok((await auditTypes(res.runId)).includes("price_improved"));
});

test("small price rise within tolerance is accepted", async () => {
  const id = await makeIntent();
  live.unitPrice = 1.01 + 0.01; // +2% exactly
  const res = await commit(id);
  assert.equal(res.status, "committed");
  assert.equal(res.totalPrice, 10.2);
  assert.ok((await auditTypes(res.runId)).includes("price_drift_accepted"));
});

test("big rise requires re-approval when the mandate rule is on, and says was/now/pct", async () => {
  const id = await makeIntent();
  live.unitPrice = 1.2;
  await assert.rejects(commit(id), /was 1 now 1\.2 \(\+20%\)/);
  const after = (await getIntent(id, C))!;
  assert.equal(after.status, "pending_approval");
  assert.equal(after.approvalSnapshotHash, null);
  assert.equal(after.totalPrice, 12);
  assert.ok((await auditTypes(after.runId)).includes("commit_requires_reapproval"));
});

test("big rise invalidates the intent when price_change_on_revalidate is not a required approval", async () => {
  const m = (await getMandate(C))!;
  await setMandate({ ...m, requireApprovalFor: m.requireApprovalFor.filter((r) => r !== "price_change_on_revalidate") });
  const id = await makeIntent();
  live.unitPrice = 1.2;
  await assert.rejects(commit(id), /stale_offer: price_drift_exceeded.*was 1 now 1\.2/);
  const after = (await getIntent(id, C))!;
  assert.equal(after.status, "stale_invalidated");
  assert.ok((await auditTypes(after.runId)).includes("stale_offer"));
});

test("sales block invalidates", async () => {
  const id = await makeIntent();
  live.salesBlock = true;
  await assert.rejects(commit(id), /sales block/);
  assert.equal((await getIntent(id, C))!.status, "stale_invalidated");
});

test("availability drop invalidates", async () => {
  const id = await makeIntent();
  live.available = 3;
  await assert.rejects(commit(id), /availability dropped/);
  assert.equal((await getIntent(id, C))!.status, "stale_invalidated");
});

test("expired mandate at commit time refuses and audits", async () => {
  const id = await makeIntent();
  await setMandate({ ...(await getMandate(C))!, expiresAt: "2020-01-01T00:00:00Z" });
  await assert.rejects(commit(id), /mandate_expired/);
  const after = (await getIntent(id, C))!;
  assert.equal(after.status, "blocked");
  assert.ok((await auditTypes(after.runId)).includes("commit_refused_policy"));
});

test("a rule newly failing since approval sends the intent back for approval; acknowledged rules are honoured", async () => {
  // tightened mandate: spend cap below the order value
  await setMandate({ ...(await getMandate(C))!, maxOrderValueEur: 5 });
  const fresh = await makeIntent("approved");
  await assert.rejects(commit(fresh), /reapproval_required.*over_spend/);
  assert.equal((await getIntent(fresh, C))!.status, "pending_approval");
  // same breach but the human acknowledged over_spend at approval → proceeds
  const acked = await makeIntent("approved", ["over_spend"]);
  const res = await commit(acked);
  assert.equal(res.status, "committed");
});

test("idempotent replay returns the same order without placing another", async () => {
  const id = await makeIntent();
  const first = await commit(id, "key-replay");
  live.unitPrice = 5; // would fail if revalidated again
  const second = await commit(id, "key-replay");
  assert.equal(second.committedOrderId, first.committedOrderId);
});

test("same idempotency key on a different intent is a conflict", async () => {
  const a = await makeIntent();
  const b = await makeIntent();
  await commit(a, "key-shared");
  await assert.rejects(commit(b, "key-shared"), /idempotency_key_conflict/);
  assert.equal((await getIntent(b, C))!.status, "auto_eligible"); // untouched
});

test("simultaneous double commit creates exactly one order", async () => {
  const id = await makeIntent();
  fetchDelayMs = 20;
  const [r1, r2, r3] = await Promise.all([commit(id, "k1"), commit(id, "k1"), commit(id, "k2")]);
  assert.equal(r1.committedOrderId, r2.committedOrderId);
  assert.equal(r1.committedOrderId, r3.committedOrderId);
  const committed = (await getDb().queryOne<{ n: number }>(`SELECT COUNT(*)::int AS n FROM audit_events WHERE run_id = $1 AND type = 'committed'`, [r1.runId]))!.n;
  assert.equal(committed, 1);
});

test("human-approved partial_fulfil commits when live stock matches approved partial quantity and invalidates if stock drops further", async () => {
  const okId = await makeIntent("approved", ["partial_fulfil"], { availableQuantity: 6 });
  live.available = 6;
  const res = await commit(okId);
  assert.equal(res.status, "committed");

  const dropId = await makeIntent("approved", ["partial_fulfil"], { availableQuantity: 6 });
  live.available = 4;
  await assert.rejects(commit(dropId), /availability dropped/);
  assert.equal((await getIntent(dropId, C))!.status, "stale_invalidated");
});
