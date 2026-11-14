import "./setup-db.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { configureValioRequestGateForTest, getAvailability, valioFetch, ValioRateLimitError } from "../src/valio/client.js";
import { executeAgentTool } from "../src/agent/tools.js";

test("availability sentinel is unknown/unlimited, 0.01 normalizes to one, empty schedule is unavailable", async () => {
  configureValioRequestGateForTest();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response(JSON.stringify({ products: [
    { productId: "unknown", salesBlock: false, scheduleLines: [{ availableAmount: 999999, salesUnit: "crate" }] },
    { productId: "one", salesBlock: false, scheduleLines: [{ availableAmount: 0.01, salesUnit: "crate" }] },
    { productId: "empty", salesBlock: false, scheduleLines: [] },
  ] }), { status: 200 })) as typeof fetch;
  try {
    const rows = await getAvailability("HOTEL-001", "2026-11-20", ["unknown", "one", "empty"]);
    assert.equal(rows[0].availabilityUnknown, true);
    assert.equal(rows[0].availableAmount, null);
    assert.equal(rows[0].claim.claim.availabilityUnknown, true);
    assert.equal(rows[1].availableAmount, 1);
    assert.equal(rows[2].salesBlock, true);
  } finally {
    globalThis.fetch = originalFetch;
    configureValioRequestGateForTest();
  }
});

test("a repeated upstream 429 surfaces cooldown and blocks the next call", async () => {
  let now = 0;
  configureValioRequestGateForTest({ now: () => now, sleep: async (ms) => { now += ms; } });
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async () => {
    calls++;
    return calls <= 2
      ? new Response("slow down", { status: 429, headers: { "Retry-After": "30" } })
      : new Response("ok", { status: 200 });
  }) as typeof fetch;
  try {
    await assert.rejects(valioFetch("https://mock.invalid/repeated"), (e) => e instanceof ValioRateLimitError && e.retryAfterSec === 30);
    assert.equal(now, 30_000, "the first retry waits for Retry-After");
    assert.equal((await valioFetch("https://mock.invalid/after-cooldown")).status, 200);
    assert.equal(now, 60_000, "a second call waits out the renewed cooldown");
  } finally {
    globalThis.fetch = originalFetch;
    configureValioRequestGateForTest();
  }
});

test("agent tools preserve Valio 429 errors for the chat layer", async () => {
  let now = 0;
  configureValioRequestGateForTest({ now: () => now, sleep: async (ms) => { now += ms; } });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response("slow down", { status: 429, headers: { "Retry-After": "30" } })) as typeof fetch;
  try {
    await assert.rejects(executeAgentTool("HOTEL-001", "rank_offers", {
      need: { productIntent: "lactose-free milk", quantity: 1, unit: "litre", neededBy: "2026-11-20", constraints: { lactoseFree: true } },
    }), ValioRateLimitError);
  } finally {
    globalThis.fetch = originalFetch;
    configureValioRequestGateForTest();
  }
});

test("Valio requests stay below 10/sec and retry once after Retry-After", async () => {
  let now = 0;
  const starts: number[] = [];
  const waits: number[] = [];
  configureValioRequestGateForTest({
    now: () => now,
    sleep: async (ms) => { waits.push(ms); now += ms; },
  });
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async () => {
    starts.push(now);
    calls++;
    return calls === 1
      ? new Response("slow down", { status: 429, headers: { "Retry-After": "30" } })
      : new Response("ok", { status: 200 });
  }) as typeof fetch;
  try {
    assert.equal((await valioFetch("https://mock.invalid/first")).status, 200);
    await Promise.all([
      valioFetch("https://mock.invalid/second"),
      valioFetch("https://mock.invalid/third"),
    ]);
    assert.equal(calls, 4, "one retry follows the initial 429");
    assert.ok(waits.includes(30_000), "waits for the upstream 30-second cooldown");
    for (let i = 1; i < starts.length; i++) assert.ok(starts[i] - starts[i - 1] >= 100);
  } finally {
    globalThis.fetch = originalFetch;
    configureValioRequestGateForTest();
  }
});
