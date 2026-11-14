import "./setup-db.js";
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { agentAllows, AGENTS, TOOL_OWNER } from "../src/agents/registry.js";

const KEY = { sourcing: "hotel_sourcing_key_001", planner: "hotel_planner_key_001", procurement: "hotel_procurement_key_001", valio: "valio_account_key_001" };
let app: { request: (path: string, init?: RequestInit) => Promise<Response> };
let toolDefs: Array<{ function: { name: string } }>;

before(async () => {
  app = (await import("../src/routes/api.js")).createApi() as typeof app;
  toolDefs = (await import("../src/agent/tools.js")).agentToolDefs as typeof toolDefs;
});

const call = (key: string, method: string, path: string, body?: unknown) =>
  app.request(path, { method, headers: { "content-type": "application/json", "x-api-key": key }, body: body ? JSON.stringify(body) : undefined });

const MATRIX: Array<[keyof typeof KEY, string, string, boolean]> = [
  // [agent, method, path, allowed]
  ["sourcing", "GET", "/v1/mandate", true],
  ["sourcing", "POST", "/v1/orders/intent", false],
  ["sourcing", "GET", "/v1/kitchen/inventory", false],
  ["sourcing", "GET", "/v1/kitchen/recipes", false],
  ["planner", "GET", "/v1/kitchen/inventory", true],
  ["planner", "GET", "/v1/kitchen/recipes", true],
  ["planner", "POST", "/v1/orders/intent", false],
  ["planner", "POST", "/v1/orders/x/commit", false],
  ["procurement", "GET", "/v1/orders", true],
  ["procurement", "GET", "/v1/kitchen/inventory", false],
  ["procurement", "GET", "/v1/kitchen/recipes", false],
  ["procurement", "POST", "/v1/orders/x/approve", false],
  ["procurement", "PUT", "/v1/mandate", false],
  ["valio", "GET", "/v1/kitchen/inventory", false],
  ["valio", "GET", "/v1/kitchen/recipes", false],
  ["valio", "GET", "/v1/kitchen/restock", false],
  ["valio", "POST", "/v1/orders/intent", false],
  ["valio", "POST", "/v1/orders/x/commit", false],
  ["valio", "POST", "/v1/suggestions/x/accept", false],
  ["valio", "GET", "/v1/suggestions", true],
  ["valio", "GET", "/v1/kitchen/order-history", true],
];

for (const [agent, method, path, allowed] of MATRIX) {
  test(`${agent} agent ${allowed ? "may" : "may NOT"} ${method} ${path}`, async () => {
    assert.equal(agentAllows(agent === "valio" ? "valio-account" : agent, method, path).allowed, allowed);
    const res = await call(KEY[agent], method, path, method === "GET" ? undefined : {});
    if (allowed) assert.notEqual(res.status, 403, "must not be blocked by scope");
    else assert.equal(res.status, 403);
  });
}

test("a planner cannot smuggle order creation through the plan endpoint", async () => {
  const futureDate = new Date(Date.now() + 14 * 86400_000).toISOString().slice(0, 10);
  const res = await call(KEY.planner, "POST", "/v1/kitchen/plan", { neededBy: futureDate, createIntents: true });
  assert.equal(res.status, 403);
  assert.match((await res.json()).message, /Procurement agent/);
  const feed = await (await call("hotel_buyer_key_001", "GET", "/v1/activity?limit=10")).json();
  assert.ok(feed.events.some((e: { text: string; agent?: string }) => e.agent === "planner" && /Blocked/.test(e.text)));
});

test("direct REST calls with a scoped agent key attribute audit events to that agent", async () => {
  const res = await call(KEY.sourcing, "POST", "/v1/need/parse", { text: "20 litres lactose-free milk" });
  assert.equal(res.status, 200);
  const feed = await (await call("hotel_buyer_key_001", "GET", "/v1/activity?limit=10")).json();
  assert.ok(feed.events.some((e: { text: string; agent?: string }) => e.agent === "sourcing" && /Understood/.test(e.text)));
});

test("no agent can approve, override or edit the mandate (that stays human)", () => {
  for (const a of Object.values(AGENTS)) {
    assert.ok(!agentAllows(a.id, "POST", "/v1/orders/x/approve").allowed, `${a.id} approve`);
    assert.ok(!agentAllows(a.id, "PUT", "/v1/mandate").allowed, `${a.id} mandate`);
  }
});

test("only Procurement can propose or commit orders", () => {
  for (const a of Object.values(AGENTS)) {
    const can = agentAllows(a.id, "POST", "/v1/orders/intent").allowed && agentAllows(a.id, "POST", "/v1/orders/x/commit").allowed;
    assert.equal(can, a.id === "procurement", a.id);
  }
});

test("Valio's agent never gets a capability that touches the buyer's private kitchen data", () => {
  const caps = AGENTS["valio-account"].capabilities;
  for (const forbidden of ["kitchen:read", "plan:run", "standing:read", "orders:propose", "orders:commit"]) assert.ok(!caps.includes(forbidden as never), forbidden);
});

test("every chat tool is owned by exactly one specialist agent", () => {
  for (const t of toolDefs) assert.ok(TOOL_OWNER[t.function.name], `tool ${t.function.name} has no owning agent`);
});

test("refusals are attributed to the agent that tried, and visible in the activity feed", async () => {
  await call(KEY.sourcing, "POST", "/v1/orders/intent", {});
  const feed = await (await call("hotel_buyer_key_001", "GET", "/v1/activity?limit=10")).json();
  assert.ok(feed.events.some((e: { text: string; agent?: string }) => e.agent === "sourcing" && /Blocked/.test(e.text)));
});

test("/v1/me tells an agent who it is and what it may do", async () => {
  const me = await (await call(KEY.procurement, "GET", "/v1/me")).json();
  assert.equal(me.agent.id, "procurement");
  assert.equal(me.canApprove, false);
});

test("/v1/connect (integration keys) is visible to the buyer only — never to an agent key", async () => {
  for (const k of Object.values(KEY)) assert.equal((await call(k, "GET", "/v1/connect")).status, 403, k);
  assert.equal((await call("hotel_demo_key_001", "GET", "/v1/connect")).status, 403);
  const res = await call("hotel_buyer_key_001", "GET", "/v1/connect");
  assert.equal(res.status, 200);
  const d = await res.json();
  assert.ok(d.jwks.endsWith("/.well-known/jwks.json"));
  const ids = d.identities.map((i: { id: string }) => i.id);
  for (const id of ["sourcing", "planner", "procurement", "valio-account"]) assert.ok(ids.includes(id), id);
  // The page must advertise exactly the MCP tools each scope really gets.
  const valio = d.identities.find((i: { id: string }) => i.id === "valio-account");
  assert.ok(!valio.mcpTools.includes("get_inventory") && !valio.mcpTools.includes("create_order_intent"));
});
