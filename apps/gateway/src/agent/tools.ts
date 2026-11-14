import { smartRestock } from "../hotel/optimizer.js";
import { randomUUID } from "node:crypto";
import { NeedSchema, type ComplexNeedResult, type Need, type Offer } from "@tta/shared";
import { getMandate } from "../auth/customers.js";
import { searchProducts, searchFromNeed } from "../catalog/index.js";
import { buildOffers, buildOffersBatch, explainOffers } from "../catalog/offers.js";
import { getPrices, getAvailability } from "../valio/client.js";
import { verifyClaim } from "../claims/sign.js";
import { SignedClaimSchema, PreferencesSchema } from "@tta/shared";
import {
  createOrderIntent,
  listPending,
  getIntent,
  commitOrder,
  listOrders,
} from "../orders/store.js";
import { createMultiItemQuote, createQuote, getQuote } from "../orders/quotes.js";
import { getAuditTrail, verifyAuditChain } from "../audit/chain.js";
import { parseComplexNeedFromText, parseNeedFromText } from "../need/parse.js";
import {
  getInventory,
  getRecipes,
  getOrderHistory,
  recommendRestock,
} from "../hotel/kitchen.js";
import { planSourcing, handleStockout } from "../hotel/planner.js";
import { listEvents, createEvent, orderEvent } from "../hotel/events.js";
import { TOOL_OWNER } from "../agents/registry.js";
import { withAgent } from "../agents/context.js";
import { UNTRUSTED_DATA_RULE } from "./sanitize.js";
import { ValioRateLimitError } from "../valio/client.js";
import { shortlistError } from "../middleware/ratelimit.js";

export type AgentToolDef = {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
};

export type AgentToolContext = {
  trustedUserText?: string;
  trustedNeed?: Need | { clarificationRequired: string };
  trustedComplexNeed?: ComplexNeedResult | { clarificationRequired: string };
  readOnlyRequest?: boolean;
  callerRole?: string;
};

function stemWord(token: string): string {
  if (token.length <= 3) return token;
  if (token.endsWith("ies") && token.length > 4) return `${token.slice(0, -3)}y`;
  if (token.endsWith("ves") && token.length > 4) return `${token.slice(0, -3)}f`;
  if (token.endsWith("oes") && token.length > 4) return token.slice(0, -2);
  if (token.endsWith("es") && token.length > 4 && /(?:sh|ch|x|z|s)es$/.test(token)) {
    return token.slice(0, -2);
  }
  if (token.endsWith("s") && !token.endsWith("ss")) return token.slice(0, -1);
  return token;
}

const GENERIC_MODIFIERS = new Set([
  "lactose",
  "free",
  "laktoositon",
  "laktosfri",
  "organic",
  "luomu",
  "vegan",
  "vegaani",
  "fresh",
  "valio",
]);

function extractItemStems(need: Pick<Need, "productIntent" | "constraints">): string[] {
  const raw = `${need.productIntent} ${(need.constraints?.keywords ?? []).join(" ")}`
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((w) => w.length >= 2 && !GENERIC_MODIFIERS.has(w));
  return [...new Set(raw.map(stemWord))];
}

function pinCandidateToTrusted(candidate: Need, trusted: Need): Need {
  return {
    ...candidate,
    // The model may normalize product wording and add constraints, but it
    // cannot rewrite the buyer's quantity, unit, or deadline for that item.
    quantity: trusted.quantity,
    unit: trusted.unit,
    neededBy: trusted.neededBy,
    constraints: {
      ...candidate.constraints,
      ...(trusted.constraints.lactoseFree !== undefined ? { lactoseFree: trusted.constraints.lactoseFree } : {}),
      ...(trusted.constraints.organic !== undefined ? { organic: trusted.constraints.organic } : {}),
      ...(trusted.constraints.excludeAllergens?.length
        ? { excludeAllergens: [...new Set([...(candidate.constraints.excludeAllergens ?? []), ...trusted.constraints.excludeAllergens])] }
        : {}),
      ...(trusted.constraints.maxPricePerUnit !== undefined
        ? {
            maxPricePerUnit:
              candidate.constraints.maxPricePerUnit !== undefined
                ? Math.min(trusted.constraints.maxPricePerUnit, candidate.constraints.maxPricePerUnit)
                : trusted.constraints.maxPricePerUnit,
          }
        : {}),
      keywords: candidate.constraints.keywords ?? trusted.constraints.keywords,
    },
  };
}

function matchTrustedNeedFromComplex(candidate: Need, trustedNeeds: Need[], fallbackIndex = 0): Need {
  const candStems = extractItemStems(candidate);
  let bestIdx = Math.min(fallbackIndex, trustedNeeds.length - 1);
  let bestScore = -1;

  for (let i = 0; i < trustedNeeds.length; i++) {
    const t = trustedNeeds[i];
    const tStems = extractItemStems(t);
    let score = 0;
    for (const cs of candStems) {
      if (tStems.some((ts) => ts === cs || ts.startsWith(cs) || cs.startsWith(ts))) {
        score += 10;
      }
    }
    if (candidate.unit === t.unit) score += 2;
    if (candidate.quantity === t.quantity) score += 3;
    if (score > bestScore) {
      bestScore = score;
      bestIdx = i;
    }
  }
  return trustedNeeds[bestIdx] ?? trustedNeeds[0];
}

export function needFromArgs(
  argsNeed: unknown,
  context?: AgentToolContext,
  fallbackIndex = 0,
): Need | { clarificationRequired: string } {
  const complex = context?.trustedComplexNeed;
  if (complex) {
    if ("clarificationRequired" in complex) return complex;
    if (complex.needs.length > 1) {
      const parsed = NeedSchema.safeParse(argsNeed);
      if (!parsed.success) {
        return complex.needs[Math.min(fallbackIndex, complex.needs.length - 1)] ?? complex.needs[0];
      }
      const matched = matchTrustedNeedFromComplex(parsed.data, complex.needs, fallbackIndex);
      return pinCandidateToTrusted(parsed.data, matched);
    }
  }

  const trusted =
    complex && !("clarificationRequired" in complex) && complex.needs[0]
      ? complex.needs[0]
      : context?.trustedNeed;
  if (!trusted) return NeedSchema.parse(argsNeed);
  if ("clarificationRequired" in trusted) return trusted;

  const parsed = NeedSchema.safeParse(argsNeed);
  const candidate = parsed.success ? parsed.data : trusted;
  return pinCandidateToTrusted(candidate, trusted);
}

const NEED_PARAM_SCHEMA: Record<string, unknown> = {
  type: "object",
  description: "Structured Need from parse_need",
  properties: {
    productIntent: { type: "string" },
    quantity: { type: "number" },
    unit: { type: "string", enum: ["litre", "kg", "each", "pack"] },
    neededBy: { type: "string", description: "YYYY-MM-DD" },
    constraints: {
      type: "object",
      properties: {
        lactoseFree: { type: "boolean" },
        organic: { type: "boolean" },
        keywords: { type: "array", items: { type: "string" } },
        excludeAllergens: { type: "array", items: { type: "string" } },
        maxPricePerUnit: { type: "number" },
      },
    },
  },
  required: ["productIntent", "quantity", "unit", "neededBy"],
};

const CLAIM_PARAM_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    version: { type: "number" },
    claimId: { type: "string" },
    issuer: { type: "string" },
    keyId: { type: "string" },
    asOf: { type: "string" },
    signature: { type: "string" },
    claim: {
      type: "object",
      properties: {
        customerId: { type: "string" },
        productId: { type: "string" },
        unitPrice: { type: "number" },
        currency: { type: "string" },
        validUntil: { type: "string" },
        claimType: { type: "string" },
      },
    },
  },
  required: ["claim", "issuer", "keyId", "asOf", "signature"],
};

export const agentToolDefs: AgentToolDef[] = [
  {
    type: "function",
    function: {
      name: "parse_need",
      description:
        "Parse a natural-language purchasing request into one or more structured Needs (returns isMultiItem=true and a needs[] array when multiple items are requested). Extract neededBy only from the user's text and default to next Monday if no date is stated. Do not provide a separate date hint. Only returns clarificationRequired when quantity/unit is missing — do not invent customer or allergens.",
      parameters: {
        type: "object",
        properties: {
          text: { type: "string" },
        },
        required: ["text"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "plan_menu_sourcing",
      description:
        "Recipe-driven sourcing for a menu or event: computes ingredient requirements from recipes, subtracts on-hand + on-order stock, queries Valio only for shortfalls, and returns per-ingredient status (covered / sourced / substitute_proposed / partial / unsourceable) with recipe-compatible good/better/best substitutes and trade-offs. Set createIntents=true to open order intents (substitutions always need human approval).",
      parameters: {
        type: "object",
        properties: {
          neededBy: { type: "string", description: "YYYY-MM-DD" },
          recipes: {
            type: "array",
            description: "Recipes to cook; omit for all recipes at their weekly batches",
            items: {
              type: "object",
              properties: {
                recipeId: { type: "string" },
                batches: { type: "number" },
              },
              required: ["recipeId"],
            },
          },
          createIntents: { type: "boolean" },
        },
        required: ["neededBy"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "handle_stockout",
      description:
        "A key ingredient ran out or cannot be delivered. Finds recipes that depend on it and proposes a recipe-compatible substitute (keeps lactose/allergen constraints) with the trade-off explained.",
      parameters: {
        type: "object",
        properties: {
          ingredientId: { type: "string" },
          productId: { type: "string", description: "SKU that ran out, if known" },
          neededBy: { type: "string", description: "YYYY-MM-DD" },
          createIntents: { type: "boolean" },
        },
        required: ["ingredientId", "neededBy"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_events",
      description: "List the kitchen's upcoming events (banquets, parties) with readiness: covered / ready_to_order / at_risk / ordered, order-by date and estimated extra cost.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "create_event",
      description:
        "Register a big event (wedding, party, school lunch) so the Planner works out the EXTRA ingredients needed on top of normal usage, checks Valio can deliver in time and schedules ordering. Use get_recipes first to pick recipe ids. Returns readiness and the plan; call order_event to place orders now.",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string" },
          date: { type: "string", description: "Event day, YYYY-MM-DD" },
          guests: { type: "number" },
          recipes: {
            type: "array",
            items: { type: "object", properties: { recipeId: { type: "string" }, servings: { type: "number", description: "Defaults to guests" } }, required: ["recipeId"] },
          },
          extras: { type: "array", items: { type: "object", properties: { ingredientId: { type: "string" }, qty: { type: "number" } }, required: ["ingredientId", "qty"] } },
          bufferPct: { type: "number", description: "Safety margin, default 10" },
        },
        required: ["name", "date", "guests", "recipes"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "order_event",
      description: "Place the orders for an event now (inside the mandate they are placed; others wait for human approval).",
      parameters: { type: "object", properties: { eventId: { type: "string" } }, required: ["eventId"] },
    },
  },
  {
    type: "function",
    function: {
      name: "get_mandate",
      description: "Get the authenticated customer's purchasing mandate (authority limits).",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "get_inventory",
      description:
        "Get the hotel/kitchen current ingredient on-hand list with par levels.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "get_recipes",
      description:
        "Get recipes the kitchen serves, including ingredients per batch and batches/week.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "get_order_history",
      description:
        "Get recent purchasing/order history for this customer (standing order context).",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "smart_restock",
      description:
        "Compare the exact restock quantity with other pack sizes (cheapest per unit actually used, within shelf life) and list stock to use first (near expiry / untouched). Use when asked about saving money, bulk, waste or expiry. Read-only.",
      parameters: {
        type: "object",
        properties: { daysCover: { type: "number", description: "Planning horizon in days (default 7)" } },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "recommend_restock",
      description:
        "Compare inventory + recipe demand + order history and return prioritized restock recommendations (what to order and how much).",
      parameters: {
        type: "object",
        properties: {
          daysCover: {
            type: "number",
            description: "Planning horizon in days (default 7)",
          },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "search_products",
      description:
        "Search the local Valio catalog (static data). Narrow candidates before price/availability.",
      parameters: {
        type: "object",
        properties: {
          q: { type: "string" },
          lactoseFree: { type: "boolean" },
          limit: { type: "number" },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "rank_offers",
      description:
        "Build ranked offers for one Need (`need`) or a multi-item basket (`needs` array): catalog + live Valio price/availability + pack math.",
      parameters: {
        type: "object",
        properties: {
          need: NEED_PARAM_SCHEMA,
          needs: {
            type: "array",
            description: "Pass all needs here when parse_need returned isMultiItem=true to batch-rank every item at once.",
            items: NEED_PARAM_SCHEMA,
          },
          preferences: {
            type: "object",
            description:
              "Optional weights {price, reliability, carbon, delivery} (non-negative, normalised). Use carbon high when the buyer wants sustainable options. Omit for default ranking.",
            properties: { price: { type: "number" }, reliability: { type: "number" }, carbon: { type: "number" }, delivery: { type: "number" } },
          },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "request_quote",
      description:
        "Request a firm-price quote (price guaranteed until validUntil, availability not held) for one need (`need`) or a multi-item bundle (`items: [{ need, productId }]`). Then pass quoteId to create_order_intent.",
      parameters: {
        type: "object",
        properties: {
          need: NEED_PARAM_SCHEMA,
          productIds: { type: "array", items: { type: "string" } },
          items: {
            type: "array",
            description: "Multi-item quote lines: one { need, productId } per requested item.",
            items: {
              type: "object",
              properties: {
                need: NEED_PARAM_SCHEMA,
                productId: { type: "string" },
              },
              required: ["need"],
            },
          },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_quote",
      description: "Get a quote by id (status open|used|expired|withdrawn, validUntil, lines).",
      parameters: { type: "object", properties: { quoteId: { type: "string" } }, required: ["quoteId"] },
    },
  },
  {
    type: "function",
    function: {
      name: "create_order_intent",
      description:
        "Create a fixed-price order intent (NOT a commitment) for one item (`need` + `offerProductId`), a multi-item basket (`items: [{ need, offerProductId }]`), or from a firm `quoteId` (no re-pricing). Returns policy decision: auto_commit, pending_approval, or blocked.",
      parameters: {
        type: "object",
        properties: {
          need: NEED_PARAM_SCHEMA,
          offerProductId: { type: "string" },
          quoteId: { type: "string" },
          items: {
            type: "array",
            description: "Consolidated multi-item basket lines: one { need, offerProductId } per requested item.",
            items: {
              type: "object",
              properties: {
                need: NEED_PARAM_SCHEMA,
                offerProductId: { type: "string" },
              },
              required: ["need"],
            },
          },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "commit_order",
      description:
        "Commit an auto_eligible or approved intent after revalidation. Will fail if pending_approval without human approval.",
      parameters: {
        type: "object",
        properties: {
          intentId: { type: "string" },
          idempotencyKey: { type: "string" },
        },
        required: ["intentId"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_pending_approvals",
      description: "List intents waiting for human approval for this customer.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "list_orders",
      description: "List recent order intents/orders for this customer.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "get_order_intent",
      description: "Fetch one order intent by id.",
      parameters: {
        type: "object",
        properties: { intentId: { type: "string" } },
        required: ["intentId"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_audit_trail",
      description: "Hash-chained audit events for a run id.",
      parameters: {
        type: "object",
        properties: { runId: { type: "string" } },
        required: ["runId"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "verify_claim",
      description: "Verify a signed price/availability claim envelope.",
      parameters: {
        type: "object",
        properties: { claim: CLAIM_PARAM_SCHEMA },
        required: ["claim"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_prices",
      description: "On-demand Valio prices for specific product ids (max 1000, prefer shortlists).",
      parameters: {
        type: "object",
        properties: {
          requestedDate: { type: "string" },
          productIds: { type: "array", items: { type: "string" } },
        },
        required: ["requestedDate", "productIds"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_availability",
      description: "On-demand Valio availability for specific product ids.",
      parameters: {
        type: "object",
        properties: {
          requestedDate: { type: "string" },
          productIds: { type: "array", items: { type: "string" } },
        },
        required: ["requestedDate", "productIds"],
      },
    },
  },
];

export type ToolTrace = {
  /** Which specialist agent performed this call. */
  agent?: string;
  name: string;
  args: unknown;
  resultSummary: string;
  ok: boolean;
};

function summarize(result: unknown): string {
  const s = JSON.stringify(result);
  return s.length > 4000 ? JSON.stringify(result, null, 2).slice(0, 2000) + "\n…" : s;
}

function formatComplexParseResult(
  complex: ComplexNeedResult | { clarificationRequired: string },
): Record<string, unknown> {
  if ("clarificationRequired" in complex) return complex;
  return {
    ...complex.needs[0],
    needs: complex.needs,
    isMultiItem: complex.isMultiItem,
  };
}

function trimOfferForAgent(o: Offer) {
  return {
    productId: o.productId,
    productName: o.productName,
    brand: o.brand,
    requiredPacks: o.requiredPacks,
    packSize: o.packSize,
    packUnit: o.packUnit,
    totalQuantity: o.totalQuantity,
    unitPrice: o.unitPrice,
    totalPrice: o.totalPrice,
    comparisonPrice: o.comparisonPrice,
    comparisonUnit: o.comparisonUnit,
    availableDate: o.availableDate,
    availableQuantity: o.availableQuantity,
    availabilityUnknown: o.availabilityUnknown,
    canFulfil: o.canFulfil,
    shortfall: o.shortfall,
    isSubstitution: o.isSubstitution,
    substitutionLabel: o.substitutionLabel,
    deliveryReliability: o.deliveryReliability,
    carbonKgPerKg: o.carbonKgPerKg,
    score: o.score,
    scoreReasons: o.scoreReasons,
    paretoOptimal: o.paretoOptimal,
    cutoffRisk: o.cutoffRisk,
    orderByAt: o.orderByAt,
    criteriaScores: o.criteriaScores,
    priceClaimSignature: o.priceClaim?.signature?.slice(0, 16),
  };
}

export async function executeAgentTool(
  customerId: string,
  name: string,
  args: Record<string, unknown>,
  context?: AgentToolContext,
): Promise<{ result: unknown; trace: ToolTrace }> {
  if (context?.callerRole && context.callerRole !== "buyer" && (name === "create_event" || name === "order_event")) {
    throw new Error(`forbidden: ${name} requires a buyer credential`);
  }
  try {
    const owner = TOOL_OWNER[name];
    const runTool = async () => {
      const purchaseSideEffect = ["create_order_intent", "commit_order", "request_quote", "accept_suggestion", "order_event", "create_event"].includes(name) ||
        (["plan_menu_sourcing", "handle_stockout"].includes(name) && Boolean(args.createIntents));
      if (context?.readOnlyRequest && purchaseSideEffect) {
        return { refused: true, reason: "The buyer explicitly asked to keep this request read-only. Do not create a quote or order." };
      }
      if (name === "get_prices" || name === "get_availability" || name === "rank_offers" || name === "request_quote") {
        const tooBig = shortlistError(args.productIds);
        if (tooBig) throw new Error(`${tooBig.error}: ${tooBig.message}`);
      }
      switch (name) {
        case "parse_need": {
          if (context?.trustedComplexNeed && !("clarificationRequired" in context.trustedComplexNeed)) {
            return formatComplexParseResult(context.trustedComplexNeed);
          }
          if (context?.trustedNeed && !("clarificationRequired" in context.trustedNeed)) {
            return context.trustedNeed;
          }
          const argText = typeof args.text === "string" ? args.text.trim() : "";
          if (context?.trustedUserText) {
            const fromTrusted = parseComplexNeedFromText(context.trustedUserText);
            if (!("clarificationRequired" in fromTrusted) || !argText) {
              return formatComplexParseResult(fromTrusted);
            }
          }
          const parsedComplex = parseComplexNeedFromText(argText || context?.trustedUserText || "");
          if ("clarificationRequired" in parsedComplex) {
            const fallbackSingle = parseNeedFromText(argText || context?.trustedUserText || "");
            return fallbackSingle;
          }
          return formatComplexParseResult(parsedComplex);
        }
        case "get_mandate":
          return getMandate(customerId);
        case "get_inventory":
          return getInventory(customerId) ?? { error: "no_kitchen_profile" };
        case "get_recipes":
          return getRecipes(customerId) ?? { error: "no_kitchen_profile" };
        case "get_order_history":
          return getOrderHistory(customerId) ?? { error: "no_kitchen_profile" };
        case "smart_restock":
          return (await smartRestock(customerId, { daysCover: Number(args.daysCover ?? 7) })) ?? { error: "no_kitchen_profile" };
        case "recommend_restock":
          return (
            recommendRestock(customerId, {
              daysCover: Number(args.daysCover ?? 7),
            }) ?? { error: "no_kitchen_profile" }
          );
        case "search_products": {
          if (args.need) {
            return {
              products: searchFromNeed(NeedSchema.parse(args.need), Number(args.limit ?? 15)),
            };
          }
          return {
            products: searchProducts({
              q: args.q as string,
              lactoseFree: args.lactoseFree as boolean | undefined,
              limit: Number(args.limit ?? 15),
            }).map((p) => ({
              productId: p.productId,
              name: p.name,
              brand: p.brand,
              packSize: p.packSize,
              packUnit: p.packUnit,
              labels: p.labels,
            })),
          };
        }
        case "rank_offers": {
          const mandate = getMandate(customerId);
          const preferences = args.preferences ? PreferencesSchema.parse(args.preferences) : undefined;
          if (Array.isArray(args.needs) && args.needs.length > 0) {
            const boundNeeds: Need[] = [];
            for (let i = 0; i < args.needs.length; i++) {
              const bound = needFromArgs(args.needs[i], context, i);
              if ("clarificationRequired" in bound) return bound;
              boundNeeds.push(bound);
            }
            const batch = await buildOffersBatch(customerId, boundNeeds, {
              includeSubstitutions: true,
              preferences,
              mandate,
            });
            return {
              isMultiItem: boundNeeds.length > 1,
              explanation: batch.combinedExplanation,
              items: batch.items.map((it) => ({
                need: it.need,
                explanation: it.explanation,
                offers: it.offers.slice(0, 6).map(trimOfferForAgent),
                partialAvailability: it.offers.some((o) => !o.canFulfil),
              })),
              offers: (batch.items[0]?.offers ?? []).slice(0, 8).map(trimOfferForAgent),
            };
          }
          const need = needFromArgs(args.need, context);
          if ("clarificationRequired" in need) return need;
          const offers = await buildOffers(customerId, need, {
            includeSubstitutions: true,
            preferences,
          });
          return {
            explanation: explainOffers(offers, need, mandate),
            offers: offers.slice(0, 8).map(trimOfferForAgent),
            partialAvailability: offers.some((o) => !o.canFulfil),
            substitutions: offers
              .filter((o) => o.substitutionLabel)
              .map((o) => ({
                productId: o.productId,
                label: o.substitutionLabel,
                canFulfil: o.canFulfil,
                shortfall: o.shortfall,
                totalPrice: o.totalPrice,
              })),
          };
        }
        case "list_events":
          return { events: listEvents(customerId) };
        case "create_event":
          return createEvent(customerId, args as never);
        case "order_event":
          return orderEvent(customerId, String(args.eventId));
        case "plan_menu_sourcing": {
          const mandate = getMandate(customerId);
          if (!mandate) throw new Error("no mandate");
          return planSourcing(customerId, mandate, {
            neededBy: String(args.neededBy),
            recipes: args.recipes as Array<{ recipeId: string; batches?: number }> | undefined,
            createIntents: Boolean(args.createIntents),
          });
        }
        case "handle_stockout": {
          const mandate = getMandate(customerId);
          if (!mandate) throw new Error("no mandate");
          return handleStockout(customerId, mandate, {
            ingredientId: String(args.ingredientId),
            productId: args.productId as string | undefined,
            neededBy: String(args.neededBy),
            createIntents: Boolean(args.createIntents),
          });
        }
        case "create_order_intent": {
          const mandate = getMandate(customerId);
          if (!mandate) throw new Error("no mandate");
          if (Array.isArray(args.items) && args.items.length > 0) {
            const boundItems: Array<{ need: Need; offerProductId?: string }> = [];
            for (let i = 0; i < args.items.length; i++) {
              const rawItem = args.items[i] as { need?: unknown; offerProductId?: string };
              const boundNeed = needFromArgs(rawItem?.need, context, i);
              if ("clarificationRequired" in boundNeed) return boundNeed;
              boundItems.push({
                need: boundNeed,
                offerProductId: typeof rawItem?.offerProductId === "string" ? rawItem.offerProductId : undefined,
              });
            }
            return createOrderIntent({
              customerId,
              mandate,
              items: boundItems,
            });
          }
          const quoteId = args.quoteId as string | undefined;
          const existingQuote = quoteId ? getQuote(quoteId, customerId) : undefined;
          if (quoteId && existingQuote?.isMultiItemBasket && existingQuote.lines.length > 1) {
            return createOrderIntent({
              customerId,
              mandate,
              quoteId,
              offerProductId: args.offerProductId as string | undefined,
            });
          }
          const need = needFromArgs(
            args.need ?? existingQuote?.need,
            context,
          );
          if ("clarificationRequired" in need) return need;
          return createOrderIntent({
            customerId,
            mandate,
            need,
            offerProductId: args.offerProductId as string | undefined,
            quoteId,
          });
        }
        case "request_quote": {
          if (Array.isArray(args.items) && args.items.length > 0) {
            const boundItems: Array<{ need: Need; productId?: string }> = [];
            for (let i = 0; i < args.items.length; i++) {
              const rawItem = args.items[i] as { need?: unknown; productId?: string };
              const boundNeed = needFromArgs(rawItem?.need, context, i);
              if ("clarificationRequired" in boundNeed) return boundNeed;
              boundItems.push({
                need: boundNeed,
                productId: typeof rawItem?.productId === "string" ? rawItem.productId : undefined,
              });
            }
            return createMultiItemQuote(customerId, boundItems);
          }
          const need = needFromArgs(args.need, context);
          if ("clarificationRequired" in need) return need;
          return createQuote(customerId, need, {
            productIds: Array.isArray(args.productIds) ? (args.productIds as string[]) : undefined,
          });
        }
        case "get_quote":
          return getQuote(String(args.quoteId), customerId) ?? { error: "not_found" };
        case "commit_order":
          return commitOrder({
            intentId: String(args.intentId),
            customerId,
            idempotencyKey: String(args.idempotencyKey ?? randomUUID()),
          });
        case "list_pending_approvals":
          return { intents: listPending(customerId) };
        case "list_orders":
          return { orders: listOrders(customerId) };
        case "get_order_intent":
          return getIntent(String(args.intentId), customerId);
        case "get_audit_trail":
          return {
            events: getAuditTrail(String(args.runId), customerId),
            verification: verifyAuditChain(String(args.runId), customerId),
          };
        case "verify_claim":
          return verifyClaim(SignedClaimSchema.parse(args.claim), { customerId });
        case "get_prices":
          return {
            products: await getPrices(
              customerId,
              String(args.requestedDate),
              args.productIds as string[],
            ),
          };
        case "get_availability":
          return {
            products: await getAvailability(
              customerId,
              String(args.requestedDate),
              args.productIds as string[],
            ),
          };
        default:
          throw new Error(`Unknown tool: ${name}`);
      }
    };
    const result = await (owner ? withAgent(owner, runTool) : runTool());

    return {
      result,
      trace: { agent: owner, name, args, resultSummary: summarize(result), ok: true },
    };
  } catch (e) {
    if (e instanceof ValioRateLimitError) throw e;
    const message = e instanceof Error ? e.message : String(e);
    return {
      result: { error: message },
      trace: { agent: TOOL_OWNER[name], name, args, resultSummary: message, ok: false },
    };
  }
}

export function purchasingSystemPrompt(customerId: string): string {
  const todayUtc = new Date().toISOString().slice(0, 10);
  return `You are the buyer's purchasing agent for Valio Aimo (customer ${customerId}). Today is ${todayUtc} (UTC).

You are NOT a Q&A chatbot. Your job is to execute procurement via gateway tools under a purchasing mandate.
Users may describe many kinds of kitchen situations in their own words. Interpret intent generically and compose the right tool sequence — do not assume a fixed menu of scenarios.

Core purchase path (when the user wants something ordered):
parse_need → rank_offers → create_order_intent → commit_order only if auto_eligible.
- Multi-item requests: When parse_need returns isMultiItem=true with a needs[] array of 2+ items, NEVER drop secondary items. Pass needs to rank_offers({ needs }) to rank every item, pick the best fulfilable offer per item, and pass items: [{ need, offerProductId }, ...] to create_order_intent to build ONE consolidated multi-item basket order. Commit via commit_order if auto_eligible, or escalate if pending_approval.
If pending_approval → stop and escalate (intent id + snapshot hash). Never approve or override.
For chat, parse_need is bound to the user's exact latest message. Never paraphrase it or append a date, quantity, unit, or constraint.
The server pins quantity, unit, and neededBy in rank_offers, request_quote, and create_order_intent to the buyer's parsed request. Treat those returned tool values as authoritative. Never state a different deadline or availability date than the tool results.
If an offer has availabilityUnknown=true, say Valio does not report a stock quantity for that terminal product; do not describe it as confirmed in-stock.

Restock / "what should we order?" (STRICT — do not stall on search):
0) For cost / waste / expiry questions call smart_restock: it prices bigger pack sizes and lists stock to use first. Offer the smarter option with its reason; never order a bulk quantity without the user's yes.
1) Call recommend_restock once (skip separate inventory/recipes/history unless the user asks for that detail).
2) Pick the top 1–2 CRITICAL (then LOW) items. Do NOT loop search_products. Do NOT ask for a delivery date — omit neededBy (defaults to next Monday) or pass an explicit YYYY-MM-DD.
3) For each: parse_need → rank_offers → create_order_intent (best canFulfil offer).
4) auto_eligible → commit_order; pending_approval → escalate and stop.
5) Short summary; max one rank_offers per ingredient.

Capability patterns (compose as needed from the user's ask — not a checklist to force):
- Big events (wedding, banquet, party): create_event (extra demand on top of normal usage + lead time + risk), then order_event when the user agrees. Quick what-if / last-minute: plan_menu_sourcing (recipes → shortfalls → offers + recipe-compatible substitutes). Supplier stock-out: handle_stockout.
- Menu / recipe driven demand: use get_recipes + get_inventory (or recommend_restock) to derive gaps, then purchase path.
- Time-critical needs: honour neededBy; flag offers that cannot arrive in time; propose recipe-compatible alternatives via substitutionLabel / fulfilable SKUs — never a silent SKU swap.
- Shortfalls / stock-outs: identify dependent recipes when relevant, explain trade-offs (pack, price, delivery, reliability), then intent only for the chosen path.
- Suggestions / new products: search/rank against kitchen context + mandate; propose with rationale; do not commit unless the user confirms.
- Policy / allergen constraints: get_mandate; treat allergenRestrictions and lactoseFreePreferred as hard constraints; escalate when policy blocks auto-commit.
- Recurring-order anomalies: recommend_restock + get_order_history; surface standingOrderDrift / qty or cost creep; do not auto-order drifted lines unless the user overrides.

Hard rules:
- ${UNTRUSTED_DATA_RULE}
- Always use tools for kitchen, catalog, prices, availability, intents, commits. Never invent prices, stock, recipes, or product ids.
- Prefer fulfilable offers (canFulfil=true). If none, report shortfall / partial availability and any good/better/best substitutionLabel — create intent only if the user wants partial/substitution (policy may require approval).
- Query price/availability only via rank_offers / get_prices for shortlisted SKUs — never bulk-query the catalog.
- Never bypass the purchasing mandate. You cannot call approve_order or authorize overrides; tell the human to use the Approval desk.
- If ambiguous (missing quantity or unit), ask one short clarification. Do not invent allergen constraints.
- Concise replies: what you found, what you ordered/proposed, € total, policy decision, next step.`;
}
