/**
 * Events & peak demand. A banquet, a wedding or a school party needs far more than the kitchen's usual week.
 * The buyer registers the event once; the Planner agent works out the EXTRA demand on top of normal usage,
 * checks Valio can deliver it in time, and orders at the right moment — Sourcing and Procurement do the rest,
 * under the same mandate as everything else.
 */
import { randomUUID } from "node:crypto";
import type { Mandate } from "@tta/shared";
import { getDb, appendAudit } from "../audit/chain.js";
import { getMandate } from "../auth/customers.js";
import { withAgent } from "../agents/context.js";
import { commitOrder } from "../orders/store.js";
import { getKitchen } from "./kitchen.js";
import { planSourcing, type PlanRequest, type PlanResult } from "./planner.js";
import { getVoiceState } from "./voice.js";

export type EventInput = {
  name: string;
  date: string; // YYYY-MM-DD — the day of the event
  guests: number;
  recipes: Array<{ recipeId: string; servings?: number }>;
  extras?: Array<{ ingredientId: string; qty: number }>;
  bufferPct?: number; // safety margin on recipe quantities (waste, no-show swings)
  autoOrder?: boolean;
  leadDays?: number; // days Valio needs between ordering and delivery
  prepDays?: number; // ingredients must be on site this many days before the event
  notes?: string;
};

export type EventRecord = Required<Omit<EventInput, "notes">> & {
  id: string;
  version: number;
  customerId: string;
  notes: string;
  status: "planned" | "ordered" | "done" | "cancelled";
  createdAt: string;
  plan: (PlanResult & { estTotal: number; canMeetDate: boolean; at: string }) | null;
  orders: Array<{ ingredient: string; intentId: string; status: string; total: number }> | null;
};

export type Readiness = "unplanned" | "covered" | "ready_to_order" | "at_risk" | "ordered" | "past";

export type EventView = EventRecord & {
  deliverBy: string;
  orderBy: string;
  daysAway: number;
  daysToOrderBy: number;
  orderDue: boolean;
  readiness: Readiness;
  headline: string;
};

// ───────────────────────── pure helpers (unit-tested) ─────────────────────────

const iso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const noon = (s: string) => new Date(`${s}T12:00:00`);
export const addDays = (s: string, n: number) => {
  const d = noon(s);
  d.setDate(d.getDate() + n);
  return iso(d);
};
export const daysBetween = (from: string, to: string) => Math.round((noon(to).getTime() - noon(from).getTime()) / 86_400_000);
export const todayIso = () => iso(new Date());

/** Batches of a recipe needed to serve `servings` people, with a safety buffer. */
export function batchesFor(servings: number, bufferPct: number, servingsPerBatch: number): number {
  if (servings <= 0) return 0;
  return Math.max(1, Math.ceil((servings * (1 + bufferPct / 100)) / Math.max(1, servingsPerBatch)));
}

/** Work backwards: ingredients must be on site `prepDays` before the event; Valio needs `leadDays` to deliver. */
export function schedule(date: string, prepDays: number, leadDays: number) {
  const deliverBy = addDays(date, -prepDays);
  return { deliverBy, orderBy: addDays(deliverBy, -leadDays) };
}

export function buildRequest(ev: Pick<EventRecord, "date" | "name" | "guests" | "recipes" | "extras" | "bufferPct" | "prepDays">, recipeIndex: Map<string, { servingsPerBatch: number; name: string }>): PlanRequest {
  return {
    neededBy: addDays(ev.date, -ev.prepDays),
    baselineUntil: ev.date,
    extrasLabel: `${ev.name} (extras)`,
    recipes: ev.recipes.map((r) => {
      const rec = recipeIndex.get(r.recipeId);
      if (!rec) throw new Error(`unknown recipe ${r.recipeId}`);
      return { recipeId: r.recipeId, batches: batchesFor(r.servings ?? ev.guests, ev.bufferPct, rec.servingsPerBatch) };
    }),
    extras: ev.extras,
  };
}

export function readinessOf(ev: EventRecord, today = todayIso()): Readiness {
  if (ev.date < today) return "past";
  if (ev.status === "ordered") return "ordered";
  if (!ev.plan) return "unplanned";
  const needs = ev.plan.lines.filter((l) => l.shortfall > 0);
  if (!needs.length) return "covered";
  return ev.plan.lines.some((l) => l.status === "unsourceable" || l.status === "partial") || !ev.plan.canMeetDate ? "at_risk" : "ready_to_order";
}

// ───────────────────────── storage ─────────────────────────

let ready = false;
function db() {
  const d = getDb();
  if (!ready) {
    d.exec(`CREATE TABLE IF NOT EXISTS events (
      id TEXT PRIMARY KEY, customer_id TEXT NOT NULL, status TEXT NOT NULL, date TEXT NOT NULL, json TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS event_order_claims (
      event_id TEXT PRIMARY KEY, lease_until TEXT NOT NULL
    );`);
    ready = true;
  }
  return d;
}
function save(ev: EventRecord, preserveAutoOrder = false, onStored?: (ev: EventRecord) => void) {
  const database = db();
  const tx = database.transaction(() => {
    const current = database.prepare("SELECT json FROM events WHERE id=? AND customer_id=?").get(ev.id, ev.customerId) as { json: string } | undefined;
    if (current) {
      const previous = JSON.parse(current.json) as EventRecord;
      ev.version = (previous.version ?? 1) + 1;
      if (preserveAutoOrder) ev.autoOrder = previous.autoOrder;
    } else ev.version ??= 1;
    database.prepare(`INSERT INTO events (id, customer_id, status, date, json) VALUES (?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET status=excluded.status, date=excluded.date, json=excluded.json`)
      .run(ev.id, ev.customerId, ev.status, ev.date, JSON.stringify(ev));
    onStored?.(ev);
  });
  tx();
}
function load(customerId: string, id: string): EventRecord {
  const row = db().prepare(`SELECT json FROM events WHERE id = ? AND customer_id = ?`).get(id, customerId) as { json: string } | undefined;
  if (!row) throw new Error("event not found");
  const record = JSON.parse(row.json) as EventRecord;
  record.version ??= 1;
  return record;
}
/** Read a persisted event for public approval rendering after token validation. */
export function getEventRecord(customerId: string, id: string): EventRecord {
  return load(customerId, id);
}
export function resetEvents(customerId: string) {
  db().prepare(`DELETE FROM events WHERE customer_id = ?`).run(customerId);
}
export function deleteEvent(customerId: string, id: string) {
  db().prepare(`DELETE FROM events WHERE id = ? AND customer_id = ?`).run(id, customerId);
}

function claimScheduledOrder(eventId: string): boolean {
  const d = db();
  const until = new Date(Date.now() + 5 * 60_000).toISOString();
  const result = d.prepare(`INSERT INTO event_order_claims(event_id,lease_until) VALUES(?,?)
    ON CONFLICT(event_id) DO UPDATE SET lease_until=excluded.lease_until WHERE event_order_claims.lease_until < ?`)
    .run(eventId, until, new Date().toISOString());
  return result.changes === 1;
}
function releaseScheduledOrder(eventId: string) { db().prepare("DELETE FROM event_order_claims WHERE event_id=?").run(eventId); }

export function view(ev: EventRecord): EventView {
  const today = todayIso();
  const { deliverBy, orderBy } = schedule(ev.date, ev.prepDays, ev.leadDays);
  const readiness = readinessOf(ev, today);
  const daysAway = daysBetween(today, ev.date);
  const daysToOrderBy = daysBetween(today, orderBy);
  const need = ev.plan?.lines.filter((l) => l.shortfall > 0).length ?? 0;
  const headline =
    readiness === "covered" ? "Everything for this event is already in stock or on order."
    : readiness === "ordered" ? `Ordered${ev.orders?.some((o) => o.status === "pending_approval") ? " — some orders wait for your approval" : ""}.`
    : readiness === "at_risk" ? "Valio may not be able to deliver everything in time — act early."
    : readiness === "ready_to_order" ? `${need} item${need === 1 ? "" : "s"} to order${daysToOrderBy > 0 ? `; the agents will order in ${daysToOrderBy} day${daysToOrderBy === 1 ? "" : "s"}` : "; ordering is due now"}.`
    : readiness === "past" ? "This event has passed."
    : "Not checked yet.";
  return { ...ev, deliverBy, orderBy, daysAway, daysToOrderBy, orderDue: readiness === "ready_to_order" || readiness === "at_risk" ? daysToOrderBy <= 0 : false, readiness, headline };
}

export function listEvents(customerId: string, includeCancelled = false): EventView[] {
  const rows = db().prepare(`SELECT json FROM events WHERE customer_id = ? ORDER BY date ASC`).all(customerId) as Array<{ json: string }>;
  const cutoff = addDays(todayIso(), -7);
  return rows
    .map((r) => JSON.parse(r.json) as EventRecord)
    .filter((e) => (includeCancelled || e.status !== "cancelled") && e.date >= cutoff)
    .map(view);
}

// ───────────────────────── planning & ordering ─────────────────────────

function validate(customerId: string, input: EventInput) {
  const k = getKitchen(customerId);
  if (!k) throw new Error("no_kitchen_profile");
  if (!input.name?.trim()) throw new Error("event needs a name");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.date)) throw new Error("date must be YYYY-MM-DD");
  if (!(input.guests > 0)) throw new Error("guests must be > 0");
  if (!input.recipes?.length && !input.extras?.length) throw new Error("add at least one recipe or extra item");
  for (const r of input.recipes ?? []) if (!k.recipes.some((x) => x.recipeId === r.recipeId)) throw new Error(`unknown recipe ${r.recipeId}`);
  for (const x of input.extras ?? []) if (!k.inventory.some((i) => i.ingredientId === x.ingredientId)) throw new Error(`unknown ingredient ${x.ingredientId}`);
  return k;
}

function normalize(customerId: string, input: EventInput, existing?: EventRecord): EventRecord {
  validate(customerId, input);
  return {
    id: existing?.id ?? `EVT-${randomUUID().slice(0, 6).toUpperCase()}`,
    version: existing ? (existing.version ?? 1) + 1 : 1,
    customerId,
    name: input.name.trim(),
    date: input.date,
    guests: Math.round(input.guests),
    recipes: (input.recipes ?? []).map((r) => ({ recipeId: r.recipeId, servings: r.servings ?? input.guests })),
    extras: (input.extras ?? []).filter((x) => x.qty > 0),
    bufferPct: input.bufferPct ?? existing?.bufferPct ?? 10,
    autoOrder: input.autoOrder ?? existing?.autoOrder ?? true,
    leadDays: input.leadDays ?? existing?.leadDays ?? 2,
    prepDays: input.prepDays ?? existing?.prepDays ?? 1,
    notes: input.notes ?? existing?.notes ?? "",
    status: existing?.status === "ordered" ? "ordered" : "planned",
    createdAt: existing?.createdAt ?? new Date().toISOString(),
    plan: null,
    orders: existing?.orders ?? null,
  };
}

async function runPlan(ev: EventRecord, mandate: Mandate, createIntents: boolean): Promise<PlanResult> {
  const k = getKitchen(ev.customerId)!;
  const idx = new Map(k.recipes.map((r) => [r.recipeId, { servingsPerBatch: r.servingsPerBatch, name: r.name }]));
  const req = buildRequest(ev, idx);
  return planSourcing(ev.customerId, mandate, { ...req, createIntents, runId: randomUUID() });
}

function summarise(plan: PlanResult): NonNullable<EventRecord["plan"]> {
  const estTotal = plan.lines.reduce((s, l) => s + (l.shortfall > 0 ? (l.chosen?.totalPrice ?? 0) : 0), 0);
  const canMeetDate = !plan.lines.some((l) => l.shortfall > 0 && (l.status === "unsourceable" || l.status === "partial"));
  return { ...plan, estTotal: Math.round(estTotal * 100) / 100, canMeetDate, at: new Date().toISOString() };
}

/** (Re)compute the plan — read-only against Valio, nothing is ordered. */
export async function replanEvent(customerId: string, id: string): Promise<EventView> {
  return withAgent("planner", async () => {
    const mandate = getMandate(customerId);
    if (!mandate) throw new Error("no_mandate");
    const ev = load(customerId, id);
    const before = readinessOf(ev);
    ev.plan = summarise(await runPlan(ev, mandate, false));
    save(ev, true);
    const after = readinessOf(ev);
    appendAudit(randomUUID(), customerId, "event_planned", {
      eventId: ev.id,
      name: ev.name,
      date: ev.date,
      readiness: after,
      estTotal: ev.plan.estTotal,
      risk: after === "at_risk" ? ev.plan.flags : undefined,
      changed: before !== after,
    });
    return view(ev);
  });
}

export async function createEvent(customerId: string, input: EventInput, onStored?: (ev: EventRecord) => void): Promise<EventView> {
  const ev = normalize(customerId, input);
  save(ev, true, onStored);
  appendAudit(randomUUID(), customerId, "event_created", { eventId: ev.id, name: ev.name, date: ev.date, guests: ev.guests });
  return replanEvent(customerId, ev.id);
}

export async function updateEvent(customerId: string, id: string, input: EventInput): Promise<EventView> {
  const ev = normalize(customerId, input, load(customerId, id));
  save(ev);
  return replanEvent(customerId, ev.id);
}

export function cancelEvent(customerId: string, id: string) {
  const ev = load(customerId, id);
  ev.status = "cancelled";
  save(ev, true);
  appendAudit(randomUUID(), customerId, "event_cancelled", { eventId: ev.id, name: ev.name });
  return { cancelled: true };
}

/**
 * Place the orders for an event: the Planner works out what's missing, Sourcing picks offers, Procurement
 * creates the orders — auto-placed if inside the mandate, otherwise waiting in Needs approval.
 */
export async function orderEvent(customerId: string, id: string, trigger: "manual" | "schedule" = "manual"): Promise<EventView> {
  const mandate = getMandate(customerId);
  if (!mandate) throw new Error("no_mandate");
  const ev = load(customerId, id);
  if (ev.status === "cancelled") throw new Error("event is cancelled");
  if (ev.status === "ordered") return view(ev);
  const plan = await withAgent("planner", () => runPlan(ev, mandate, true));
  const placed: NonNullable<EventRecord["orders"]> = [];
  await withAgent("procurement", async () => {
    for (const l of plan.lines) {
      if (!l.intent) continue;
      let status = l.intent.status;
      if (status === "auto_eligible") {
        const done = await commitOrder({ intentId: l.intent.id, customerId, idempotencyKey: `event-${ev.id}-${l.intent.id}` });
        status = done.status;
      }
      placed.push({ ingredient: l.name, intentId: l.intent.id, status, total: l.chosen?.totalPrice ?? 0 });
    }
  });
  ev.plan = summarise(plan);
  ev.orders = [...(ev.orders ?? []).filter((o) => !placed.some((p) => p.intentId === o.intentId)), ...placed];
  ev.status = placed.length || ev.plan.lines.every((l) => l.shortfall <= 0) ? "ordered" : ev.status;
  save(ev, true);
  appendAudit(randomUUID(), customerId, "event_orders_placed", {
    eventId: ev.id,
    name: ev.name,
    trigger,
    committed: placed.filter((p) => p.status === "committed").length,
    waiting: placed.filter((p) => p.status === "pending_approval").length,
    agent: "procurement",
  });
  return view(ev);
}

// ───────────────────────── scheduler ─────────────────────────

/** Orders events whose order-by date has come; refreshes stale plans so risks surface early. */
export async function tickEvents(customerId: string): Promise<string[]> {
  const log: string[] = [];
  for (const e of listEvents(customerId)) {
    if (e.status !== "planned" || e.readiness === "past") continue;
    try {
      const stale = !e.plan || Date.now() - new Date(e.plan.at).getTime() > 6 * 3600_000;
      if (e.autoOrder && e.daysToOrderBy <= 0 && e.readiness !== "covered") {
        if (!claimScheduledOrder(e.id)) continue;
        try {
          await orderEvent(customerId, e.id, "schedule");
          log.push(`ordered ${e.name}`);
        } finally { releaseScheduledOrder(e.id); }
      } else if (stale && e.daysAway <= 21) {
        const voiceApproval = getVoiceState(customerId, e.id)?.approval;
        if (voiceApproval === "pending" || voiceApproval === "pending_buyer_approval") continue;
        await replanEvent(customerId, e.id);
        log.push(`re-checked ${e.name}`);
      }
    } catch (err) {
      log.push(`${e.name}: ${err instanceof Error ? err.message : err}`);
    }
  }
  return log;
}

export function startEventScheduler(customerIds: string[]): void {
  const run = async () => {
    for (const id of customerIds) {
      const log = await tickEvents(id).catch(() => []);
      if (log.length) console.log(`[events] ${id}: ${log.join("; ")}`);
    }
  };
  setTimeout(() => void run(), 15_000);
  setInterval(() => void run(), 30 * 60_000);
}
