import "./setup-db.js";
import assert from "node:assert/strict";
import { before, test } from "node:test";

let app: { request: (path: string, init?: RequestInit) => Promise<Response> };

before(async () => {
  const { createApi } = await import("../src/routes/api.js");
  const { loadCatalog } = await import("../src/catalog/index.js");
  await loadCatalog();
  app = createApi();
});

test("POST /v1/demo/seed requires buyer role and seeds showcase data", async () => {
  const agentRes = await app.request("/v1/demo/seed", {
    method: "POST",
    headers: {
      "X-API-Key": "hotel_demo_key_001",
      "Content-Type": "application/json",
    },
    body: "{}",
  });
  assert.equal(agentRes.status, 403);

  const buyerRes = await app.request("/v1/demo/seed", {
    method: "POST",
    headers: {
      "X-API-Key": "hotel_buyer_key_001",
      "Content-Type": "application/json",
    },
    body: "{}",
  });
  assert.equal(buyerRes.status, 200);
  const body = (await buyerRes.json()) as {
    ok: boolean;
    seeded: {
      customerId: string;
      committedOrders: number;
      pendingApprovals: number;
      events: number;
      standingOrders: number;
    };
  };
  assert.equal(body.ok, true);
  assert.equal(body.seeded.customerId, "HOTEL-001");
  assert.ok(body.seeded.committedOrders >= 1);
  assert.ok(body.seeded.pendingApprovals >= 1);
  assert.equal(body.seeded.events, 2);
  assert.equal(body.seeded.standingOrders, 2);
});
