/** Unified order history: everything the system created, with where it stands and where it came from. */
import { getDb } from "../audit/chain.js";
import { getLastReset, type LastReset } from "./overview.js";
import { getKitchen } from "../hotel/kitchen.js";
import { listOrders, type Alternative, type CascadeExecuted } from "../orders/store.js";
import type { HumanSignatureProof } from "../auth/humanProof.js";

export type Stage = "approval" | "awaiting_delivery" | "delivered" | "closed";

export type OrderRow = {
  intentId: string;
  orderId: string | null;
  runId: string;
  stage: Stage;
  statusLabel: string;
  note: string | null;
  source: string;
  createdAt: string;
  placedAt: string | null;
  neededBy: string;
  deliveredAt: string | null;
  overdue: boolean;
  total: number;
  items: Array<{
    productId: string;
    name: string;
    quantity: number;
    unit: string;
    price: number;
    isSubstitution: boolean;
    facts: { origin: string | null; producer: string | null; allergens: string[]; mayContain: string[]; certifications: string[]; labels: string[] };
  }>;
  need: string;
  rationale: string[];
  alternatives: Alternative[];
  decidedBy: "agent" | "human" | null;
  humanSignatureProof: HumanSignatureProof | null;
  cascadeExecuted: CascadeExecuted | null;
};

function sourceOf(types: Set<string>, idemKey: string | null, hasIngredient: boolean): string {
  if (types.has("standing_order_triggered")) return "Recurring order";
  if (types.has("menu_plan_started")) return "Menu planner";
  if (idemKey?.startsWith("auto-restock-")) return "Auto-restock";
  if (hasIngredient) return "Restock (agent)";
  return "Agent / API request";
}

export function getOrderHistory(customerId: string): { orders: OrderRow[]; counts: Record<Stage, number>; lastReset: LastReset | null } {
  const intents = listOrders(customerId);
  const k = getKitchen(customerId);
  const delivered = new Map((k?.orderHistory ?? []).map((o) => [o.orderId, o]));
  const runIds = [...new Set(intents.map((i) => i.runId))];
  const typesByRun = new Map<string, Set<string>>();
  if (runIds.length) {
    const rows = getDb()
      .prepare(
        `SELECT run_id, type FROM audit_events WHERE customer_id = ? AND type IN ('standing_order_triggered','menu_plan_started','human_approved') AND run_id IN (${runIds.map(() => "?").join(",")})`,
      )
      .all(customerId, ...runIds) as Array<{ run_id: string; type: string }>;
    for (const r of rows) {
      if (!typesByRun.has(r.run_id)) typesByRun.set(r.run_id, new Set());
      typesByRun.get(r.run_id)!.add(r.type);
    }
  }
  const today = new Date().toISOString().slice(0, 10);

  const orders: OrderRow[] = intents
    .filter((i) => i.status !== "intent_created")
    .map((i) => {
      const types = typesByRun.get(i.runId) ?? new Set<string>();
      const k2 = i.committedOrderId ? delivered.get(i.committedOrderId) : undefined;
      let stage: Stage = "closed";
      let label = i.status.replace(/_/g, " ");
      let note: string | null = null;
      switch (i.status) {
        case "pending_approval":
          stage = "approval";
          label = "Waiting for your approval";
          note = i.policy.reasons.join("; ") || null;
          break;
        case "approved":
        case "revalidating":
          stage = "approval";
          label = i.status === "revalidating" ? "Re-checking price & stock" : "Approved — not placed yet";
          break;
        case "auto_eligible":
          stage = "approval";
          label = "Ready — not placed yet";
          break;
        case "committed":
          if (k2?.status === "delivered") {
            stage = "delivered";
            label = "Delivered";
          } else {
            stage = "awaiting_delivery";
            label = i.neededBy < today ? "Overdue — not received" : "Ordered — awaiting delivery";
          }
          break;
        case "rejected":
          label = "Rejected";
          break;
        case "superseded":
          label = "Replaced by a newer proposal";
          break;
        case "expired":
          label = "Expired (not approved in time)";
          break;
        case "stale_invalidated":
          label = "Cancelled — price or stock changed";
          break;
        case "blocked":
          label = "Blocked by mandate";
          note = i.policy.reasons.join("; ") || null;
          break;
      }
      return {
        intentId: i.id,
        orderId: i.committedOrderId,
        runId: i.runId,
        stage,
        statusLabel: label,
        note,
        source: sourceOf(types, i.idempotencyKey, Boolean(i.need.ingredientId)),
        createdAt: i.createdAt,
        placedAt: i.status === "committed" ? i.updatedAt : null,
        neededBy: i.neededBy,
        deliveredAt: k2?.deliveredAt ?? null,
        overdue: stage === "awaiting_delivery" && i.neededBy < today,
        total: i.totalPrice,
        items: i.basket.map((b) => ({
          productId: b.productId,
          name: b.productName,
          quantity: b.totalQuantity,
          unit: b.quantityUnit,
          price: b.totalPrice,
          isSubstitution: b.isSubstitution,
          facts: {
            origin: b.origin ?? null,
            producer: b.producer ?? null,
            allergens: b.allergens ?? [],
            mayContain: b.mayContain ?? [],
            certifications: b.certifications ?? [],
            labels: b.labels ?? [],
          },
        })),
        rationale: i.meta?.rationale ?? [],
        alternatives: i.meta?.alternatives ?? [],
        need:
          i.meta?.itemNeeds && i.meta.itemNeeds.length > 1
            ? i.meta.itemNeeds
                .map((n) =>
                  n.ingredientQuantity != null &&
                  n.ingredientUnit &&
                  n.ingredientUnit.toLowerCase() !== String(n.unit).toLowerCase()
                    ? `${n.ingredientQuantity} ${n.ingredientUnit === "each" ? "pcs" : n.ingredientUnit} ${n.productIntent}`
                    : `${n.quantity} ${n.unit === "each" ? "pcs" : n.unit} ${n.productIntent}`,
                )
                .join(" + ")
            : i.need.ingredientQuantity != null && i.need.ingredientUnit && i.need.ingredientUnit.toLowerCase() !== String(i.need.unit).toLowerCase()
              ? `${i.need.ingredientQuantity} ${i.need.ingredientUnit === "each" ? "pcs" : i.need.ingredientUnit} ${i.need.productIntent} (pack rounding: ${i.need.quantity} ${i.need.unit})`
              : `${i.need.quantity} ${i.need.unit} ${i.need.productIntent}`,
        decidedBy: i.status === "committed" ? (types.has("human_approved") ? "human" : "agent") : null,
        humanSignatureProof: i.meta?.humanSignatureProof ?? null,
        cascadeExecuted: i.meta?.cascadeExecuted ?? null,
      };
    });

  const counts: Record<Stage, number> = { approval: 0, awaiting_delivery: 0, delivered: 0, closed: 0 };
  for (const o of orders) counts[o.stage]++;
  return { orders, counts, lastReset: getLastReset(customerId) };
}
