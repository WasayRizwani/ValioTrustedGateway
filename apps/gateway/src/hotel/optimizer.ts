/**
 * Smart restock: instead of ordering "exactly the shortfall", price the real choices and say why.
 *
 *  - Quantity: Valio prices are flat per pack, so the real lever is pack size. Rounding 12 kg up to
 *    two 10 kg bags can be cheaper per kg actually used than twelve 1 kg packs — if the surplus will be
 *    used before it spoils. We value surplus only up to what the recipes will use within shelf life.
 *  - Use first: stock close to its expiry date (or not touched for weeks) is flagged with the recipes
 *    that use it, before anything new is bought.
 * The mandate still gates every order; this only decides which offer and how many packs to propose.
 */
import type { Need } from "@tta/shared";
import { buildOffers } from "../catalog/offers.js";
import { getMandate } from "../auth/customers.js";
import { isDairyText } from "../policy/engine.js";
import { withAgent } from "../agents/context.js";
import {
  getKitchen,
  ingredientToNeed,
  recommendRestock,
  type IngredientStock,
  type Recipe,
  type RestockRecommendation,
} from "./kitchen.js";

export type QtyOption = {
  productId: string;
  productName: string;
  packs: number;
  packLabel: string;
  /** Quantity in the unit sent to Valio (kg / litre / each). */
  quantity: number;
  unit: string;
  /** Quantity in the hotel's own ingredient unit, credited to stock on delivery. */
  ingredientQuantity: number;
  totalEur: number;
  /** What each unit you actually use costs, once waste is counted. */
  effectivePerUnit: number;
  usedQty: number;
  surplusQty: number;
  wasteQty: number;
  wasteEur: number;
  why: string;
};

export type SmartLine = {
  ingredientId: string;
  name: string;
  urgency: string;
  unit: string;
  exact: QtyOption | null;
  smart: QtyOption | null;
  savingEur: number;
  /** Which one the agent will order unless told otherwise. */
  recommendation: "smart" | "exact";
  note: string;
  others: Array<{ productName: string; totalEur: number; effectivePerUnit: number; deltaPerUnit: number }>;
};

export type UseFirst = {
  ingredientId: string;
  name: string;
  kind: "expiring" | "slow_moving";
  qty: number;
  unit: string;
  headline: string;
  detail: string;
  daysToExpiry?: number;
  atRiskQty?: number;
  wasteEur?: number | null;
  recipes: Array<{ recipeId: string; name: string; extraBatches: number; uses: number }>;
};

export type SmartRestock = {
  hotelName: string;
  neededBy: string;
  lines: SmartLine[];
  useFirst: UseFirst[];
  totalSavingEur: number;
};

export function nextMondayIso(): string {
  const d = new Date();
  const day = d.getDay();
  const add = day === 0 ? 1 : day === 1 ? 7 : 8 - day;
  d.setDate(d.getDate() + add);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  return `${y}-${m}-${String(d.getDate()).padStart(2, "0")}`;
}

const r2 = (n: number) => Math.round(n * 100) / 100;

function mustBeLactoseFree(customerId: string, item: IngredientStock): boolean {
  const m = getMandate(customerId);
  return Boolean(
    item.lactoseFreePreferred ||
      (m?.allergenRestrictions.includes("must_be_lactose_free") && isDairyText(`${item.name} ${item.catalogHints.join(" ")}`)),
  );
}

function quantityCap(customerId: string, unit: string): number {
  const m = getMandate(customerId);
  if (!m) return Infinity;
  const cap = (m.maxQuantities as Record<string, number> | undefined)?.[unit];
  if (cap != null) return cap;
  return m.maxQuantity.unit === unit ? m.maxQuantity.value : Infinity;
}

/** Price the exact quantity against alternatives with different pack sizes / products. */
export async function optimizeLine(
  customerId: string,
  item: IngredientStock,
  rec: RestockRecommendation,
  neededBy: string,
  daysCover: number,
): Promise<SmartLine> {
  const base: SmartLine = {
    ingredientId: rec.ingredientId,
    name: rec.name,
    urgency: rec.urgency,
    unit: rec.unit,
    exact: null,
    smart: null,
    savingEur: 0,
    recommendation: "exact",
    note: "",
    others: [],
  };
  const need = ingredientToNeed(item, rec.suggestedOrderQty, neededBy, mustBeLactoseFree(customerId, item)) as Need;
  const offers = await buildOffers(customerId, need);
  const onTime = (o: { availableDate: string | null }) => !o.availableDate || o.availableDate <= neededBy;
  const deliverable = offers.filter((o) => o.canFulfil && onTime(o) && !o.isSubstitution);
  const counts = new Map<string, number>();
  for (const o of deliverable) counts.set(o.category ?? "", (counts.get(o.category ?? "") ?? 0) + 1);
  const mainCat = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
  const pool = deliverable.filter((o) => (o.category ?? "") === mainCat);
  if (!pool.length) return { ...base, note: "No deliverable offer found." };

  const needQty = need.quantity;
  const weight = item.unit === "each" && item.unitWeightKg ? item.unitWeightKg : 1;
  const dailyUse = (rec.weeklyRecipeDemand / 7) * weight;
  const shelf = item.shelfLifeDays ?? 14;
  // Extra stock is only worth buying if it is used well within shelf life, after the days this order already covers.
  const extraDays = Math.max(0, Math.floor(shelf * 0.6) - daysCover);
  const usableExtra = dailyUse * extraDays;
  const cap = quantityCap(customerId, need.unit);
  const mandate = getMandate(customerId);

  const options: QtyOption[] = pool.map((o) => {
    const surplus = Math.max(0, o.totalQuantity - needQty);
    const usedExtra = Math.min(surplus, usableExtra);
    const used = needQty + usedExtra;
    const waste = surplus - usedExtra;
    const unitCost = o.totalPrice / o.totalQuantity;
    return {
      productId: o.productId,
      productName: o.productName,
      packs: o.requiredPacks,
      packLabel: `${o.packSize}${String(o.packUnit).toLowerCase()}`,
      quantity: o.totalQuantity,
      unit: need.unit,
      ingredientQuantity: weight !== 1 ? Math.floor(o.totalQuantity / weight) : o.totalQuantity,
      totalEur: r2(o.totalPrice),
      effectivePerUnit: r2(o.totalPrice / used),
      usedQty: r2(used),
      surplusQty: r2(surplus),
      wasteQty: r2(waste),
      wasteEur: r2(waste * unitCost),
      why: "",
    };
  });

  // The agent's usual pick (price-first ranking) is the "exact" baseline.
  const exact = options.find((o) => o.productId === pool[0].productId) ?? options[0];
  exact.why = `Cheapest way to cover exactly ${needQty}${need.unit}: ${exact.packs} × ${exact.packLabel}.`;
  base.exact = exact;

  const eligible = options.filter(
    (o) =>
      o.productId !== exact.productId &&
      o.quantity <= cap &&
      (mandate ? o.totalEur <= mandate.maxOrderValueEur : true) &&
      o.totalEur <= exact.totalEur * 3,
  );
  const best = eligible.sort((a, b) => a.effectivePerUnit - b.effectivePerUnit)[0];
  base.others = options
    .filter((o) => o.productId !== exact.productId && o.totalEur <= exact.totalEur * 3)
    .sort((a, b) => a.effectivePerUnit - b.effectivePerUnit)
    .slice(0, 3)
    .map((o) => ({
      productName: o.productName,
      totalEur: o.totalEur,
      effectivePerUnit: o.effectivePerUnit,
      deltaPerUnit: r2(o.effectivePerUnit - exact.effectivePerUnit),
    }));

  if (best) {
    // What it would cost to get the same usable quantity the usual way.
    const saving = r2(exact.effectivePerUnit * best.usedQty - best.totalEur);
    if (saving >= Math.max(0.5, best.totalEur * 0.03)) {
      const extra = r2(best.quantity - needQty);
      best.why =
        `${best.packs} × ${best.packLabel} costs €${best.effectivePerUnit.toFixed(2)}/${need.unit} used vs €${exact.effectivePerUnit.toFixed(2)}/${need.unit}` +
        (extra > 0.001
          ? `. You get ${extra}${need.unit} more than needed; ${r2(best.usedQty - needQty)}${need.unit} of it is used within ${Math.max(1, Math.floor(shelf * 0.6))} days` +
            (best.wasteQty > 0.001 ? `, ~${best.wasteQty}${need.unit} may go to waste (€${best.wasteEur.toFixed(2)}).` : ".")
          : ".");
      base.smart = best;
      base.savingEur = saving;
      const extraCash = r2(best.totalEur - exact.totalEur);
      // Only switch automatically when the bigger buy is a modest step up; a bulk buy is offered, not assumed.
      base.recommendation = best.totalEur <= exact.totalEur * 2 ? "smart" : "exact";
      base.note =
        (extraCash > 0 ? `Costs €${extraCash.toFixed(2)} more today, ` : `Costs €${Math.abs(extraCash).toFixed(2)} less today, `) +
        `and works out about €${saving.toFixed(2)} cheaper for what you will use.` +
        (base.recommendation === "exact" ? " A bulk buy, so it needs your go-ahead." : "");
    } else {
      base.note = "The exact order is already the best price.";
    }
  } else {
    base.note = eligible.length === 0 && options.length > 1 ? "Other pack sizes are over your order limits." : "The exact order is already the best price.";
  }
  return base;
}

/** Recipes that would use up a given ingredient, with the extra batches needed. */
function recipesUsing(recipes: Recipe[], ingredientId: string, qty: number) {
  return recipes
    .map((r) => {
      const ing = r.ingredients.find((i) => i.ingredientId === ingredientId);
      if (!ing || ing.qtyPerBatch <= 0) return null;
      const extraBatches = Math.max(1, Math.min(4, Math.ceil(qty / ing.qtyPerBatch)));
      return { recipeId: r.recipeId, name: r.name, extraBatches, uses: r2(extraBatches * ing.qtyPerBatch) };
    })
    .filter((x): x is { recipeId: string; name: string; extraBatches: number; uses: number } => x !== null)
    .sort((a, b) => b.uses - a.uses)
    .slice(0, 3);
}

function lastUnitPrice(history: Array<{ lines: Array<{ ingredientId?: string; quantity: number; totalEur: number }> }>, ingredientId: string): number | null {
  for (const o of history)
    for (const l of o.lines) if (l.ingredientId === ingredientId && l.quantity > 0 && l.totalEur > 0) return l.totalEur / l.quantity;
  return null;
}

export function useFirstFor(customerId: string): UseFirst[] {
  const k = getKitchen(customerId);
  if (!k) return [];
  const rec = recommendRestock(customerId)?.recommendations ?? [];
  const out: UseFirst[] = [];
  for (const r of rec) {
    const price = lastUnitPrice(k.orderHistory, r.ingredientId);
    if (r.atRiskQty != null && r.atRiskQty > 0.4 && r.daysToExpiry != null && r.daysToExpiry <= 7) {
      const recipes = recipesUsing(k.recipes, r.ingredientId, r.atRiskQty);
      out.push({
        ingredientId: r.ingredientId,
        name: r.name,
        kind: "expiring",
        qty: r.atRiskQty,
        unit: r.unit,
        daysToExpiry: r.daysToExpiry,
        atRiskQty: r.atRiskQty,
        wasteEur: price != null ? r2(price * r.atRiskQty) : null,
        headline: `${r.atRiskQty}${r.unit} of ${r.name.toLowerCase()} won't be used before it expires${r.daysToExpiry <= 0 ? " (today)" : ` in ${r.daysToExpiry} day${r.daysToExpiry === 1 ? "" : "s"}`}`,
        detail: recipes.length
          ? `Use it first: ${recipes.map((x) => `${x.extraBatches} extra batch${x.extraBatches === 1 ? "" : "es"} of ${x.name}`).join(" or ")}.`
          : "Plan a menu item that uses it.",
        recipes,
      });
    } else if (r.daysSinceUse != null && r.daysSinceUse >= 14 && r.onHand > 0) {
      const recipes = recipesUsing(k.recipes, r.ingredientId, r.onHand / 2);
      out.push({
        ingredientId: r.ingredientId,
        name: r.name,
        kind: "slow_moving",
        qty: r.onHand,
        unit: r.unit,
        wasteEur: price != null ? r2(price * r.onHand) : null,
        headline: `${r.onHand}${r.unit} of ${r.name.toLowerCase()} untouched for ${r.daysSinceUse} days`,
        detail: `Counted as stock, so the agent won't reorder it.${recipes.length ? ` Put it back on the menu: ${recipes.map((x) => x.name).join(", ")}.` : ""}`,
        recipes,
      });
    }
  }
  return out.sort((a, b) => (a.kind === b.kind ? 0 : a.kind === "expiring" ? -1 : 1));
}

export async function smartRestock(customerId: string, options?: { daysCover?: number }): Promise<SmartRestock | null> {
  const daysCover = options?.daysCover ?? 7;
  const k = getKitchen(customerId);
  const rec = recommendRestock(customerId, { daysCover });
  if (!k || !rec) return null;
  const neededBy = nextMondayIso();
  const todo = rec.recommendations.filter((r) => r.urgency !== "ok" && r.suggestedOrderQty > 0);
  const lines = await withAgent("planner", async () => {
    const out: SmartLine[] = [];
    for (const r of todo) {
      const item = k.inventory.find((i) => i.ingredientId === r.ingredientId);
      if (!item) continue;
      try {
        out.push(await optimizeLine(customerId, item, r, neededBy, daysCover));
      } catch (e) {
        out.push({
          ingredientId: r.ingredientId,
          name: r.name,
          urgency: r.urgency,
          unit: r.unit,
          exact: null,
          smart: null,
          savingEur: 0,
          recommendation: "exact",
          note: `Could not price this: ${e instanceof Error ? e.message : String(e)}`,
          others: [],
        });
      }
    }
    return out;
  });
  return {
    hotelName: k.hotelName,
    neededBy,
    lines,
    useFirst: useFirstFor(customerId),
    totalSavingEur: r2(lines.reduce((s, l) => s + l.savingEur, 0)),
  };
}
