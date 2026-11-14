import "./setup-db.js";
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { config } from "../src/config.js";

const origVoiceMockMode = config.voiceMockMode;
const origVoiceCallerMap = { ...config.voiceCallerMap };

let app: { request: (path: string, init?: RequestInit) => Promise<Response> };
before(async () => { app = (await import("../src/routes/api.js")).createApi() as typeof app; });
after(() => {
  config.voiceMockMode = origVoiceMockMode;
  for (const k of Object.keys(config.voiceCallerMap)) delete config.voiceCallerMap[k];
  Object.assign(config.voiceCallerMap, origVoiceCallerMap);
});
const headers = { "content-type": "application/json", host: "localhost:8787" };
const mockCall = (toolId: string, args: unknown) => ({ message: { call: { id: "call-voice-test", customer: { number: "+358401234567" } }, toolCallList: [{ id: toolId, name: "create_event_proposal", parameters: args }] } });

test("voice demo creates a non-ordering proposal; approval link is read-only on GET and single-use on POST", async () => {
  config.voiceMockMode = true;
  config.voiceCallerMap["+358401234567"] = { customerId: "HOTEL-001", buyerEmail: "buyer@example.test" };
  const recipe = "rcp-pancake";
  const date = new Date(Date.now() + 2 * 86400_000).toISOString().slice(0, 10);
  const args = { confirmed: true, name: "Voice demo lunch", date, guests: 1, recipeIds: [recipe] };
  const created = await app.request("/vapi/mock/tools", { method: "POST", headers, body: JSON.stringify(mockCall("tool-voice-1", args)) });
  assert.equal(created.status, 200);
  const body = await created.json() as { results: Array<{ result: { eventId: string; status: string; mockApprovalUrl: string } }> };
  const result = body.results[0].result;
  assert.equal(result.status, "mock_preview");
  assert.ok(result.mockApprovalUrl.includes("/approval/voice/"));

  const events = await app.request("/v1/events", { headers: { "x-api-key": "hotel_buyer_key_001" } });
  const listed = await events.json() as { events: Array<{ id: string; autoOrder: boolean; voice?: { delivery: string; approval: string; approvalUrl?: string } }> };
  const event = listed.events.find((item) => item.id === result.eventId)!;
  assert.equal(event.autoOrder, false);
  assert.deepEqual(event.voice && { delivery: event.voice.delivery, approval: event.voice.approval }, { delivery: "mocked", approval: "pending" });
  assert.equal(event.voice?.approvalUrl, result.mockApprovalUrl);

  const path = new URL(result.mockApprovalUrl).pathname;
  const preview = await app.request(path, { method: "GET", headers });
  assert.equal(preview.status, 200, await preview.clone().text());
  const html = await preview.text();
  assert.match(html, /Approve plan and schedule ordering/);
  assert.match(html, /This page approves a plan, not an individual order/);
  assert.match(html, /Dishes/);
  assert.match(html, /Hotel buttermilk pancakes/);
  assert.match(html, /total estimate unavailable/);
  const afterGet = await app.request(path, { method: "GET", headers });
  assert.equal(afterGet.status, 200, "email link scanners must not consume approval");

  const approvals = await Promise.all([
    app.request(path, { method: "POST", headers }),
    app.request(path, { method: "POST", headers }),
  ]);
  assert.deepEqual(approvals.map((x) => x.status).sort(), [200, 410], "overlapping approvals consume the token once");
  const afterApproval = await app.request("/v1/events", { headers: { "x-api-key": "hotel_buyer_key_001" } });
  const approvedEvents = await afterApproval.json() as { events: Array<{ id: string; autoOrder: boolean; voice?: { approval: string } }> };
  const approvedEvent = approvedEvents.events.find((item) => item.id === result.eventId)!;
  assert.equal(approvedEvent.autoOrder, true);
  assert.equal(approvedEvent.voice?.approval, "approved");
  assert.equal((await app.request(path, { method: "POST", headers })).status, 410, "approval token is single-use");
});

test("voice tool redelivery is idempotent and conflicting payload reuse is rejected", async () => {
  config.voiceMockMode = true;
  config.voiceCallerMap["+358401234567"] = { customerId: "HOTEL-001", buyerEmail: "buyer@example.test" };
  const date = new Date(Date.now() + 3 * 86400_000).toISOString().slice(0, 10);
  const args = { confirmed: true, name: "Duplicate guard", date, guests: 1, recipeIds: ["rcp-pancake"] };
  const invoke = (input: unknown) => app.request("/vapi/mock/tools", { method: "POST", headers, body: JSON.stringify(mockCall("tool-voice-duplicate", input)) });
  const first = await invoke(args);
  const firstResult = (await first.json() as { results: Array<{ result: unknown }> }).results[0].result;
  const replay = await invoke(args);
  const replayResult = (await replay.json() as { results: Array<{ result: unknown }> }).results[0].result;
  assert.deepEqual(replayResult, firstResult);
  const conflict = await invoke({ ...args, guests: 2 });
  const conflictBody = await conflict.json() as { results: Array<{ result: { code: string } }> };
  assert.equal(conflictBody.results[0].result.code, "idempotency_conflict");
});

test("voice endpoint rejects missing auth and unrecognized callers without a proposal", async () => {
  config.voiceMockMode = true;
  const futureDate = new Date(Date.now() + 7 * 86400_000).toISOString().slice(0, 10);
  const body = mockCall("tool-denied", { confirmed: true, name: "No", date: futureDate, guests: 1, recipeIds: ["rcp-pancake"] });
  assert.equal((await app.request("/vapi/tools", { method: "POST", headers, body: JSON.stringify(body) })).status, 503, "live webhook is disabled in mock mode");
  config.voiceMockMode = false;
  const response = await app.request("/vapi/tools", { method: "POST", headers, body: JSON.stringify(body) });
  assert.equal(response.status, 401);
});

test("editing a voice event invalidates its old approval link", async () => {
  config.voiceMockMode = true;
  config.voiceCallerMap["+358401234567"] = { customerId: "HOTEL-001", buyerEmail: "buyer@example.test" };
  const date = new Date(Date.now() + 5 * 86400_000).toISOString().slice(0, 10);
  const args = { confirmed: true, name: "Snapshot edit", date, guests: 1, recipeIds: ["rcp-pancake"] };
  const created = await app.request("/vapi/mock/tools", { method: "POST", headers, body: JSON.stringify(mockCall("tool-voice-edit", args)) });
  const result = (await created.json() as { results: Array<{ result: { eventId: string } }> }).results[0].result;
  const listed = await app.request("/v1/events", { headers: { "x-api-key": "hotel_buyer_key_001" } });
  const event = (await listed.json() as { events: Array<{ id: string; voice?: { approvalUrl: string } }> }).events.find((x) => x.id === result.eventId)!;
  const approvalPath = new URL(event.voice.approvalUrl).pathname;
  const update = await app.request(`/v1/events/${result.eventId}`, {
    method: "PUT", headers: { ...headers, "x-api-key": "hotel_buyer_key_001" },
    body: JSON.stringify({ name: "Snapshot edit updated", date, guests: 1, bufferPct: 10, autoOrder: false, recipes: [{ recipeId: "rcp-pancake", servings: 1 }], extras: [] }),
  });
  assert.equal(update.status, 200);
  const stalePreview = await app.request(approvalPath, { method: "GET", headers });
  assert.equal(stalePreview.status, 410, await stalePreview.text());
  assert.equal((await app.request(approvalPath, { method: "POST", headers })).status, 410);
});
