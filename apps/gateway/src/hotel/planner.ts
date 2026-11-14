/**
 * Recipe-driven sourcing: menu / event → ingredient requirements → shortfalls → Valio offers,
 * with recipe-compatible substitutions (allergen + lactose + unit constraints) instead of a
 * blind SKU swap. Nothing is ordered here unless `createIntents` is set, and every intent still
 * passes through the mandate policy (substitutions need human sign-off by default).
 */
import type { Mandate, Need, Offer } from "@tta/shared";
import { buildOffers } from "../catalog/offers.js";
import { getProduct, getValioSubstitutes, allergenConflicts, isLactoseFree } from "../catalog/index.js";
import {
  inferAnchorCategory,
  isDeterministicallyCompatible,
  judgeRecipeSubstitutesWithLlm,
  type JudgeIngredientInput,
} from "../catalog/substituteJudge.js";
import { createOrderIntent } from "../orders/store.js";
import { isDairyText } from "../policy/engine.js";
import { appendAudit } from "../audit/chain.js";
import { withAgent } from "../agents/context.js";
import { randomUUID } from "node:crypto";
import {
  getKitchen,
  weeklyDemand,
  ingredientToNeed,
  type IngredientStock,
  type Recipe,
} from "./kitchen.js";

export type PlanRequest = {
  neededBy: string;
  /** Recipes to cook; `batches` defaults to the recipe's weekly batches. */
  recipes?: Array<{ recipeId: string; batches?: number }>;
  /** Restrict to specific ingredients (used for stock-out handling). */
  onlyIngredients?: string[];
  createIntents?: boolean;
  runId?: string;
  /** Stock-out: pending Valio orders for these ingredients will not arrive, so don't count them. */
  ignoreOnOrderFor?: string[];
  /** Stock-out: product ids that can no longer be supplied. */
  excludeProductIds?: string[];
  /** Extra ingredients on top of recipes (e.g. event add-ons). */
  extras?: Array<{ ingredientId: string; qty: number }>;
  extrasLabel?: string;
  /**
   * Planning for a one-off peak (event): the kitchen keeps using its usual weekly volume until this date,
   * so only stock beyond that usual use counts toward the event.
   */
  baselineUntil?: string;
  /** Optional test/runtime override for the Stage-2 batched LLM culinary judge. */
  judgeOptions?: {
    fetchImpl?: typeof fetch;
    forceEnableInTests?: boolean;
    timeoutMs?: number;
  };
};

export type SubstituteOption = {
  label: "good" | "better" | "best";
  productId: string;
  productName: string;
  totalPrice: number;
  availableDate: string | null;
  deliveryReliability: number | null;
  tradeOff: string;
  culinaryNote?: string;
  verifiedBy?: "llm_judge" | "catalog_declared" | "category_gate";
};

export type IngredientLine = {
  usualUse?: number;
  ingredientId: string;
  name: string;
  unit: string;
  required: number;
  onHand: number;
  onOrder: number;
  shortfall: number;
  usedBy: string[];
  status: "covered" | "sourced" | "substitute_proposed" | "partial" | "unsourceable";
  chosen?: {
    productId: string;
    productName: string;
    totalPrice: number;
    availableDate: string | null;
    isSubstitution: boolean;
  };
  substitutes: SubstituteOption[];
  intent?: { id: string; status: string; reasons: string[] };
  explanation: string;
};

export type PlanResult = {
  neededBy: string;
  runId: string;
  lines: IngredientLine[];
  summary: string;
  flags: string[];
};

function requirements(recipes: Recipe[], request: PlanRequest) {
  const req = new Map<string, { qty: number; usedBy: Set<string> }>();
  const chosen = request.recipes
    ? request.recipes
    : recipes.map((r) => ({ recipeId: r.recipeId, batches: undefined as number | undefined }));
  for (const sel of chosen) {
    const r = recipes.find((x) => x.recipeId === sel.recipeId);
    if (!r) throw new Error(`unknown recipe ${sel.recipeId}`);
    const batches = sel.batches ?? r.batchesPerWeek;
    for (const ing of r.ingredients) {
      const e = req.get(ing.ingredientId) ?? { qty: 0, usedBy: new Set<string>() };
      e.qty += ing.qtyPerBatch * batches;
      e.usedBy.add(r.name);
      req.set(ing.ingredientId, e);
    }
  }
  for (const x of request.extras ?? []) {
    const e = req.get(x.ingredientId) ?? { qty: 0, usedBy: new Set<string>() };
    e.qty += x.qty;
    e.usedBy.add(request.extrasLabel ?? "extras");
    req.set(x.ingredientId, e);
  }
  return req;
}

/** A substitute must satisfy the *ingredient's* constraints, not just look similar. */
export function mustBeLactoseFree(mandate: Mandate, item: IngredientStock): boolean {
  return (
    Boolean(item.lactoseFreePreferred) ||
    (mandate.allergenRestrictions.includes("must_be_lactose_free") &&
      isDairyText(`${item.name} ${item.catalogHints.join(" ")}`))
  );
}

function itemQueryContext(item: IngredientStock): string {
  return [item.name, ...item.catalogHints].filter(Boolean).join(" ");
}

export function recipeCompatible(
  item: IngredientStock,
  offer: Offer,
  lf: boolean,
  anchorCategory: string | null = null,
): { ok: boolean; why: string } {
  if (lf && !isLactoseFree({ name: offer.productName, labels: offer.labels, claims: offer.claims })) {
    return { ok: false, why: "not lactose-free" };
  }
  const conflicts = allergenConflicts(
    { contains: offer.allergens, mayContain: offer.mayContain },
    item.excludeAllergens ?? [],
  );
  if (conflicts.length) {
    return { ok: false, why: `${conflicts[0].level} ${conflicts[0].found}` };
  }
  const prod = getProduct(offer.productId);
  const det = isDeterministicallyCompatible({
    queryText: itemQueryContext(item),
    anchorCategory,
    candidate: {
      productId: offer.productId,
      name: offer.productName,
      nameFi: prod?.nameFi,
      category: offer.category ?? prod?.category ?? null,
      isValioDeclaredSub: offer.substitutionSource === "valio_catalog",
    },
  });
  if (!det.ok) {
    return { ok: false, why: det.reason };
  }
  return { ok: true, why: "meets category, culinary, lactose and allergen constraints" };
}

function tradeOff(offer: Offer, reference: Offer | undefined, neededBy: string): string {
  const bits: string[] = [];
  if (reference) {
    const d = offer.totalPrice - reference.totalPrice;
    bits.push(`${d >= 0 ? "+" : "−"}€${Math.abs(d).toFixed(2)} vs top-ranked`);
  }
  bits.push(
    offer.availableDate && offer.availableDate <= neededBy
      ? `arrives ${offer.availableDate} (in time)`
      : `arrives ${offer.availableDate ?? "unknown"} (late)`,
  );
  bits.push(
    offer.deliveryReliability != null
      ? `${Math.round(offer.deliveryReliability * 100)}% on-time history`
      : "reliability unknown",
  );
  return bits.join(" · ");
}

export function planSourcing(customerId: string, mandate: Mandate, request: PlanRequest): Promise<PlanResult> {
  return withAgent("planner", () => planSourcingImpl(customerId, mandate, request));
}

async function planSourcingImpl(customerId: string, mandate: Mandate, request: PlanRequest): Promise<PlanResult> {
  const k = getKitchen(customerId);
  if (!k) throw new Error("no_kitchen_profile");
  const runId = request.runId ?? randomUUID();
  const req = requirements(k.recipes, request);
  const inbound = new Map<string, number>();
  for (const o of k.orderHistory) {
    if (o.status !== "committed") continue;
    for (const l of o.lines) {
      if (l.ingredientId) inbound.set(l.ingredientId, (inbound.get(l.ingredientId) ?? 0) + l.quantity);
    }
  }

  appendAudit(runId, customerId, "menu_plan_started", {
    neededBy: request.neededBy,
    recipes: request.recipes ?? "all",
    only: request.onlyIngredients ?? null,
  });

  type PendingShortfallWork = {
    slotIndex: number;
    item: IngredientStock;
    usedBy: string[];
    shortfall: number;
    need: Need;
    compatible: Offer[];
    primary: Offer | undefined;
    reference: Offer | undefined;
    stage1AltPool: Offer[];
  };

  const lines: IngredientLine[] = [];
  const pendingWork: PendingShortfallWork[] = [];
  const inTime = (o: Offer) => !o.availableDate || o.availableDate <= request.neededBy;

  for (const [ingredientId, r] of req) {
    if (request.onlyIngredients?.length && !request.onlyIngredients.includes(ingredientId)) continue;
    const item = k.inventory.find((i) => i.ingredientId === ingredientId);
    if (!item) continue;
    const onOrder = request.ignoreOnOrderFor?.includes(ingredientId) ? 0 : (inbound.get(ingredientId) ?? 0);
    const usual = request.baselineUntil
      ? (weeklyDemand(k.recipes, ingredientId) * Math.max(0, (new Date(`${request.baselineUntil}T12:00:00`).getTime() - Date.now()) / 86_400_000)) / 7
      : 0;
    const shortfall = Math.max(0, Math.ceil((r.qty + usual - item.onHand - onOrder) * 10) / 10);
    const base: IngredientLine = {
      ingredientId,
      name: item.name,
      unit: item.unit,
      required: Math.round(r.qty * 10) / 10,
      onHand: item.onHand,
      onOrder,
      shortfall,
      usedBy: [...r.usedBy],
      status: "covered",
      substitutes: [],
      usualUse: Math.round(usual * 10) / 10,
      explanation: `Needs ${r.qty.toFixed(1)}${item.unit}${usual > 0 ? ` on top of ~${usual.toFixed(1)}${item.unit} you'll use as usual` : ""}; ${item.onHand} on hand${onOrder ? ` + ${onOrder} on order` : ""} — covered.`,
    };
    if (shortfall <= 0) {
      lines.push(base);
      continue;
    }

    const lf = mustBeLactoseFree(mandate, item);
    const need: Need = ingredientToNeed(item, shortfall, request.neededBy, lf);
    const extraHints = item.catalogHints.slice(1);
    let offers: Offer[] = [];
    try {
      offers = await withAgent("sourcing", () =>
        buildOffers(customerId, need, {
          includeSubstitutions: false,
          extraSearchHints: extraHints.length ? extraHints : undefined,
        }),
      );
    } catch (e) {
      base.status = "unsourceable";
      base.explanation = `Could not query Valio for ${item.name}: ${e instanceof Error ? e.message : e}`;
      lines.push(base);
      continue;
    }
    if (request.excludeProductIds?.length) {
      const origin = new Map<string, string>();
      for (const ex of request.excludeProductIds)
        for (const id of getValioSubstitutes(ex)) origin.set(id, getProduct(ex)?.name ?? ex);
      const missing = [...origin.keys()].filter((id) => !offers.some((o) => o.productId === id));
      if (missing.length) {
        offers = [...offers, ...(await buildOffers(customerId, need, { productIds: missing.slice(0, 12), includeSubstitutions: false }))];
      }
      // Whether found by search or fetched by id, anything Valio declares as a substitute is labelled as such.
      for (const o of offers) {
        if (origin.has(o.productId)) {
          o.isSubstitution = true;
          o.substitutionSource = "valio_catalog";
          o.substituteFor = origin.get(o.productId);
        }
      }
    }

    const anchorCategory = inferAnchorCategory(
      offers.map((o) => ({
        name: o.productName,
        nameFi: getProduct(o.productId)?.nameFi,
        category: o.category,
      })),
      itemQueryContext(item),
    );
    const compatible = offers.filter(
      (o) => !request.excludeProductIds?.includes(o.productId) && recipeCompatible(item, o, lf, anchorCategory).ok,
    );
    const primary = compatible.find((o) => o.canFulfil && inTime(o));
    const reference = compatible[0];

    // Stage-1 recipe-compatible shortlist (up to 6 candidates sent to Stage-2 batched LLM culinary judge)
    const stage1AltPool = compatible
      .filter((o) => o !== primary && inTime(o))
      .sort(
        (a, b) =>
          Number(b.substitutionSource === "valio_catalog") - Number(a.substitutionSource === "valio_catalog") ||
          Number(b.canFulfil) - Number(a.canFulfil) ||
          b.score - a.score,
      )
      .slice(0, 6);

    const slotIndex = lines.length;
    lines.push(base);
    pendingWork.push({
      slotIndex,
      item,
      usedBy: [...r.usedBy],
      shortfall,
      need,
      compatible,
      primary,
      reference,
      stage1AltPool,
    });
  }

  // Stage-2: One batched LLM culinary judge call across all shortfall ingredients in this plan (cached + fallback)
  const judgeInputs: JudgeIngredientInput[] = pendingWork
    .filter((w) => w.stage1AltPool.length > 0)
    .map((w) => ({
      ingredientId: w.item.ingredientId,
      ingredientName: w.item.name,
      unit: w.item.unit,
      requiredQty: w.shortfall,
      recipes: w.usedBy,
      primary: w.primary
        ? {
            productId: w.primary.productId,
            productName: w.primary.productName,
            category: w.primary.category,
          }
        : null,
      candidates: w.stage1AltPool.map((o) => ({
        productId: o.productId,
        productName: o.productName,
        category: o.category,
        packSize: o.packSize,
        packUnit: o.packUnit,
        totalPrice: o.totalPrice,
        isValioDeclaredSub: o.substitutionSource === "valio_catalog",
      })),
    }));

  const judgeBatch = await judgeRecipeSubstitutesWithLlm(judgeInputs, request.judgeOptions);
  const labels: Array<"best" | "better" | "good"> = ["best", "better", "good"];

  for (const w of pendingWork) {
    const base = lines[w.slotIndex]!;
    const verdict = judgeBatch.byIngredient.get(w.item.ingredientId);
    const vettedPool = verdict
      ? w.stage1AltPool.filter((o) => verdict.approvedIds.has(o.productId))
      : w.stage1AltPool;
    const altPool = vettedPool.slice(0, 3);

    base.substitutes = altPool.map((o, i) => {
      const culinaryNote = verdict?.notes.get(o.productId);
      const verifiedBy: SubstituteOption["verifiedBy"] =
        o.substitutionSource === "valio_catalog"
          ? "catalog_declared"
          : judgeBatch.source === "deterministic_fallback"
            ? "category_gate"
            : "llm_judge";
      return {
        label: labels[i],
        productId: o.productId,
        productName: o.productName,
        totalPrice: o.totalPrice,
        availableDate: o.availableDate,
        deliveryReliability: o.deliveryReliability,
        ...(culinaryNote ? { culinaryNote } : {}),
        verifiedBy,
        tradeOff:
          (o.substitutionSource === "valio_catalog" ? `Valio-declared substitute${o.substituteFor ? ` for ${o.substituteFor}` : ""} · ` : "") +
          (o.canFulfil ? "" : `PARTIAL (short ${o.shortfall} packs) · `) +
          tradeOff(o, w.primary ?? w.reference, request.neededBy),
      };
    });

    // Stock-out: a substitute Valio itself declares for the missing SKU beats an arbitrary alternative.
    const declared = request.excludeProductIds?.length
      ? w.compatible.find(
          (o) =>
            o.substitutionSource === "valio_catalog" &&
            o.canFulfil &&
            inTime(o) &&
            (!verdict || verdict.approvedIds.has(o.productId)),
        )
      : undefined;
    let pick: Offer | undefined = declared ?? w.primary;
    let isSub = Boolean(declared);
    if (declared) {
      base.status = "substitute_proposed";
      base.explanation = `${base.name} can't be supplied as before. Valio's own catalog lists ${declared.productName} as a substitute (${tradeOff(declared, w.primary ?? w.reference, request.neededBy)}); lactose/allergen constraints for ${w.usedBy.join(", ")} still hold.`;
    } else if (w.primary) {
      base.status = "sourced";
      base.explanation = `Short ${w.shortfall}${w.item.unit} for ${w.usedBy.join(", ")}; best in-time compatible offer is ${w.primary.productName} at €${w.primary.totalPrice.toFixed(2)}.`;
    } else if (altPool[0]) {
      pick = altPool[0];
      isSub = true;
      base.status = pick.canFulfil ? "substitute_proposed" : "partial";
      base.explanation = `Exact request can't be met by ${request.neededBy}. Recipe-compatible substitute: ${pick.productName} (${base.substitutes[0].tradeOff}). Kept lactose/allergen constraints for ${w.usedBy.join(", ")}.`;
    } else {
      base.status = "unsourceable";
      base.explanation = `Nothing compatible can reach you by ${request.neededBy} for ${w.item.name}. Affected recipes: ${w.usedBy.join(", ")}. Consider moving the date or changing the menu.`;
    }

    if (pick) {
      base.chosen = {
        productId: pick.productId,
        productName: pick.productName,
        totalPrice: pick.totalPrice,
        availableDate: pick.availableDate,
        isSubstitution: isSub,
      };
      if (request.createIntents) {
        try {
          const res = await createOrderIntent({
            customerId,
            mandate,
            need: w.need,
            runId,
            offerProductId: pick.productId,
            markSubstitution: isSub,
            substitutionLabel: isSub ? base.substitutes[0]?.label : undefined,
          });
          base.intent = {
            id: res.intent.id,
            status: res.intent.status,
            reasons: res.intent.policy.reasons,
          };
        } catch (e) {
          base.explanation += ` Intent failed: ${e instanceof Error ? e.message : e}`;
        }
      }
    }
  }

  const flags = lines
    .filter((l) => l.status === "unsourceable" || l.status === "partial")
    .map((l) => `${l.name}: ${l.status} — affects ${l.usedBy.join(", ")}`);
  const needing = lines.filter((l) => l.shortfall > 0);
  const total = needing.reduce((s, l) => s + (l.chosen?.totalPrice ?? 0), 0);
  const n = (st: string) => lines.filter((l) => l.status === st).length;
  const atRisk = lines.filter((l) => l.status === "partial" || l.status === "unsourceable").length;
  const parts = [
    n("covered") ? `${n("covered")} already in stock or on order` : "",
    n("sourced") ? `${n("sourced")} to buy from Valio` : "",
    n("substitute_proposed") ? `${n("substitute_proposed")} need a substitute` : "",
    atRisk ? `${atRisk} at risk` : "",
  ].filter(Boolean);
  const summary =
    `${lines.length} ingredients checked for ${request.neededBy}: ${parts.join(", ") || "nothing to buy"}. ` +
    `Estimated purchase €${total.toFixed(2)}${request.createIntents ? " (orders created; the audit trail shows what was actually placed)" : ""}.`;

  appendAudit(runId, customerId, "menu_plan_completed", {
    summary,
    flags,
    substituteJudge: {
      source: judgeBatch.source,
      model: judgeBatch.model,
      vetoedCount: judgeBatch.totalVetoed,
    },
  });
  return { neededBy: request.neededBy, runId, lines, summary, flags };
}

/** Stock-out: a product ran out mid-week — find affected recipes and a recipe-compatible fix. */
export async function handleStockout(
  customerId: string,
  mandate: Mandate,
  params: {
    ingredientId: string;
    neededBy: string;
    createIntents?: boolean;
    /** The specific SKU that ran out, if known. */
    productId?: string;
  },
): Promise<PlanResult & { affectedRecipes: string[] }> {
  const k = getKitchen(customerId);
  if (!k) throw new Error("no_kitchen_profile");
  const affected = k.recipes.filter((r) =>
    r.ingredients.some((i) => i.ingredientId === params.ingredientId),
  );
  const item = k.inventory.find((i) => i.ingredientId === params.ingredientId);
  if (!item) throw new Error("unknown_ingredient");
  // Treat the supplier-side stock-out as zero cover: plan against the full week's demand.
  const plan = await planSourcing(customerId, mandate, {
    neededBy: params.neededBy,
    recipes: affected.map((r) => ({ recipeId: r.recipeId })),
    onlyIngredients: [params.ingredientId],
    createIntents: params.createIntents,
    ignoreOnOrderFor: [params.ingredientId],
    excludeProductIds: params.productId ? [params.productId] : undefined,
  });
  return { ...plan, affectedRecipes: affected.map((r) => r.name) };
}
