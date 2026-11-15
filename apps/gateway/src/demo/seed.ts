import { createHash, randomUUID } from "node:crypto";
import type { Need } from "@tta/shared";
import { appendAudit, getDb } from "../audit/chain.js";
import { getMandate, resetMandate } from "../auth/customers.js";
import { resetSuggestions } from "../agents/valioAgent.js";
import { searchFromNeed } from "../catalog/index.js";
import { addDays, createEvent, resetEvents, todayIso } from "../hotel/events.js";
import { getKitchen, resetKitchen } from "../hotel/kitchen.js";
import { resetRestockAutomation } from "../hotel/restock-automation.js";
import { createStanding, resetStanding } from "../hotel/standing.js";
import { approveOrder, commitOrder, createOrderIntent, resetIntents } from "../orders/store.js";

export type DemoSeedSummary = {
  customerId: string;
  committedOrders: number;
  pendingApprovals: number;
  events: number;
  standingOrders: number;
};

async function insertFallbackIntent(params: {
  customerId: string;
  need: Need;
  status: "committed" | "pending_approval";
  totalPrice: number;
  reasonCodes: string[];
  failingRules: string[];
  explanation: string;
  isSubstitution?: boolean;
}): Promise<void> {
  const product = searchFromNeed(params.need, 1)[0];
  const productId = product?.productId ?? "611100";
  const productName = product?.name ?? params.need.productIntent;
  const now = new Date().toISOString();
  const expiresAt = new Date(Date.now() + 30 * 60_000).toISOString();
  const intentId = `INT-DEMO-${randomUUID().slice(0, 8).toUpperCase()}`;
  const runId = randomUUID();
  const packs = Math.max(1, Math.round(params.need.quantity));
  const unitPrice = Math.round((params.totalPrice / packs) * 100) / 100;

  const basket = [
    {
      productId,
      productName,
      packs,
      unitPrice,
      totalPrice: params.totalPrice,
      availableDate: params.need.neededBy,
      canFulfil: true,
      isSubstitution: Boolean(params.isSubstitution),
      certifications: product?.certifications ?? ["LACTOSE_FREE"],
      origin: product?.origin ?? "FI",
    },
  ];
  const snapshotHash = createHash("sha256")
    .update(JSON.stringify({ customerId: params.customerId, basket, totalPrice: params.totalPrice }))
    .digest("hex");

  const policy = {
    outcome: params.status === "committed" ? "auto_approve" : "require_approval",
    reasonCodes: params.reasonCodes,
    failingRules: params.failingRules,
    explanation: params.explanation,
  };

  const committedOrderId =
    params.status === "committed" ? `ORD-DEMO-${randomUUID().slice(0, 6).toUpperCase()}` : null;

  const intent = {
    id: intentId,
    customerId: params.customerId,
    runId,
    status: params.status,
    need: params.need,
    basket,
    snapshotHash,
    policy: policy,
    totalPrice: params.totalPrice,
    neededBy: params.need.neededBy,
    expiresAt,
    approvalSnapshotHash: params.status === "committed" ? snapshotHash : null,
    idempotencyKey: params.status === "committed" ? `demo-${intentId}` : null,
    committedOrderId,
    createdAt: now,
    updatedAt: now,
  };

  await getDb().execute(
    `INSERT INTO order_intents (
      id, customer_id, run_id, status, need_json, basket_json, snapshot_hash,
      policy_json, total_price, needed_by, expires_at, approval_snapshot_hash,
      idempotency_key, committed_order_id, created_at, updated_at, meta_json
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)`,
    [
      intent.id,
      intent.customerId,
      intent.runId,
      intent.status,
      JSON.stringify(intent.need),
      JSON.stringify(intent.basket),
      intent.snapshotHash,
      JSON.stringify(intent.policy),
      intent.totalPrice,
      intent.neededBy,
      intent.expiresAt,
      intent.approvalSnapshotHash,
      intent.idempotencyKey,
      intent.committedOrderId,
      intent.createdAt,
      intent.updatedAt,
      JSON.stringify({ rationale: [params.explanation], alternatives: [], consideredOffers: 1 }),
    ],
  );
  await appendAudit(runId, params.customerId, "demo_intent_seeded", {
    intentId,
    status: params.status,
  });
}

/**
 * Resets a kitchen account to a clean baseline and populates realistic sample
 * records across orders, approvals, events, and recurring schedules so anyone
 * testing the live demo can immediately explore every feature.
 */
export async function seedDemoShowcase(
  customerId: string,
  source: string,
  clearSimulatedStockouts?: () => void,
): Promise<DemoSeedSummary> {
  await resetIntents(customerId, source);
  await resetKitchen(customerId);
  await resetRestockAutomation(customerId);
  await resetStanding(customerId);
  await resetSuggestions(customerId);
  await resetEvents(customerId);
  clearSimulatedStockouts?.();
  await resetMandate(customerId);

  const mandate = await getMandate(customerId);
  if (!mandate) {
    throw new Error(`No mandate found for ${customerId}`);
  }
  const kitchen = await getKitchen(customerId);
  const today = todayIso();
  const isSchool = customerId.includes("SCHOOL");

  let committedOrders = 0;
  let pendingApprovals = 0;
  let events = 0;
  let standingOrders = 0;

  // 1. One auto-committed order so Past Orders & Digital Receipts have live data.
  const committedNeed: Need = {
    productIntent: "lactose-free milk",
    quantity: 20,
    unit: "litre",
    neededBy: addDays(today, 3),
    constraints: { lactoseFree: true },
  };
  try {
    const res = await createOrderIntent({
      customerId,
      mandate,
      need: committedNeed,
    });
    if (res.intent.status === "pending_approval" || res.intent.status === "auto_eligible") {
      await approveOrder(res.intent.id, customerId, res.intent.snapshotHash);
    }
    const committed =
      res.intent.status === "committed"
        ? res.intent
        : await commitOrder({
            intentId: res.intent.id,
            customerId,
            idempotencyKey: `demo-seed-commit-${res.intent.id}`,
          });
    if (committed.status === "committed") {
      committedOrders += 1;
    }
  } catch {
    await insertFallbackIntent({
      customerId,
      need: committedNeed,
      status: "committed",
      totalPrice: 36.8,
      reasonCodes: [],
      failingRules: [],
      explanation: "Auto-placed within your kitchen budget and lactose-free safety rules.",
    });
    committedOrders += 1;
  }

  // 2. Pending approval #1: over-budget bulk dairy order for "Needs Your OK".
  const overBudgetNeed: Need = {
    productIntent: "lactose-free milk",
    quantity: isSchool ? 220 : 420,
    unit: "litre",
    neededBy: addDays(today, 2),
    constraints: { lactoseFree: true },
  };
  try {
    const res = await createOrderIntent({
      customerId,
      mandate,
      need: overBudgetNeed,
    });
    if (res.intent.status === "pending_approval") {
      pendingApprovals += 1;
    }
  } catch {
    await insertFallbackIntent({
      customerId,
      need: overBudgetNeed,
      status: "pending_approval",
      totalPrice: isSchool ? 396.0 : 756.0,
      reasonCodes: ["over_spend"],
      failingRules: ["withinMaxOrderValue"],
      explanation: `Order total exceeds your €${mandate.maxOrderValueEur} auto-order limit and needs your quick OK.`,
    });
    pendingApprovals += 1;
  }

  // 3. Pending approval #2: substitution review for "Needs Your OK".
  const subNeed: Need = {
    productIntent: isSchool ? "yogurt" : "butter",
    quantity: 25,
    unit: "kg",
    neededBy: addDays(today, 2),
    constraints: isSchool ? { lactoseFree: true } : {},
  };
  try {
    const res = await createOrderIntent({
      customerId,
      mandate,
      need: subNeed,
      markSubstitution: true,
      substitutionLabel: "better",
    });
    if (res.intent.status === "pending_approval") {
      pendingApprovals += 1;
    }
  } catch {
    await insertFallbackIntent({
      customerId,
      need: subNeed,
      status: "pending_approval",
      totalPrice: 168.5,
      reasonCodes: ["substitution"],
      failingRules: ["allowedSubstitutions"],
      explanation: "A recipe-compatible alternative was selected and needs your quick OK.",
      isSubstitution: true,
    });
    pendingApprovals += 1;
  }

  // 4. Upcoming kitchen events so Stock & Kitchen -> Events is immediately interactive.
  const recipes = kitchen?.recipes ?? [];
  if (recipes.length > 0) {
    try {
      await createEvent(customerId, {
        name: isSchool ? "Spring Term Nutrition Day" : "Nordic Hospitality Gala Dinner",
        date: addDays(today, 4),
        guests: isSchool ? 180 : 120,
        prepDays: 1,
        leadDays: 2,
        recipes: recipes.slice(0, 2).map((r) => ({ recipeId: r.recipeId, servings: isSchool ? 180 : 120 })),
      });
      events += 1;
    } catch {
      // Non-fatal
    }

    try {
      const secondRecipe = recipes[recipes.length - 1];
      await createEvent(customerId, {
        name: isSchool ? "Regional School Sports Lunch" : "Executive Breakfast Summit",
        date: addDays(today, 7),
        guests: 65,
        prepDays: 1,
        leadDays: 2,
        recipes: [{ recipeId: secondRecipe.recipeId, servings: 65 }],
      });
      events += 1;
    } catch {
      // Non-fatal
    }
  }

  // 5. Recurring / standing orders so Stock & Kitchen -> Recurring is populated.
  const inventory = kitchen?.inventory ?? [];
  if (inventory.length > 0) {
    try {
      await createStanding(customerId, {
        ingredientId: inventory[0].ingredientId,
        quantity: isSchool ? 40 : 60,
        weekday: 1, // Monday
        leadTimeDays: 2,
      });
      standingOrders += 1;
    } catch {
      // Non-fatal
    }
  }
  if (inventory.length > 1) {
    try {
      await createStanding(customerId, {
        ingredientId: inventory[1].ingredientId,
        quantity: 20,
        weekday: 4, // Thursday
        leadTimeDays: 2,
      });
      standingOrders += 1;
    } catch {
      // Non-fatal
    }
  }

  return {
    customerId,
    committedOrders,
    pendingApprovals,
    events,
    standingOrders,
  };
}
