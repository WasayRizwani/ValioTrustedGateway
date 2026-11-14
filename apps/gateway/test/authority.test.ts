import "./setup-db.js";
import { test, before } from "node:test";
import assert from "node:assert/strict";

const AGENT = "hotel_demo_key_001";
const BUYER = "hotel_buyer_key_001";
let app: { request: (path: string, init?: RequestInit) => Promise<Response> };

before(async () => {
  const { createApi } = await import("../src/routes/api.js");
  app = createApi() as typeof app;
});

const call = (key: string | undefined, method: string, path: string, body?: unknown) =>
  app.request(path, {
    method,
    headers: { "content-type": "application/json", ...(key ? { "x-api-key": key } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });

test("no credential → 401", async () => {
  assert.equal((await call(undefined, "GET", "/v1/me")).status, 401);
});

test("roles are exposed on /v1/me", async () => {
  const a = await (await call(AGENT, "GET", "/v1/me")).json();
  const b = await (await call(BUYER, "GET", "/v1/me")).json();
  assert.equal(a.role, "agent");
  assert.equal(a.canApprove, false);
  assert.equal(b.role, "buyer");
  assert.equal(b.canApprove, true);
});

const AUTHORITY_CALLS: Array<[string, string, unknown]> = [
  ["POST", "/v1/orders/some-id/approve", { snapshotHash: "x", authorizeMandateOverride: true, acknowledgedRules: ["over_spend"] }],
  ["POST", "/v1/orders/some-id/reject", { snapshotHash: "x" }],
  ["PUT", "/v1/mandate", { customerId: "HOTEL-001" }],
  ["POST", "/v1/standing-orders", { ingredientId: "x" }],
  ["PUT", "/v1/kitchen/restock/automation", { enabled: true }],
  ["POST", "/v1/kitchen/restock/sync", { mode: "pos_sync", autoOrder: false }],
  ["POST", "/v1/admin/demo-reset", {}],
];

for (const [method, path, body] of AUTHORITY_CALLS) {
  test(`agent key cannot ${method} ${path}`, async () => {
    const res = await call(AGENT, method, path, body);
    assert.equal(res.status, 403);
    assert.equal((await res.json()).error, "forbidden");
  });
}

test("the same calls are not blocked for a buyer key (they fail on content, not authority)", async () => {
  for (const [method, path, body] of AUTHORITY_CALLS.slice(0, 2)) {
    const res = await call(BUYER, method, path, body);
    assert.notEqual(res.status, 403);
    assert.notEqual(res.status, 401);
  }
});

test("agent keys can still use agent endpoints", async () => {
  assert.equal((await call(AGENT, "GET", "/v1/mandate")).status, 200);
  assert.equal((await call(AGENT, "GET", "/v1/orders/pending")).status, 200);
});

test("a blocked escalation attempt is audited and visible", async () => {
  await call(AGENT, "POST", "/v1/orders/x/approve", { snapshotHash: "x" });
  const feed = await (await call(AGENT, "GET", "/v1/activity?limit=10")).json();
  assert.ok(
    feed.events.some((e: { text: string }) => e.text.includes("tried to approve an order")),
    "the refusal must appear in the activity feed / audit log",
  );
});

test("customer isolation: a school key cannot read the hotel's mandate", async () => {
  const school = await (await call("school_demo_key_001", "GET", "/v1/mandate")).json();
  assert.equal(school.customerId, "SCHOOL-001");
});

test("Object.prototype property key in X-API-Key is rejected with 401", async () => {
  const res = await call("toString", "GET", "/v1/me");
  assert.equal(res.status, 401);
});

test("PUT /v1/mandate rejects cross-tenant customerId in payload with 403 customer_mismatch", async () => {
  const hotelMandate = await (await call(BUYER, "GET", "/v1/mandate")).json();
  const res = await call("school_buyer_key_001", "PUT", "/v1/mandate", { ...hotelMandate, customerId: "HOTEL-001" });
  assert.equal(res.status, 403);
  assert.equal((await res.json()).error, "customer_mismatch");
});

test("POST /v1/admin/demo-reset requires X-Demo-Reset: confirm header", async () => {
  const res = await call(BUYER, "POST", "/v1/admin/demo-reset", {});
  assert.equal(res.status, 400);
  assert.equal((await res.json()).error, "confirmation_required");
});

test("executeAgentTool blocks buyer-only tools when callerRole is agent", async () => {
  const { executeAgentTool } = await import("../src/agent/tools.js");
  await assert.rejects(
    executeAgentTool(
      "HOTEL-001",
      "create_event",
      { title: "VIP Gala", eventDate: "2026-12-01", guests: 50, menuItems: [{ recipeId: "R1", servings: 50 }] },
      { callerRole: "agent" },
    ),
    /forbidden/,
  );
});
