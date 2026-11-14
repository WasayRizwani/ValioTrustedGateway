/**
 * Operator-facing views: system status, an end-to-end agent self-test, an activity feed in plain
 * language, and the "what needs you" overview that powers the desk home page.
 */
import { randomUUID } from "node:crypto";
import type { Need } from "@tta/shared";
import { config } from "../config.js";
import { getDb, appendAudit, verifyAuditChain } from "../audit/chain.js";
import { getMandate } from "../auth/customers.js";
import { loadCatalog, searchProducts } from "../catalog/index.js";
import { buildOffers } from "../catalog/offers.js";
import { parseNeedFromText } from "../need/parse.js";
import { evaluatePolicy, offerToBasketLine } from "../policy/engine.js";
import { verifyClaim } from "../claims/sign.js";
import { listOrders, listPending } from "../orders/store.js";
import { recommendRestock, getKitchen } from "../hotel/kitchen.js";
import { getRestockAutomationPolicy, getLastRestockRun } from "../hotel/restock-automation.js";
import { getLlmStatus, pingLlm } from "../agent/chat.js";
import { pingValio } from "../valio/client.js";
import { AGENTS, type AgentId } from "../agents/registry.js";

const clip = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s);

export type Check = {
  id: string;
  label: string;
  ok: boolean;
  ms?: number;
  detail: string;
};

function nextMonday(): string {
  const d = new Date();
  d.setDate(d.getDate() + ((8 - d.getDay()) % 7 || 7));
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

async function timed<T>(fn: () => Promise<T>): Promise<{ v?: T; ms: number; err?: string }> {
  const t0 = Date.now();
  try {
    return { v: await fn(), ms: Date.now() - t0 };
  } catch (e) {
    return { ms: Date.now() - t0, err: e instanceof Error ? e.message : String(e) };
  }
}

let valioLastOk = 0;
/** One shared Valio health check (retries, and tolerates a blip right after a success) so the banner and self-test agree. */
async function checkValio(): Promise<{ ok: boolean; ms: number; err?: string; note?: string }> {
  const t0 = Date.now();
  let err: string | undefined;
  for (let i = 0; i < 3; i++) {
    const r = await timed(() => pingValio());
    if (r.v?.ok) {
      valioLastOk = Date.now();
      return { ok: true, ms: r.ms };
    }
    err = r.err ?? "Ping failed";
    await new Promise((res) => setTimeout(res, 250));
  }
  if (Date.now() - valioLastOk < 2 * 60_000) return { ok: true, ms: Date.now() - t0, note: "one ping failed; reachable moments ago" };
  return { ok: false, ms: Date.now() - t0, err };
}

/** Fast, side-effect-free health snapshot. */
export async function getSystemStatus(): Promise<{ checks: Check[]; allOk: boolean }> {
  const checks: Check[] = [];
  checks.push({ id: "gateway", label: "Agent Gateway", ok: true, detail: "Serving REST + MCP + OpenAPI" });

  const valio = await checkValio();
  checks.push({
    id: "valio",
    label: "Valio Aimo mock backend",
    ok: valio.ok,
    ms: valio.ms,
    detail: valio.ok ? (valio.note ?? "Price & availability API reachable") : (valio.err ?? "Ping failed"),
  });

  loadCatalog();
  const cat = searchProducts({ q: "milk", limit: 1 });
  checks.push({
    id: "catalog",
    label: "Product catalog",
    ok: cat.length > 0,
    detail: cat.length ? "Catalog loaded and searchable" : "Catalog empty — run npm run download-data",
  });

  const llm = getLlmStatus();
  checks.push({
    id: "llm",
    label: "LLM agent",
    ok: llm.configured,
    detail: llm.configured
      ? `${llm.provider} · ${llm.model} (run self-test to verify it answers)`
      : "No key — heuristic tool agent only",
  });

  checks.push({
    id: "claims",
    label: "Claim signing",
    ok: true,
    detail: `Ed25519 key ${config.claimKeyId}`,
  });
  return { checks, allOk: checks.every((c) => c.ok) };
}

/** Runs the real purchase path end to end WITHOUT creating an order intent. */
export async function runSelfTest(customerId: string): Promise<{
  ok: boolean;
  steps: Check[];
  ms: number;
  runId: string;
}> {
  const t0 = Date.now();
  const runId = randomUUID();
  const steps: Check[] = [];
  const push = (c: Check) => steps.push(c);
  const mandate = getMandate(customerId);

  const valio = await checkValio();
  push({ id: "valio", label: "Valio backend reachable", ok: valio.ok, ms: valio.ms, detail: valio.ok ? (valio.note ?? "ping ok") : (valio.err ?? "failed") });

  const parsedRaw = parseNeedFromText("I need 20 litres of lactose-free milk", nextMonday());
  if ("clarificationRequired" in parsedRaw && !("quantity" in parsedRaw)) {
    push({ id: "parse", label: "Agent understands a request", ok: false, detail: String(parsedRaw.clarificationRequired) });
    return { ok: false, steps, ms: Date.now() - t0, runId };
  }
  const parsed = parsedRaw as Need;
  push({
    id: "parse",
    label: "Agent understands a request",
    ok: true,
    detail: `"20 litres lactose-free milk" → ${parsed.quantity} ${parsed.unit} · ${parsed.productIntent}${parsed.constraints.lactoseFree ? " · lactose-free" : ""}`,
  });

  const offersRes = await timed(() => buildOffers(customerId, parsed, { includeSubstitutions: true }));
  const offers = offersRes.v ?? [];
  const top = offers.find((o) => o.canFulfil) ?? offers[0];
  push({
    id: "offers",
    label: "Live prices & availability for a shortlist",
    ok: Boolean(top),
    ms: offersRes.ms,
    detail: top
      ? `${offers.length} offers ranked · best: ${clip(top.productName, 50)} · €${top.totalPrice.toFixed(2)} · ${top.canFulfil ? "in stock" : "partial"}`
      : (offersRes.err ?? "No offers returned"),
  });

  if (top) {
    const sig = top.priceClaim ? verifyClaim(top.priceClaim) : null;
    push({
      id: "claim",
      label: "Price claim is signed and verifiable",
      ok: Boolean((sig as { valid?: boolean } | null)?.valid),
      detail: sig ? `Signature ${top.priceClaim!.signature.slice(0, 16)}… verified against the public key` : "No claim attached",
    });

    if (mandate) {
      const verdict = evaluatePolicy(mandate, parsed, [offerToBasketLine(top)], {
        isSubstitution: top.isSubstitution,
        partialFulfil: !top.canFulfil,
      });
      push({
        id: "policy",
        label: "Mandate decides: auto vs human",
        ok: true,
        detail: `Decision: ${verdict.decision}${verdict.failingRules.length ? ` (${verdict.failingRules.join(", ")})` : " — within mandate"}`,
      });
      const big = evaluatePolicy(mandate, { ...parsed, quantity: 1000 }, [{ ...offerToBasketLine(top), totalPrice: top.totalPrice * 50 }]);
      push({
        id: "guardrail",
        label: "Guardrail blocks over-limit orders",
        ok: big.decision !== "auto_commit",
        detail: big.decision !== "auto_commit" ? `€${(top.totalPrice * 50).toFixed(0)} basket → ${big.decision} (${big.failingRules.join(", ")})` : "Over-limit order would auto-commit!",
      });
    }
  }

  appendAudit(runId, customerId, "selftest_run", { steps: steps.length });
  const chain = verifyAuditChain(runId, customerId);
  push({ id: "audit", label: "Tamper-evident audit chain", ok: chain.valid, detail: chain.valid ? `Hash chain verified · head ${chain.headHash?.slice(0, 12)}…` : `Broken at event ${chain.brokenAt}` });

  const llm = await pingLlm();
  push({ id: "llm", label: "LLM answers", ok: llm.ok, ms: llm.ms, detail: llm.detail });

  return { ok: steps.every((s) => s.ok), steps, ms: Date.now() - t0, runId };
}

// ───────────────────────── activity feed ─────────────────────────

type Activity = {
  agent?: AgentId;
  id: number;
  at: string;
  runId: string;
  actor: "agent" | "human" | "system" | "valio";
  kind: "info" | "good" | "warn" | "bad";
  text: string;
};

function describe(type: string, p: Record<string, any>): Pick<Activity, "actor" | "kind" | "text"> | null {
  switch (type) {
    case "need_validated":
      return { actor: "agent", kind: "info", text: `Agent started a request: ${p.quantity} ${p.unit} ${p.productIntent} by ${p.neededBy}` };
    case "need_parsed":
      return { actor: "agent", kind: "info", text: `Understood "${clip(String(p.text), 70)}"` };
    case "offers_built":
      return { actor: "agent", kind: "info", text: `Compared ${p.count} Valio offers (live price & stock)` };
    case "intent_created":
      return {
        actor: "agent",
        kind: "info",
        text: `Chose ${p.productName ? clip(String(p.productName), 56) : "an offer"} · €${Number(p.totalPrice).toFixed(2)}${
          Array.isArray(p.why) && p.why.length ? ` — ${p.why[0]}` : ""
        }`,
      };
    case "intent_superseded":
      return { actor: "system", kind: "info", text: "An older unapproved proposal for the same need was replaced" };
    case "intent_deduplicated":
      return { actor: "system", kind: "info", text: "Identical open order found — reused instead of duplicating" };
    case "policy_evaluated":
      return p.decision === "auto_commit"
        ? { actor: "system", kind: "good", text: "Mandate check passed — agent may buy autonomously" }
        : { actor: "system", kind: "warn", text: `Mandate check: needs a human (${(p.failingRules ?? []).join(", ").replace(/_/g, " ") || "policy"})` };
    case "human_approved":
      return { actor: "human", kind: "good", text: `Human approved${p.mandateOverride ? " with mandate override" : ""}` };
    case "human_rejected":
      return { actor: "human", kind: "bad", text: `Human rejected the order${p.reason ? `: ${p.reason}` : ""}` };
    case "revalidating":
      return { actor: "system", kind: "info", text: "Re-checking price & availability before committing" };
    case "committed":
      return { actor: "agent", kind: "good", text: `Order ${p.orderId} placed · €${Number(p.totalPrice).toFixed(2)}` };
    case "stale_offer":
      return { actor: "system", kind: "bad", text: `Order stopped: ${String(p.reason).replace(/_/g, " ")} changed since quote` };
    case "intent_expired":
      return { actor: "system", kind: "warn", text: "An unapproved order expired (1 h window)" };
    case "menu_plan_completed":
      return { actor: "agent", kind: "info", text: `Menu plan: ${p.summary}` };
    case "delivery_received":
      return { actor: "human", kind: "good", text: `Delivery ${p.orderId} received — stock updated` };
    case "kitchen_imported":
      return { actor: "human", kind: "info", text: `Kitchen data imported (${p.inventory} ingredients, ${p.recipes} recipes)` };
    case "kitchen_recipe_saved":
      return { actor: "human", kind: "info", text: "Recipe saved" };
    case "kitchen_inventory_updated":
      return { actor: "human", kind: "info", text: "Inventory updated" };
    case "standing_order_triggered":
      return { actor: "system", kind: "info", text: `Recurring order for ${p.ingredient} is due — ordering for delivery ${p.deliveryDate}` };
    case "standing_order_created":
      return { actor: "human", kind: "good", text: "Recurring order set up" };
    case "forbidden_action":
      return { actor: "system", kind: "bad", text: `Blocked: ${p.role} tried to ${p.action}` };
    case "event_created":
      return { actor: "human", kind: "info", text: `Event added: ${p.name} on ${p.date} for ${p.guests} guests` };
    case "event_planned":
      return {
        actor: "agent",
        kind: p.readiness === "at_risk" ? "warn" : "info",
        text:
          p.readiness === "at_risk"
            ? `Event "${p.name}" is at risk: ${(p.risk ?? []).slice(0, 2).join("; ") || "Valio may not deliver in time"}`
            : p.readiness === "covered"
              ? `Event "${p.name}": everything is already in stock or on order`
              : `Planned event "${p.name}" (${p.date}) — estimated extra purchase €${Number(p.estTotal ?? 0).toFixed(2)}`,
      };
    case "event_orders_placed":
      return {
        actor: "agent",
        kind: p.waiting ? "warn" : "good",
        text: `Event "${p.name}": ${p.committed} order(s) placed${p.waiting ? `, ${p.waiting} waiting for your approval` : ""}${p.trigger === "schedule" ? " (automatically, order date reached)" : ""}`,
      };
    case "event_cancelled":
      return { actor: "human", kind: "info", text: `Event "${p.name}" cancelled` };
    case "agent_handoff":
      return { actor: "agent", kind: "info", text: `Hand-off ${AGENTS[p.from as AgentId]?.short ?? p.from} → ${p.to}: ${p.reason}` };
    case "valio_agent_started":
      return { actor: "agent", kind: "info", text: `Checking ${p.watching} product(s) you usually buy against live stock and prices for ${p.upcoming}` };
    case "valio_agent_finished":
      return { actor: "agent", kind: p.created ? "warn" : "good", text: p.created ? `Found ${p.created} thing(s) worth telling you about` : "All good — nothing to flag" };
    case "suggestion_created":
      return { actor: "agent", kind: "warn", text: `Suggests: ${p.title}${p.suggested ? ` → ${clip(String(p.suggested), 50)}` : ""}` };
    case "suggestion_accepted":
      return { actor: "human", kind: p.status === "pending_approval" ? "warn" : "good", text: `Accepted Valio's suggestion "${clip(String(p.title), 56)}"${p.status === "pending_approval" ? " — substitution needs your approval" : ""}` };
    case "suggestion_dismissed":
      return { actor: "human", kind: "info", text: `Dismissed Valio's suggestion "${clip(String(p.title), 56)}"` };
    case "rate_limited":
      return { actor: "system", kind: "warn", text: `Rate limit hit: ${p.action} (retry in ${p.retryAfterSec}s)` };
    case "demo_reset":
      return { actor: "system", kind: "warn", text: "Demo data reset" };
    case "agent_chat_turn":
      return { actor: "agent", kind: "info", text: `Chat: "${clip(String(p.messagePreview ?? ""), 90)}" — used ${(p.tools ?? []).length} tool(s)` };
    case "quote_issued":
      return { actor: "agent", kind: "info", text: `Firm quote ${p.quoteId} issued · €${Number(p.totalPrice ?? 0).toFixed(2)} (valid until ${String(p.validUntil ?? "").slice(11, 16) || p.validUntil})` };
    case "quote_accepted":
      return { actor: "agent", kind: "info", text: `Accepted quote ${p.quoteId} into order intent ${p.intentId}` };
    case "quote_price_honoured":
      return { actor: "system", kind: "good", text: `Honoured firm quote ${p.quoteId} price (€${Number(p.quotedUnitPrice ?? 0).toFixed(2)} vs live €${Number(p.liveUnitPrice ?? 0).toFixed(2)})` };
    case "quote_expired":
      return { actor: "system", kind: "warn", text: `Quote ${p.quoteId} expired` };
    case "quote_withdrawn":
      return { actor: "human", kind: "info", text: `Quote ${p.quoteId} withdrawn` };
    case "exception_followup_drafted":
      return { actor: "agent", kind: "warn", text: `Drafted exception follow-up: ${p.problem ?? p.subject ?? "issue"}` };
    case "selftest_run":
      return { actor: "system", kind: "info", text: "Self-test executed" };
    default:
      return null;
  }
}

export type LastReset = { id: number; at: string; removedIntents: number; source: string | null };

/** Most recent demo reset for this customer (null if none). Orders/feed older than this were wiped or are historical. */
export function getLastReset(customerId: string): LastReset | null {
  const r = getDb()
    .prepare(`SELECT id, payload, created_at FROM audit_events WHERE customer_id = ? AND type = 'demo_reset' ORDER BY id DESC LIMIT 1`)
    .get(customerId) as { id: number; payload: string; created_at: string } | undefined;
  if (!r) return null;
  const p = JSON.parse(r.payload) as Record<string, unknown>;
  return { id: r.id, at: r.created_at, removedIntents: Number(p.removedIntents ?? 0), source: typeof p.source === "string" ? p.source : null };
}

export function getActivity(customerId: string, limit = 30, runId?: string): Activity[] {
  const rows = (runId
    ? getDb()
        .prepare(`SELECT id, run_id, type, payload, created_at FROM audit_events WHERE customer_id = ? AND run_id = ? ORDER BY id ASC`)
        .all(customerId, runId)
    : getDb()
        // The live feed only shows what happened since the last demo reset, so it never lists orders that no longer exist.
        // The append-only audit trail (per run) keeps everything.
        .prepare(`SELECT id, run_id, type, payload, created_at FROM audit_events WHERE customer_id = ? AND id >= ? ORDER BY id DESC LIMIT ?`)
        .all(customerId, getLastReset(customerId)?.id ?? 0, limit * 3)) as Array<{ id: number; run_id: string; type: string; payload: string; created_at: string }>;
  const out: Activity[] = [];
  const nowMs = Date.now();
  for (const r of rows) {
    if (!runId && r.type === "rate_limited") {
      const ageMs = nowMs - Date.parse(r.created_at);
      if (Number.isFinite(ageMs) && ageMs > 60_000) continue;
    }
    const d = describe(r.type, JSON.parse(r.payload));
    if (!d) continue;
    const pl2 = JSON.parse(r.payload) as Record<string, unknown>;
    const agent = typeof pl2.agent === "string" && pl2.agent in AGENTS ? (pl2.agent as AgentId) : undefined;
    out.push({ id: r.id, at: r.created_at, runId: r.run_id, ...d, agent, actor: agent ? (agent === "valio-account" ? "valio" : "agent") : d.actor });
    if (out.length >= limit) break;
  }
  return out;
}

// ───────────────────────── overview ─────────────────────────

export function getOverview(customerId: string) {
  const mandate = getMandate(customerId);
  const orders = listOrders(customerId);
  const pending = listPending(customerId);
  const committed = orders.filter((o) => o.status === "committed");
  const autoCommitted = committed.filter((o) => o.policy.decision === "auto_commit");
  const humanApproved = committed.length - autoCommitted.length;
  const today = new Date().toISOString().slice(0, 10);
  const spendToday = committed.filter((o) => o.updatedAt.slice(0, 10) === today).reduce((s, o) => s + o.totalPrice, 0);

  const restock = recommendRestock(customerId);
  const kitchen = getKitchen(customerId);
  const inbound = (kitchen?.orderHistory ?? []).filter((o) => o.status === "committed");

  const attention: Array<{ kind: "approval" | "stock" | "drift" | "inbound"; severity: "high" | "med" | "low"; title: string; detail: string; view: string }> = [];
  for (const i of pending.slice(0, 5)) {
    attention.push({
      kind: "approval",
      severity: "high",
      title: `Approve ${i.need.quantity} ${i.need.unit} ${i.need.productIntent} — €${i.totalPrice.toFixed(2)}`,
      detail: i.policy.reasons.join("; ") || "Needs human sign-off",
      view: "approval",
    });
  }
  for (const r of restock?.recommendations ?? []) {
    if (r.urgency === "critical")
      attention.push({ kind: "stock", severity: "high", title: `${r.name} is critically low`, detail: `${r.onHand}${r.unit} on hand${r.onOrder ? ` (+${r.onOrder} on order)` : ""} vs need ${r.targetQty}${r.unit} (par ${r.parLevel}). Suggested order ${r.suggestedOrderQty}${r.unit}.`, view: "kitchen" });
    if (r.standingOrderDrift)
      attention.push({ kind: "drift", severity: "med", title: `Standing-order drift: ${r.name}`, detail: `Suggested ${r.suggestedOrderQty}${r.unit} vs recent average ${r.standingOrderAvgQty}${r.unit} — the scheduled auto-restock skips this item; ordering it by hand still works.`, view: "kitchen" });
  }
  for (const o of inbound.slice(0, 3))
    attention.push({ kind: "inbound", severity: "low", title: `Delivery ${o.orderId} is on its way`, detail: `${o.lines.map((l) => `${l.quantity}${l.unit} ${clip(l.productName, 30)}`).join(", ")} — mark received when it arrives.`, view: "kitchen" });

  const SHORT: Record<string, string> = {
    over_spend: `Over your €${mandate?.maxOrderValueEur ?? "?"} limit`,
    over_quantity: "Quantity above limit",
    late_delivery: "Arrives late",
    substitution: "Substitute product",
    partial_fulfil: "Partial supply",
    allergen_restrictions: "Allergen / lactose rule",
    unknown_reliability: "No delivery history",
    mandate_expired: "Mandate expired",
    category_not_allowed: "Category not allowed",
    brand_not_allowed: "Brand not allowed",
    over_unit_price: "Unit price above cap",
    over_daily_spend: "Over daily spend limit",
    over_weekly_spend: "Over weekly spend limit",
    over_monthly_spend: "Over monthly spend limit",
    over_order_velocity: "Too many orders today",
    order_splitting_suspected: "Order splitting check",
    price_change_on_revalidate: "Price changed on recheck",
  };
  const approvals = pending.map((i) => ({
    id: i.id,
    title: `${i.need.quantity} ${i.need.unit} ${i.need.productIntent}`,
    product: i.basket[0]?.productName ?? "",
    total: i.totalPrice,
    chips: (i.policy.failingRules.length ? i.policy.failingRules : ["policy"]).map((r) => SHORT[r] ?? "Needs sign-off"),
    createdAt: i.createdAt,
    neededBy: i.neededBy,
  }));
  const today2 = new Date().toISOString().slice(0, 10);
  const deliveries = inbound.map((o) => {
    const intent = orders.find((x) => x.committedOrderId === o.orderId);
    return {
      orderId: o.orderId,
      summary: o.lines.map((l) => `${l.quantity}${l.unit} ${clip(l.productName, 38)}`).join(", "),
      items: o.lines.map((l) => ({ productName: l.productName, quantity: l.quantity, unit: l.unit })),
      neededBy: intent?.neededBy ?? null,
      overdue: Boolean(intent && intent.neededBy < today2),
      total: intent?.totalPrice ?? null,
    };
  });
  const drift = (restock?.recommendations ?? [])
    .filter((r) => r.standingOrderDrift)
    .map((r) => ({
      name: r.name,
      suggested: r.suggestedOrderQty,
      usual: r.standingOrderAvgQty ?? null,
      unit: r.unit,
      pct: r.standingOrderAvgQty ? Math.round(((r.suggestedOrderQty - r.standingOrderAvgQty) / r.standingOrderAvgQty) * 100) : null,
    }));

  return {
    lastReset: getLastReset(customerId),
    approvals,
    deliveries,
    drift,
    customerId,
    hotelName: kitchen?.hotelName ?? customerId,
    mandate: mandate && {
      maxOrderValueEur: mandate.maxOrderValueEur,
      allowedSubstitutions: mandate.allowedSubstitutions,
      expiresAt: mandate.expiresAt,
      requireApprovalFor: mandate.requireApprovalFor,
    },
    stats: {
      pending: pending.length,
      committed: committed.length,
      autoCommitted: autoCommitted.length,
      humanApproved,
      spendToday: Math.round(spendToday * 100) / 100,
      onOrderEur: Math.round(committed.reduce((s, o) => s + o.totalPrice, 0) * 100) / 100,
    },
    attention: attention.sort((a, b) => ({ high: 0, med: 1, low: 2 })[a.severity] - ({ high: 0, med: 1, low: 2 })[b.severity]),
    stock: (restock?.recommendations ?? []).map((r) => ({
      name: r.name,
      onHand: r.onHand,
      onOrder: r.onOrder ?? 0,
      par: r.parLevel,
      target: r.targetQty,
      unit: r.unit,
      urgency: r.urgency,
      suggested: r.suggestedOrderQty,
      drift: Boolean(r.standingOrderDrift),
    })),
    automation: { policy: getRestockAutomationPolicy(customerId), lastRun: getLastRestockRun(customerId) },
  };
}

// ───────────────────────── audit run picker ─────────────────────────

export type AuditRun = {
  runId: string;
  startedAt: string;
  endedAt: string;
  title: string;
  outcome: string;
  tone: "good" | "warn" | "bad" | "info";
  events: number;
  /** True when the run's orders were wiped by a later demo reset (the audit entries are kept). */
  clearedByReset?: boolean;
};

/** One row per agent run so a human can pick "what happened with the milk order" instead of pasting a run id. */
export function getAuditRuns(customerId: string, limit = 40): AuditRun[] {
  const rows = getDb()
    .prepare(
      `SELECT run_id, type, payload, created_at, id FROM audit_events WHERE customer_id = ? ORDER BY id DESC LIMIT 1500`,
    )
    .all(customerId) as Array<{ run_id: string; type: string; payload: string; created_at: string; id: number }>;
  const byRun = new Map<string, typeof rows>();
  for (const r of rows) {
    if (!byRun.has(r.run_id)) byRun.set(r.run_id, []);
    byRun.get(r.run_id)!.unshift(r);
  }
  const reset = getLastReset(customerId);
  // Event runs are separate from the ordering run, so look up each event's latest ordering result by id.
  const eventOrders = new Map<string, { committed: number; waiting: number }>();
  const placedRows = getDb()
    .prepare(`SELECT payload FROM audit_events WHERE customer_id = ? AND type = 'event_orders_placed' ORDER BY id ASC`)
    .all(customerId) as Array<{ payload: string }>;
  for (const r of placedRows) {
    const d = JSON.parse(r.payload) as Record<string, any>;
    const prev = eventOrders.get(String(d.eventId)) ?? { committed: 0, waiting: 0 };
    eventOrders.set(String(d.eventId), { committed: prev.committed + Number(d.committed ?? 0), waiting: Number(d.waiting ?? 0) });
  }
  const out: AuditRun[] = [];
  const HOUSEKEEPING = new Set([
    "demo_reset", "kitchen_inventory_updated", "kitchen_recipe_saved", "kitchen_imported",
    "standing_order_created", "standing_order_updated", "standing_order_deleted", "delivery_received",
    "event_cancelled", "rate_limited",
  ]);
  for (const [runId, evs] of byRun) {
    const types = new Set(evs.map((e) => e.type));
    if ([...types].every((t) => HOUSEKEEPING.has(t))) continue; // setup/admin noise isn't an "agent run"
    const pl = (t: string) => {
      const e = evs.find((x) => x.type === t);
      return e ? (JSON.parse(e.payload) as Record<string, any>) : null;
    };
    const need = pl("need_validated");
    const committed = pl("committed");
    const inten = pl("intent_created");
    let title = need ? (need.ingredientQuantity != null && need.ingredientUnit && need.ingredientUnit !== need.unit ? `${need.ingredientQuantity} ${need.ingredientUnit === "each" ? "pcs" : need.ingredientUnit} ${need.productIntent}` : `${need.quantity} ${need.unit} ${need.productIntent}`) : (describe(evs[0].type, JSON.parse(evs[0].payload))?.text ?? evs[0].type);
    if (types.has("standing_order_triggered")) title = `Recurring: ${pl("standing_order_triggered")?.ingredient ?? title}`;
    if (types.has("menu_plan_started")) title = "Menu plan";
    if (types.has("event_created")) title = `Event: ${pl("event_created")?.name}`;
    else if (types.has("event_planned") && !need) title = `Event plan: ${pl("event_planned")?.name}`;
    if (types.has("selftest_run")) title = "System self-test";
    if (types.has("agent_chat_turn") && !need) {
      const m = pl("agent_chat_turn");
      title = `Chat: ${clip(String(m?.messagePreview ?? "agent conversation"), 60)}`;
    }
    if (types.has("forbidden_action")) title = `Blocked attempt: ${pl("forbidden_action")?.action}`;
    let outcome = "In progress";
    let tone: AuditRun["tone"] = "info";
    const allCommitted = evs.filter((x) => x.type === "committed").map((x) => JSON.parse(x.payload) as Record<string, any>);
    const evRef = pl("event_created") ?? pl("event_planned");
    const placed = pl("event_orders_placed") ?? (evRef?.eventId ? ((o) => (o ? { committed: o.committed, waiting: o.waiting } : null))(eventOrders.get(String(evRef.eventId))) : null);
    const planDone = pl("menu_plan_completed");
    const waiting = Number(placed?.waiting ?? 0);
    if (allCommitted.length) {
      const sum = allCommitted.reduce((t, c) => t + Number(c.totalPrice ?? 0), 0);
      const count = allCommitted.length > 1 ? `${allCommitted.length} orders placed` : "Ordered";
      const pendingNote = waiting ? ` · ${waiting} awaiting approval` : "";
      outcome = `${count} · €${sum.toFixed(2)}${pendingNote}`;
      tone = waiting ? "warn" : "good";
    } else if (placed) {
      outcome = waiting ? `${placed.committed ?? 0} placed · ${waiting} awaiting approval` : `${placed.committed ?? 0} orders placed`;
      tone = waiting ? "warn" : "good";
    } else if (types.has("event_cancelled")) {
      outcome = "Cancelled";
    } else if (types.has("event_planned") && !types.has("policy_evaluated")) {
      outcome = pl("event_planned")?.readiness === "at_risk" ? "Planned — at risk" : "Planned — not ordered yet";
      tone = pl("event_planned")?.readiness === "at_risk" ? "warn" : "info";
    } else if (types.has("human_rejected")) {
      outcome = "Rejected by buyer";
      tone = "bad";
    } else if (types.has("stale_offer")) {
      outcome = "Stopped — price or stock changed";
      tone = "bad";
    } else if (types.has("forbidden_action")) {
      outcome = "Refused";
      tone = "bad";
    } else if (types.has("intent_superseded") && !committed) {
      outcome = "Replaced";
    } else if (types.has("human_approved")) {
      outcome = "Approved — not placed yet";
      tone = "warn";
    } else if (types.has("policy_evaluated")) {
      const v = pl("policy_evaluated");
      outcome = v?.decision === "auto_commit" ? "Cleared — ready to order" : "Waiting for approval";
      tone = v?.decision === "auto_commit" ? "good" : "warn";
    } else if ([...types].every((t) => t === "agent_handoff")) {
      outcome = "Handed over — orders appear as their own runs";
    } else if (planDone) {
      outcome = "Plan ready — nothing ordered yet";
    } else if (types.has("selftest_run") || types.has("agent_chat_turn") || types.has("event_created")) {
      outcome = "Completed";
    }
    void inten;
    out.push({ runId, startedAt: evs[0].created_at, endedAt: evs[evs.length - 1].created_at, title, outcome, tone, events: evs.length, clearedByReset: reset && types.has("intent_created") && evs[evs.length - 1].id < reset.id ? true : undefined });
  }
  return out.sort((a, b) => b.endedAt.localeCompare(a.endedAt)).slice(0, limit);
}

// ───────────────────────── agent roster ─────────────────────────

export function getAgentRoster(customerId: string) {
  const since = new Date(Date.now() - 24 * 3600_000).toISOString();
  return Object.values(AGENTS).map((a) => {
    const rows = getDb()
      .prepare(`SELECT type, payload, created_at, run_id FROM audit_events WHERE customer_id = ? AND payload LIKE ? ORDER BY id DESC LIMIT 200`)
      .all(customerId, `%"agent":"${a.id}"%`) as Array<{ type: string; payload: string; created_at: string; run_id: string }>;
    let last: { text: string; at: string; runId: string } | null = null;
    let refusal: { text: string; at: string; runId: string } | null = null;
    for (const r of rows) {
      const d = describe(r.type, JSON.parse(r.payload));
      if (!d) continue;
      const item = { text: d.text, at: r.created_at, runId: r.run_id };
      if (r.type === "forbidden_action") refusal = refusal ?? item;
      else {
        last = item;
        break;
      }
    }
    last = last ?? refusal;
    return {
      id: a.id,
      name: a.name,
      short: a.short,
      side: a.side,
      job: a.job,
      capabilities: a.capabilities,
      cannot: a.cannot,
      actions24h: rows.filter((r) => r.created_at >= since).length,
      last,
    };
  });
}
