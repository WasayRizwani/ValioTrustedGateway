import "./setup-db.js";
import { after, before, test } from "node:test";
import assert from "node:assert/strict";

const BUYER = "hotel_buyer_key_001";
const realFetch = globalThis.fetch;
let app: { request: (path: string, init?: RequestInit) => Promise<Response> };

before(async () => {
  const { localDate } = {
    localDate: (d: Date) =>
      `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`,
  };
  const tomorrowIso = localDate(new Date(Date.now() + 86_400_000));

  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    const body = JSON.parse(String(init?.body ?? "{}"));
    const ids: string[] = body.products ?? [];
    const json = u.endsWith("/api/price")
      ? {
          currency: "EUR",
          products: ids.map((id) => ({ productId: id, catalogPrice: { value: 1.85 } })),
        }
      : {
          products: ids.map((id) => ({
            productId: id,
            salesBlock: false,
            scheduleLines: [
              { availableAmount: 2000, availableDate: tomorrowIso, salesUnit: "pack" },
            ],
          })),
        };
    return new Response(JSON.stringify(json), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;

  const { createApi } = await import("../src/routes/api.js");
  app = createApi() as typeof app;
});

after(() => {
  globalThis.fetch = realFetch;
});

const call = (method: string, path: string, body?: unknown) =>
  app.request(path, {
    method,
    headers: { "content-type": "application/json", "x-api-key": BUYER },
    body: body ? JSON.stringify(body) : undefined,
  });

test("GET /v1/kitchen/restock/automation exposes active auto-sync, low/critical thresholds, and stockHealth", async () => {
  const res = await call("GET", "/v1/kitchen/restock/automation");
  assert.equal(res.status, 200);
  const json = await res.json();

  assert.equal(json.policy.enabled, true);
  assert.equal(json.policy.autoSyncInventory, true);
  assert.deepEqual(json.policy.urgencies, ["critical", "low"]);
  assert.ok(Array.isArray(json.syncStatus.connectedSources));
  assert.ok(json.syncStatus.connectedSources.length >= 3);
  assert.ok(json.stockHealth);
  assert.ok(json.stockHealth.criticalCount >= 1);
  assert.ok(Array.isArray(json.stockHealth.items));
  assert.equal(json.policy.dailyDigestEnabled, true);
  assert.equal(json.dailyDigest.enabled, true);
  assert.equal(json.dailyDigest.cadence, "1 email/day");
  assert.match(json.dailyDigest.summary, /One daily email/i);
});

test("PUT /v1/kitchen/restock/automation persists urgency filter and sync cadence", async () => {
  const putRes = await call("PUT", "/v1/kitchen/restock/automation", {
    urgencies: ["critical"],
    daysCover: 5,
    syncIntervalMinutes: 5,
  });
  assert.equal(putRes.status, 200);
  const updated = await putRes.json();
  assert.deepEqual(updated.policy.urgencies, ["critical"]);
  assert.equal(updated.policy.daysCover, 5);
  assert.equal(updated.policy.syncIntervalMinutes, 5);

  const restoreRes = await call("PUT", "/v1/kitchen/restock/automation", {
    urgencies: ["critical", "low"],
    daysCover: 7,
    syncIntervalMinutes: 15,
  });
  assert.equal(restoreRes.status, 200);
});

test("POST /v1/kitchen/restock/sync with service_rush + autoOrder=true syncs POS usage and auto-orders low/critical items", async () => {
  const beforeRes = await (await call("GET", "/v1/kitchen/restock/automation")).json();
  const milkBefore = beforeRes.stockHealth.items.find(
    (i: { ingredientId: string }) => i.ingredientId === "ing-milk-lf",
  )?.onHand;

  const syncRes = await call("POST", "/v1/kitchen/restock/sync", {
    mode: "service_rush",
    autoOrder: true,
  });
  assert.equal(syncRes.status, 200);
  const synced = await syncRes.json();

  assert.equal(synced.syncStatus.lastSyncSource, "service_rush");
  assert.ok(Array.isArray(synced.syncStatus.deductions));
  assert.ok(synced.syncStatus.deductions.length > 0);
  assert.ok(synced.restockResult);
  assert.ok(
    synced.restockResult.committedCount + synced.restockResult.pendingApprovalCount >= 1,
    "Low/critical items must be automatically ordered or queued for approval",
  );
  assert.ok(synced.restockResult.lines.length >= 1);

  const milkAfterItem = synced.stockHealth.items.find(
    (i: { ingredientId: string }) => i.ingredientId === "ing-milk-lf",
  );
  assert.ok(milkAfterItem.onHand < milkBefore, "POS service rush sync should deduct recipe milk stock");
  assert.ok(
    milkAfterItem.onOrder > 0 || synced.restockResult.pendingApprovalCount > 0,
    "Restocked milk should either be inbound onOrder or awaiting approval",
  );
});
