/**
 * Recurring ("standing") orders. The buyer picks an ingredient, a quantity and a delivery weekday;
 * the gateway places the order automatically `leadTimeDays` before each delivery so it arrives on
 * schedule. Every automatic order still goes through the mandate: over-limit or substituted orders
 * land in Approval instead of being bought silently.
 */
import { randomUUID } from "node:crypto";
import type { Mandate, Need } from "@tta/shared";
import { getDb, appendAudit } from "../audit/chain.js";
import { getMandate } from "../auth/customers.js";
import { withAgent } from "../agents/context.js";
import { createOrderIntent, commitOrder } from "../orders/store.js";
import { getKitchen, ingredientToNeed } from "./kitchen.js";
import { mustBeLactoseFree } from "./planner.js";

export type StandingOrder = {
  id: string;
  customerId: string;
  ingredientId: string;
  ingredientName: string;
  quantity: number;
  unit: string;
  /** Delivery weekday, 0 = Sunday … 6 = Saturday. */
  weekday: number;
  /** Days between placing the order and delivery. */
  leadTimeDays: number;
  enabled: boolean;
  createdAt: string;
  nextDelivery: string;
  nextOrderOn: string;
  lastRun: StandingRun | null;
};

export type StandingRun = {
  deliveryDate: string;
  placedAt: string;
  status: string;
  intentId: string | null;
  detail: string;
};

let ready = false;
function db() {
  const d = getDb();
  if (!ready) {
    d.exec(`
      CREATE TABLE IF NOT EXISTS standing_orders (
        id TEXT PRIMARY KEY, customer_id TEXT NOT NULL, ingredient_id TEXT NOT NULL,
        quantity REAL NOT NULL, weekday INTEGER NOT NULL, lead_time_days INTEGER NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS standing_runs (
        standing_id TEXT NOT NULL, delivery_date TEXT NOT NULL, placed_at TEXT NOT NULL,
        status TEXT NOT NULL, intent_id TEXT, detail TEXT NOT NULL,
        PRIMARY KEY (standing_id, delivery_date)
      );
    `);
    ready = true;
  }
  return d;
}

const iso = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const addDays = (d: Date, n: number) => {
  const x = new Date(d);
  x.setDate(x.getDate() + n);
  return x;
};
const parseDay = (s: string) => new Date(`${s}T12:00:00`);
const today = () => parseDay(iso(new Date()));

/** Next delivery dates for a weekday, strictly after today. */
export function upcomingDeliveries(weekday: number, count = 2): string[] {
  const out: string[] = [];
  let d = addDays(today(), 1);
  while (out.length < count) {
    if (d.getDay() === weekday) out.push(iso(d));
    d = addDays(d, 1);
  }
  return out;
}

function lastRunFor(id: string): StandingRun | null {
  const r = db()
    .prepare(`SELECT * FROM standing_runs WHERE standing_id = ? ORDER BY delivery_date DESC LIMIT 1`)
    .get(id) as Record<string, string> | undefined;
  return r
    ? { deliveryDate: r.delivery_date, placedAt: r.placed_at, status: r.status, intentId: r.intent_id, detail: r.detail }
    : null;
}

function hydrate(row: Record<string, unknown>): StandingOrder | null {
  const k = getKitchen(String(row.customer_id));
  const ing = k?.inventory.find((i) => i.ingredientId === row.ingredient_id);
  if (!ing) return null;
  const weekday = Number(row.weekday);
  const lead = Number(row.lead_time_days);
  const id = String(row.id);
  // Next delivery that hasn't been ordered yet (or the next upcoming one).
  const done = new Set(
    (db().prepare(`SELECT delivery_date FROM standing_runs WHERE standing_id = ?`).all(id) as Array<{ delivery_date: string }>).map(
      (r) => r.delivery_date,
    ),
  );
  const nextDelivery = upcomingDeliveries(weekday, 4).find((d) => !done.has(d)) ?? upcomingDeliveries(weekday, 1)[0];
  return {
    id,
    customerId: String(row.customer_id),
    ingredientId: ing.ingredientId,
    ingredientName: ing.name,
    quantity: Number(row.quantity),
    unit: ing.unit,
    weekday,
    leadTimeDays: lead,
    enabled: Boolean(row.enabled),
    createdAt: String(row.created_at),
    nextDelivery,
    nextOrderOn: iso(addDays(parseDay(nextDelivery), -lead)),
    lastRun: lastRunFor(id),
  };
}

export function listStanding(customerId: string): StandingOrder[] {
  return (db().prepare(`SELECT * FROM standing_orders WHERE customer_id = ? ORDER BY created_at`).all(customerId) as Array<Record<string, unknown>>)
    .map(hydrate)
    .filter((x): x is StandingOrder => !!x);
}

function validate(customerId: string, b: Record<string, unknown>, existing?: StandingOrder) {
  const ingredientId = String(b.ingredientId ?? existing?.ingredientId ?? "");
  const k = getKitchen(customerId);
  if (!k?.inventory.some((i) => i.ingredientId === ingredientId)) throw new Error("unknown ingredient");
  const quantity = Number(b.quantity ?? existing?.quantity);
  if (!(quantity > 0)) throw new Error("quantity must be > 0");
  const weekday = Number(b.weekday ?? existing?.weekday);
  if (!Number.isInteger(weekday) || weekday < 0 || weekday > 6) throw new Error("weekday must be 0 (Sun) – 6 (Sat)");
  const lead = Number(b.leadTimeDays ?? existing?.leadTimeDays ?? 2);
  if (!Number.isInteger(lead) || lead < 0 || lead > 14) throw new Error("leadTimeDays must be 0–14");
  return { ingredientId, quantity, weekday, lead };
}

export function createStanding(customerId: string, b: Record<string, unknown>): StandingOrder {
  const v = validate(customerId, b);
  const dup = listStanding(customerId).find((s) => s.ingredientId === v.ingredientId && s.weekday === v.weekday);
  if (dup) throw new Error(`a recurring order for ${dup.ingredientName} on this weekday already exists`);
  const id = `STD-${randomUUID().slice(0, 6).toUpperCase()}`;
  db()
    .prepare(`INSERT INTO standing_orders (id, customer_id, ingredient_id, quantity, weekday, lead_time_days, enabled, created_at) VALUES (?,?,?,?,?,?,1,?)`)
    .run(id, customerId, v.ingredientId, v.quantity, v.weekday, v.lead, new Date().toISOString());
  appendAudit(randomUUID(), customerId, "standing_order_created", { id, ...v });
  return listStanding(customerId).find((s) => s.id === id)!;
}

export function updateStanding(customerId: string, id: string, b: Record<string, unknown>): StandingOrder {
  const cur = listStanding(customerId).find((s) => s.id === id);
  if (!cur) throw new Error("not_found");
  const v = validate(customerId, b, cur);
  const dup = listStanding(customerId).find((s) => s.id !== id && s.ingredientId === v.ingredientId && s.weekday === v.weekday);
  if (dup) throw new Error(`a recurring order for ${dup.ingredientName} on this weekday already exists`);
  const enabled = b.enabled === undefined ? cur.enabled : Boolean(b.enabled);
  db()
    .prepare(`UPDATE standing_orders SET ingredient_id=?, quantity=?, weekday=?, lead_time_days=?, enabled=? WHERE id=? AND customer_id=?`)
    .run(v.ingredientId, v.quantity, v.weekday, v.lead, enabled ? 1 : 0, id, customerId);
  appendAudit(randomUUID(), customerId, "standing_order_updated", { id, ...v, enabled });
  return listStanding(customerId).find((s) => s.id === id)!;
}

export function deleteStanding(customerId: string, id: string): boolean {
  const ok = db().prepare(`DELETE FROM standing_orders WHERE id = ? AND customer_id = ?`).run(id, customerId).changes > 0;
  if (ok) appendAudit(randomUUID(), customerId, "standing_order_deleted", { id });
  return ok;
}

// ───────────────────────── suggestions from history ─────────────────────────

export type Suggestion = {
  ingredientId: string;
  name: string;
  quantity: number;
  unit: string;
  weekday: number;
  leadTimeDays: number;
  orders: number;
  avgIntervalDays: number;
  reason: string;
};

const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
export const dayName = (n: number) => DAY_NAMES[n] ?? "?";

/** Find ingredients the kitchen already re-orders on a steady cadence. */
export function suggestFromHistory(customerId: string): Suggestion[] {
  const k = getKitchen(customerId);
  if (!k) return [];
  const taken = new Set(listStanding(customerId).map((s) => s.ingredientId));
  const out: Suggestion[] = [];
  for (const ing of k.inventory) {
    if (taken.has(ing.ingredientId)) continue;
    const pts = k.orderHistory
      .flatMap((o) => o.lines.filter((l) => l.ingredientId === ing.ingredientId).map((l) => ({ at: o.orderedAt, qty: l.quantity })))
      .sort((a, b) => a.at.localeCompare(b.at));
    // Same-day duplicates (e.g. test runs) shouldn't look like a cadence.
    const days = [...new Set(pts.map((p) => p.at))];
    if (days.length < 2) continue;
    const gaps = days.slice(1).map((d, i) => (parseDay(d).getTime() - parseDay(days[i]).getTime()) / 86_400_000);
    const avg = gaps.reduce((s, g) => s + g, 0) / gaps.length;
    if (avg < 5 || avg > 9.5) continue; // weekly-ish only
    const qtys = pts.map((p) => p.qty).sort((a, b) => a - b);
    const qty = qtys[Math.floor(qtys.length / 2)];
    const weekdays = days.map((d) => parseDay(d).getDay());
    const mode = [...new Set(weekdays)].sort((a, b) => weekdays.filter((w) => w === b).length - weekdays.filter((w) => w === a).length)[0];
    const lead = 2;
    const weekday = (mode + lead) % 7;
    out.push({
      ingredientId: ing.ingredientId,
      name: ing.name,
      quantity: qty,
      unit: ing.unit,
      weekday,
      leadTimeDays: lead,
      orders: days.length,
      avgIntervalDays: Math.round(avg * 10) / 10,
      reason: `Ordered ${days.length}× roughly every ${Math.round(avg)} days (typically ~${qty}${ing.unit}).`,
    });
  }
  return out;
}

// ───────────────────────── execution ─────────────────────────

export type RunResult = {
  standingId: string;
  ingredient: string;
  deliveryDate: string;
  outcome: "committed" | "pending_approval" | "blocked" | "skipped" | "failed";
  detail: string;
  intentId?: string;
  totalPrice?: number;
};

async function placeOne(s: StandingOrder, deliveryDate: string, mandate: Mandate): Promise<RunResult> {
  const base = { standingId: s.id, ingredient: s.ingredientName, deliveryDate };
  const claim = db()
    .prepare(`INSERT OR IGNORE INTO standing_runs (standing_id, delivery_date, placed_at, status, intent_id, detail) VALUES (?,?,?,?,NULL,?)`)
    .run(s.id, deliveryDate, new Date().toISOString(), "running", "placing order");
  if (claim.changes === 0) return { ...base, outcome: "skipped", detail: "Already ordered for this delivery" };

  const finish = (status: string, detail: string, intentId?: string) =>
    db()
      .prepare(`UPDATE standing_runs SET status=?, detail=?, intent_id=? WHERE standing_id=? AND delivery_date=?`)
      .run(status, detail, intentId ?? null, s.id, deliveryDate);

  try {
    const k = getKitchen(s.customerId)!;
    const item = k.inventory.find((i) => i.ingredientId === s.ingredientId)!;
    const need = ingredientToNeed(item, s.quantity, deliveryDate, mustBeLactoseFree(mandate, item)) as Need;
    const runId = randomUUID();
    withAgent("planner", () =>
      appendAudit(runId, s.customerId, "standing_order_triggered", {
        standingId: s.id,
        ingredient: s.ingredientName,
        deliveryDate,
        leadTimeDays: s.leadTimeDays,
      }),
    );
    const res = await createOrderIntent({ customerId: s.customerId, mandate, need, runId });
    const intent = res.intent;
    if (intent.status === "auto_eligible") {
      const done = await commitOrder({ intentId: intent.id, customerId: s.customerId, idempotencyKey: `standing-${s.id}-${deliveryDate}` });
      const detail = `Ordered automatically · ${done.committedOrderId} · €${done.totalPrice.toFixed(2)}`;
      finish("committed", detail, intent.id);
      return { ...base, outcome: "committed", detail, intentId: intent.id, totalPrice: done.totalPrice };
    }
    if (intent.status === "pending_approval") {
      const detail = `Needs your approval: ${intent.policy.reasons.join("; ") || "mandate"}`;
      finish("pending_approval", detail, intent.id);
      return { ...base, outcome: "pending_approval", detail, intentId: intent.id, totalPrice: intent.totalPrice };
    }
    finish("blocked", `Blocked: ${intent.policy.reasons.join("; ")}`, intent.id);
    return { ...base, outcome: "blocked", detail: intent.policy.reasons.join("; "), intentId: intent.id };
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e);
    // Release the claim so the next tick can retry a transient failure.
    db().prepare(`DELETE FROM standing_runs WHERE standing_id=? AND delivery_date=?`).run(s.id, deliveryDate);
    return { ...base, outcome: "failed", detail };
  }
}

/**
 * Place every standing order whose "order-by" date has arrived. `force` ignores the lead-time
 * window and orders the next delivery now (used by "Order next delivery now").
 */
export async function runDueStanding(
  customerId: string,
  options?: { standingId?: string; force?: boolean },
): Promise<RunResult[]> {
  const mandate = getMandate(customerId);
  if (!mandate) return [];
  const results: RunResult[] = [];
  const todayIso = iso(today());
  for (const s of listStanding(customerId)) {
    if (options?.standingId && s.id !== options.standingId) continue;
    if (!s.enabled && !options?.force) continue;
    for (const d of upcomingDeliveries(s.weekday, 2)) {
      const orderBy = iso(addDays(parseDay(d), -s.leadTimeDays));
      const due = options?.force ? d === s.nextDelivery : orderBy <= todayIso;
      if (!due) continue;
      results.push(await placeOne(s, d, mandate));
    }
  }
  return results;
}

export function startStandingScheduler(customerIds: string[]): void {
  const tick = async () => {
    for (const id of customerIds) {
      try {
        const r = await runDueStanding(id);
        const acted = r.filter((x) => x.outcome !== "skipped");
        if (acted.length) console.log(`[standing-orders] ${id}:`, acted.map((a) => `${a.ingredient}→${a.outcome}`).join(", "));
      } catch (e) {
        console.error("[standing-orders] failed", e);
      }
    }
  };
  setTimeout(() => void tick(), 5_000);
  setInterval(() => void tick(), 10 * 60_000);
}

export function resetStanding(customerId: string) {
  const ids = (db().prepare(`SELECT id FROM standing_orders WHERE customer_id = ?`).all(customerId) as Array<{ id: string }>).map((r) => r.id);
  for (const id of ids) db().prepare(`DELETE FROM standing_runs WHERE standing_id = ?`).run(id);
  db().prepare(`DELETE FROM standing_orders WHERE customer_id = ?`).run(customerId);
}
