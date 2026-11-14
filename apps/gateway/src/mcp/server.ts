import { smartRestock } from "../hotel/optimizer.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { NeedSchema, SignedClaimSchema, PreferencesSchema } from "@tta/shared";
import { randomUUID } from "node:crypto";
import { authenticate, getMandate } from "../auth/customers.js";
import { searchProducts, searchFromNeed, loadCatalog } from "../catalog/index.js";
import { buildOffers, explainOffers } from "../catalog/offers.js";
import { getPrices, getAvailability } from "../valio/client.js";
import { verifyClaim, getPublicKeyPem } from "../claims/sign.js";
import {
  createOrderIntent,
  listPending,
  getIntent,
  approveOrder,
  rejectOrder,
  commitOrder,
} from "../orders/store.js";
import { createQuote, getQuote } from "../orders/quotes.js";
import { getAuditTrail, verifyAuditChain, appendAudit } from "../audit/chain.js";
import { parseNeedFromText } from "../need/parse.js";
import {
  getInventory,
  getRecipes,
  getOrderHistory,
  recommendRestock,
} from "../hotel/kitchen.js";
import { planSourcing, handleStockout } from "../hotel/planner.js";
import { mcpToolAllowed, TOOL_OWNER, AGENTS, type AgentId } from "../agents/registry.js";
import { withAgent } from "../agents/context.js";
import { listSuggestions, runValioAgent, acceptSuggestion, dismissSuggestion } from "../agents/valioAgent.js";
import { listStanding } from "../hotel/standing.js";
import { listEvents } from "../hotel/events.js";
import { explainOrder } from "../ops/explain.js";
import { checkLimit, auditRefusal, rateLimitBody, shortlistError, SENSITIVE_TOOLS } from "../middleware/ratelimit.js";

/**
 * MCP tools mirror REST. Auth via VALIO_GATEWAY_API_KEY env for the MCP process.
 */
export async function startMcpServer() {
  loadCatalog();
  const apiKey = process.env.VALIO_GATEWAY_API_KEY ?? process.env.DEMO_API_KEY_HOTEL;
  const auth = authenticate(apiKey);
  if (!auth) {
    throw new Error("Set VALIO_GATEWAY_API_KEY to a valid demo customer key");
  }

  const server = new Server(
    { name: "valio-aimo-agent-gateway", version: "0.1.0" },
    { capabilities: { tools: {} } },
  );

  const BUYER_ONLY_TOOLS = new Set(["approve_order", "reject_order"]);
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: ([
      {
        name: "plan_menu_sourcing",
        description:
          "Recipes/event -> ingredient needs -> shortfall vs stock+open orders -> Valio offers with recipe-compatible good/better/best substitutes. createIntents=true opens order intents under the mandate.",
        inputSchema: {
          type: "object",
          properties: {
            neededBy: { type: "string" },
            recipes: {
              type: "array",
              items: {
                type: "object",
                properties: { recipeId: { type: "string" }, batches: { type: "number" } },
                required: ["recipeId"],
              },
            },
            createIntents: { type: "boolean" },
          },
          required: ["neededBy"],
        },
      },
      {
        name: "handle_stockout",
        description:
          "Supplier stock-out: finds dependent recipes and proposes a recipe-compatible substitute with trade-offs (lactose/allergen constraints kept).",
        inputSchema: {
          type: "object",
          properties: {
            ingredientId: { type: "string" },
            productId: { type: "string", description: "SKU that ran out, if known" },
            neededBy: { type: "string" },
            createIntents: { type: "boolean" },
          },
          required: ["ingredientId", "neededBy"],
        },
      },
      {
        name: "list_suggestions",
        description: "Suggestions from Valio's account agent (stock-out alerts, cheaper equivalents) waiting for the buyer.",
        inputSchema: { type: "object", properties: {} },
      },
      {
        name: "run_account_check",
        description: "Valio's account agent checks the customer's usual products against live stock/prices and files suggestions.",
        inputSchema: { type: "object", properties: {} },
      },
      {
        name: "accept_suggestion",
        description: "Act on a Valio suggestion through the Procurement path. The mandate still applies (a substitute needs human sign-off).",
        inputSchema: { type: "object", properties: { suggestionId: { type: "string" } }, required: ["suggestionId"] },
      },
      {
        name: "dismiss_suggestion",
        description: "Dismiss a Valio suggestion.",
        inputSchema: { type: "object", properties: { suggestionId: { type: "string" } }, required: ["suggestionId"] },
      },
      {
        name: "list_events",
        description: "Upcoming events (banquets, parties) with readiness, order-by date and risk.",
        inputSchema: { type: "object", properties: {} },
      },
      {
        name: "list_recurring_orders",
        description: "The buyer's recurring (standing) orders: item, quantity, delivery weekday, lead time, next order date.",
        inputSchema: { type: "object", properties: {} },
      },
      {
        name: "search_products",
        description: "Search local Valio catalog (static). Narrow before price/availability.",
        inputSchema: {
          type: "object",
          properties: {
            q: { type: "string" },
            lactoseFree: { type: "boolean" },
            limit: { type: "number" },
          },
        },
      },
      {
        name: "get_prices",
        description: "On-demand Valio prices with signed claim envelopes",
        inputSchema: {
          type: "object",
          properties: {
            requestedDate: { type: "string" },
            productIds: { type: "array", items: { type: "string" } },
          },
          required: ["requestedDate", "productIds"],
        },
      },
      {
        name: "get_availability",
        description: "On-demand Valio availability with signed claims",
        inputSchema: {
          type: "object",
          properties: {
            requestedDate: { type: "string" },
            productIds: { type: "array", items: { type: "string" } },
          },
          required: ["requestedDate", "productIds"],
        },
      },
      {
        name: "rank_offers",
        description: "Deterministic offer ranking for a structured Need",
        inputSchema: {
          type: "object",
          properties: {
            need: { type: "object" },
            preferences: {
              type: "object",
              description: "Optional non-negative weights {price, reliability, carbon, delivery}; normalised. Omit for default ranking.",
              properties: { price: { type: "number" }, reliability: { type: "number" }, carbon: { type: "number" }, delivery: { type: "number" } },
            },
          },
          required: ["need"],
        },
      },
      {
        name: "verify_claim",
        description: "Verify a signed price/availability claim",
        inputSchema: {
          type: "object",
          properties: { claim: { type: "object" } },
          required: ["claim"],
        },
      },
      {
        name: "get_mandate",
        description: "Get purchasing mandate for authenticated customer",
        inputSchema: { type: "object", properties: {} },
      },
      {
        name: "request_quote",
        description:
          "Request a firm-price quote for a need (optionally for shortlisted productIds). Price is guaranteed until validUntil (default 30 min); availability is not held. Next: create_order_intent with quoteId.",
        inputSchema: {
          type: "object",
          properties: {
            need: { type: "object" },
            productIds: { type: "array", items: { type: "string" } },
          },
          required: ["need"],
        },
      },
      {
        name: "get_quote",
        description: "Get a quote by id: lines, signed claims, validUntil and status (open|used|expired|withdrawn)",
        inputSchema: { type: "object", properties: { quoteId: { type: "string" } }, required: ["quoteId"] },
      },
      {
        name: "create_order_intent",
        description:
          "Create fixed-price order intent (not a commitment). Pass quoteId to use a firm quote's lines and prices (no re-pricing; need optional then).",
        inputSchema: {
          type: "object",
          properties: {
            need: { type: "object" },
            offerProductId: { type: "string" },
            quoteId: { type: "string" },
          },
        },
      },
      {
        name: "list_pending_approvals",
        description: "List intents awaiting human approval",
        inputSchema: { type: "object", properties: {} },
      },
      {
        name: "get_order_intent",
        description: "Get order intent by id",
        inputSchema: {
          type: "object",
          properties: { intentId: { type: "string" } },
          required: ["intentId"],
        },
      },
      {
        name: "explain_order",
        description:
          "Read-only plain-English explanation of an order: summary, timeline, who decided and which mandate rules passed/failed/were overridden, offers considered and why one was chosen, price/availability facts with claim verification status.",
        inputSchema: {
          type: "object",
          properties: { intentId: { type: "string" } },
          required: ["intentId"],
        },
      },
      {
        name: "approve_order",
        description:
          "Human approve exact basket snapshot. If mandate failingRules exist, requires authorizeMandateOverride=true and acknowledgedRules covering every failing rule — silent override is rejected.",
        inputSchema: {
          type: "object",
          properties: {
            intentId: { type: "string" },
            snapshotHash: { type: "string" },
            authorizeMandateOverride: { type: "boolean" },
            acknowledgedRules: {
              type: "array",
              items: { type: "string" },
            },
          },
          required: ["intentId", "snapshotHash"],
        },
      },
      {
        name: "reject_order",
        description: "Human reject order intent",
        inputSchema: {
          type: "object",
          properties: {
            intentId: { type: "string" },
            snapshotHash: { type: "string" },
            reason: { type: "string" },
          },
          required: ["intentId", "snapshotHash"],
        },
      },
      {
        name: "commit_order",
        description: "Revalidate price/availability and commit with idempotency key",
        inputSchema: {
          type: "object",
          properties: {
            intentId: { type: "string" },
            idempotencyKey: { type: "string" },
          },
          required: ["intentId", "idempotencyKey"],
        },
      },
      {
        name: "get_audit_trail",
        description: "Hash-chained audit events for a run",
        inputSchema: {
          type: "object",
          properties: { runId: { type: "string" } },
          required: ["runId"],
        },
      },
      {
        name: "verify_audit_chain",
        description: "Verify audit hash chain integrity",
        inputSchema: {
          type: "object",
          properties: { runId: { type: "string" } },
          required: ["runId"],
        },
      },
      {
        name: "parse_need",
        description: "Optional deterministic NL→Need helper (clarifies instead of inventing)",
        inputSchema: {
          type: "object",
          properties: {
            text: { type: "string" },
            neededBy: { type: "string" },
          },
          required: ["text"],
        },
      },
      {
        name: "get_public_key",
        description: "Publish gateway claim verification public key",
        inputSchema: { type: "object", properties: {} },
      },
      {
        name: "get_inventory",
        description: "Buyer kitchen on-hand inventory + par levels",
        inputSchema: { type: "object", properties: {} },
      },
      {
        name: "get_recipes",
        description: "Kitchen recipes with ingredient demand",
        inputSchema: { type: "object", properties: {} },
      },
      {
        name: "get_order_history",
        description: "Standing-order / recent purchase history",
        inputSchema: { type: "object", properties: {} },
      },
      {
        name: "recommend_restock",
        description:
          "Prioritized restock recommendations (includes standingOrderDrift). Prefer this over guessing.",
        inputSchema: {
          type: "object",
          properties: { daysCover: { type: "number" } },
        },
      },
      {
        name: "smart_restock",
        description:
          "Prices the exact restock quantity against other pack sizes (cheapest per unit actually used, within shelf life) and lists stock to use first (near expiry / untouched for weeks). Read-only.",
        inputSchema: { type: "object", properties: { daysCover: { type: "number" } } },
      },
    ]).filter((t) => mcpToolAllowed(auth, t.name)),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const name = req.params.name;
    const args = (req.params.arguments ?? {}) as Record<string, unknown>;
    const mandate = getMandate(auth.customerId);

    // Least privilege over MCP too: the key's role/agent decides which tools it may call.
    if (!mcpToolAllowed(auth, name)) {
      appendAudit(randomUUID(), auth.customerId, "forbidden_action", {
        action: `MCP tool ${name}`,
        role: auth.agentId ? `${AGENTS[auth.agentId as AgentId].short} agent` : auth.role,
        agent: auth.agentId ?? null,
      });
      return {
        isError: true,
        content: [
          {
            type: "text",
            text: `forbidden: this credential${auth.agentId ? ` (${AGENTS[auth.agentId as AgentId].name})` : ""} may not call "${name}".`,
          },
        ],
      };
    }
    // Rate limit per API key (stable code `rate_limited`) and cap price/availability shortlists.
    const limited = checkLimit(apiKey ?? "", SENSITIVE_TOOLS.has(name), auth.role);
    if (!limited.ok) {
      auditRefusal(apiKey ?? "", auth.customerId, limited, `MCP tool ${name}`, auth.agentId);
      return { isError: true, content: [{ type: "text", text: JSON.stringify(rateLimitBody(limited)) }] };
    }
    if (name === "get_prices" || name === "get_availability" || name === "rank_offers" || name === "request_quote") {
      const tooBig = shortlistError(args.productIds);
      if (tooBig) return { isError: true, content: [{ type: "text", text: JSON.stringify(tooBig) }] };
    }
    if (
      (name === "plan_menu_sourcing" || name === "handle_stockout") &&
      args.createIntents &&
      auth.agentId &&
      !AGENTS[auth.agentId as AgentId].capabilities.includes("orders:propose")
    ) {
      return { isError: true, content: [{ type: "text", text: "forbidden: this agent can plan but cannot create orders — hand the plan to the Procurement agent." }] };
    }
    const actingAgent = (auth.agentId as AgentId | undefined) ?? TOOL_OWNER[name];
    const runTool = async () => {
      switch (name) {
        case "search_products":
          return {
            products: searchProducts({
              q: args.q as string,
              lactoseFree: args.lactoseFree as boolean,
              limit: (args.limit as number) ?? 20,
            }),
          };
        case "get_prices":
          return {
            products: await getPrices(
              auth.customerId,
              String(args.requestedDate),
              args.productIds as string[],
            ),
          };
        case "get_availability":
          return {
            products: await getAvailability(
              auth.customerId,
              String(args.requestedDate),
              args.productIds as string[],
            ),
          };
        case "rank_offers": {
          const need = NeedSchema.parse(args.need);
          const offers = await buildOffers(auth.customerId, need, {
            includeSubstitutions: true,
            preferences: args.preferences ? PreferencesSchema.parse(args.preferences) : undefined,
          });
          return { offers, explanation: explainOffers(offers, need, mandate) };
        }
        case "verify_claim":
          return verifyClaim(SignedClaimSchema.parse(args.claim), { customerId: auth.customerId });
        case "get_mandate":
          return mandate;
        case "create_order_intent": {
          if (!mandate) throw new Error("no mandate");
          const quoteId = args.quoteId as string | undefined;
          return createOrderIntent({
            customerId: auth.customerId,
            mandate,
            need: NeedSchema.parse(args.need ?? (quoteId ? getQuote(quoteId, auth.customerId)?.need : undefined)),
            offerProductId: args.offerProductId as string | undefined,
            quoteId,
          });
        }
        case "request_quote":
          return createQuote(auth.customerId, NeedSchema.parse(args.need), {
            productIds: Array.isArray(args.productIds) ? (args.productIds as string[]) : undefined,
          });
        case "get_quote":
          return getQuote(String(args.quoteId), auth.customerId) ?? { error: "not_found" };
        case "list_pending_approvals":
          return { intents: listPending(auth.customerId) };
        case "get_order_intent":
          return getIntent(String(args.intentId), auth.customerId);
        case "explain_order":
          return explainOrder(String(args.intentId), auth.customerId) ?? { error: "not_found" };
        case "approve_order":
          if (auth.role !== "buyer") throw new Error("forbidden: agent credentials cannot approve orders");
          return approveOrder(
            String(args.intentId),
            auth.customerId,
            String(args.snapshotHash),
            {
              authorizeMandateOverride: Boolean(args.authorizeMandateOverride),
              acknowledgedRules: Array.isArray(args.acknowledgedRules)
                ? (args.acknowledgedRules as string[])
                : undefined,
            },
          );
        case "reject_order":
          if (auth.role !== "buyer") throw new Error("forbidden: agent credentials cannot reject orders");
          return rejectOrder(
            String(args.intentId),
            auth.customerId,
            String(args.snapshotHash),
            args.reason as string | undefined,
          );
        case "commit_order":
          return commitOrder({
            intentId: String(args.intentId),
            customerId: auth.customerId,
            idempotencyKey: String(args.idempotencyKey ?? randomUUID()),
          });
        case "get_audit_trail":
          return {
            events: getAuditTrail(String(args.runId), auth.customerId),
            verification: verifyAuditChain(String(args.runId), auth.customerId),
          };
        case "verify_audit_chain":
          return verifyAuditChain(String(args.runId), auth.customerId);
        case "parse_need":
          return parseNeedFromText(String(args.text), args.neededBy as string | undefined);
        case "get_public_key":
          return { pem: getPublicKeyPem(), keyId: process.env.CLAIM_KEY_ID };
        case "plan_menu_sourcing": {
          const m = getMandate(auth.customerId);
          if (!m) throw new Error("no mandate");
          return planSourcing(auth.customerId, m, {
            neededBy: String(args.neededBy),
            recipes: args.recipes as Array<{ recipeId: string; batches?: number }> | undefined,
            createIntents: Boolean(args.createIntents),
          });
        }
        case "handle_stockout": {
          const m = getMandate(auth.customerId);
          if (!m) throw new Error("no mandate");
          return handleStockout(auth.customerId, m, {
            ingredientId: String(args.ingredientId),
            productId: args.productId as string | undefined,
            neededBy: String(args.neededBy),
            createIntents: Boolean(args.createIntents),
          });
        }
        case "list_suggestions":
          return { suggestions: listSuggestions(auth.customerId) };
        case "run_account_check":
          return runValioAgent(auth.customerId);
        case "accept_suggestion":
          if (!mandate) throw new Error("no mandate");
          return acceptSuggestion(auth.customerId, String(args.suggestionId), mandate);
        case "dismiss_suggestion":
          return dismissSuggestion(auth.customerId, String(args.suggestionId));
        case "list_events":
          return { events: listEvents(auth.customerId) };
        case "list_recurring_orders":
          return { recurringOrders: listStanding(auth.customerId) };
        case "get_inventory":
          return getInventory(auth.customerId) ?? { error: "no_kitchen_profile" };
        case "get_recipes":
          return getRecipes(auth.customerId) ?? { error: "no_kitchen_profile" };
        case "get_order_history":
          return getOrderHistory(auth.customerId) ?? { error: "no_kitchen_profile" };
        case "recommend_restock":
          return (
            recommendRestock(auth.customerId, {
              daysCover: Number(args.daysCover ?? 7),
            }) ?? { error: "no_kitchen_profile" }
          );
        case "smart_restock":
          return (
            (await smartRestock(auth.customerId, { daysCover: Number(args.daysCover ?? 7) })) ?? { error: "no_kitchen_profile" }
          );
        default:
          throw new Error(`Unknown tool ${name}`);
      }
    };
    const result = await (actingAgent ? withAgent(actingAgent, runTool) : runTool());

    return {
      content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
    };
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
}
