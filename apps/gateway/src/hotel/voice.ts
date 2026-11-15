import { createHash, randomBytes, randomUUID } from "node:crypto";
import { config } from "../config.js";
import { getDb, appendAudit } from "../audit/chain.js";
import { getRecipes } from "./kitchen.js";
import { addDays, createEvent, deleteEvent, getEventRecord, todayIso, view, type EventInput, type EventRecord, type EventView } from "./events.js";

type Caller = { customerId: string; buyerEmail: string };
type VoiceState = { eventId: string; delivery: string; approval: string; attempts: number; updatedAt: string; approvalUrl?: string; errorCode?: string; retryAfterAt?: string };
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const now = () => new Date().toISOString();

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonical(item)]));
  return value;
}

const db = () => getDb();

function eventSnapshot(ev: EventRecord) {
  return sha(JSON.stringify({ id: ev.id, version: ev.version, name: ev.name, date: ev.date, guests: ev.guests, recipes: ev.recipes, extras: ev.extras, plan: ev.plan }));
}
function esc(value: unknown) { return String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!); }

async function summaryHtml(ev: EventView, approvalUrl: string) {
  const lines = ev.plan?.lines ?? [];
  const needed = lines.filter((l) => l.shortfall > 0);
  const dishes = (await eventDishNames(ev)).map((dish) => `<li>${esc(dish.name)} · ${dish.servings} portion${dish.servings === 1 ? "" : "s"}</li>`).join("");
  const unpriced = needed.filter((l) => !l.chosen).length;
  const hasPriced = needed.some((l) => l.chosen);
  const spend = unpriced ? hasPriced ? `At least €${(ev.plan?.estTotal ?? 0).toFixed(2)} for priced items · ${unpriced} item${unpriced === 1 ? "" : "s"} not priced` : `${unpriced} item${unpriced === 1 ? "" : "s"} not priced · total estimate unavailable` : `€${(ev.plan?.estTotal ?? 0).toFixed(2)}`;
  const risk = ev.plan?.flags.length ? `<h3>Needs attention</h3><ul>${ev.plan.flags.map((x) => `<li>${esc(x)}</li>`).join("")}</ul>` : "";
  const items = needed.length ? `<ul>${needed.map((l) => `<li>${esc(l.name)}: ${esc(l.shortfall)} ${esc(l.unit)} estimated${l.chosen ? ` · ${esc(l.chosen.productName)} · €${l.chosen.totalPrice.toFixed(2)}` : " · no offer found"}</li>`).join("")}</ul>` : "<p>Everything appears covered by stock or existing orders.</p>";
  return `<h1>Event purchase plan</h1><p><b>${esc(ev.name)}</b> · ${esc(ev.date)} · ${ev.guests} guest${ev.guests === 1 ? "" : "s"}</p><h2>Dishes</h2><ul>${dishes}</ul><p>Estimated additional spend: <b>${spend}</b></p><h2>Estimated items</h2>${items}<p>Order by ${esc(ev.orderBy)} · planned delivery by ${esc(ev.deliverBy)}</p>${risk}<p>Approving schedules a future purchasing attempt after live price and availability checks. Orders still follow your mandate; exceptions may need separate approval. This is a proposal, not an order. Approval link expires after seven days.</p><p><a href="${esc(approvalUrl)}">Review and approve the plan</a></p>`;
}

async function sendEmail(to: string, subject: string, html: string, id: string) {
  if (config.voiceMockMode) return { providerId: `mock-${id}` };
  if (!config.resendApiKey || !config.emailFrom) throw Object.assign(new Error("email_not_configured"), { code: "email_not_configured" });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 8_000);
    try {
      const response = await fetch("https://api.resend.com/emails", {
        method: "POST", signal: ctrl.signal,
        headers: { Authorization: `Bearer ${config.resendApiKey}`, "Content-Type": "application/json", "Idempotency-Key": `voice-plan-${id}` },
        body: JSON.stringify({ from: config.emailFrom, to: [to], subject, html }),
      });
      const body = await response.json().catch(() => ({})) as { id?: string };
      if (response.ok) return { providerId: body.id ?? null };
      if (response.status === 429) {
        const rawRetry = Number(response.headers.get("retry-after") ?? "1");
        const retryAfterSeconds = Number.isFinite(rawRetry) ? Math.max(0, Math.ceil(rawRetry)) : 0;
        if (attempt === 0 && retryAfterSeconds > 0 && retryAfterSeconds <= 2) {
          await new Promise((resolve) => setTimeout(resolve, retryAfterSeconds * 1000));
          continue;
        }
        throw Object.assign(new Error("email_rate_limited"), { code: "email_rate_limited", retryAfterSeconds });
      }
      if (response.status >= 500 && attempt === 0) {
        await new Promise((resolve) => setTimeout(resolve, 250));
        continue;
      }
      throw Object.assign(new Error(`email_provider_${response.status}`), { code: "email_provider_rejected", status: response.status });
    } catch (error) {
      if (error instanceof Error && "code" in error) throw error;
      throw Object.assign(new Error("email_delivery_unknown"), { code: "email_delivery_unknown" });
    } finally { clearTimeout(timer); }
  }
  throw Object.assign(new Error("email_provider_rejected"), { code: "email_provider_rejected" });
}

export function voiceReadiness() {
  let localApprovalUrl = false;
  let secureApprovalUrl = false;
  try {
    const parsed = new URL(config.voiceApprovalBaseUrl);
    localApprovalUrl = ["localhost", "127.0.0.1"].includes(parsed.hostname);
    secureApprovalUrl = parsed.protocol === "https:" || (config.voiceMockMode && localApprovalUrl);
  } catch { localApprovalUrl = true; }
  const missing = [
    ["VAPI_WEBHOOK_SECRET", config.vapiWebhookSecret],
    ["VOICE_PUBLIC_NUMBER", config.voicePublicNumber],
    ["VOICE_CALLER_MAP_JSON", Object.keys(config.voiceCallerMap).length ? "configured" : ""],
    ["RESEND_API_KEY", config.resendApiKey], ["EMAIL_FROM", config.emailFrom],
    ["VOICE_APPROVAL_BASE_URL", secureApprovalUrl ? config.voiceApprovalBaseUrl : ""],
  ].filter(([, v]) => !v).map(([k]) => k);
  return { mode: config.voiceMockMode ? "mock" : "live", ready: !config.voiceMockMode && missing.length === 0, phoneNumber: config.voicePublicNumber, missing };
}

export function resolveCaller(phone: string): Caller | null {
  const caller = config.voiceCallerMap[phone] ?? config.voiceCallerMap["*"];
  if (!caller || typeof caller.customerId !== "string" || !Object.values(config.apiKeys).includes(caller.customerId)) return null;
  if (typeof caller.buyerEmail !== "string" || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(caller.buyerEmail)) return null;
  return caller;
}

export async function allowVoiceAttempt(phone: string): Promise<boolean> {
  const d = db();
  const key = sha(phone || "unknown");
  return d.withTransaction(async (tx) => {
    const row = await tx.queryOne<{ window_started: string; attempts: number }>(
      "SELECT window_started, attempts FROM voice_attempts WHERE caller_hash = $1",
      [key],
    );
    if (!row || Date.now() - new Date(row.window_started).getTime() >= 5 * 60_000) {
      await tx.execute(
        "INSERT INTO voice_attempts (caller_hash, window_started, attempts) VALUES ($1, $2, 1) ON CONFLICT (caller_hash) DO UPDATE SET window_started = excluded.window_started, attempts = 1",
        [key, now()],
      );
      return true;
    }
    if (row.attempts >= 12) return false;
    await tx.execute("UPDATE voice_attempts SET attempts = attempts + 1 WHERE caller_hash = $1", [key]);
    return true;
  });
}

export async function getSavedRecipes(customerId: string) {
  return ((await getRecipes(customerId))?.recipes ?? []).map((r) => ({ id: r.recipeId, name: r.name, servingsPerBatch: r.servingsPerBatch }));
}

export async function eventDishNames(ev: Pick<EventRecord, "customerId" | "recipes" | "guests">) {
  const names = new Map((await getSavedRecipes(ev.customerId)).map((recipe) => [recipe.id, recipe.name]));
  return ev.recipes.map((recipe) => ({ name: names.get(recipe.recipeId) ?? recipe.recipeId, servings: recipe.servings ?? ev.guests }));
}

export async function createVoiceProposal(args: {
  caller: Caller; callId: string; toolCallId: string; payload: Record<string, unknown>;
  event: EventInput;
}) {
  const database = db();
  const payloadHash = sha(JSON.stringify(canonical({ customerId: args.caller.customerId, payload: args.payload })));
  const previous = await database.queryOne<{ payload_hash: string; result_json: string | null; status: string }>(
    "SELECT payload_hash, result_json, status FROM voice_calls WHERE call_id = $1 AND tool_call_id = $2",
    [args.callId, args.toolCallId],
  );
  if (previous) {
    if (previous.payload_hash !== payloadHash) throw Object.assign(new Error("idempotency_conflict"), { code: "idempotency_conflict" });
    if (previous.result_json) return JSON.parse(previous.result_json) as { eventId: string; status: string; message: string };
    if (previous.status === "failed") {
      await database.execute("DELETE FROM voice_calls WHERE call_id = $1 AND tool_call_id = $2", [args.callId, args.toolCallId]);
    } else {
      throw Object.assign(new Error("request_in_progress"), { code: "request_in_progress" });
    }
  }
  await database.execute(
    "INSERT INTO voice_calls (call_id, tool_call_id, payload_hash, status, created_at) VALUES ($1, $2, $3, 'processing', $4)",
    [args.callId, args.toolCallId, payloadHash, now()],
  );
  const token = randomBytes(32).toString("base64url");
  const tokenHash = sha(token);
  const expiresAt = new Date(Date.now() + 7 * 86400_000).toISOString();
  const outboxId = `mail-${randomUUID()}`;
  const approvalBaseUrl = config.voiceApprovalBaseUrl || (config.voiceMockMode ? "http://localhost:8787" : "");
  let eventId = "";
  try {
    if (!approvalBaseUrl) throw Object.assign(new Error("approval_url_not_configured"), { code: "approval_url_not_configured" });
    const approvalOrigin = new URL(approvalBaseUrl);
    if (!config.voiceMockMode && approvalOrigin.protocol !== "https:") throw Object.assign(new Error("approval_url_requires_https"), { code: "approval_url_requires_https" });
    const ev = await createEvent(args.caller.customerId, { ...args.event, autoOrder: false }, async (created) => {
      eventId = created.id;
      await database.execute(
        "INSERT INTO voice_approvals (event_id, customer_id, buyer_email, event_version, snapshot_hash, token_hash, expires_at, status, updated_at) VALUES ($1, $2, $3, $4, $5, $6, $7, 'pending', $8)",
        [created.id, args.caller.customerId, args.caller.buyerEmail, created.version, eventSnapshot(created), tokenHash, expiresAt, now()],
      );
      const baseUrl = config.voiceApprovalBaseUrl || (config.voiceMockMode ? "http://localhost:8787" : "");
      const mockLink = config.voiceMockMode ? `${baseUrl.replace(/\/$/, "")}/approval/voice/${token}` : null;
      await database.execute(
        "INSERT INTO voice_outbox (id, event_id, customer_id, recipient, status, mock_approval_url, updated_at) VALUES ($1, $2, $3, $4, 'queued', $5, $6)",
        [outboxId, created.id, args.caller.customerId, args.caller.buyerEmail, mockLink, now()],
      );
    });
    const snapshotHash = eventSnapshot(ev);
    await database.execute(
      "UPDATE voice_approvals SET event_version = $1, snapshot_hash = $2, updated_at = $3 WHERE event_id = $4",
      [ev.version, snapshotHash, now(), ev.id],
    );
    const approvalUrl = `${approvalBaseUrl.replace(/\/$/, "")}/approval/voice/${token}`;
    await database.execute("UPDATE voice_outbox SET status = 'sending', updated_at = $1 WHERE id = $2", [now(), outboxId]);
    try {
      const sent = await sendEmail(args.caller.buyerEmail, `Approve event plan: ${ev.name}`, await summaryHtml(ev, approvalUrl), outboxId);
      await database.execute(
        "UPDATE voice_outbox SET status = $1, attempts = attempts + 1, provider_id = $2, updated_at = $3 WHERE id = $4",
        [config.voiceMockMode ? "mocked" : "sent", sent.providerId, now(), outboxId],
      );
    } catch (e) {
      const code = (e as { code?: string }).code ?? "email_failed";
      const status = code === "email_delivery_unknown" ? "unknown" : "failed";
      const retryAfter = (e as { retryAfterSeconds?: number }).retryAfterSeconds;
      const retryAt = retryAfter ? new Date(Date.now() + retryAfter * 1000).toISOString() : null;
      await database.execute(
        "UPDATE voice_outbox SET status = $1, attempts = attempts + 1, error_code = $2, retry_after_at = $3, updated_at = $4 WHERE id = $5",
        [status, code, retryAt, now(), outboxId],
      );
    }
    const state = (await getVoiceState(args.caller.customerId, ev.id))!;
    const result = { eventId: ev.id, status: state.delivery === "sent" ? "awaiting_approval" : state.delivery === "mocked" ? "mock_preview" : `email_${state.delivery}`, message: state.delivery === "sent" ? "Proposal saved. The buyer has been emailed to approve it; no order has been placed." : state.delivery === "mocked" ? "Mock mode only: no email was sent and no order was placed. The local preview is ready." : "Proposal saved, but approval email was not confirmed. No order has been placed; the buyer must retry delivery from the dashboard.", ...(config.voiceMockMode ? { mockApprovalUrl: approvalUrl } : {}) };
    await database.execute(
      "UPDATE voice_calls SET status = 'done', result_json = $1 WHERE call_id = $2 AND tool_call_id = $3",
      [JSON.stringify(result), args.callId, args.toolCallId],
    );
    await appendAudit(randomUUID(), args.caller.customerId, "voice_event_proposed", { eventId: ev.id, callId: args.callId, toolCallId: args.toolCallId, emailStatus: state.delivery });
    return result;
  } catch (error) {
    if (eventId) {
      try {
        await database.execute("DELETE FROM voice_outbox WHERE id = $1", [outboxId]);
        await database.execute("DELETE FROM voice_approvals WHERE event_id = $1", [eventId]);
        await deleteEvent(args.caller.customerId, eventId);
      } catch { /* preserve the original safe failure */ }
    }
    await database.execute("UPDATE voice_calls SET status = 'failed' WHERE call_id = $1 AND tool_call_id = $2", [args.callId, args.toolCallId]);
    throw error;
  }
}

export async function getVoiceState(customerId: string, eventId: string): Promise<VoiceState | null> {
  const row = await db().queryOne<{
    event_id: string;
    status: string;
    attempts: number;
    updated_at: string;
    error_code: string | null;
    mock_approval_url: string | null;
    retry_after_at: string | null;
    approval: string;
    token_hash: string;
    expires_at: string;
  }>(
    `SELECT o.event_id, o.status, o.attempts, o.updated_at, o.error_code, o.mock_approval_url, o.retry_after_at, a.status AS approval, a.token_hash, a.expires_at
     FROM voice_outbox o JOIN voice_approvals a ON a.event_id = o.event_id WHERE o.customer_id = $1 AND o.event_id = $2 ORDER BY o.updated_at DESC LIMIT 1`,
    [customerId, eventId],
  );
  if (!row) return null;
  // Live bearer tokens are never stored in mock_approval_url; only explicit mock/simulated proposals set it.
  let approval = row.approval;
  try {
    if (approval === "approved") return { eventId: row.event_id, delivery: row.status, approval, attempts: row.attempts, updatedAt: row.updated_at, errorCode: row.error_code ?? undefined, retryAfterAt: row.retry_after_at ?? undefined, ...(row.mock_approval_url ? { approvalUrl: row.mock_approval_url } : {}) };
    const ev = await getEventRecord(customerId, eventId);
    const tokenRow = await db().queryOne<{ event_version: number; snapshot_hash: string; expires_at: string }>(
      "SELECT event_version, snapshot_hash, expires_at FROM voice_approvals WHERE event_id = $1",
      [eventId],
    );
    if (!tokenRow || ev.version !== tokenRow.event_version || eventSnapshot(ev) !== tokenRow.snapshot_hash || new Date(tokenRow.expires_at).getTime() <= Date.now() || ev.status === "cancelled") approval = "stale";
  } catch { approval = "stale"; }
  const delivery = row.status === "sending" && Date.now() - new Date(row.updated_at).getTime() > 60_000 ? "unknown" : row.status;
  return { eventId: row.event_id, delivery, approval, attempts: row.attempts, updatedAt: row.updated_at, errorCode: row.error_code ?? undefined, retryAfterAt: row.retry_after_at ?? undefined, ...(row.mock_approval_url ? { approvalUrl: row.mock_approval_url } : {}) };
}

export async function retryVoiceEmail(customerId: string, eventId: string) {
  const d = db();
  const row = await d.queryOne<{ id: string; recipient: string; status: string; attempts: number; retry_after_at: string | null; approval: string; expires_at: string }>(
    `SELECT o.id, o.recipient, o.status, o.attempts, o.retry_after_at, a.status AS approval, a.expires_at
     FROM voice_outbox o JOIN voice_approvals a ON a.event_id = o.event_id WHERE o.customer_id = $1 AND o.event_id = $2 ORDER BY o.updated_at DESC LIMIT 1`,
    [customerId, eventId],
  );
  if (!row) throw Object.assign(new Error("voice_delivery_not_found"), { code: "not_found" });
  if (row.status === "unknown") throw Object.assign(new Error("email_delivery_unknown_reconcile_before_retry"), { code: "delivery_unknown" });
  if (row.retry_after_at && new Date(row.retry_after_at).getTime() > Date.now()) throw Object.assign(new Error("email_retry_after_provider_cooldown"), { code: "retry_after", retryAfterSeconds: Math.ceil((new Date(row.retry_after_at).getTime() - Date.now()) / 1000) });
  if (row.status === "sent" || row.status === "mocked") throw Object.assign(new Error("email_already_sent"), { code: "already_sent" });
  if (row.attempts >= 3) throw Object.assign(new Error("email_retry_limit"), { code: "retry_limit" });
  const raw = await getEventRecord(customerId, eventId);
  if (raw.status === "cancelled" || new Date(row.expires_at).getTime() < Date.now()) throw Object.assign(new Error("approval_expired"), { code: "approval_expired" });
  const token = randomBytes(32).toString("base64url");
  const expiry = new Date(Date.now() + 7 * 86400_000).toISOString();
  const baseUrl = (config.voiceApprovalBaseUrl || (config.voiceMockMode ? `http://localhost:${config.port}` : "")).replace(/\/$/, "");
  const link = `${baseUrl}/approval/voice/${token}`;
  const mockLink = config.voiceMockMode ? link : null;
  const claimedOk = await d.withTransaction(async (tx) => {
    const claimed = await tx.execute(
      "UPDATE voice_outbox SET status = 'sending', retry_after_at = NULL, mock_approval_url = COALESCE($1, mock_approval_url), updated_at = $2 WHERE id = $3 AND status = 'failed'",
      [mockLink, now(), row.id],
    );
    if (!claimed.rowCount) return false;
    await tx.execute(
      "UPDATE voice_approvals SET token_hash = $1, event_version = $2, snapshot_hash = $3, expires_at = $4, status = 'pending', updated_at = $5 WHERE event_id = $6",
      [sha(token), raw.version, eventSnapshot(raw), expiry, now(), eventId],
    );
    return true;
  });
  if (!claimedOk) throw Object.assign(new Error("delivery_not_retryable"), { code: "delivery_not_retryable" });
  try {
    const sent = await sendEmail(row.recipient, `Approve event plan: ${raw.name}`, await summaryHtml(view(raw), link), `${row.id}-retry-${row.attempts + 1}`);
    await d.execute(
      "UPDATE voice_outbox SET status = $1, attempts = attempts + 1, error_code = NULL, provider_id = $2, updated_at = $3 WHERE id = $4",
      [config.voiceMockMode ? "mocked" : "sent", sent.providerId, now(), row.id],
    );
  } catch (e) {
    const code = (e as { code?: string }).code ?? "email_failed";
    const retryAfter = (e as { retryAfterSeconds?: number }).retryAfterSeconds;
    const retryAt = retryAfter ? new Date(Date.now() + retryAfter * 1000).toISOString() : null;
    await d.execute(
      "UPDATE voice_outbox SET status = $1, attempts = attempts + 1, error_code = $2, retry_after_at = $3, updated_at = $4 WHERE id = $5",
      [code === "email_delivery_unknown" ? "unknown" : "failed", code, retryAt, now(), row.id],
    );
    throw Object.assign(new Error(code), { code });
  }
  await appendAudit(randomUUID(), customerId, "voice_email_retried", { eventId, attempts: row.attempts + 1 });
  return getVoiceState(customerId, eventId);
}

function publicError(code: string, status: number, detail = code) { return { type: "about:blank", title: code.replace(/_/g, " "), status, code, detail, requestId: randomUUID() }; }

export async function approvalPreview(token: string) {
  const d = db();
  const row = await d.queryOne<{ customer_id: string; event_id: string; event_version: number; snapshot_hash: string; expires_at: string; consumed_at: string | null; status: string }>(
    "SELECT customer_id, event_id, event_version, snapshot_hash, token_hash, expires_at, consumed_at, status FROM voice_approvals WHERE token_hash = $1",
    [sha(token)],
  );
  if (!row || row.consumed_at || row.status !== "pending" || new Date(row.expires_at).getTime() <= Date.now()) return null;
  let ev;
  try { ev = await getEventRecord(row.customer_id, row.event_id); } catch { return null; }
  if (ev.version !== row.event_version || eventSnapshot(ev) !== row.snapshot_hash || ev.status === "cancelled") return null;
  return { event: ev, customerId: row.customer_id };
}

export async function approveVoicePlan(token: string): Promise<boolean> {
  const d = db();
  const tokenHash = sha(token);
  const outcome = await d.withTransaction(async (tx) => {
    const row = await tx.queryOne<{ customer_id: string; event_id: string; event_version: number; snapshot_hash: string; expires_at: string; consumed_at: string | null; status: string }>(
      "SELECT customer_id, event_id, event_version, snapshot_hash, expires_at, consumed_at, status FROM voice_approvals WHERE token_hash = $1",
      [tokenHash],
    );
    if (!row || row.consumed_at || row.status !== "pending" || new Date(row.expires_at).getTime() <= Date.now()) return { ok: false as const };
    const eventRow = await tx.queryOne<{ json: string }>(
      "SELECT json FROM events WHERE id = $1 AND customer_id = $2",
      [row.event_id, row.customer_id],
    );
    if (!eventRow) return { ok: false as const };
    const ev = JSON.parse(eventRow.json) as EventRecord;
    ev.version ??= 1;
    if (ev.status === "cancelled" || ev.version !== row.event_version || eventSnapshot(ev) !== row.snapshot_hash) return { ok: false as const };
    const result = await tx.execute(
      "UPDATE voice_approvals SET status = 'approved', consumed_at = $1, updated_at = $2 WHERE event_id = $3 AND status = 'pending' AND token_hash = $4 AND consumed_at IS NULL",
      [now(), now(), row.event_id, tokenHash],
    );
    if (!result.rowCount) return { ok: false as const };
    ev.autoOrder = true;
    ev.version += 1;
    await tx.execute("UPDATE events SET json = $1 WHERE id = $2 AND customer_id = $3", [
      JSON.stringify(ev),
      row.event_id,
      row.customer_id,
    ]);
    return { ok: true as const, eventId: ev.id, customerId: row.customer_id };
  });
  if (!outcome.ok) return false;
  await appendAudit(randomUUID(), outcome.customerId, "voice_event_approved", { eventId: outcome.eventId });
  return true;
}

export async function isSimulatedVoiceToken(token: string): Promise<boolean> {
  if (!token) return false;
  const row = await db().queryOne<{ status: string }>(
    `SELECT o.status FROM voice_approvals a
     JOIN voice_outbox o ON o.event_id = a.event_id
     WHERE a.token_hash = $1
     ORDER BY o.updated_at DESC LIMIT 1`,
    [sha(token)],
  );
  return row?.status === "mocked";
}

export async function simulateVoiceCall(
  customerId: string,
  opts?: {
    preset?: string;
    name?: string;
    date?: string;
    guests?: number;
    recipeIds?: string[];
    spokenText?: string;
    utterance?: string;
    text?: string;
  },
) {
  const database = db();
  const saved = await getSavedRecipes(customerId);
  if (!saved.length) {
    throw new Error("no_saved_recipes");
  }
  const rawPreset = String(opts?.preset ?? "wedding").toLowerCase();
  const preset: "gala" | "sports" | "wedding" =
    rawPreset === "gala" ? "gala" : rawPreset === "sports" ? "sports" : "wedding";

  let defaultName = "Saturday Wedding Brunch";
  let defaultDate = addDays(todayIso(), 12);
  let defaultGuests = 120;
  let defaultRecipes = saved.slice(0, 2);
  let defaultSpeech =
    "Hi! I'm in the walk-in cooler — we just booked a 120-guest Saturday Wedding Brunch. Can you check our pantry and line up the missing Valio ingredients?";

  if (preset === "gala") {
    defaultName = "Nordic Tech Gala Banquet";
    defaultDate = addDays(todayIso(), 10);
    defaultGuests = 320;
    defaultRecipes = saved.slice(0, 3);
    defaultSpeech =
      "Hey assistant, hands are full on the prep line — put together a banquet plan for next week's 320-guest Nordic Tech Gala Banquet.";
  } else if (preset === "sports") {
    defaultName = "City Sports Day Lunch";
    defaultDate = addDays(todayIso(), 9);
    defaultGuests = 220;
    defaultRecipes = saved.slice(0, 1);
    defaultSpeech =
      "Calling from the kitchen — we have 220 guests for City Sports Day Lunch next week. Please check stock and prepare the lactose-free ingredient plan.";
  }

  const name = opts?.name?.trim() || defaultName;
  const date =
    opts?.date && /^\d{4}-\d{2}-\d{2}$/.test(opts.date) && opts.date >= todayIso()
      ? opts.date
      : defaultDate;
  const guests =
    typeof opts?.guests === "number" && Number.isFinite(opts.guests) && opts.guests >= 1
      ? Math.round(opts.guests)
      : defaultGuests;

  const savedIds = new Set(saved.map((r) => r.id));
  const requestedIds = Array.isArray(opts?.recipeIds)
    ? opts!.recipeIds.map(String).filter((id) => savedIds.has(id))
    : [];
  const chosenRecipeIds = requestedIds.length ? requestedIds : defaultRecipes.map((r) => r.id);
  const recipes = chosenRecipeIds.map((recipeId) => ({ recipeId, servings: guests }));
  const recipeNames = chosenRecipeIds.map(
    (id) => saved.find((r) => r.id === id)?.name ?? id,
  );

  const callId = `call-sim-${randomUUID().slice(0, 8)}`;
  const token = randomBytes(32).toString("base64url");
  const tokenHash = sha(token);
  const expiresAt = new Date(Date.now() + 7 * 86400_000).toISOString();
  const outboxId = `mail-${randomUUID()}`;
  const approvalUrl = `/approval/voice/${token}`;
  const buyerEmail =
    config.voiceCallerMap["*"]?.buyerEmail ?? "chef.matti@hotel-kitchen.local";

  const ev = await createEvent(
    customerId,
    { name, date, guests, recipes, autoOrder: false },
    async (created) => {
      await database.execute(
        `INSERT INTO voice_approvals (event_id, customer_id, buyer_email, event_version, snapshot_hash, token_hash, expires_at, status, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'pending', $8)`,
        [
          created.id,
          customerId,
          buyerEmail,
          created.version,
          eventSnapshot(created),
          tokenHash,
          expiresAt,
          now(),
        ],
      );
      await database.execute(
        `INSERT INTO voice_outbox (id, event_id, customer_id, recipient, status, attempts, provider_id, mock_approval_url, updated_at)
         VALUES ($1, $2, $3, $4, 'mocked', 1, $5, $6, $7)`,
        [
          outboxId,
          created.id,
          customerId,
          buyerEmail,
          `sim-${outboxId}`,
          approvalUrl,
          now(),
        ],
      );
    },
  );

  const persisted = await getEventRecord(customerId, ev.id);
  await database.execute(
    `UPDATE voice_approvals SET event_version = $1, snapshot_hash = $2, updated_at = $3 WHERE event_id = $4`,
    [persisted.version, eventSnapshot(persisted), now(), ev.id],
  );

  await appendAudit(randomUUID(), customerId, "voice_event_proposed", {
    eventId: ev.id,
    callId,
    simulated: true,
    emailStatus: "mocked",
  });

  const spoken = (opts?.spokenText ?? opts?.utterance ?? opts?.text ?? "").trim() || defaultSpeech;
  const shortfallCount = (ev.plan?.lines ?? []).filter((l) => l.shortfall > 0).length;
  const estTotal = ev.plan?.estTotal ?? 0;

  const transcript = [
    {
      speaker: "Chef Matti",
      role: "caller",
      text: spoken,
    },
    {
      speaker: "Valio Voice Assistant · Tool",
      role: "assistant",
      text: `list_saved_recipes() → matched ${recipeNames.join(", ")} and compared against current pantry inventory.`,
    },
    {
      speaker: "Valio Voice Assistant",
      role: "assistant",
      text: `Got it, Chef Matti! For ${guests} guests at ${name} (${date}), I subtracted on-hand stock and priced ${shortfallCount} missing Valio item${shortfallCount === 1 ? "" : "s"} (~€${estTotal.toFixed(2)}). Shall I save this non-ordering proposal and send your approval link?`,
    },
    {
      speaker: "Chef Matti",
      role: "caller",
      text: "Yes, confirmed — save the proposal and send the one-tap approval link to my phone so I can review after prep.",
    },
    {
      speaker: "Valio Voice Assistant · Tool",
      role: "assistant",
      text: `create_event_proposal(confirmed=true, autoOrder=false) → saved ${ev.id} awaiting buyer sign-off (€0.00 committed).`,
    },
    {
      speaker: "Valio Voice Assistant",
      role: "assistant",
      text: "Proposal saved! Zero money was spent on this call. Your single-use mobile approval link is ready whenever you want to schedule purchasing.",
    },
  ];

  const voiceState = await getVoiceState(customerId, ev.id);
  const assistantNumber = config.voicePublicNumber || "+1 269 665 8009";

  return {
    callId,
    preset,
    assistantNumber,
    phoneNumber: assistantNumber,
    callerLabel: "+358 40 123 4567 · Chef Matti (Walk-in Cooler)",
    transcript,
    eventId: ev.id,
    event: { ...ev, voice: voiceState },
    voice: voiceState,
    approvalUrl,
  };
}

export async function approveVoiceEventByBuyer(customerId: string, eventId: string) {
  const d = db();
  const current = await getEventRecord(customerId, eventId);
  if (current.status === "cancelled") {
    throw Object.assign(new Error("event_cancelled"), { code: "event_cancelled" });
  }
  const updatedRecord = await d.withTransaction(async (tx) => {
    const eventRow = await tx.queryOne<{ json: string }>(
      "SELECT json FROM events WHERE id = $1 AND customer_id = $2",
      [eventId, customerId],
    );
    if (!eventRow) throw new Error("event not found");
    const ev = JSON.parse(eventRow.json) as EventRecord;
    ev.autoOrder = true;
    ev.version = (ev.version ?? 1) + 1;
    await tx.execute("UPDATE events SET json = $1 WHERE id = $2 AND customer_id = $3", [
      JSON.stringify(ev),
      eventId,
      customerId,
    ]);
    const ts = now();
    await tx.execute(
      `UPDATE voice_approvals
       SET status = 'approved', consumed_at = COALESCE(consumed_at, $1), event_version = $2, snapshot_hash = $3, updated_at = $4
       WHERE event_id = $5 AND customer_id = $6`,
      [ts, ev.version, eventSnapshot(ev), ts, eventId, customerId],
    );
    return ev;
  });
  await appendAudit(randomUUID(), customerId, "voice_event_approved", {
    eventId,
    approvedBy: "buyer",
  });
  const updatedView = view(updatedRecord);
  return {
    ok: true,
    event: { ...updatedView, voice: await getVoiceState(customerId, eventId) },
  };
}

export { publicError };
