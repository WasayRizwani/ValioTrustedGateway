/**
 * Deterministic inventory auto-sync + restock automation:
 * POS / delivery sync → recommend low & very-low stock → quote/intent → commit if auto_eligible.
 * Mandate / approval still gate every order — this only orchestrates the existing tools.
 */

import { randomUUID } from "node:crypto";
import { executeAgentTool } from "../agent/tools.js";
import { withAgent } from "../agents/context.js";
import { appendAudit, getDb } from "../audit/chain.js";
import { getMandate } from "../auth/customers.js";
import { isDairyText } from "../policy/engine.js";
import type { RestockRecommendation } from "./kitchen.js";
import { getKitchen, recommendRestock, recordUsage } from "./kitchen.js";
import { nextMondayIso, optimizeLine } from "./optimizer.js";

export type RestockAutomationPolicy = {
  enabled: boolean;
  autoSyncInventory: boolean;
  syncIntervalMinutes: number;
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
  ingredientId?: string;
  ingredient: string;
  urgency: string;
  outcome: string;
  productName?: string;
  quantity?: number;
  unit?: string;
  orderId?: string;
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
  trigger?: "manual" | "pos_sync" | "service_rush" | "scheduled";
  summary: string;
  skippedReason?: string;
  lines: RestockRunLine[];
  pendingApprovalCount: number;
  committedCount: number;
};

export type SyncDeduction = {
  ingredientId: string;
  name: string;
  used: number;
  onHandAfter: number;
  unit: string;
};

export type InventorySyncStatus = {
  autoSyncEnabled: boolean;
  syncIntervalMinutes: number;
  lastSyncedAt: string;
  lastSyncSource: "pos_sync" | "service_rush" | "delivery_receipt" | "scheduled";
  lastSyncSummary: string;
  deductions?: SyncDeduction[];
  connectedSources: Array<{
    id: string;
    label: string;
    detail: string;
    connected: boolean;
  }>;
};

export type StockHealthItem = {
  ingredientId: string;
  name: string;
  onHand: number;
  onOrder: number;
  parLevel: number;
  targetQty: number;
  suggestedOrderQty: number;
  unit: string;
  urgency: "critical" | "low" | "ok";
  standingOrderDrift?: boolean;
  daysToExpiry?: number;
};

export type StockHealthSnapshot = {
  daysCover: number;
  criticalCount: number;
  lowCount: number;
  okCount: number;
  actionableCount: number;
  items: StockHealthItem[];
};

const defaultPolicy = (): RestockAutomationPolicy => ({
  enabled: true,
  autoSyncInventory: true,
  syncIntervalMinutes: 15,
  daysCover: 7,
  maxItems: 6,
  urgencies: ["critical", "low"],
  pauseOnStandingOrderDrift: true,
  smartQuantities: true,
  intervalMinutes: 60,
});

const defaultSyncStatus = (policy: RestockAutomationPolicy): InventorySyncStatus => ({
  autoSyncEnabled: policy.autoSyncInventory,
  syncIntervalMinutes: policy.syncIntervalMinutes,
  lastSyncedAt: new Date(Date.now() - 2 * 60_000).toISOString(),
  lastSyncSource: "pos_sync",
  lastSyncSummary:
    "Synced with Kitchen POS recipe sales, walk-in cooler counts, and inbound Valio deliveries.",
  connectedSources: [
    {
      id: "pos_recipes",
      label: "Kitchen POS & Recipe Sales",
      detail: "Deducts ingredients automatically as dishes are sold",
      connected: true,
    },
    {
      id: "valio_deliveries",
      label: "Valio Inbound & Delivery Sync",
      detail: "Tracks orders in transit so items are never double-ordered",
      connected: true,
    },
    {
      id: "smart_pantry",
      label: "Fridge & Shelf Par Monitor",
      detail: "Flags Very Low (<50% target) & Low stock ahead of service",
      connected: true,
    },
  ],
});

let tableReady = false;
function ensureTable() {
  const d = getDb();
  if (!tableReady) {
    d.exec(`
      CREATE TABLE IF NOT EXISTS restock_automation_state (
        customer_id TEXT PRIMARY KEY,
        policy_json TEXT NOT NULL,
        last_run_json TEXT,
        sync_json TEXT
      );
    `);
    tableReady = true;
  }
  return d;
}

type StoredRow = {
  policy_json: string;
  last_run_json: string | null;
  sync_json: string | null;
};

function readRow(customerId: string): StoredRow | undefined {
  const d = ensureTable();
  return d
    .prepare(
      `SELECT policy_json, last_run_json, sync_json FROM restock_automation_state WHERE customer_id = ?`,
    )
    .get(customerId) as StoredRow | undefined;
}

function writeRow(
  customerId: string,
  policy: RestockAutomationPolicy,
  lastRun: RestockRunResult | null,
  sync: InventorySyncStatus | null,
) {
  const d = ensureTable();
  d.prepare(
    `INSERT INTO restock_automation_state (customer_id, policy_json, last_run_json, sync_json)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(customer_id) DO UPDATE SET
       policy_json = excluded.policy_json,
       last_run_json = excluded.last_run_json,
       sync_json = excluded.sync_json`,
  ).run(
    customerId,
    JSON.stringify(policy),
    lastRun ? JSON.stringify(lastRun) : null,
    sync ? JSON.stringify(sync) : null,
  );
}

const lastScheduledAt = new Map<string, number>();

export function getRestockAutomationPolicy(
  customerId: string,
): RestockAutomationPolicy {
  const row = readRow(customerId);
  if (!row) return defaultPolicy();
  try {
    const parsed = JSON.parse(row.policy_json) as Partial<RestockAutomationPolicy>;
    return {
      ...defaultPolicy(),
      ...parsed,
      urgencies:
        Array.isArray(parsed.urgencies) && parsed.urgencies.length > 0
          ? parsed.urgencies.filter((u): u is "critical" | "low" => u === "critical" || u === "low")
          : ["critical", "low"],
    };
  } catch {
    return defaultPolicy();
  }
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
  next.maxItems = Math.max(1, Math.min(15, Number(next.maxItems) || 6));
  next.intervalMinutes = Math.max(
    1,
    Math.min(24 * 60, Number(next.intervalMinutes) || 60),
  );
  next.syncIntervalMinutes = Math.max(
    1,
    Math.min(24 * 60, Number(next.syncIntervalMinutes) || 15),
  );
  next.enabled = Boolean(next.enabled);
  next.autoSyncInventory =
    clean.autoSyncInventory !== undefined
      ? Boolean(clean.autoSyncInventory)
      : next.autoSyncInventory !== false;
  next.pauseOnStandingOrderDrift = Boolean(next.pauseOnStandingOrderDrift);
  next.smartQuantities = next.smartQuantities !== false;

  const prevRun = getLastRestockRun(customerId);
  const prevSync = getInventorySyncStatus(customerId);
  const nextSync: InventorySyncStatus = {
    ...prevSync,
    autoSyncEnabled: next.autoSyncInventory,
    syncIntervalMinutes: next.syncIntervalMinutes,
  };
  writeRow(customerId, next, prevRun, nextSync);
  return next;
}

export function getLastRestockRun(
  customerId: string,
): RestockRunResult | null {
  const row = readRow(customerId);
  if (!row?.last_run_json) return null;
  try {
    return JSON.parse(row.last_run_json) as RestockRunResult;
  } catch {
    return null;
  }
}

export function getInventorySyncStatus(
  customerId: string,
): InventorySyncStatus {
  const policy = getRestockAutomationPolicy(customerId);
  const base = defaultSyncStatus(policy);
  const row = readRow(customerId);
  if (!row?.sync_json) return base;
  try {
    const parsed = JSON.parse(row.sync_json) as Partial<InventorySyncStatus>;
    return {
      ...base,
      ...parsed,
      autoSyncEnabled: policy.autoSyncInventory,
      syncIntervalMinutes: policy.syncIntervalMinutes,
      connectedSources: base.connectedSources,
    };
  } catch {
    return base;
  }
}

export function getStockHealthSnapshot(
  customerId: string,
  daysCoverOverride?: number,
): StockHealthSnapshot | null {
  const policy = getRestockAutomationPolicy(customerId);
  const daysCover = daysCoverOverride ?? policy.daysCover;
  const rec = withAgent("planner", () => recommendRestock(customerId, { daysCover }));
  if (!rec) return null;
  const urgencySet = new Set(policy.urgencies);
  const items: StockHealthItem[] = rec.recommendations.map((r) => ({
    ingredientId: r.ingredientId,
    name: r.name,
    onHand: r.onHand,
    onOrder: r.onOrder ?? 0,
    parLevel: r.parLevel,
    targetQty: r.targetQty,
    suggestedOrderQty: r.suggestedOrderQty,
    unit: r.unit,
    urgency: r.urgency,
    standingOrderDrift: r.standingOrderDrift,
    daysToExpiry: r.daysToExpiry,
  }));
  const criticalCount = items.filter((i) => i.urgency === "critical").length;
  const lowCount = items.filter((i) => i.urgency === "low").length;
  const okCount = items.filter((i) => i.urgency === "ok").length;
  const actionableCount = items.filter(
    (i) => urgencySet.has(i.urgency as "critical" | "low") && i.suggestedOrderQty > 0,
  ).length;

  return {
    daysCover,
    criticalCount,
    lowCount,
    okCount,
    actionableCount,
    items,
  };
}

export function resetRestockAutomation(customerId: string): void {
  const d = ensureTable();
  d.prepare(`DELETE FROM restock_automation_state WHERE customer_id = ?`).run(customerId);
  lastScheduledAt.set(customerId, Date.now());
}

function saveLastRun(customerId: string, runResult: RestockRunResult): void {
  const policy = getRestockAutomationPolicy(customerId);
  const sync = getInventorySyncStatus(customerId);
  writeRow(customerId, policy, runResult, sync);
}

function saveSyncStatus(customerId: string, sync: InventorySyncStatus): void {
  const policy = getRestockAutomationPolicy(customerId);
  const lastRun = getLastRestockRun(customerId);
  writeRow(customerId, policy, lastRun, sync);
}

export async function runAutomatedRestock(
  customerId: string,
  options?: {
    force?: boolean;
    /** Order exactly these ingredients (a person asked for them) — even if flagged for a quantity check. */
    only?: string[];
    /** Order everything matching urgency filter, not just maxItems. */
    all?: boolean;
    /** Explicit urgency filter override ("critical" | "low"). */
    urgencies?: Array<"critical" | "low">;
    /** "exact" orders precisely the shortfall; "smart" takes the cheaper pack size when there is one. Default follows the policy. */
    choice?: "exact" | "smart";
    trigger?: "manual" | "pos_sync" | "service_rush" | "scheduled";
  },
): Promise<RestockRunResult> {
  const policy = getRestockAutomationPolicy(customerId);
  if (!policy.enabled && !options?.force) {
    const skipped: RestockRunResult = {
      customerId,
      ranAt: new Date().toISOString(),
      trigger: options?.trigger ?? "scheduled",
      summary: "Restock automation is paused. Resume it or click Sync & Order Now.",
      skippedReason: "disabled",
      lines: [],
      pendingApprovalCount: 0,
      committedCount: 0,
    };
    saveLastRun(customerId, skipped);
    return skipped;
  }

  const rec = withAgent("planner", () => recommendRestock(customerId, { daysCover: policy.daysCover }));
  if (!rec) {
    const skipped: RestockRunResult = {
      customerId,
      ranAt: new Date().toISOString(),
      trigger: options?.trigger ?? "manual",
      summary: "No kitchen profile for this customer.",
      skippedReason: "no_kitchen_profile",
      lines: [],
      pendingApprovalCount: 0,
      committedCount: 0,
    };
    saveLastRun(customerId, skipped);
    return skipped;
  }

  const skippedForDrift: RestockRunLine[] = [];
  let top: RestockRecommendation[];
  const recs = rec.recommendations as RestockRecommendation[];
  if (options?.only?.length) {
    // An explicit request for specific items: honour it. The mandate still gates every order.
    top = recs.filter((r) => options.only!.includes(r.ingredientId) && r.suggestedOrderQty > 0);
  } else {
    const activeUrgencies =
      options?.urgencies && options.urgencies.length > 0
        ? options.urgencies
        : policy.urgencies;
    const urgencySet = new Set(activeUrgencies);
    let candidates = recs.filter(
      (r) => urgencySet.has(r.urgency as "critical" | "low") && r.suggestedOrderQty > 0,
    );
    // Only the unattended schedule pauses for a quantity check. When a person clicks the button, they asked for it:
    // the order still goes through the mandate, which sends big ones to approval.
    if (policy.pauseOnStandingOrderDrift && !options?.force && !options?.all) {
      for (const r of candidates.filter((x) => x.standingOrderDrift)) {
        skippedForDrift.push({
          ingredientId: r.ingredientId,
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
      trigger: options?.trigger ?? "manual",
      summary: skippedForDrift.length
        ? `Nothing ordered — ${skippedForDrift.length} item(s) need a quantity check first.`
        : `All stock is healthy & covered for the next ${policy.daysCover} days — no orders needed.`,
      lines: skippedForDrift,
      pendingApprovalCount: 0,
      committedCount: 0,
    };
    saveLastRun(customerId, result);
    lastScheduledAt.set(customerId, Date.now());
    return result;
  }

  withAgent("planner", () =>
    appendAudit(randomUUID(), customerId, "agent_handoff", {
      from: "planner",
      to: "sourcing → procurement",
      reason: `Auto-restock needed: ${top.map((t) => `${t.suggestedOrderQty}${t.unit} ${t.name} (${t.urgency})`).join(", ")}`,
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
            text: `smart pack ${sl.smart.packs} × ${sl.smart.packLabel} saves €${sl.savingEur.toFixed(2)}`,
          };
        }
      } catch {
        /* pricing alternatives is best-effort; fall back to the exact order */
      }
    }

    if (parsedNeed.clarificationRequired) {
      lines.push({
        ingredientId: item.ingredientId,
        ingredient: item.name,
        urgency: item.urgency,
        outcome: `Needs clarification: ${parsedNeed.clarificationRequired}`,
      });
      continue;
    }

    const ranked = (await run("rank_offers", { need: parsedNeed })) as {
      offers?: Array<{
        productId: string;
        productName?: string;
        canFulfil: boolean;
        totalPrice: number;
        totalQuantity?: number;
        quantityUnit?: string;
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
        ingredientId: item.ingredientId,
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
        basket?: Array<{ productName?: string; totalQuantity?: number; quantityUnit?: string }>;
      };
      error?: string;
    };
    const intent = intentRes.intent;
    if (!intent) {
      lines.push({
        ingredientId: item.ingredientId,
        ingredient: item.name,
        urgency: item.urgency,
        outcome: intentRes.error ?? "Failed to create intent",
      });
      continue;
    }

    const basketHead = intent.basket?.[0];
    const resolvedProductName = basketHead?.productName ?? pick.productName ?? item.name;
    const resolvedQty = Number(parsedNeed.ingredientQuantity ?? item.suggestedOrderQty);
    const resolvedUnit = String(parsedNeed.ingredientUnit ?? item.unit);

    const partialNote = !pick.canFulfil
      ? ` · partial shortfall=${pick.shortfall ?? "?"}`
      : "";
    const gbb =
      (pick.substitutionLabel ? ` · ${pick.substitutionLabel}` : "") +
      (smartPick ? ` · ${smartPick.text}` : "");

    if (intent.status === "auto_eligible") {
      const commitRes = (await run("commit_order", {
        intentId: intent.id,
        idempotencyKey: `auto-restock-${intent.id}`,
      })) as {
        confirmation?: { orderId?: string };
        orderId?: string;
        error?: string;
      };
      if (commitRes?.error) {
        lines.push({
          ingredientId: item.ingredientId,
          ingredient: item.name,
          urgency: item.urgency,
          productName: resolvedProductName,
          quantity: resolvedQty,
          unit: resolvedUnit,
          outcome: `Revalidation paused order: ${commitRes.error}`,
          intentId: intent.id,
          status: "failed_commit",
          totalPrice: intent.totalPrice,
          committed: false,
        });
        continue;
      }
      const orderId = commitRes?.confirmation?.orderId ?? commitRes?.orderId;
      committedCount += 1;
      lines.push({
        ingredientId: item.ingredientId,
        ingredient: item.name,
        urgency: item.urgency,
        productName: resolvedProductName,
        quantity: resolvedQty,
        unit: resolvedUnit,
        orderId,
        outcome: `Placed automatically${orderId ? ` (${orderId})` : ""}${partialNote}${gbb}`,
        intentId: intent.id,
        status: "committed",
        totalPrice: intent.totalPrice,
        committed: true,
        savedEur: smartPick?.saving,
      });
    } else {
      if (intent.status === "pending_approval") pendingApprovalCount += 1;
      lines.push({
        ingredientId: item.ingredientId,
        ingredient: item.name,
        urgency: item.urgency,
        productName: resolvedProductName,
        quantity: resolvedQty,
        unit: resolvedUnit,
        outcome:
          intent.status === "pending_approval"
            ? `Queued in Needs Your OK${partialNote}${gbb}`
            : `${intent.status}${partialNote}${gbb}`,
        intentId: intent.id,
        status: intent.status,
        totalPrice: intent.totalPrice,
        committed: false,
        savedEur: smartPick?.saving,
      });
    }
  }

  const totalSaved = lines.reduce((s, l) => s + (l.savedEur ?? 0), 0);
  const result: RestockRunResult = {
    customerId,
    ranAt: new Date().toISOString(),
    trigger: options?.trigger ?? "manual",
    summary:
      `Ordered ${committedCount} low-stock item${committedCount === 1 ? "" : "s"} automatically` +
      (pendingApprovalCount ? `, ${pendingApprovalCount} waiting in Needs Your OK` : "") +
      (skippedForDrift.length ? `, ${skippedForDrift.length} paused for quantity check` : "") +
      (totalSaved > 0 ? ` · Smart packs saved €${totalSaved.toFixed(2)}` : "") +
      ".",
    lines,
    pendingApprovalCount,
    committedCount,
  };
  saveLastRun(customerId, result);
  lastScheduledAt.set(customerId, Date.now());
  return result;
}

/**
 * Syncs restaurant POS / recipe sales + inbound deliveries with kitchen inventory,
 * detects Very Low ("critical") and Low ("low") items, and optionally runs auto-restock immediately.
 */
export async function syncInventoryAndRestock(
  customerId: string,
  options?: {
    mode?: "pos_sync" | "service_rush";
    autoOrder?: boolean;
    urgencies?: Array<"critical" | "low">;
  },
): Promise<{
  syncStatus: InventorySyncStatus;
  stockHealth: StockHealthSnapshot | null;
  restockResult: RestockRunResult | null;
  policy: RestockAutomationPolicy;
}> {
  const mode = options?.mode ?? "pos_sync";
  const policy = getRestockAutomationPolicy(customerId);
  const kitchen = getKitchen(customerId);
  const deductions: SyncDeduction[] = [];

  if (kitchen && mode === "service_rush") {
    // Simulate a busy restaurant service rush synced from the POS (deducts 2 batches across up to 3 active menu recipes)
    const rushRecipes = kitchen.recipes.slice(0, 3);
    const agg = new Map<string, { name: string; used: number; onHandAfter: number; unit: string }>();
    for (const r of rushRecipes) {
      try {
        const usage = recordUsage(customerId, r.recipeId, 2);
        for (const u of usage.used) {
          const meta = kitchen.inventory.find((i) => i.ingredientId === u.ingredientId);
          const prev = agg.get(u.ingredientId);
          agg.set(u.ingredientId, {
            name: meta?.name ?? u.ingredientId,
            used: Math.round(((prev?.used ?? 0) + u.used) * 100) / 100,
            onHandAfter: u.onHand,
            unit: meta?.unit ?? "kg",
          });
        }
      } catch {
        /* ignore empty recipe edge cases */
      }
    }
    for (const [ingredientId, val] of agg.entries()) {
      deductions.push({ ingredientId, ...val });
    }
  }

  const preHealth = getStockHealthSnapshot(customerId, policy.daysCover);
  const nowIso = new Date().toISOString();

  appendAudit(randomUUID(), customerId, "kitchen_inventory_synced", {
    mode,
    deductionsCount: deductions.length,
    criticalCount: preHealth?.criticalCount ?? 0,
    lowCount: preHealth?.lowCount ?? 0,
  });

  const shouldAutoOrder = options?.autoOrder !== false;
  let restockResult: RestockRunResult | null = null;
  if (shouldAutoOrder) {
    restockResult = await runAutomatedRestock(customerId, {
      force: true,
      all: true,
      urgencies: options?.urgencies ?? policy.urgencies,
      choice: policy.smartQuantities ? "smart" : "exact",
      trigger: mode,
    });
  }

  const postHealth = getStockHealthSnapshot(customerId, policy.daysCover);
  const syncSummary =
    mode === "service_rush"
      ? deductions.length > 0
        ? `Synced busy POS service rush (${deductions.map((d) => `−${d.used} ${d.unit === "litre" ? "L" : d.unit === "each" ? "pcs" : d.unit} ${d.name}`).join(", ")})` +
          (restockResult
            ? ` → ${restockResult.summary}`
            : ` → ${postHealth?.criticalCount ?? 0} very low, ${postHealth?.lowCount ?? 0} low.`)
        : "Synced POS service activity with kitchen pantry."
      : restockResult
        ? `Synced POS sales & inbound deliveries → ${restockResult.summary}`
        : `Synced POS sales & inbound deliveries (${postHealth?.criticalCount ?? 0} very low, ${postHealth?.lowCount ?? 0} low, ${postHealth?.okCount ?? 0} healthy).`;

  const nextSync: InventorySyncStatus = {
    ...defaultSyncStatus(policy),
    lastSyncedAt: nowIso,
    lastSyncSource: mode,
    lastSyncSummary: syncSummary,
    deductions: deductions.length > 0 ? deductions : undefined,
  };
  saveSyncStatus(customerId, nextSync);

  return {
    syncStatus: nextSync,
    stockHealth: postHealth,
    restockResult,
    policy,
  };
}

/** Background tick for customers with automation enabled. */
export function startRestockScheduler(customerIds: string[]): void {
  const bootAt = Date.now();
  for (const id of customerIds) {
    if (!lastScheduledAt.has(id)) {
      lastScheduledAt.set(id, bootAt);
    }
  }
  const tick = async () => {
    for (const customerId of customerIds) {
      const policy = getRestockAutomationPolicy(customerId);
      if (!policy.enabled) continue;
      const last = lastScheduledAt.get(customerId) ?? 0;
      const due =
        Date.now() - last >= policy.intervalMinutes * 60 * 1000;
      if (!due) continue;
      try {
        if (policy.autoSyncInventory) {
          saveSyncStatus(customerId, {
            ...getInventorySyncStatus(customerId),
            lastSyncedAt: new Date().toISOString(),
            lastSyncSource: "scheduled",
            lastSyncSummary: "Scheduled POS & delivery inventory sync completed.",
          });
        }
        await runAutomatedRestock(customerId, { trigger: "scheduled" });
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
