import { PreferencesSchema, type Mandate, type Need, type Offer, type Preferences } from "@tta/shared";
import { getMandate } from "../auth/customers.js";
import { buildOffers, buildOffersBatch } from "../catalog/offers.js";
import {
  getKitchen,
  ingredientToNeed,
  recommendRestock,
  type IngredientStock,
  type Recipe,
} from "../hotel/kitchen.js";
import { mustBeLactoseFree } from "../hotel/planner.js";
import { parseComplexNeedFromText } from "../need/parse.js";
import { runPurchasingAgent, type ChatMessage } from "./chat.js";
import type { ToolTrace } from "./tools.js";

export type BundleItemPayload = {
  id: string;
  label: string;
  need: Need;
  offers: Offer[];
  recommendedProductId: string | null;
  contextNote?: string;
  urgency?: "critical" | "low" | "recipe" | "requested";
};

export type CoveredItemNote = {
  ingredientId?: string;
  name: string;
  requiredQty: number;
  onHand: number;
  unit: string;
  needToAdd: Need;
};

export type UnifiedAssistantResponse = {
  mode: "bundle" | "clarification" | "assistant";
  sourceKind?: "single" | "multi" | "recipe" | "restock" | "chat";
  bundleTitle?: string;
  assistantSummary: string;
  bundleItems?: BundleItemPayload[];
  coveredItems?: CoveredItemNote[];
  clarification?: {
    rawText: string;
    missingItem: string;
    preservedItemsText?: string;
    message: string;
  };
  chatReply?: string;
  toolTrace?: ToolTrace[];
  createdPendingOrder?: boolean;
  committedOrder?: boolean;
};

type CulinaryRecipeTemplate = {
  id: string;
  name: string;
  matchRe: RegExp;
  defaultServings: number;
  ingredientsPerServing: Array<{
    label: string;
    productIntent: string;
    qtyPerServing: number;
    unit: Need["unit"];
    dairy?: boolean;
  }>;
};

const BUILTIN_CULINARY_RECIPES: CulinaryRecipeTemplate[] = [
  {
    id: "builtin-pancakes",
    name: "Buttermilk Pancakes",
    matchRe: /\bpancakes?\b|\bcrepes?\b|\bwaffles?\b|\blettu|\bpannukakku/i,
    defaultServings: 50,
    ingredientsPerServing: [
      { label: "Milk", productIntent: "milk", qtyPerServing: 0.14, unit: "litre", dairy: true },
      { label: "Eggs", productIntent: "eggs", qtyPerServing: 0.6, unit: "each" },
      { label: "Butter", productIntent: "butter", qtyPerServing: 0.02, unit: "kg", dairy: true },
      { label: "Bananas", productIntent: "bananas", qtyPerServing: 0.04, unit: "kg" },
    ],
  },
  {
    id: "builtin-omelette",
    name: "Breakfast Omelette / Scrambled Eggs",
    matchRe: /\bomelettes?\b|\bomelets?\b|\bscrambled\s+eggs?\b|\bfrittata\b/i,
    defaultServings: 40,
    ingredientsPerServing: [
      { label: "Eggs", productIntent: "eggs", qtyPerServing: 2.5, unit: "each" },
      { label: "Milk", productIntent: "milk", qtyPerServing: 0.04, unit: "litre", dairy: true },
      { label: "Butter", productIntent: "butter", qtyPerServing: 0.015, unit: "kg", dairy: true },
      { label: "Cheese", productIntent: "cheese", qtyPerServing: 0.03, unit: "kg", dairy: true },
    ],
  },
  {
    id: "builtin-french-toast",
    name: "French Toast",
    matchRe: /\bfrench\s+toast\b|\bpoor\s+knights\b|\bköyhät\s+ritarit\b/i,
    defaultServings: 40,
    ingredientsPerServing: [
      { label: "Milk", productIntent: "milk", qtyPerServing: 0.08, unit: "litre", dairy: true },
      { label: "Eggs", productIntent: "eggs", qtyPerServing: 1, unit: "each" },
      { label: "Butter", productIntent: "butter", qtyPerServing: 0.02, unit: "kg", dairy: true },
    ],
  },
  {
    id: "builtin-porridge",
    name: "Morning Oat Porridge",
    matchRe: /\bporridge\b|\boatmeal\b|\bpuuro\b|\bovernight\s+oats?\b/i,
    defaultServings: 50,
    ingredientsPerServing: [
      { label: "Rolled oats", productIntent: "rolled oats", qtyPerServing: 0.08, unit: "kg" },
      { label: "Milk", productIntent: "milk", qtyPerServing: 0.22, unit: "litre", dairy: true },
      { label: "Butter", productIntent: "butter", qtyPerServing: 0.01, unit: "kg", dairy: true },
      { label: "Bananas", productIntent: "bananas", qtyPerServing: 0.05, unit: "kg" },
    ],
  },
  {
    id: "builtin-smoothie",
    name: "Fruit & Yogurt Smoothie",
    matchRe: /\bsmoothies?\b|\bmilkshakes?\b/i,
    defaultServings: 40,
    ingredientsPerServing: [
      { label: "Bananas", productIntent: "bananas", qtyPerServing: 0.1, unit: "kg" },
      { label: "Milk", productIntent: "milk", qtyPerServing: 0.18, unit: "litre", dairy: true },
      { label: "Yogurt", productIntent: "yogurt", qtyPerServing: 0.08, unit: "kg", dairy: true },
    ],
  },
  {
    id: "builtin-creamy-pasta",
    name: "Creamy Pasta / Gratin Sauce",
    matchRe: /\bcreamy?\s+pasta\b|\balfredo\b|\bcarbonara\b|\bgratin\b|\blasagn[ae]\b/i,
    defaultServings: 40,
    ingredientsPerServing: [
      { label: "Cooking cream", productIntent: "cooking cream", qtyPerServing: 0.12, unit: "litre", dairy: true },
      { label: "Butter", productIntent: "butter", qtyPerServing: 0.02, unit: "kg", dairy: true },
      { label: "Cheese", productIntent: "cheese", qtyPerServing: 0.04, unit: "kg", dairy: true },
    ],
  },
  {
    id: "builtin-mashed-potatoes",
    name: "Mashed Potatoes",
    matchRe: /\bmashed\s+potato(?:es)?\b|\bperunamuusi\b/i,
    defaultServings: 50,
    ingredientsPerServing: [
      { label: "Potatoes", productIntent: "potato", qtyPerServing: 0.22, unit: "kg" },
      { label: "Milk", productIntent: "milk", qtyPerServing: 0.06, unit: "litre", dairy: true },
      { label: "Butter", productIntent: "butter", qtyPerServing: 0.025, unit: "kg", dairy: true },
    ],
  },
  {
    id: "builtin-muffins",
    name: "Bakery Muffins / Cake Batter",
    matchRe: /\bmuffins?\b|\bcupcakes?\b|\bsponge\s+cake\b|\bbrownies?\b/i,
    defaultServings: 48,
    ingredientsPerServing: [
      { label: "Butter", productIntent: "butter", qtyPerServing: 0.03, unit: "kg", dairy: true },
      { label: "Milk", productIntent: "milk", qtyPerServing: 0.05, unit: "litre", dairy: true },
      { label: "Eggs", productIntent: "eggs", qtyPerServing: 0.5, unit: "each" },
    ],
  },
];

function extractNeededByFromText(text: string): string {
  const probe = parseComplexNeedFromText(`1 litre milk ${text}`);
  if (!("clarificationRequired" in probe) && probe.needs[0]?.neededBy) {
    return probe.needs[0].neededBy;
  }
  const d = new Date();
  d.setDate(d.getDate() + 3);
  return d.toISOString().slice(0, 10);
}

function matchSavedKitchenRecipes(recipes: Recipe[], text: string): Recipe[] {
  const lower = text.toLowerCase();
  const stopWords = new Set([
    "hotel",
    "city",
    "school",
    "daily",
    "lobby",
    "evening",
    "for",
    "with",
    "and",
    "the",
    "milk",
    "cream",
    "service",
  ]);
  return recipes.filter((r) => {
    if (lower.includes(r.recipeId.toLowerCase()) || lower.includes(r.name.toLowerCase())) {
      return true;
    }
    const significantWords = r.name
      .toLowerCase()
      .replace(/\([^)]*\)/g, " ")
      .split(/[^\p{L}\p{N}]+/u)
      .filter((w) => w.length >= 4 && !stopWords.has(w));
    return significantWords.some(
      (w) =>
        lower.includes(w) ||
        (w.endsWith("s") && lower.includes(w.slice(0, -1))) ||
        lower.includes(`${w}s`),
    );
  });
}

function isRestockPrompt(text: string): boolean {
  return /\b(?:restock|running\s+low|low\s+pantry|low\s+stock|what\s+should\s+we\s+order|what(?:'s|\s+is)\s+low|replenish|check\s+pantry)\b/i.test(
    text,
  );
}

function isConversationalOrWorkflowPrompt(text: string): boolean {
  return /\b(?:why\b|how\s+does|explain\b|audit\b|pending\s+approvals?|past\s+orders?|order\s+history|create\s+(?:an?\s+)?event|register\s+(?:an?\s+)?event|wedding|banquet|conference|stock[-\s]?out|ran\s+out|compare\b.*\bvs\b|do\s+not\s+order|don't\s+order|smart\s+restock|near\s+expiry|expiring)\b/i.test(
    text,
  );
}

function looksLikeRecipeIntent(text: string): boolean {
  return /\b(?:recipe|recipes|batches?|servings?|portions?|guests?|people|ingredients?\s+for|to\s+(?:make|cook|bake|prepare)|make\s+\d+|cook\s+\d+)\b/i.test(
    text,
  );
}

async function buildBundlePayloadFromNeeds(
  customerId: string,
  entries: Array<{
    label: string;
    need: Need;
    contextNote?: string;
    urgency?: BundleItemPayload["urgency"];
  }>,
  mandate: Mandate | null,
  preferences?: Preferences,
): Promise<BundleItemPayload[]> {
  if (entries.length === 0) return [];

  if (entries.length === 1) {
    const first = entries[0];
    const offers = await buildOffers(customerId, first.need, {
      includeSubstitutions: true,
      preferences,
      mandate,
    });
    const recommended = offers.find((o) => o.canFulfil) ?? offers[0] ?? null;
    return [
      {
        id: `item-0`,
        label: first.label,
        need: first.need,
        offers,
        recommendedProductId: recommended?.productId ?? null,
        contextNote: first.contextNote,
        urgency: first.urgency ?? "requested",
      },
    ];
  }

  const batch = await buildOffersBatch(
    customerId,
    entries.map((e) => e.need),
    {
      includeSubstitutions: true,
      preferences,
      mandate,
    },
  );

  return batch.items.map((it, idx) => {
    const meta = entries[idx];
    const recommended = it.offers.find((o) => o.canFulfil) ?? it.offers[0] ?? null;
    return {
      id: `item-${idx}`,
      label: meta?.label ?? it.need.productIntent,
      need: it.need,
      offers: it.offers,
      recommendedProductId: recommended?.productId ?? null,
      contextNote: meta?.contextNote,
      urgency: meta?.urgency ?? "requested",
    };
  });
}

export async function resolveUnifiedKitchenPrompt(params: {
  customerId: string;
  text: string;
  preferences?: unknown;
  history?: ChatMessage[];
  callerRole?: string;
}): Promise<UnifiedAssistantResponse> {
  const text = params.text.trim();
  const mandate = getMandate(params.customerId) ?? null;
  const preferences = params.preferences ? PreferencesSchema.parse(params.preferences) : undefined;
  const neededBy = extractNeededByFromText(text);

  // 1. Pantry restock / low-stock query → build interactive Restock Bundle
  if (isRestockPrompt(text) && !/\bsmart\s+restock|expiry|waste\b/i.test(text)) {
    const rec = recommendRestock(params.customerId, { daysCover: 7 });
    const kitchen = getKitchen(params.customerId);
    const urgent = (rec?.recommendations ?? []).filter(
      (r) => (r.urgency === "critical" || r.urgency === "low") && r.suggestedOrderQty > 0,
    );

    if (urgent.length > 0 && kitchen) {
      const entries: Array<{
        label: string;
        need: Need;
        contextNote?: string;
        urgency?: BundleItemPayload["urgency"];
      }> = [];

      for (const r of urgent.slice(0, 6)) {
        const stockItem = kitchen.inventory.find((i) => i.ingredientId === r.ingredientId);
        if (!stockItem) continue;
        const lf = mandate
          ? mustBeLactoseFree(mandate, stockItem)
          : Boolean(stockItem.lactoseFreePreferred);
        const qty = Math.max(1, Math.ceil(r.suggestedOrderQty));
        const need = ingredientToNeed(stockItem, qty, neededBy, lf);
        entries.push({
          label: r.name,
          need: {
            ...need,
            constraints: {
              ...need.constraints,
              keywords: (stockItem.catalogHints[0] ?? r.name).split(/\s+/).filter(Boolean),
            },
          },
          contextNote: `Fridge: ${r.onHand} ${r.unit} · Par ${r.parLevel} ${r.unit} (${r.urgency === "critical" ? "Critical" : "Running low"})`,
          urgency: r.urgency === "critical" ? "critical" : "low",
        });
      }

      const bundleItems = await buildBundlePayloadFromNeeds(
        params.customerId,
        entries,
        mandate,
        preferences,
      );
      return {
        mode: "bundle",
        sourceKind: "restock",
        bundleTitle: `Pantry Restock Bundle · ${bundleItems.length} Low-Stock ${bundleItems.length === 1 ? "Item" : "Items"}`,
        assistantSummary: `Checked your fridge stock and 7-day recipe demand — ${bundleItems.length} ${bundleItems.length === 1 ? "ingredient is" : "ingredients are"} running low. Order the full restock bundle directly, or click any item to swap Valio alternatives.`,
        bundleItems,
      };
    }
  }

  // 2. Open-ended analytical, comparison, event, or audit workflow → run specialist agent team
  if (isConversationalOrWorkflowPrompt(text)) {
    const chatRes = await runPurchasingAgent({
      customerId: params.customerId,
      message: text,
      history: params.history,
      callerRole: params.callerRole,
    });
    const traces = chatRes.toolTrace ?? [];
    const createdPendingOrder = traces.some(
      (t) =>
        t.ok &&
        (t.name === "create_order_intent" ||
          t.name === "accept_suggestion" ||
          t.name === "plan_menu_sourcing" ||
          t.name === "order_event"),
    );
    const committedOrder = traces.some((t) => t.ok && t.name === "commit_order");

    // If it was a read-only comparison for a parseable product need, ALSO attach interactive options!
    let bundleItems: BundleItemPayload[] | undefined;
    if (!createdPendingOrder && !committedOrder) {
      const parsed = parseComplexNeedFromText(text);
      if (!("clarificationRequired" in parsed) && parsed.needs.length > 0) {
        bundleItems = await buildBundlePayloadFromNeeds(
          params.customerId,
          parsed.needs.map((n) => ({ label: n.productIntent, need: n })),
          mandate,
          preferences,
        );
      }
    }

    return {
      mode: "assistant",
      sourceKind: "chat",
      assistantSummary: chatRes.reply,
      chatReply: chatRes.reply,
      toolTrace: traces,
      createdPendingOrder,
      committedOrder,
      bundleItems,
    };
  }

  // 3. Check if the user is asking for a Recipe / Dish (saved kitchen recipes OR culinary dishes)
  const kitchen = getKitchen(params.customerId);
  const savedRecipeMatches = kitchen ? matchSavedKitchenRecipes(kitchen.recipes, text) : [];
  const builtinMatch = BUILTIN_CULINARY_RECIPES.find((tpl) => tpl.matchRe.test(text));
  const explicitQuantities = parseComplexNeedFromText(text);
  const hasDirectItemNeed = !("clarificationRequired" in explicitQuantities);

  // Trigger recipe resolution when there is no explicit direct item quantity/unit (e.g. "Order for pancakes")
  // OR when the prompt explicitly mentions recipe/batches/servings/guests/make
  if ((savedRecipeMatches.length > 0 || builtinMatch) && (!hasDirectItemNeed || looksLikeRecipeIntent(text))) {
    const batchMatch = text.match(/\b(\d+)\s*batch(?:es)?\b/i);
    const guestMatch = text.match(/\b(\d+)\s*(?:guests?|people|servings?|portions?)\b/i);

    if (savedRecipeMatches.length > 0 && kitchen) {
      const reqMap = new Map<string, { qty: number; recipeNames: Set<string> }>();
      let totalServings = 0;
      const batchDescriptions: string[] = [];

      for (const r of savedRecipeMatches) {
        const batches = batchMatch
          ? Math.max(1, Number(batchMatch[1]))
          : guestMatch
            ? Math.max(1, Math.ceil(Number(guestMatch[1]) / Math.max(1, r.servingsPerBatch)))
            : Math.min(2, Math.max(1, r.batchesPerWeek));
        totalServings += batches * r.servingsPerBatch;
        batchDescriptions.push(`${batches} ${batches === 1 ? "batch" : "batches"} of ${r.name}`);
        for (const ing of r.ingredients) {
          const prev = reqMap.get(ing.ingredientId) ?? { qty: 0, recipeNames: new Set() };
          prev.qty += ing.qtyPerBatch * batches;
          prev.recipeNames.add(r.name);
          reqMap.set(ing.ingredientId, prev);
        }
      }

      const shortfallEntries: Array<{
        label: string;
        need: Need;
        contextNote?: string;
        urgency?: BundleItemPayload["urgency"];
      }> = [];
      const fullBatchEntries: Array<{
        label: string;
        need: Need;
        contextNote?: string;
        urgency?: BundleItemPayload["urgency"];
      }> = [];
      const coveredItems: CoveredItemNote[] = [];

      for (const [ingredientId, reqInfo] of reqMap.entries()) {
        const stock = kitchen.inventory.find((i: IngredientStock) => i.ingredientId === ingredientId);
        if (!stock) continue;
        const lf = mandate
          ? mustBeLactoseFree(mandate, stock)
          : Boolean(stock.lactoseFreePreferred);
        const requiredRounded = Math.max(1, Math.ceil(reqInfo.qty * 10) / 10);
        const shortfall = Math.max(0, Math.ceil((reqInfo.qty - stock.onHand) * 10) / 10);

        const buildEntry = (orderQty: number, note: string) => {
          const baseNeed = ingredientToNeed(stock, Math.max(1, Math.ceil(orderQty)), neededBy, lf);
          return {
            label: stock.name,
            need: {
              ...baseNeed,
              constraints: {
                ...baseNeed.constraints,
                keywords: (stock.catalogHints[0] ?? stock.name).split(/\s+/).filter(Boolean),
              },
            },
            contextNote: note,
            urgency: "recipe" as const,
          };
        };

        const fullEntry = buildEntry(
          requiredRounded,
          `Recipe needs ${requiredRounded} ${stock.unit} (${stock.onHand} ${stock.unit} currently in fridge)`,
        );
        fullBatchEntries.push(fullEntry);

        if (shortfall > 0) {
          shortfallEntries.push(
            buildEntry(
              shortfall,
              `Recipe needs ${requiredRounded} ${stock.unit} · ${stock.onHand} ${stock.unit} in fridge → ordering ${Math.ceil(shortfall)} ${stock.unit} shortfall`,
            ),
          );
        } else {
          coveredItems.push({
            ingredientId: stock.ingredientId,
            name: stock.name,
            requiredQty: requiredRounded,
            onHand: stock.onHand,
            unit: stock.unit,
            needToAdd: fullEntry.need,
          });
        }
      }

      const chosenEntries = shortfallEntries.length > 0 ? shortfallEntries : fullBatchEntries;
      const finalCovered = shortfallEntries.length > 0 ? coveredItems : [];
      const bundleItems = await buildBundlePayloadFromNeeds(
        params.customerId,
        chosenEntries,
        mandate,
        preferences,
      );

      const summaryNote =
        shortfallEntries.length > 0
          ? `Matched kitchen recipe **${batchDescriptions.join(" + ")}** (~${totalServings} servings). Deducted current fridge stock so you only buy what's missing — click any ingredient to swap alternatives or order the bundle directly.`
          : `Matched kitchen recipe **${batchDescriptions.join(" + ")}** (~${totalServings} servings). Your fridge already covers 1 run, so we prepared a full-batch ingredient bundle below — remove any item you don't need or swap alternatives.`;

      return {
        mode: "bundle",
        sourceKind: "recipe",
        bundleTitle: `Recipe Bundle: ${savedRecipeMatches.map((r) => r.name).join(" + ")}`,
        assistantSummary: summaryNote,
        bundleItems,
        coveredItems: finalCovered,
      };
    }

    if (builtinMatch) {
      const servings = guestMatch
        ? Math.max(5, Number(guestMatch[1]))
        : batchMatch
          ? Math.max(1, Number(batchMatch[1])) * builtinMatch.defaultServings
          : builtinMatch.defaultServings;
      const mandateLf = Boolean(mandate?.allergenRestrictions?.includes("must_be_lactose_free"));

      const entries = builtinMatch.ingredientsPerServing.map((ing) => {
        const rawQty = Math.max(1, Math.ceil(ing.qtyPerServing * servings));
        const lf = Boolean(ing.dairy && (mandateLf || /lactose[-\s]?free|laktoositon/i.test(text)));
        const intentStr = lf ? `lactose-free ${ing.productIntent}` : ing.productIntent;
        const need: Need = {
          productIntent: intentStr,
          quantity: rawQty,
          unit: ing.unit,
          neededBy,
          constraints: {
            lactoseFree: lf || undefined,
            keywords: intentStr.split(/\s+/).filter(Boolean),
          },
        };
        return {
          label: lf ? `Lactose-free ${ing.label.toLowerCase()}` : ing.label,
          need,
          contextNote: `Sized for ~${servings} servings of ${builtinMatch.name}`,
          urgency: "recipe" as const,
        };
      });

      const bundleItems = await buildBundlePayloadFromNeeds(
        params.customerId,
        entries,
        mandate,
        preferences,
      );
      return {
        mode: "bundle",
        sourceKind: "recipe",
        bundleTitle: `Recipe Bundle: ${builtinMatch.name} (~${servings} servings)`,
        assistantSummary: `Prepared a ${bundleItems.length}-ingredient bundle for **${builtinMatch.name}** (~${servings} servings, arriving by ${neededBy}). Click any ingredient to view alternatives or order the bundle directly.`,
        bundleItems,
      };
    }
  }

  // 4. Direct Single-Item or Multi-Item Request
  if (!("clarificationRequired" in explicitQuantities)) {
    const needs = explicitQuantities.needs;
    const bundleItems = await buildBundlePayloadFromNeeds(
      params.customerId,
      needs.map((n) => ({
        label: n.productIntent,
        need: n,
        urgency: "requested" as const,
      })),
      mandate,
      preferences,
    );

    const isMulti = needs.length > 1;
    return {
      mode: "bundle",
      sourceKind: isMulti ? "multi" : "single",
      bundleTitle: isMulti
        ? `Ready-to-Order Bundle · ${needs.length} Items`
        : `Best Matches · ${needs[0].quantity} ${needs[0].unit} ${needs[0].productIntent}`,
      assistantSummary: isMulti
        ? `Bundled ${needs.length} requested items with verified Valio contract prices. Order the bundle directly, or click any item below to swap alternatives.`
        : `Found ${bundleItems[0]?.offers.length ?? 0} matching Valio options for **${needs[0].quantity} ${needs[0].unit} of ${needs[0].productIntent}** by **${needs[0].neededBy}**.`,
      bundleItems,
    };
  }

  // 5. If text looks like a general question or complex sentence (has '?' or >= 6 words without being an incomplete item list), route to AI assistant!
  const wordCount = text.split(/\s+/).filter(Boolean).length;
  const hasQuestionStyle =
    text.includes("?") ||
    /^(?:can\s+you|could\s+you|what\b|which\b|show\s+me\s+our|tell\s+me|check\s+our|help\s+me|plan\b)/i.test(
      text,
    );
  if (hasQuestionStyle && wordCount >= 4) {
    const chatRes = await runPurchasingAgent({
      customerId: params.customerId,
      message: text,
      history: params.history,
      callerRole: params.callerRole,
    });
    const traces = chatRes.toolTrace ?? [];
    return {
      mode: "assistant",
      sourceKind: "chat",
      assistantSummary: chatRes.reply,
      chatReply: chatRes.reply,
      toolTrace: traces,
      createdPendingOrder: traces.some(
        (t) =>
          t.ok &&
          (t.name === "create_order_intent" ||
            t.name === "accept_suggestion" ||
            t.name === "plan_menu_sourcing" ||
            t.name === "order_event"),
      ),
      committedOrder: traces.some((t) => t.ok && t.name === "commit_order"),
    };
  }

  // 6. Otherwise return friendly inline quantity clarification (supporting partial multi-item prompts too!)
  const clarMsg = explicitQuantities.clarificationRequired;
  const quotedMatch = clarMsg.match(/"([^"]+)"/);
  const missingItemRaw = quotedMatch
    ? quotedMatch[1]
    : text
        .replace(
          /\b(by|before|on)\s+(monday|tuesday|wednesday|thursday|friday|saturday|sunday|tomorrow|\d{4}-\d{2}-\d{2})\b/gi,
          "",
        )
        .replace(/^(please\s+)?(find|order|get|buy|need|show|i\s+need|we\s+need)\s+/i, "")
        .trim();

  // Check if earlier clauses in a multi-item prompt already had valid quantities so clicking a chip preserves them!
  let preservedItemsText: string | undefined;
  if (quotedMatch) {
    const idx = text.toLowerCase().lastIndexOf(quotedMatch[1].toLowerCase());
    if (idx > 0) {
      const prefix = text
        .slice(0, idx)
        .replace(/(?:\s*(?:,|;|\+|&|\band\b|\bplus\b)\s*)+$/i, "")
        .trim();
      if (prefix) preservedItemsText = prefix;
    }
  }

  return {
    mode: "clarification",
    assistantSummary: clarMsg,
    clarification: {
      rawText: text,
      missingItem: missingItemRaw || "lactose-free milk",
      preservedItemsText,
      message: clarMsg,
    },
  };
}
