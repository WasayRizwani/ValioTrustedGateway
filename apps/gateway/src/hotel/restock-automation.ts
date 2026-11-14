/**
 * Deterministic restock automation: recommend → intent → commit if auto_eligible.
 * Mandate / approval still gate every order — this only orchestrates the existing tools.
 */

import { executeAgentTool } from "../agent/tools.js";
import { getMandate } from "../auth/customers.js";
import { withAgent } from "../agents/context.js";
import { appendAudit } from "../audit/chain.js";
import { randomUUID } from "node:crypto";
import { isDairyText } from "../policy/engine.js";
import type { RestockRecommendation } from "./kitchen.js";
import { getKitchen, recommendRestock } from "./kitchen.js";
import { nextMondayIso, optimizeLine } from "./optimizer.js";

export type RestockAutomationPolicy = {
  enabled: boolean;
  daysCover: number;
  maxItems: number;
  urgencies: Array<"critical" | "low">;
  pauseOnStandingOrderDrift: boolean;
  /** Order the pack size that is cheapest per unit actually used, when it beats the exact quantity. */
  smartQuantities: boolean;
  /** How often the gateway scheduler may run when enabled (minutes). */
  intervalMinutes: number;
};

export type RestockRunLine = {
  ingredient: string;
  urgency: string;
  outcome: string;
  intentId?: string;
  status?: string;
  totalPrice?: number;
  committed?: boolean;
  /** Set when a cheaper pack size was ordered instead of the exact quantity. */
  savedEur?: number;
};

export type RestockRunResult = {
  customerId: string;
  ranAt: string;
  summary: string;
  skippedReason?: string;
  lines: RestockRunLine[];
  pendingApprovalCount: number;
  committedCount: number;
};

const defaultPolicy = (): RestockAutomationPolicy => ({
  enabled: false,
  daysCover: 7,
  maxItems: 2,
  urgencies: ["critical", "low"],
  pauseOnStandingOrderDrift: true,
  smartQuantities: true,
  intervalMinutes: 60,
});

const policies = new Map<string, RestockAutomationPolicy>();
const lastRuns = new Map<string, RestockRunResult>();
const lastScheduledAt = new Map<string, number>();

export function getRestockAutomationPolicy(
  customerId: string,
): RestockAutomationPolicy {
  return policies.get(customerId) ?? defaultPolicy();
}

export function setRestockAutomationPolicy(
  customerId: string,
  patch: Partial<RestockAutomationPolicy>,
): RestockAutomationPolicy {
  const clean = Object.fromEntries(
    Object.entries(patch).filter(([, v]) => v !== undefined),
  ) as Partial<RestockAutomationPolicy>;
  const next: RestockAutomationPolicy = {
    ...getRestockAutomationPolicy(customerId),
    ...clean,
  };
  if (clean.urgencies) {
    next.urgencies = clean.urgencies.filter(
      (u): u is "critical" | "low" => u === "critical" || u === "low",
    );
    if (!next.urgencies.length) next.urgencies = ["critical", "low"];
  }
  if (!next.urgencies?.length) next.urgencies = ["critical", "low"];
  next.daysCover = Math.max(1, Math.min(30, Number(next.daysCover) || 7));
  next.maxItems = Math.max(1, Math.min(10, Number(next.maxItems) || 2));
  next.intervalMinutes = Math.max(
    1,
    Math.min(24 * 60, Number(next.intervalMinutes) || 60),
  );
  next.enabled = Boolean(next.enabled);
  next.pauseOnStandingOrderDrift = Boolean(next.pauseOnStandingOrderDrift);
  next.smartQuantities = next.smartQuantities !== false;
  policies.set(customerId, next);
  return next;
}

export function getLastRestockRun(
  customerId: string,
): RestockRunResult | null {
  return lastRuns.get(customerId) ?? null;
}

export async function runAutomatedRestock(
  customerId: string,
  options?: {
    force?: boolean;
    /** Order exactly these ingredients (a person asked for them) — even if flagged for a quantity check. */
    only?: string[];
    /** Order everything that is low, not just the top few the schedule would take. */
    all?: boolean;
    /** "exact" orders precisely the shortfall; "smart" takes the cheaper pack size when there is one. Default follows the policy. */
    choice?: "exact" | "smart";
  },
): Promise<RestockRunResult> {
  const policy = getRestockAutomationPolicy(customerId);
  if (!policy.enabled && !options?.force) {
    const skipped: RestockRunResult = {
      customerId,
      ranAt: new Date().toISOString(),
      summary: "Restock automation is off. Enable it or use Run now.",
      skippedReason: "disabled",
      lines: [],
      pendingApprovalCount: 0,
      committedCount: 0,
    };
    lastRuns.set(customerId, skipped);
    return skipped;
  }

  const rec = withAgent("planner", () => recommendRestock(customerId, { daysCover: policy.daysCover }));
  if (!rec) {
    const skipped: RestockRunResult = {
      customerId,
      ranAt: new Date().toISOString(),
      summary: "No kitchen profile for this customer.",
      skippedReason: "no_kitchen_profile",
      lines: [],
      pendingApprovalCount: 0,
      committedCount: 0,
    };
    lastRuns.set(customerId, skipped);
    return skipped;
  }

  const skippedForDrift: RestockRunLine[] = [];
  let top: RestockRecommendation[];
  const recs = rec.recommendations as RestockRecommendation[];
  if (options?.only?.length) {
    // An explicit request for specific items: honour it. The mandate still gates every order.
    top = recs.filter((r) => options.only!.includes(r.ingredientId) && r.suggestedOrderQty > 0);
  } else {
    const urgencySet = new Set(options?.all ? ["critical", "low"] : policy.urgencies);
    let candidates = recs.filter((r) => urgencySet.has(r.urgency as "critical" | "low") && r.suggestedOrderQty > 0);
    // Only the unattended schedule pauses for a quantity check. When a person clicks the button, they asked for it:
    // the order still goes through the mandate, which sends big ones to approval.
    if (policy.pauseOnStandingOrderDrift && !options?.force && !options?.all) {
      for (const r of candidates.filter((x) => x.standingOrderDrift)) {
        skippedForDrift.push({
          ingredient: r.name,
          urgency: r.urgency,
          outcome: `Skipped — suggested ${r.suggestedOrderQty}${r.unit} is very different from your usual ~${r.standingOrderAvgQty}${r.unit}. Check it, then use “Order anyway”.`,
        });
      }
      candidates = candidates.filter((r) => !r.standingOrderDrift);
    }
    top = options?.all ? candidates.slice(0, 20) : candidates.slice(0, policy.maxItems);
  }

  if (!top.length) {
    const result: RestockRunResult = {
      customerId,
      ranAt: new Date().toISOString(),
      summary: skippedForDrift.length
        ? `Nothing ordered — ${skippedForDrift.length} item(s) need a quantity check first.`
        : "Nothing to order — stock is covered for the planning horizon.",
      lines: skippedForDrift,
      pendingApprovalCount: 0,
      committedCount: 0,
    };
    lastRuns.set(customerId, result);
    lastScheduledAt.set(customerId, Date.now());
    return result;
  }

  withAgent("planner", () =>
    appendAudit(randomUUID(), customerId, "agent_handoff", {
      from: "planner",
      to: "sourcing → procurement",
      reason: `Restock needed: ${top.map((t) => `${t.suggestedOrderQty}${t.unit} ${t.name}`).join(", ")}`,
    }),
  );

  const run = async (name: string, args: Record<string, unknown>) => {
    const { result } = await executeAgentTool(customerId, name, args);
    return result;
  };

  const lines: RestockRunLine[] = [...skippedForDrift];
  let pendingApprovalCount = 0;
  let committedCount = 0;
  const neededBy = nextMondayIso();
  const mandate = getMandate(customerId);

  for (const item of top) {
    const hint = item.catalogHints[0] ?? item.name;
    const byWeight = item.unit === "each" && item.unitWeightKg;
    const qtyPhrase = byWeight
      ? `${Math.ceil(item.suggestedOrderQty * (item.unitWeightKg as number) * 100) / 100} kg of ${hint}`
      : item.unit === "each"
        ? `${item.suggestedOrderQty} pieces of ${hint}`
        : `${item.suggestedOrderQty} ${item.unit} of ${hint}`;
    const lf =
      item.lactoseFreePreferred ||
      (mandate?.allergenRestrictions.includes("must_be_lactose_free") &&
        isDairyText(`${item.name} ${item.catalogHints.join(" ")}`));
    const needText = `I need ${qtyPhrase} by ${neededBy}${lf ? " lactose-free" : ""}`;
    const parsedNeed = (await run("parse_need", {
      text: needText,
      neededBy,
    })) as { clarificationRequired?: string } & Record<string, unknown>;

    parsedNeed.ingredientId = item.ingredientId;
    parsedNeed.ingredientQuantity = item.suggestedOrderQty;
    parsedNeed.ingredientUnit = item.unit;
    if (item.excludeAllergens?.length) {
      const c = (parsedNeed.constraints ?? {}) as Record<string, unknown>;
      parsedNeed.constraints = { ...c, excludeAllergens: item.excludeAllergens };
    }

    // Smart quantity: price the alternatives and order the pack size that is cheapest per unit actually used.
    const exactQuantity = parsedNeed.quantity;
    let smartPick: { productId: string; saving: number; text: string } | null = null;
    const wantSmart = options?.choice ? options.choice === "smart" : policy.smartQuantities !== false;
    const stockItem = getKitchen(customerId)?.inventory.find((i) => i.ingredientId === item.ingredientId);
    if (wantSmart && stockItem && !parsedNeed.clarificationRequired) {
      try {
        const sl = await withAgent("planner", () => optimizeLine(customerId, stockItem, item, neededBy, policy.daysCover));
        if (sl.smart && sl.exact && (options?.choice === "smart" || sl.recommendation === "smart")) {
          parsedNeed.quantity = sl.smart.quantity;
          parsedNeed.ingredientQuantity = sl.smart.ingredientQuantity;
          smartPick = {
            productId: sl.smart.productId,
            saving: sl.savingEur,
            text: `smart quantity ${sl.smart.packs} × ${sl.smart.packLabel} instead of ${sl.exact.packs} × ${sl.exact.packLabel}, saves €${sl.savingEur.toFixed(2)}`,
          };
        }
      } catch {
        /* pricing alternatives is best-effort; fall back to the exact order */
      }
    }

    if (parsedNeed.clarificationRequired) {
      lines.push({
        ingredient: item.name,
        urgency: item.urgency,
        outcome: `Needs clarification: ${parsedNeed.clarificationRequired}`,
      });
      continue;
    }

    const ranked = (await run("rank_offers", { need: parsedNeed })) as {
      offers?: Array<{
        productId: string;
        canFulfil: boolean;
        totalPrice: number;
        shortfall?: number | null;
        substitutionLabel?: string;
      }>;
    };
    let pick = ranked.offers?.find((o) => o.canFulfil) ?? ranked.offers?.[0];
    if (smartPick) {
      const sp = ranked.offers?.find((o) => o.productId === smartPick!.productId && o.canFulfil);
      if (sp) pick = sp;
      else {
        smartPick = null;
        parsedNeed.quantity = exactQuantity ?? item.suggestedOrderQty;
        parsedNeed.ingredientQuantity = item.suggestedOrderQty;
      }
    }
    if (!pick) {
      lines.push({
        ingredient: item.name,
        urgency: item.urgency,
        outcome: "No Valio offers found",
      });
      continue;
    }

    const intentRes = (await run("create_order_intent", {
      need: parsedNeed,
      offerProductId: pick.productId,
    })) as {
      intent?: {
        id: string;
        status: string;
        totalPrice: number;
      };
      error?: string;
    };
    const intent = intentRes.intent;
    if (!intent) {
      lines.push({
        ingredient: item.name,
        urgency: item.urgency,
        outcome: intentRes.error ?? "Failed to create intent",
      });
      continue;
    }

    const partialNote = !pick.canFulfil
      ? ` · partial shortfall=${pick.shortfall ?? "?"}`
      : "";
    const gbb = (pick.substitutionLabel ? ` · ${pick.substitutionLabel}` : "") + (smartPick ? ` · ${smartPick.text}` : "");

    if (intent.status === "auto_eligible") {
      await run("commit_order", {
        intentId: intent.id,
        idempotencyKey: `auto-restock-${intent.id}`,
      });
      committedCount += 1;
      lines.push({
        ingredient: item.name,
        urgency: item.urgency,
        outcome: `Auto-committed${partialNote}${gbb}`,
        intentId: intent.id,
        status: "committed",
        totalPrice: intent.totalPrice,
        committed: true,
        savedEur: smartPick?.saving,
      });
    } else {
      if (intent.status === "pending_approval") pendingApprovalCount += 1;
      lines.push({
        ingredient: item.name,
        urgency: item.urgency,
        outcome: `${intent.status}${partialNote}${gbb}`,
        intentId: intent.id,
        status: intent.status,
        totalPrice: intent.totalPrice,
        committed: false,
        savedEur: smartPick?.saving,
      });
    }
  }

  const result: RestockRunResult = {
    customerId,
    ranAt: new Date().toISOString(),
    summary:
      `Ordered ${committedCount} automatically` +
      (pendingApprovalCount ? `, ${pendingApprovalCount} waiting for your approval` : "") +
      (skippedForDrift.length ? `, ${skippedForDrift.length} skipped for a quantity check` : "") +
      (lines.some((l) => l.savedEur) ? `. Smart quantities saved about €${lines.reduce((s, l) => s + (l.savedEur ?? 0), 0).toFixed(2)}` : "") +
      ".",
    lines,
    pendingApprovalCount,
    committedCount,
  };
  lastRuns.set(customerId, result);
  lastScheduledAt.set(customerId, Date.now());
  return result;
}

/** Background tick for customers with automation enabled. */
export function startRestockScheduler(customerIds: string[]): void {
  const tick = async () => {
    for (const customerId of customerIds) {
      const policy = getRestockAutomationPolicy(customerId);
      if (!policy.enabled) continue;
      const last = lastScheduledAt.get(customerId) ?? 0;
      const due =
        Date.now() - last >= policy.intervalMinutes * 60 * 1000;
      if (!due) continue;
      try {
        await runAutomatedRestock(customerId);
        console.log(
          `[restock-automation] ran for ${customerId} (interval ${policy.intervalMinutes}m)`,
        );
      } catch (e) {
        console.error(`[restock-automation] failed for ${customerId}`, e);
      }
    }
  };
  // Check every minute; intervalMinutes gates actual runs.
  setInterval(() => {
    void tick();
  }, 60_000);
}
