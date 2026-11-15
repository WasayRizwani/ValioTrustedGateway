import "./setup-db.js";
import { test, beforeEach, before } from "node:test";
import assert from "node:assert/strict";
import { configureRateLimits, checkLimit, shortlistError } from "../src/middleware/ratelimit.js";
import { getDb } from "../src/audit/chain.js";

const AGENT = "hotel_demo_key_001";
const PROC = "hotel_procurement_key_001";
let app: { request: (path: string, init?: RequestInit) => Promise<Response> };
let t = 1_000_000;

before(async () => {
  const { createApi } = await import("../src/routes/api.js");
  app = createApi() as typeof app;
});
beforeEach(() => {
  t = 1_000_000;
  configureRateLimits({ generalPerMin: 5, sensitivePerMin: 2, maxShortlist: 3 }, () => t);
});

const post = (key: string, path: string, body: unknown) =>
  app.request(path, { method: "POST", headers: { "content-type": "application/json", "x-api-key": key }, body: JSON.stringify(body) });

test("token bucket caps bursts and blocks for 30 seconds after a limit hit", () => {
  assert.equal(checkLimit("k", false).ok, true);
  for (let i = 0; i < 4; i++) assert.equal(checkLimit("k", false).ok, true);
  const d = checkLimit("k", false);
  assert.equal(d.ok, false);
  assert.ok(!d.ok && d.retryAfterSec === 30);
  t += 29_999;
  const stillBlocked = checkLimit("k", false);
  assert.ok(!stillBlocked.ok && stillBlocked.retryAfterSec === 1);
  t += 1;
  assert.equal(checkLimit("k", false).ok, true);
  assert.equal(checkLimit("other", false).ok, true, "buckets are per key");
});

test("few hundred calls per minute pass while bursts above 10 are throttled", () => {
  configureRateLimits({ generalPerMin: 300, sensitivePerMin: 300 }, () => t);
  for (let i = 0; i < 300; i++) {
    t = 1_000_000 + Math.floor((i * 60_000) / 300);
    assert.equal(checkLimit("steady", false).ok, true, `request ${i + 1}`);
  }

  configureRateLimits({ generalPerMin: 300, sensitivePerMin: 300 }, () => t);
  for (let i = 0; i < 10; i++) assert.equal(checkLimit("burst", false).ok, true);
  const limited = checkLimit("burst", false);
  assert.deepEqual(limited, { ok: false, bucket: "general", retryAfterSec: 30, limit: 300 });

  configureRateLimits({ generalPerMin: 300, sensitivePerMin: 300 }, () => t);
  for (let i = 0; i < 120; i++) assert.equal(checkLimit("desk", false, "buyer").ok, true, "desk startup and rapid action burst remains usable");
});

test("buyer bucket recovers on natural refill without a 30s lockout", () => {
  configureRateLimits({ generalPerMin: 10, sensitivePerMin: 10 }, () => t);
  // Buyer general limit = 10 * 6 = 60/min (1 token/sec), burst = min(300, 60) = 60
  for (let i = 0; i < 60; i++) assert.equal(checkLimit("buyer-key", false, "buyer").ok, true);
  const limited = checkLimit("buyer-key", false, "buyer");
  assert.deepEqual(limited, { ok: false, bucket: "general", retryAfterSec: 1, limit: 60 });
  // After 1 second (1000ms), 1 token refills and the next request succeeds immediately
  t += 1_000;
  assert.equal(checkLimit("buyer-key", false, "buyer").ok, true);
});

test("REST: desk UI read-only GET requests use buyer bucket capacity even with agent credential", async () => {
  configureRateLimits({ generalPerMin: 300, sensitivePerMin: 300 }, () => t);
  for (let i = 0; i < 25; i++) {
    const res = await app.request("/v1/me", { headers: { "x-api-key": AGENT, "x-desk-ui": "1" } });
    assert.equal(res.status, 200);
  }
});

test("REST: sensitive endpoints are throttled tighter, 429 + Retry-After + stable code, and audited", async () => {
  const body = { q: "milk" };
  assert.equal((await post(AGENT, "/v1/products/search", body)).status, 200);
  assert.equal((await post(AGENT, "/v1/products/search", body)).status, 200);
  const res = await post(AGENT, "/v1/products/search", body);
  assert.equal(res.status, 429);
  assert.equal(res.headers.get("retry-after"), "30");
  const j = await res.json();
  assert.equal(j.error, "rate_limited");
  assert.equal(j.retryAfterSec, 30);
  const rows = await getDb().query<{ payload: string }>(`SELECT payload FROM audit_events WHERE type = 'rate_limited'`);
  assert.ok(rows.some((r) => JSON.parse(r.payload).bucket === "sensitive"));
  // non-sensitive endpoint still works for the same key
  assert.equal((await app.request("/v1/me", { headers: { "x-api-key": AGENT } })).status, 200);
  t += 60_000;
  assert.equal((await post(AGENT, "/v1/products/search", body)).status, 200);
});

test("REST: general bucket applies to every endpoint", async () => {
  for (let i = 0; i < 5; i++) assert.equal((await app.request("/v1/me", { headers: { "x-api-key": PROC } })).status, 200);
  const res = await app.request("/v1/me", { headers: { "x-api-key": PROC } });
  assert.equal(res.status, 429);
});

test("price/availability/rank lookups are capped to a shortlist", async () => {
  const ids = ["a", "b", "c", "d"];
  for (const path of ["/v1/prices", "/v1/availability"]) {
    const res = await post(AGENT, path, { customerId: "HOTEL-001", requestedDate: "2030-01-01", productIds: ids });
    assert.equal(res.status, 400);
    const j = await res.json();
    assert.equal(j.error, "shortlist_too_large");
    assert.equal(j.max, 3);
  }
  assert.equal(shortlistError(["a"]), null);
  assert.ok(shortlistError(ids));
});
