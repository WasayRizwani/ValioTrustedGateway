/**
 * Buyer-side kitchen context (inventory, recipes, order history) for the purchasing agent.
 * Valio mock APIs don't expose this — it belongs to the hotel. It is persisted in SQLite,
 * seeded with demo data on first run, and kept in sync by:
 *   - write APIs (inventory / recipes / import),
 *   - committed orders (inbound stock), and
 *   - delivery receipts / recipe usage (on-hand updates).
 */
import { getDb } from "../audit/chain.js";

export type IngredientStock = {
  ingredientId: string;
  name: string;
  onHand: number;
  unit: "kg" | "litre" | "each" | "pack";
  parLevel: number;
  catalogHints: string[]; // search terms for Valio catalog
  lactoseFreePreferred?: boolean;
  /** Allergens a purchased product must NOT contain (e.g. "nuts", "gluten"). */
  excludeAllergens?: string[];
  /** For piece-counted goods sold by weight (eggs): kg per piece, used to size the Valio order. */
  unitWeightKg?: number;
  /** How long a delivery keeps. Drives expiry dates on arrival and how much extra is safe to stock up on. */
  shelfLifeDays?: number;
  /** Earliest expiry date (YYYY-MM-DD) of the stock on hand. */
  expiresOn?: string;
  /** Last day a recipe used this ingredient (YYYY-MM-DD). */
  lastUsedAt?: string;
};

export type Recipe = {
  recipeId: string;
  name: string;
  servingsPerBatch: number;
  batchesPerWeek: number;
  ingredients: Array<{
    ingredientId: string;
    qtyPerBatch: number;
    unit: "kg" | "litre" | "each" | "pack";
  }>;
};

export type PastOrder = {
  orderId: string;
  orderedAt: string;
  status: "delivered" | "committed" | "partial";
  intentId?: string;
  deliveredAt?: string;
  lines: Array<{
    productName: string;
    quantity: number;
    unit: string;
    totalEur: number;
    ingredientId?: string;
  }>;
};

export type RestockRecommendation = {
  ingredientId: string;
  name: string;
  onHand: number;
  parLevel: number;
  weeklyRecipeDemand: number;
  suggestedOrderQty: number;
  unit: string;
  urgency: "critical" | "low" | "ok";
  /** Quantity we aim to hold: the larger of par and recipe demand for the planning horizon. */
  targetQty: number;
  reason: string;
  catalogHints: string[];
  lactoseFreePreferred?: boolean;
  recentOrderTrend?: string;
  /** True when suggested qty diverges sharply from recent standing-order pattern */
  standingOrderDrift?: boolean;
  standingOrderAvgQty?: number;
  /** Quantity already committed with Valio but not yet received. */
  onOrder?: number;
  excludeAllergens?: string[];
  unitWeightKg?: number;
  shelfLifeDays?: number;
  expiresOn?: string;
  daysToExpiry?: number;
  /** Quantity that will not be used before it expires, at the current usage rate. */
  atRiskQty?: number;
  lastUsedAt?: string;
  daysSinceUse?: number;
};

export type HotelKitchen = {
  customerId: string;
  hotelName: string;
  inventory: IngredientStock[];
  recipes: Recipe[];
  orderHistory: PastOrder[];
};

function daysAgo(n: number): string {
  const d = new Date();
  d.setDate(d.getDate() - n);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function daysBetween(a: string, b: string): number {
  return Math.round((Date.parse(`${b}T12:00:00Z`) - Date.parse(`${a}T12:00:00Z`)) / 86400000);
}

function daysFromNow(n: number): string {
  return daysAgo(-n);
}

/** Demo freshness data, relative to today, applied when a kitchen is seeded. */
const SEED_FRESHNESS: Record<string, { shelfLifeDays: number; expiresInDays?: number; lastUsedDaysAgo?: number }> = {
  "ing-milk-lf": { shelfLifeDays: 10, expiresInDays: 5, lastUsedDaysAgo: 0 },
  "ing-cream-lf": { shelfLifeDays: 12, expiresInDays: 2, lastUsedDaysAgo: 1 },
  "ing-banana": { shelfLifeDays: 6, expiresInDays: 3, lastUsedDaysAgo: 0 },
  "ing-yogurt-lf": { shelfLifeDays: 21, expiresInDays: 6, lastUsedDaysAgo: 0 },
  "ing-butter": { shelfLifeDays: 60, expiresInDays: 4, lastUsedDaysAgo: 1 },
  "ing-eggs": { shelfLifeDays: 28, expiresInDays: 18, lastUsedDaysAgo: 0 },
  "ing-oats": { shelfLifeDays: 365, expiresInDays: 200, lastUsedDaysAgo: 26 },
};

const seedKitchens = new Map<string, HotelKitchen>([
  [
    "HOTEL-001",
    {
      customerId: "HOTEL-001",
      hotelName: "Hotel ABC Helsinki",
      inventory: [
        {
          ingredientId: "ing-milk-lf",
          name: "Lactose-free milk",
          onHand: 18,
          unit: "litre",
          parLevel: 80,
          catalogHints: ["lactose-free milk", "eila milk"],
          lactoseFreePreferred: true,
        },
        {
          ingredientId: "ing-cream-lf",
          name: "Lactose-free cooking cream",
          onHand: 6,
          unit: "litre",
          parLevel: 20,
          catalogHints: ["lactose-free cream", "cooking cream"],
          lactoseFreePreferred: true,
        },
        {
          ingredientId: "ing-banana",
          name: "Bananas",
          onHand: 4,
          unit: "kg",
          parLevel: 25,
          catalogHints: ["banana", "BANANA KG"],
        },
        {
          ingredientId: "ing-yogurt-lf",
          name: "Lactose-free yogurt",
          onHand: 12,
          unit: "kg",
          parLevel: 15,
          catalogHints: ["lactose-free yogurt", "eila yogurt"],
          lactoseFreePreferred: true,
        },
        {
          ingredientId: "ing-butter",
          name: "Butter",
          onHand: 8,
          unit: "kg",
          parLevel: 10,
          catalogHints: ["lactose-free butter", "butter", "voi"],
          lactoseFreePreferred: true,
        },
        {
          ingredientId: "ing-eggs",
          name: "Eggs",
          onHand: 90,
          unit: "each",
          parLevel: 120,
          catalogHints: ["egg", "kananmuna"],
          unitWeightKg: 0.058,
        },
        {
          ingredientId: "ing-oats",
          name: "Rolled oats",
          onHand: 14,
          unit: "kg",
          parLevel: 12,
          catalogHints: ["rolled oats", "oat flakes", "kaurahiutale"],
        },
      ],
      recipes: [
        {
          recipeId: "rcp-breakfast-bowl",
          name: "Breakfast banana-yogurt bowl",
          servingsPerBatch: 40,
          batchesPerWeek: 7,
          ingredients: [
            { ingredientId: "ing-banana", qtyPerBatch: 3.5, unit: "kg" },
            { ingredientId: "ing-yogurt-lf", qtyPerBatch: 4, unit: "kg" },
            { ingredientId: "ing-oats", qtyPerBatch: 1.2, unit: "kg" },
            { ingredientId: "ing-milk-lf", qtyPerBatch: 2, unit: "litre" },
          ],
        },
        {
          recipeId: "rcp-pancake",
          name: "Hotel buttermilk pancakes (LF milk)",
          servingsPerBatch: 50,
          batchesPerWeek: 5,
          ingredients: [
            { ingredientId: "ing-milk-lf", qtyPerBatch: 6, unit: "litre" },
            { ingredientId: "ing-eggs", qtyPerBatch: 30, unit: "each" },
            { ingredientId: "ing-butter", qtyPerBatch: 0.8, unit: "kg" },
            { ingredientId: "ing-banana", qtyPerBatch: 1.5, unit: "kg" },
          ],
        },
        {
          recipeId: "rcp-salmon-sauce",
          name: "Cream sauce for evening salmon",
          servingsPerBatch: 30,
          batchesPerWeek: 4,
          ingredients: [
            { ingredientId: "ing-cream-lf", qtyPerBatch: 3, unit: "litre" },
            { ingredientId: "ing-butter", qtyPerBatch: 0.4, unit: "kg" },
          ],
        },
        {
          recipeId: "rcp-smoothie",
          name: "Lobby banana smoothie",
          servingsPerBatch: 25,
          batchesPerWeek: 6,
          ingredients: [
            { ingredientId: "ing-banana", qtyPerBatch: 2.5, unit: "kg" },
            { ingredientId: "ing-milk-lf", qtyPerBatch: 5, unit: "litre" },
            { ingredientId: "ing-yogurt-lf", qtyPerBatch: 1.5, unit: "kg" },
          ],
        },
      ],
      orderHistory: [
        {
          orderId: "HIST-8841",
          orderedAt: daysAgo(3),
          status: "delivered",
          lines: [
            {
              productName: "Valio Eila lactose-free milk 10 L",
              quantity: 40,
              unit: "L",
              totalEur: 125.2,
            },
            {
              productName: "BANANA KG",
              quantity: 15,
              unit: "KG",
              totalEur: 28.5,
            },
          ],
        },
        {
          orderId: "HIST-8790",
          orderedAt: daysAgo(10),
          status: "delivered",
          lines: [
            {
              productName: "Valio Eila lactose-free milk 10 L",
              quantity: 50,
              unit: "L",
              totalEur: 156.5,
            },
            {
              productName: "Lactose-free cooking cream",
              quantity: 12,
              unit: "L",
              totalEur: 48.0,
            },
            {
              productName: "BANANA 4.5KG",
              quantity: 9,
              unit: "KG",
              totalEur: 22.0,
            },
          ],
        },
        {
          orderId: "HIST-8702",
          orderedAt: daysAgo(17),
          status: "partial",
          lines: [
            {
              productName: "Valio Eila lactose-free milk 10 L",
              quantity: 30,
              unit: "L",
              totalEur: 93.9,
            },
            {
              productName: "BANANA KG",
              quantity: 8,
              unit: "KG",
              totalEur: 15.2,
            },
          ],
        },
        {
          orderId: "HIST-8611",
          orderedAt: daysAgo(24),
          status: "delivered",
          lines: [
            {
              productName: "Lactose-free yogurt",
              quantity: 20,
              unit: "KG",
              totalEur: 62.0,
            },
            {
              productName: "Butter",
              quantity: 10,
              unit: "KG",
              totalEur: 85.0,
            },
          ],
        },
      ],
    },
  ],
  [
    "SCHOOL-001",
    {
      customerId: "SCHOOL-001",
      hotelName: "City School Kitchen",
      inventory: [
        {
          ingredientId: "ing-milk-lf",
          name: "Lactose-free milk",
          onHand: 40,
          unit: "litre",
          parLevel: 60,
          catalogHints: ["lactose-free milk"],
          lactoseFreePreferred: true,
        },
      ],
      recipes: [
        {
          recipeId: "rcp-school-milk",
          name: "Daily milk service",
          servingsPerBatch: 200,
          batchesPerWeek: 5,
          ingredients: [
            { ingredientId: "ing-milk-lf", qtyPerBatch: 40, unit: "litre" },
          ],
        },
      ],
      orderHistory: [
        {
          orderId: "SCH-100",
          orderedAt: daysAgo(7),
          status: "delivered",
          lines: [
            {
              productName: "Lactose-free milk 1L",
              quantity: 80,
              unit: "L",
              totalEur: 88,
            },
          ],
        },
      ],
    },
  ],
]);

// ───────────────────────── persistence ─────────────────────────

const iso = (d = new Date()) => d.toISOString();

function db() {
  return getDb();
}

function inferIngredientId(
  inventory: IngredientStock[],
  productName: string,
): string | undefined {
  const name = productName.toLowerCase();
  const lf = /lactose|laktoositon/.test(name);
  const scored = inventory
    .map((i) => {
      const hits = i.catalogHints.filter((h) => {
        const words = h.toLowerCase().split(/[\s-]+/).filter((w) => w !== "lactose" && w !== "free");
        return words.length > 0 && words.every((w) => name.includes(w));
      }).length;
      return { id: i.ingredientId, hits, lfMatch: Boolean(i.lactoseFreePreferred) === lf };
    })
    .filter((x) => x.hits > 0)
    .sort((a, b) => Number(b.lfMatch) - Number(a.lfMatch) || b.hits - a.hits);
  return scored[0]?.id;
}

async function seedCustomer(customerId: string) {
  const seed = seedKitchens.get(customerId);
  if (!seed) return;
  const d = db();
  await d.withTransaction(async (tx) => {
    await tx.execute(
      `INSERT INTO kitchen_profile (customer_id, hotel_name) VALUES ($1, $2)
       ON CONFLICT (customer_id) DO UPDATE SET hotel_name = excluded.hotel_name`,
      [customerId, seed.hotelName],
    );
    for (const i of seed.inventory) {
      const f = SEED_FRESHNESS[i.ingredientId];
      const withDates: IngredientStock = f
        ? {
            ...i,
            shelfLifeDays: f.shelfLifeDays,
            expiresOn: f.expiresInDays != null && i.onHand > 0 ? daysFromNow(f.expiresInDays) : undefined,
            lastUsedAt: f.lastUsedDaysAgo != null ? daysAgo(f.lastUsedDaysAgo) : undefined,
          }
        : i;
      await tx.execute(
        `INSERT INTO kitchen_inventory (customer_id, ingredient_id, json) VALUES ($1, $2, $3)
         ON CONFLICT (customer_id, ingredient_id) DO UPDATE SET json = excluded.json`,
        [customerId, i.ingredientId, JSON.stringify(withDates)],
      );
    }
    for (const r of seed.recipes) {
      await tx.execute(
        `INSERT INTO kitchen_recipes (customer_id, recipe_id, json) VALUES ($1, $2, $3)
         ON CONFLICT (customer_id, recipe_id) DO UPDATE SET json = excluded.json`,
        [customerId, r.recipeId, JSON.stringify(r)],
      );
    }
    for (const o of seed.orderHistory) {
      const withIds: PastOrder = {
        ...o,
        lines: o.lines.map((l) => ({
          ...l,
          ingredientId: l.ingredientId ?? inferIngredientId(seed.inventory, l.productName),
        })),
      };
      await tx.execute(
        `INSERT INTO kitchen_orders (order_id, customer_id, ordered_at, status, intent_id, json) VALUES ($1, $2, $3, $4, NULL, $5)
         ON CONFLICT (order_id) DO UPDATE SET customer_id = excluded.customer_id, ordered_at = excluded.ordered_at, status = excluded.status, intent_id = excluded.intent_id, json = excluded.json`,
        [o.orderId, customerId, o.orderedAt, o.status, JSON.stringify(withIds)],
      );
    }
  });
}

async function ensureSeeded(customerId: string) {
  const d = db();
  const has = await d.queryOne(`SELECT 1 FROM kitchen_profile WHERE customer_id = $1`, [customerId]);
  if (!has) await seedCustomer(customerId);
}

/** Wipe a customer's kitchen back to the demo seed. */
export async function resetKitchen(customerId: string) {
  const d = db();
  await d.execute(`DELETE FROM kitchen_inventory WHERE customer_id = $1`, [customerId]);
  await d.execute(`DELETE FROM kitchen_recipes WHERE customer_id = $1`, [customerId]);
  await d.execute(`DELETE FROM kitchen_orders WHERE customer_id = $1`, [customerId]);
  await d.execute(`DELETE FROM kitchen_profile WHERE customer_id = $1`, [customerId]);
  await seedCustomer(customerId);
}

export async function getKitchen(customerId: string): Promise<HotelKitchen | null> {
  await ensureSeeded(customerId);
  const d = db();
  const profile = await d.queryOne<{ hotel_name: string }>(
    `SELECT hotel_name FROM kitchen_profile WHERE customer_id = $1`,
    [customerId],
  );
  if (!profile) return null;
  const parse = <T,>(rows: Array<{ json: string }>) =>
    rows.map((r) => JSON.parse(r.json) as T);
  const inventory = parse<IngredientStock>(
    await d.query<{ json: string }>(
      `SELECT json FROM kitchen_inventory WHERE customer_id = $1 ORDER BY seq`,
      [customerId],
    ),
  );
  const recipes = parse<Recipe>(
    await d.query<{ json: string }>(
      `SELECT json FROM kitchen_recipes WHERE customer_id = $1 ORDER BY seq`,
      [customerId],
    ),
  );
  const orderHistory = parse<PastOrder>(
    await d.query<{ json: string }>(
      `SELECT json FROM kitchen_orders WHERE customer_id = $1 ORDER BY ordered_at DESC, seq DESC`,
      [customerId],
    ),
  );
  return { customerId, hotelName: profile.hotel_name, inventory, recipes, orderHistory };
}

export async function getInventory(customerId: string) {
  const k = await getKitchen(customerId);
  if (!k) return null;
  const inbound = inboundByIngredient(k.orderHistory);
  const recs = new Map(((await recommendRestock(customerId))?.recommendations ?? []).map((r) => [r.ingredientId, r]));
  const inventory = k.inventory.map((i) => {
    const r = recs.get(i.ingredientId);
    return {
      ...i,
      onOrder: inbound.get(i.ingredientId) ?? 0,
      targetQty: r?.targetQty ?? i.parLevel,
      status: r?.urgency ?? "ok",
    };
  });
  const n = (u: string) => inventory.filter((i) => i.status === u).length;
  return {
    hotelName: k.hotelName,
    summary: `${n("critical")} critical, ${n("low")} low, ${n("ok")} ok (status counts on-hand + on-order vs target = max(par, recipe demand for 7 days); same rule as the Overview and Kitchen screens).`,
    inventory,
  };
}

export async function getRecipes(customerId: string) {
  const k = await getKitchen(customerId);
  if (!k) return null;
  return { hotelName: k.hotelName, recipes: k.recipes };
}

export async function getOrderHistory(customerId: string) {
  const k = await getKitchen(customerId);
  if (!k) return null;
  return { hotelName: k.hotelName, orders: k.orderHistory };
}

// ───────────────────────── write APIs ─────────────────────────

const UNITS = ["kg", "litre", "each", "pack"] as const;
type Unit = (typeof UNITS)[number];

function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

function cleanUnit(u: unknown): Unit {
  const x = String(u ?? "").toLowerCase();
  if (x === "l" || x === "litre" || x === "liter") return "litre";
  if (x === "kg" || x === "kilo") return "kg";
  if (x === "pack" || x === "packs") return "pack";
  if (x === "each" || x === "pcs" || x === "piece" || x === "pieces") return "each";
  throw new Error(`invalid unit "${String(u)}" (use kg, litre, each, pack)`);
}

function num(v: unknown, field: string, min = 0): number {
  const n = Number(v);
  if (!Number.isFinite(n) || n < min) throw new Error(`${field} must be a number >= ${min}`);
  return n;
}

export function normalizeIngredient(raw: Record<string, unknown>): IngredientStock {
  const name = String(raw.name ?? "").trim();
  if (!name) throw new Error("ingredient name is required");
  const hints = Array.isArray(raw.catalogHints)
    ? raw.catalogHints.map(String).filter(Boolean)
    : [name.toLowerCase()];
  return {
    ingredientId: String(raw.ingredientId ?? `ing-${slug(name)}`),
    name,
    onHand: num(raw.onHand ?? 0, "onHand"),
    unit: cleanUnit(raw.unit),
    parLevel: num(raw.parLevel ?? 0, "parLevel"),
    catalogHints: hints.length ? hints : [name.toLowerCase()],
    lactoseFreePreferred: Boolean(raw.lactoseFreePreferred),
    excludeAllergens: Array.isArray(raw.excludeAllergens)
      ? raw.excludeAllergens.map(String)
      : undefined,
    unitWeightKg: raw.unitWeightKg != null ? num(raw.unitWeightKg, "unitWeightKg") : undefined,
    shelfLifeDays: raw.shelfLifeDays != null && raw.shelfLifeDays !== "" ? num(raw.shelfLifeDays, "shelfLifeDays", 1) : undefined,
    expiresOn: dateOrUndef(raw.expiresOn, "expiresOn"),
    lastUsedAt: dateOrUndef(raw.lastUsedAt, "lastUsedAt"),
  };
}

function dateOrUndef(v: unknown, field: string): string | undefined {
  if (v == null || v === "") return undefined;
  const t = String(v).slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(t)) throw new Error(`${field} must be a date like 2026-12-31`);
  return t;
}

export function normalizeRecipe(
  raw: Record<string, unknown>,
  knownIngredients: Set<string>,
): Recipe {
  const name = String(raw.name ?? "").trim();
  if (!name) throw new Error("recipe name is required");
  const ingredients = Array.isArray(raw.ingredients) ? raw.ingredients : [];
  if (!ingredients.length) throw new Error("recipe needs at least one ingredient");
  return {
    recipeId: String(raw.recipeId ?? `rcp-${slug(name)}`),
    name,
    servingsPerBatch: num(raw.servingsPerBatch ?? 1, "servingsPerBatch", 1),
    batchesPerWeek: num(raw.batchesPerWeek ?? 1, "batchesPerWeek"),
    ingredients: ingredients.map((x) => {
      const r = x as Record<string, unknown>;
      const ingredientId = String(r.ingredientId ?? "");
      if (!knownIngredients.has(ingredientId)) {
        throw new Error(`recipe "${name}" references unknown ingredient "${ingredientId}"`);
      }
      return {
        ingredientId,
        qtyPerBatch: num(r.qtyPerBatch, "qtyPerBatch"),
        unit: cleanUnit(r.unit),
      };
    }),
  };
}

export async function upsertInventory(customerId: string, items: Array<Record<string, unknown>>) {
  await ensureSeeded(customerId);
  const saved = items.map(normalizeIngredient);
  await db().withTransaction(async (tx) => {
    for (const i of saved) {
      await tx.execute(
        `INSERT INTO kitchen_inventory (customer_id, ingredient_id, json) VALUES ($1, $2, $3)
         ON CONFLICT (customer_id, ingredient_id) DO UPDATE SET json = excluded.json`,
        [customerId, i.ingredientId, JSON.stringify(i)],
      );
    }
  });
  return saved;
}

export async function deleteIngredient(customerId: string, ingredientId: string): Promise<boolean> {
  const k = await getKitchen(customerId);
  const used = k?.recipes.filter((r) => r.ingredients.some((i) => i.ingredientId === ingredientId));
  if (used?.length) {
    throw new Error(`ingredient is used by recipe(s): ${used.map((r) => r.name).join(", ")}`);
  }
  const res = await db().execute(
    `DELETE FROM kitchen_inventory WHERE customer_id = $1 AND ingredient_id = $2`,
    [customerId, ingredientId],
  );
  return res.rowCount > 0;
}

export async function upsertRecipe(customerId: string, raw: Record<string, unknown>): Promise<Recipe> {
  const k = await getKitchen(customerId);
  if (!k) throw new Error("no_kitchen_profile");
  const recipe = normalizeRecipe(raw, new Set(k.inventory.map((i) => i.ingredientId)));
  await db().execute(
    `INSERT INTO kitchen_recipes (customer_id, recipe_id, json) VALUES ($1, $2, $3)
     ON CONFLICT (customer_id, recipe_id) DO UPDATE SET json = excluded.json`,
    [customerId, recipe.recipeId, JSON.stringify(recipe)],
  );
  return recipe;
}

export async function deleteRecipe(customerId: string, recipeId: string): Promise<boolean> {
  const res = await db().execute(
    `DELETE FROM kitchen_recipes WHERE customer_id = $1 AND recipe_id = $2`,
    [customerId, recipeId],
  );
  return res.rowCount > 0;
}

/** Bulk import (e.g. from the hotel's PMS / recipe system or a spreadsheet exported to JSON). */
export async function importKitchen(
  customerId: string,
  body: {
    inventory?: Array<Record<string, unknown>>;
    recipes?: Array<Record<string, unknown>>;
    replace?: boolean;
  },
) {
  await ensureSeeded(customerId);
  const d = db();
  await d.withTransaction(async (tx) => {
    if (body.replace) {
      if (body.inventory) await tx.execute(`DELETE FROM kitchen_inventory WHERE customer_id = $1`, [customerId]);
      if (body.recipes) await tx.execute(`DELETE FROM kitchen_recipes WHERE customer_id = $1`, [customerId]);
    }
    if (body.inventory) await upsertInventory(customerId, body.inventory);
    for (const r of body.recipes ?? []) await upsertRecipe(customerId, r);
  });
  const k = (await getKitchen(customerId))!;
  return { inventory: k.inventory.length, recipes: k.recipes.length };
}

// ───────────────────────── stock movements ─────────────────────────

async function saveInventoryItem(customerId: string, item: IngredientStock) {
  await db().execute(
    `UPDATE kitchen_inventory SET json = $1 WHERE customer_id = $2 AND ingredient_id = $3`,
    [JSON.stringify(item), customerId, item.ingredientId],
  );
}

/** Record a committed Valio order as inbound stock (linked to its ingredient when known). */
export async function recordCommittedOrder(
  customerId: string,
  order: {
    orderId: string;
    intentId: string;
    ingredientId?: string;
    productName: string;
    quantity: number;
    unit: string;
    totalEur: number;
    lines?: Array<{
      ingredientId?: string;
      productName: string;
      quantity: number;
      unit: string;
      totalEur: number;
    }>;
  },
) {
  await ensureSeeded(customerId);
  const k = await getKitchen(customerId);
  const resolvedLines =
    order.lines && order.lines.length > 0
      ? order.lines.map((l) => ({
          productName: l.productName,
          quantity: l.quantity,
          unit: l.unit,
          totalEur: l.totalEur,
          ingredientId:
            l.ingredientId ?? (k ? inferIngredientId(k.inventory, l.productName) : undefined),
        }))
      : [
          {
            productName: order.productName,
            quantity: order.quantity,
            unit: order.unit,
            totalEur: order.totalEur,
            ingredientId:
              order.ingredientId ??
              (k ? inferIngredientId(k.inventory, order.productName) : undefined),
          },
        ];
  const entry: PastOrder = {
    orderId: order.orderId,
    orderedAt: iso().slice(0, 10),
    status: "committed",
    intentId: order.intentId,
    lines: resolvedLines,
  };
  await db().execute(
    `INSERT INTO kitchen_orders (order_id, customer_id, ordered_at, status, intent_id, json)
     VALUES ($1, $2, $3, 'committed', $4, $5)
     ON CONFLICT DO NOTHING`,
    [order.orderId, customerId, entry.orderedAt, order.intentId, JSON.stringify(entry)],
  );
}

function inboundByIngredient(orders: PastOrder[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const o of orders) {
    if (o.status !== "committed") continue;
    for (const l of o.lines) {
      if (l.ingredientId) m.set(l.ingredientId, (m.get(l.ingredientId) ?? 0) + l.quantity);
    }
  }
  return m;
}

/** Mark a committed order delivered and add its quantities to on-hand stock. */
export async function receiveDelivery(
  customerId: string,
  orderId: string,
  received?: Record<string, number>,
) {
  const k = await getKitchen(customerId);
  if (!k) throw new Error("no_kitchen_profile");
  const order = k.orderHistory.find((o) => o.orderId === orderId);
  if (!order) throw new Error("order_not_found");
  if (order.status === "delivered") throw new Error("order_already_received");
  const applied: Array<{ ingredientId: string; added: number }> = [];
  await db().withTransaction(async (tx) => {
    for (const line of order.lines) {
      if (!line.ingredientId) continue;
      const item = k.inventory.find((i) => i.ingredientId === line.ingredientId);
      if (!item) continue;
      const qty = received?.[line.ingredientId] !== undefined ? num(received[line.ingredientId], "received", 0) : line.quantity;
      const hadStock = item.onHand > 0;
      item.onHand = Math.round((item.onHand + qty) * 100) / 100;
      // The nearest expiry stays the old batch's; a delivery into an empty shelf sets a fresh date.
      if (item.shelfLifeDays && (!hadStock || !item.expiresOn)) item.expiresOn = daysFromNow(item.shelfLifeDays);
      await saveInventoryItem(customerId, item);
      applied.push({ ingredientId: item.ingredientId, added: qty });
    }
    order.status = "delivered";
    order.deliveredAt = new Date().toISOString();
    await tx.execute(`UPDATE kitchen_orders SET status = 'delivered', json = $1 WHERE order_id = $2`, [
      JSON.stringify(order),
      orderId,
    ]);
  });
  return { orderId, applied };
}

/** Manual stock correction (stock-take) or recipe usage (cook N batches). */
export async function adjustStock(
  customerId: string,
  change: { ingredientId: string; onHand?: number; delta?: number; expiresOn?: string; shelfLifeDays?: number },
) {
  const k = await getKitchen(customerId);
  const item = k?.inventory.find((i) => i.ingredientId === change.ingredientId);
  if (!item) throw new Error("unknown_ingredient");
  if (change.expiresOn !== undefined) item.expiresOn = dateOrUndef(change.expiresOn, "expiresOn");
  if (change.shelfLifeDays !== undefined) item.shelfLifeDays = num(change.shelfLifeDays, "shelfLifeDays", 1);
  const onHand = change.onHand !== undefined ? num(change.onHand, "onHand", 0) : undefined;
  const delta = change.delta !== undefined ? num(change.delta, "delta", -1_000_000) : undefined;
  const next = onHand ?? item.onHand + (delta ?? 0);
  item.onHand = Math.max(0, Math.round(next * 100) / 100);
  await saveInventoryItem(customerId, item);
  return item;
}

export async function recordUsage(customerId: string, recipeId: string, batches: number) {
  const b = num(batches, "batches", 0.01);
  const k = await getKitchen(customerId);
  const recipe = k?.recipes.find((r) => r.recipeId === recipeId);
  if (!k || !recipe) throw new Error("unknown_recipe");
  const used: Array<{ ingredientId: string; used: number; onHand: number }> = [];
  await db().withTransaction(async () => {
    for (const ing of recipe.ingredients) {
      const item = k.inventory.find((i) => i.ingredientId === ing.ingredientId);
      if (!item) continue;
      item.onHand = Math.max(0, Math.round((item.onHand - ing.qtyPerBatch * b) * 100) / 100);
      item.lastUsedAt = daysAgo(0);
      if (item.onHand === 0) item.expiresOn = undefined;
      await saveInventoryItem(customerId, item);
      used.push({ ingredientId: item.ingredientId, used: ing.qtyPerBatch * b, onHand: item.onHand });
    }
  });
  return { recipeId, batches: b, used };
}

// ───────────────────────── restock logic ─────────────────────────

export function weeklyDemand(recipes: Recipe[], ingredientId: string): number {
  let total = 0;
  for (const r of recipes) {
    for (const ing of r.ingredients) {
      if (ing.ingredientId === ingredientId) total += ing.qtyPerBatch * r.batchesPerWeek;
    }
  }
  return total;
}

function historyFor(history: PastOrder[], item: IngredientStock) {
  return history
    .flatMap((o) =>
      o.lines
        .filter((l) =>
          l.ingredientId
            ? l.ingredientId === item.ingredientId
            : item.catalogHints.some((h) => l.productName.toLowerCase().includes(h.toLowerCase())),
        )
        .map((l) => ({ at: o.orderedAt, qty: l.quantity, name: l.productName })),
    )
    .sort((a, b) => b.at.localeCompare(a.at));
}

function fmtU(unit?: string): string {
  return unit ? ` ${{ litre: "L", litres: "L", each: "pcs" }[unit.toLowerCase()] ?? unit}` : "";
}
function fmtDay(iso: string): string {
  const d = new Date(iso.length === 10 ? `${iso}T12:00:00` : iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" });
}

function recentTrend(matched: Array<{ at: string; qty: number }>, unit?: string): string | undefined {
  if (matched.length < 2) {
    return matched[0] ? `Last ordered ${matched[0].qty}${fmtU(unit)} on ${fmtDay(matched[0].at)}` : undefined;
  }
  const [a, b] = matched;
  const delta = a.qty - b.qty;
  if (delta > 0) return `Order qty rising (${b.qty} → ${a.qty}${fmtU(unit)} recently)`;
  if (delta < 0) return `Order qty falling (${b.qty} → ${a.qty}${fmtU(unit)} recently)`;
  return `Stable recent orders (~${a.qty}${fmtU(unit)})`;
}

function standingOrderDrift(
  matched: Array<{ qty: number }>,
  suggested: number,
): { drift: boolean; avgQty?: number } {
  if (matched.length < 2 || suggested <= 0) return { drift: false };
  const avg = matched.reduce((s, m) => s + m.qty, 0) / matched.length;
  const ratio = suggested / avg;
  return { drift: ratio >= 1.5 || ratio <= 0.5, avgQty: Math.round(avg * 10) / 10 };
}

export type StockStatus = { urgency: "critical" | "low" | "ok"; targetQty: number; effective: number };

/**
 * The single definition of ok / low / critical, used by Overview, Kitchen and the agent tools.
 * effective = on hand + already ordered. target = max(par, recipe demand over the horizon).
 * ok: effective >= target · critical: effective < 50% of target · low: in between.
 */
export function classifyStock(onHand: number, onOrder: number, parLevel: number, horizonDemand: number): StockStatus {
  const effective = onHand + onOrder;
  const targetQty = Math.max(parLevel, horizonDemand);
  const urgency = effective >= targetQty ? "ok" : effective < targetQty * 0.5 ? "critical" : "low";
  return { urgency, targetQty: Math.round(targetQty * 10) / 10, effective };
}

export async function recommendRestock(
  customerId: string,
  options?: { daysCover?: number },
): Promise<{
  hotelName: string;
  recommendations: RestockRecommendation[];
  summary: string;
} | null> {
  const k = await getKitchen(customerId);
  if (!k) return null;
  const daysCover = options?.daysCover ?? 7;
  const weekFraction = daysCover / 7;
  const inbound = inboundByIngredient(k.orderHistory);

  const recommendations: RestockRecommendation[] = k.inventory.map((item) => {
    const weekly = weeklyDemand(k.recipes, item.ingredientId);
    const demandForHorizon = weekly * weekFraction;
    const onOrder = inbound.get(item.ingredientId) ?? 0;
    // Stock already ordered counts toward coverage so we never double-order.
    const effective = item.onHand + onOrder;

    const daily = weekly / 7;
    const daysToExpiry = item.expiresOn && item.onHand > 0 ? daysBetween(daysAgo(0), item.expiresOn) : undefined;
    const atRiskQty =
      daysToExpiry != null
        ? Math.max(0, Math.round((item.onHand - daily * Math.max(daysToExpiry, 0)) * 10) / 10)
        : undefined;
    // Stock that will expire unused is not a reason to top up to par: if recipes are already covered, hold off.
    const parWaived = Boolean(atRiskQty && atRiskQty > 0) && effective >= demandForHorizon;
    const status = classifyStock(item.onHand, onOrder, parWaived ? 0 : item.parLevel, demandForHorizon);
    const urgency = status.urgency;
    const need = `need ${status.targetQty}${item.unit} (${parWaived ? `par ${item.parLevel} waived: ${atRiskQty}${item.unit} would expire unused` : `par ${item.parLevel}`}, recipes ~${demandForHorizon.toFixed(1)}/${daysCover}d)`;
    const have = `${item.onHand}${item.unit} on hand${onOrder ? ` + ${onOrder}${item.unit} on order` : ""}`;
    const target = status.targetQty;
    const gap = Math.max(0, target - effective);
    const suggestedOrderQty = Math.ceil(gap * 10) / 10;
    let reason =
      urgency === "ok"
        ? onOrder
          ? `Covered: ${have} meets ${need}.`
          : `Stock is at or above target: ${have} vs ${need}.`
        : `${urgency === "critical" ? "Far below" : "Below"} target: ${have}, ${need}.`;

    const matched = historyFor(k.orderHistory, item);
    const drift = standingOrderDrift(matched, suggestedOrderQty);
    if (drift.drift) {
      reason += ` Standing-order drift: suggested ${suggestedOrderQty} vs recent avg ~${drift.avgQty}.`;
    }

    const daysSinceUse = item.lastUsedAt ? daysBetween(item.lastUsedAt, daysAgo(0)) : undefined;
    return {
      ingredientId: item.ingredientId,
      name: item.name,
      onHand: item.onHand,
      parLevel: item.parLevel,
      shelfLifeDays: item.shelfLifeDays,
      expiresOn: item.expiresOn,
      daysToExpiry,
      atRiskQty,
      lastUsedAt: item.lastUsedAt,
      daysSinceUse,
      weeklyRecipeDemand: Math.round(weekly * 10) / 10,
      suggestedOrderQty,
      unit: item.unit,
      urgency,
      targetQty: status.targetQty,
      reason,
      catalogHints: item.catalogHints,
      lactoseFreePreferred: item.lactoseFreePreferred,
      excludeAllergens: item.excludeAllergens,
      unitWeightKg: item.unitWeightKg,
      onOrder,
      recentOrderTrend: recentTrend(matched, item.unit),
      standingOrderDrift: drift.drift,
      standingOrderAvgQty: drift.avgQty,
    };
  });

  recommendations.sort((a, b) => {
    const rank = { critical: 0, low: 1, ok: 2 };
    return rank[a.urgency] - rank[b.urgency] || b.suggestedOrderQty - a.suggestedOrderQty;
  });

  const critical = recommendations.filter((r) => r.urgency === "critical");
  const low = recommendations.filter((r) => r.urgency === "low");
  const drifted = recommendations.filter((r) => r.standingOrderDrift);
  const summary = [
    `${k.hotelName}: ${critical.length} critical, ${low.length} low restock items for next ${daysCover} days.`,
    ...critical.map(
      (r) =>
        `CRITICAL ${r.name}: order ~${r.suggestedOrderQty}${r.unit} (on hand ${r.onHand}, par ${r.parLevel}, weekly recipe ${r.weeklyRecipeDemand}).`,
    ),
    ...low.map((r) => `LOW ${r.name}: order ~${r.suggestedOrderQty}${r.unit}.`),
    drifted.length
      ? `Standing-order drift flags: ${drifted.map((r) => r.name).join(", ")}.`
      : "",
  ]
    .filter(Boolean)
    .join(" ");

  return { hotelName: k.hotelName, recommendations, summary };
}

/** Convert an ingredient shortfall into a Valio catalog need (e.g. eggs: pieces → kg). */
export function ingredientToNeed(
  item: IngredientStock,
  qty: number,
  neededBy: string,
  lactoseFree: boolean,
) {
  const byWeight = item.unit === "each" && item.unitWeightKg;
  return {
    productIntent: item.catalogHints[0] ?? item.name,
    quantity: byWeight ? Math.ceil(qty * (item.unitWeightKg as number) * 100) / 100 : qty,
    unit: (byWeight ? "kg" : item.unit) as IngredientStock["unit"],
    neededBy,
    ingredientId: item.ingredientId,
    ingredientQuantity: qty,
    ingredientUnit: item.unit,
    constraints: {
      lactoseFree: lactoseFree || undefined,
      excludeAllergens: item.excludeAllergens,
    },
  };
}
