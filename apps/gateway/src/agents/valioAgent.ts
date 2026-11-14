/**
 * Valio Aimo's account agent — the *seller's* side of the conversation.
 *
 * It watches the products this customer already buys from Valio (Valio's own order records), checks live
 * price and availability for the upcoming delivery, and proactively tells the buyer's agents:
 *   • stock-out alert — "your usual product may not arrive; here is a substitute Valio itself recommends"
 *   • better price   — "same need, deliverable, cheaper alternative"
 *
 * Privacy boundary: it never reads the buyer's inventory or recipes (its credential cannot — see registry),
 * and it can only SUGGEST. Acting on a suggestion is the buyer side's decision, through the same mandate.
 */
import { randomUUID } from "node:crypto";
import type { Mandate, Need } from "@tta/shared";
import { getDb, appendAudit } from "../audit/chain.js";
import { buildOffers } from "../catalog/offers.js";
import { listOrders, createOrderIntent } from "../orders/store.js";
import { withAgent } from "./context.js";

export type Suggestion = {
  id: string;
  customerId: string;
  kind: "stockout_alert" | "better_price";
  title: string;
  body: string;
  status: "new" | "accepted" | "dismissed";
  createdAt: string;
  originalProductId: string;
  suggestedProductId: string;
  suggestedProductName: string;
  deltaEur: number;
  source: "valio_catalog" | "price_comparison";
  need: Need;
  intentId?: string;
};

let ready = false;
function db() {
  const d = getDb();
  if (!ready) {
    d.exec(`
      CREATE TABLE IF NOT EXISTS valio_suggestions (
        id TEXT PRIMARY KEY, customer_id TEXT NOT NULL, dedupe_key TEXT NOT NULL,
        status TEXT NOT NULL, created_at TEXT NOT NULL, json TEXT NOT NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_sugg_open ON valio_suggestions(customer_id, dedupe_key) WHERE status = 'new';
    `);
    ready = true;
  }
  return d;
}

const iso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

export function listSuggestions(customerId: string): Suggestion[] {
  const rows = db()
    .prepare(`SELECT json, status, id FROM valio_suggestions WHERE customer_id = ? ORDER BY created_at DESC LIMIT 50`)
    .all(customerId) as Array<{ json: string; status: string; id: string }>;
  return rows.map((r) => ({ ...(JSON.parse(r.json) as Suggestion), status: r.status as Suggestion["status"], id: r.id }));
}

function getSuggestion(customerId: string, id: string): Suggestion | null {
  const row = db()
    .prepare(`SELECT json, status, id FROM valio_suggestions WHERE customer_id = ? AND id = ?`)
    .get(customerId, id) as { json: string; status: string; id: string } | undefined;
  return row ? { ...(JSON.parse(row.json) as Suggestion), status: row.status as Suggestion["status"], id: row.id } : null;
}

function save(s: Suggestion): boolean {
  const res = db()
    .prepare(`INSERT OR IGNORE INTO valio_suggestions (id, customer_id, dedupe_key, status, created_at, json) VALUES (?,?,?,?,?,?)`)
    .run(s.id, s.customerId, `${s.kind}:${s.originalProductId}:${s.suggestedProductId}`, s.status, s.createdAt, JSON.stringify(s));
  return res.changes > 0;
}

function setStatus(id: string, patch: Partial<Suggestion>) {
  const row = db().prepare(`SELECT json FROM valio_suggestions WHERE id = ?`).get(id) as { json: string } | undefined;
  if (!row) throw new Error("suggestion not found");
  const next = { ...(JSON.parse(row.json) as Suggestion), ...patch };
  db().prepare(`UPDATE valio_suggestions SET status = ?, json = ? WHERE id = ?`).run(next.status, JSON.stringify(next), id);
  return next;
}

export function resetSuggestions(customerId: string) {
  db().prepare(`DELETE FROM valio_suggestions WHERE customer_id = ?`).run(customerId);
}

/** One pass of the Valio account agent for a customer. */
export function runValioAgent(customerId: string): Promise<{ checked: number; created: Suggestion[]; notes: string[] }> {
  return withAgent("valio-account", () => runImpl(customerId));
}

async function runImpl(customerId: string) {
  const runId = randomUUID();
  const notes: string[] = [];
  const created: Suggestion[] = [];
  const since = Date.now() - 60 * 86_400_000;

  // Valio's own records: what this customer has actually bought recently (latest order per product).
  const latest = new Map<string, ReturnType<typeof listOrders>[number]>();
  for (const o of listOrders(customerId)) {
    if (o.status !== "committed" || new Date(o.updatedAt).getTime() < since) continue;
    const pid = o.basket[0]?.productId;
    if (pid && !latest.has(pid)) latest.set(pid, o);
  }
  const watched = [...latest.entries()].slice(0, 6);
  const upcoming = iso(new Date(Date.now() + 3 * 86_400_000));
  appendAudit(runId, customerId, "valio_agent_started", { watching: watched.length, upcoming });

  for (const [productId, order] of watched) {
    const need: Need = { ...order.need, neededBy: upcoming };
    const name = order.basket[0].productName;
    try {
      const same = (await buildOffers(customerId, need, { productIds: [productId], includeSubstitutions: false }))[0];
      const ok = same && same.canFulfil && (!same.availableDate || same.availableDate <= upcoming);

      if (!ok) {
        const alts = (await buildOffers(customerId, need, { includeSubstitutions: true })).filter(
          (o) => o.productId !== productId && o.canFulfil && (!o.availableDate || o.availableDate <= upcoming),
        );
        const alt = alts.find((o) => o.substitutionSource === "valio_catalog") ?? alts[0];
        if (!alt) {
          notes.push(`${name}: at risk and no compliant substitute found`);
          continue;
        }
        const delta = Math.round((alt.totalPrice - order.totalPrice) * 100) / 100;
        const s: Suggestion = {
          id: randomUUID(),
          customerId,
          kind: "stockout_alert",
          title: `${name.slice(0, 48)} may not arrive by ${upcoming}`,
          body: `${same ? (same.canFulfil ? `The usual item would arrive ${same.availableDate}, after your date.` : "The usual item is out of stock.") : "The usual item is no longer available."} ${delta >= 0 ? `Switching costs €${delta.toFixed(2)} more` : `Switching saves €${Math.abs(delta).toFixed(2)}`} for the same quantity${alt.substitutionSource === "valio_catalog" ? "; Valio lists this as a substitute" : ""}.`,
          status: "new",
          createdAt: new Date().toISOString(),
          originalProductId: productId,
          suggestedProductId: alt.productId,
          suggestedProductName: alt.productName,
          deltaEur: delta,
          source: alt.substitutionSource === "valio_catalog" ? "valio_catalog" : "price_comparison",
          need,
        };
        if (save(s)) {
          created.push(s);
          appendAudit(runId, customerId, "suggestion_created", { kind: s.kind, title: s.title, suggested: alt.productName });
        }
        continue;
      }

      const best = (await buildOffers(customerId, need, { includeSubstitutions: false })).find(
        (o) => o.canFulfil && (!o.availableDate || o.availableDate <= upcoming),
      );
      if (best && best.productId !== productId && same && best.category === same.category && same.totalPrice - best.totalPrice >= Math.max(5, same.totalPrice * 0.1)) {
        const saving = Math.round((same.totalPrice - best.totalPrice) * 100) / 100;
        const s: Suggestion = {
          id: randomUUID(),
          customerId,
          kind: "better_price",
          title: `Save €${saving.toFixed(2)} on your usual ${need.productIntent}`,
          body: `Same requirements · €${best.totalPrice.toFixed(2)} instead of €${same.totalPrice.toFixed(2)} · arrives ${best.availableDate ?? "on time"}.`,
          status: "new",
          createdAt: new Date().toISOString(),
          originalProductId: productId,
          suggestedProductId: best.productId,
          suggestedProductName: best.productName,
          deltaEur: -saving,
          source: "price_comparison",
          need,
        };
        if (save(s)) {
          created.push(s);
          appendAudit(runId, customerId, "suggestion_created", { kind: s.kind, title: s.title, suggested: best.productName });
        }
      }
    } catch (e) {
      notes.push(`${name}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  appendAudit(runId, customerId, "valio_agent_finished", { checked: watched.length, created: created.length });
  return { checked: watched.length, created, notes };
}

/** The buyer side acts on a suggestion — through the Procurement agent and the normal mandate. */
export async function acceptSuggestion(customerId: string, id: string, mandate: Mandate) {
  const s = getSuggestion(customerId, id);
  if (!s) throw new Error("suggestion not found");
  if (s.status !== "new") throw new Error(`suggestion already ${s.status}`);
  const res = await createOrderIntent({
    customerId,
    mandate,
    need: s.need,
    offerProductId: s.suggestedProductId,
    // A stock-out replacement is a substitution; a cheaper equivalent is the same need, better sourced.
    markSubstitution: s.kind === "stockout_alert",
  });
  appendAudit(res.intent.runId, customerId, "suggestion_accepted", { title: s.title, intentId: res.intent.id, status: res.intent.status });
  setStatus(id, { status: "accepted", intentId: res.intent.id });
  return res.intent;
}

export function dismissSuggestion(customerId: string, id: string) {
  const s = getSuggestion(customerId, id);
  if (!s) throw new Error("suggestion not found");
  appendAudit(randomUUID(), customerId, "suggestion_dismissed", { title: s.title });
  return setStatus(id, { status: "dismissed" });
}
