import { smartRestock } from "../hotel/optimizer.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import {
  NeedSchema,
  SignedClaimSchema,
  PreferencesSchema,
  DetachedBuyerSignatureInputSchema,
  DisputePresetSchema,
  SimulatedInvoiceDocumentSchema,
  type TradeReceipt,
} from "@tta/shared";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import { authenticate, getMandate } from "../auth/customers.js";
import { searchProducts, searchFromNeed, loadCatalog } from "../catalog/index.js";
import { buildOffers, buildOffersBatch, explainOffers } from "../catalog/offers.js";
import { getPrices, getAvailability } from "../valio/client.js";
import { verifyClaim, getPublicKeyPem } from "../claims/sign.js";
import { verifyTradeReceipt, arbitrateTradeDispute } from "../claims/receipt.js";
import {
  createOrderIntent,
  listPending,
  getIntent,
  approveOrder,
  rejectOrder,
  commitOrder,
  ensureReceiptForCommittedOrder,
} from "../orders/store.js";
import { createMultiItemQuote, createQuote, getQuote } from "../orders/quotes.js";
import { getAuditTrail, verifyAuditChain, appendAudit } from "../audit/chain.js";
import { parseComplexNeedFromText, parseNeedFromText } from "../need/parse.js";
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
        description: "Deterministic offer ranking for one structured Need (`need`) or a multi-item bundle (`needs` array)",
        inputSchema: {
          type: "object",
          properties: {
            need: { type: "object" },
            needs: { type: "array", items: { type: "object" } },
            preferences: {
              type: "object",
              description: "Optional non-negative weights {price, reliability, carbon, delivery}; normalised. Omit for default ranking.",
              properties: { price: { type: "number" }, reliability: { type: "number" }, carbon: { type: "number" }, delivery: { type: "number" } },
            },
          },
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
          "Request a firm-price quote for one need (`need`) or a multi-item bundle (`items: [{ need, productId }]`). Price is guaranteed until validUntil (default 30 min); availability is not held. Next: create_order_intent with quoteId.",
        inputSchema: {
          type: "object",
          properties: {
            need: { type: "object" },
            productIds: { type: "array", items: { type: "string" } },
            items: {
              type: "array",
              items: {
                type: "object",
                properties: { need: { type: "object" }, productId: { type: "string" } },
                required: ["need"],
              },
            },
          },
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
          "Create fixed-price order intent (not a commitment) for one item (`need`), a multi-item bundle (`items: [{ need, offerProductId }]`), or from `quoteId` (no re-pricing).",
        inputSchema: {
          type: "object",
          properties: {
            need: { type: "object" },
            offerProductId: { type: "string" },
            quoteId: { type: "string" },
            items: {
              type: "array",
              items: {
                type: "object",
                properties: { need: { type: "object" }, offerProductId: { type: "string" } },
                required: ["need"],
              },
            },
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
        description:
          "Revalidate price/availability, commit with idempotency key, and issue a dual-signed Bilateral Liability Receipt (.vtr.json). Optionally accepts a detached buyerSignature (Ed25519 or ECDSA-P256).",
        inputSchema: {
          type: "object",
          properties: {
            intentId: { type: "string" },
            idempotencyKey: { type: "string" },
            buyerSignature: {
              type: "object",
              description:
                "Optional detached buyer cryptographic signature (Ed25519 or ECDSA-P256) over canonical BuyerReceiptPayload",
              properties: {
                algorithm: { type: "string", enum: ["Ed25519", "ECDSA-P256"] },
                keyId: { type: "string" },
                publicKeyPem: { type: "string" },
                signedAt: { type: "string" },
                authorizedMaxTotalEur: { type: "number" },
                actingAgentId: { type: "string" },
                signature: { type: "string" },
              },
              required: ["algorithm", "keyId", "publicKeyPem", "signedAt", "signature"],
            },
          },
          required: ["intentId", "idempotencyKey"],
        },
      },
      {
        name: "get_trade_receipt",
        description:
          "Fetch (or issue if missing) the dual-signed Bilateral Liability Receipt (.vtr.json) for a committed order by Order ID (ORD-...), Intent ID, or Receipt ID (VTR-...).",
        inputSchema: {
          type: "object",
          properties: {
            id: {
              type: "string",
              description: "Order ID (ORD-...), Intent ID, or Receipt ID (VTR-...)",
            },
          },
          required: ["id"],
        },
      },
      {
        name: "verify_trade_receipt",
        description:
          "Offline cryptographic verification of a portable .vtr.json Bilateral Liability Receipt (SHA-256 receiptHash, buyer Ed25519/ECDSA-P256 signature, supplier Ed25519 signature, bilateral cross-hash binding, and human override proof).",
        inputSchema: {
          type: "object",
          properties: {
            receipt: {
              type: "object",
              description: "Portable .vtr.json TradeReceipt object",
            },
          },
          required: ["receipt"],
        },
      },
      {
        name: "arbitrate_dispute",
        description:
          "Deterministic (<10 ms) 3-Way Invoice & Bilateral Liability Dispute Arbitrator. Resolves a .vtr.json TradeReceipt (inline or by Order/Intent/Receipt ID) against a preset scenario or simulated invoice/delivery document and returns a DisputeRuling.",
        inputSchema: {
          type: "object",
          properties: {
            id: {
              type: "string",
              description:
                "Order ID (ORD-...), Intent ID, or Receipt ID (VTR-...) used to resolve the receipt when inline receipt is omitted",
            },
            receipt: {
              type: "object",
              description: "Optional inline portable .vtr.json TradeReceipt object",
            },
            preset: {
              type: "string",
              enum: [
                "price_hike_012",
                "late_delivery",
                "rogue_agent_chargeback",
                "allergen_breach",
                "tampered_receipt",
                "clean_3way_match",
              ],
              description: "Optional deterministic dispute simulation preset",
            },
            document: {
              type: "object",
              description: "Optional simulated e-invoice / delivery note document for 3-way matching",
              properties: {
                documentId: { type: "string" },
                documentType: {
                  type: "string",
                  enum: ["e_invoice", "delivery_note", "combined_3way"],
                },
                deliveredAt: { type: "string" },
                buyerDisputeClaim: {
                  type: "string",
                  enum: [
                    "none",
                    "rogue_agent_hallucination",
                    "price_overcharge",
                    "late_delivery",
                    "allergen_breach",
                  ],
                },
                buyerDisputeNote: { type: "string" },
                billedTotalEur: { type: "number" },
                currency: { type: "string" },
                lines: {
                  type: "array",
                  items: {
                    type: "object",
                    properties: {
                      productId: { type: "string" },
                      productName: { type: "string" },
                      billedPacks: { type: "number" },
                      deliveredPacks: { type: "number" },
                      billedQuantity: { type: "number" },
                      deliveredQuantity: { type: "number" },
                      billedUnitPriceEur: { type: "number" },
                      billedPricePerQtyUnitEur: { type: "number" },
                      billedLineTotalEur: { type: "number" },
                      deliveredAllergens: { type: "array", items: { type: "string" } },
                      deliveredLactoseFree: { type: "boolean" },
                    },
                    required: ["productId", "billedLineTotalEur"],
                  },
                },
              },
              required: ["billedTotalEur", "lines"],
            },
          },
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
    const mandate = await getMandate(auth.customerId);

    // Least privilege over MCP too: the key's role/agent decides which tools it may call.
    if (!mcpToolAllowed(auth, name)) {
      await appendAudit(randomUUID(), auth.customerId, "forbidden_action", {
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
      await auditRefusal(apiKey ?? "", auth.customerId, limited, `MCP tool ${name}`, auth.agentId);
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
          const preferences = args.preferences ? PreferencesSchema.parse(args.preferences) : undefined;
          if (Array.isArray(args.needs) && args.needs.length > 0) {
            const parsedNeeds = args.needs.map((n) => NeedSchema.parse(n));
            const batch = await buildOffersBatch(auth.customerId, parsedNeeds, {
              includeSubstitutions: true,
              preferences,
              mandate,
            });
            return {
              isMultiItem: parsedNeeds.length > 1,
              items: batch.items,
              offers: batch.items[0]?.offers ?? [],
              explanation: batch.combinedExplanation,
            };
          }
          const need = NeedSchema.parse(args.need);
          const offers = await buildOffers(auth.customerId, need, {
            includeSubstitutions: true,
            preferences,
          });
          return { offers, explanation: explainOffers(offers, need, mandate) };
        }
        case "verify_claim":
          return verifyClaim(SignedClaimSchema.parse(args.claim), { customerId: auth.customerId });
        case "get_mandate":
          return mandate;
        case "create_order_intent": {
          if (!mandate) throw new Error("no mandate");
          if (Array.isArray(args.items) && args.items.length > 0) {
            const items = (args.items as Array<{ need: unknown; offerProductId?: string }>).map((it) => ({
              need: NeedSchema.parse(it.need),
              offerProductId: typeof it.offerProductId === "string" ? it.offerProductId : undefined,
            }));
            return createOrderIntent({
              customerId: auth.customerId,
              mandate,
              items,
            });
          }
          const quoteId = args.quoteId as string | undefined;
          const quote = quoteId ? await getQuote(quoteId, auth.customerId) : undefined;
          if (quoteId && quote?.isMultiItemBasket && quote.lines.length > 1) {
            return createOrderIntent({
              customerId: auth.customerId,
              mandate,
              quoteId,
              offerProductId: args.offerProductId as string | undefined,
            });
          }
          return createOrderIntent({
            customerId: auth.customerId,
            mandate,
            need: NeedSchema.parse(args.need ?? quote?.need),
            offerProductId: args.offerProductId as string | undefined,
            quoteId,
          });
        }
        case "request_quote": {
          if (Array.isArray(args.items) && args.items.length > 0) {
            const items = (args.items as Array<{ need: unknown; productId?: string; offerProductId?: string }>).map((it) => ({
              need: NeedSchema.parse(it.need),
              productId: typeof it.offerProductId === "string"
                ? it.offerProductId
                : typeof it.productId === "string"
                  ? it.productId
                  : undefined,
            }));
            return createMultiItemQuote(auth.customerId, items);
          }
          return createQuote(auth.customerId, NeedSchema.parse(args.need), {
            productIds: Array.isArray(args.productIds) ? (args.productIds as string[]) : undefined,
          });
        }
        case "get_quote":
          return (await getQuote(String(args.quoteId), auth.customerId)) ?? { error: "not_found" };
        case "list_pending_approvals":
          return { intents: await listPending(auth.customerId) };
        case "get_order_intent":
          return await getIntent(String(args.intentId), auth.customerId);
        case "explain_order":
          return (await explainOrder(String(args.intentId), auth.customerId)) ?? { error: "not_found" };
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
        case "commit_order": {
          const buyerSignature = DetachedBuyerSignatureInputSchema.optional().parse(
            args.buyerSignature,
          );
          const intent = await commitOrder({
            intentId: String(args.intentId),
            customerId: auth.customerId,
            idempotencyKey: String(args.idempotencyKey ?? randomUUID()),
            buyerSignature,
          });
          const receipt = await ensureReceiptForCommittedOrder(intent.id, auth.customerId);
          return {
            ...intent,
            orderId: intent.committedOrderId,
            confirmation: {
              orderId: intent.committedOrderId,
              status: intent.status,
              lines: intent.basket,
              totalPrice: intent.totalPrice,
              confirmedAt: intent.updatedAt,
              runId: intent.runId,
            },
            intent,
            receipt,
          };
        }
        case "get_trade_receipt": {
          const { id } = z
            .object({
              id: z
                .string()
                .min(1)
                .describe("Order ID (ORD-...), Intent ID, or Receipt ID (VTR-...)"),
            })
            .parse({
              id: args.id ?? args.orderId ?? args.intentId ?? args.receiptId,
            });
          return (
            (await ensureReceiptForCommittedOrder(id, auth.customerId)) ?? {
              error: "not_found",
            }
          );
        }
        case "verify_trade_receipt": {
          const { receipt } = z
            .object({
              receipt: z.record(z.unknown()).describe("Portable .vtr.json TradeReceipt object"),
            })
            .parse(args);
          const target =
            "receipt" in receipt &&
            !("receiptId" in receipt) &&
            receipt.receipt &&
            typeof receipt.receipt === "object"
              ? (receipt.receipt as TradeReceipt)
              : (receipt as unknown as TradeReceipt);
          return verifyTradeReceipt(target);
        }
        case "arbitrate_dispute": {
          const parsed = z
            .object({
              id: z.string().optional(),
              receipt: z.record(z.unknown()).optional(),
              preset: DisputePresetSchema.optional(),
              document: SimulatedInvoiceDocumentSchema.optional(),
            })
            .parse({
              ...args,
              id: args.id ?? args.orderId ?? args.receiptId ?? args.intentId,
            });
          let receipt: TradeReceipt | null = null;
          if (parsed.receipt) {
            const raw = parsed.receipt;
            receipt =
              "receipt" in raw &&
              !("receiptId" in raw) &&
              raw.receipt &&
              typeof raw.receipt === "object"
                ? (raw.receipt as TradeReceipt)
                : (raw as unknown as TradeReceipt);
          } else if (parsed.id) {
            receipt = await ensureReceiptForCommittedOrder(parsed.id, auth.customerId);
            if (!receipt) {
              throw new Error(
                `receipt_not_found: No committed order or bilateral receipt found for ${parsed.id}`,
              );
            }
          } else {
            throw new Error(
              "receipt_required: Provide either `id` (Order ID, Intent ID, or Receipt ID) or `receipt` (.vtr.json)",
            );
          }
          const fallbackDoc =
            !parsed.preset &&
            !parsed.document &&
            !(receipt as unknown as { supplier?: { payload?: unknown } })?.supplier?.payload
              ? SimulatedInvoiceDocumentSchema.parse({ billedTotalEur: 0, lines: [] })
              : undefined;
          return arbitrateTradeDispute({
            receipt,
            preset: parsed.preset,
            document: parsed.document ?? fallbackDoc,
          });
        }
        case "get_audit_trail":
          return {
            events: await getAuditTrail(String(args.runId), auth.customerId),
            verification: await verifyAuditChain(String(args.runId), auth.customerId),
          };
        case "verify_audit_chain":
          return verifyAuditChain(String(args.runId), auth.customerId);
        case "parse_need": {
          const complex = parseComplexNeedFromText(String(args.text), args.neededBy as string | undefined);
          if ("clarificationRequired" in complex) {
            return parseNeedFromText(String(args.text), args.neededBy as string | undefined);
          }
          return {
            ...complex.needs[0],
            needs: complex.needs,
            isMultiItem: complex.isMultiItem,
          };
        }
        case "get_public_key":
          return { pem: getPublicKeyPem(), keyId: process.env.CLAIM_KEY_ID };
        case "plan_menu_sourcing": {
          const m = await getMandate(auth.customerId);
          if (!m) throw new Error("no mandate");
          return planSourcing(auth.customerId, m, {
            neededBy: String(args.neededBy),
            recipes: args.recipes as Array<{ recipeId: string; batches?: number }> | undefined,
            createIntents: Boolean(args.createIntents),
          });
        }
        case "handle_stockout": {
          const m = await getMandate(auth.customerId);
          if (!m) throw new Error("no mandate");
          return handleStockout(auth.customerId, m, {
            ingredientId: String(args.ingredientId),
            productId: args.productId as string | undefined,
            neededBy: String(args.neededBy),
            createIntents: Boolean(args.createIntents),
          });
        }
        case "list_suggestions":
          return { suggestions: await listSuggestions(auth.customerId) };
        case "run_account_check":
          return runValioAgent(auth.customerId);
        case "accept_suggestion":
          if (!mandate) throw new Error("no mandate");
          return acceptSuggestion(auth.customerId, String(args.suggestionId), mandate);
        case "dismiss_suggestion":
          return dismissSuggestion(auth.customerId, String(args.suggestionId));
        case "list_events":
          return { events: await listEvents(auth.customerId) };
        case "list_recurring_orders":
          return { recurringOrders: await listStanding(auth.customerId) };
        case "get_inventory":
          return (await getInventory(auth.customerId)) ?? { error: "no_kitchen_profile" };
        case "get_recipes":
          return (await getRecipes(auth.customerId)) ?? { error: "no_kitchen_profile" };
        case "get_order_history":
          return (await getOrderHistory(auth.customerId)) ?? { error: "no_kitchen_profile" };
        case "recommend_restock":
          return (
            (await recommendRestock(auth.customerId, {
              daysCover: Number(args.daysCover ?? 7),
            })) ?? { error: "no_kitchen_profile" }
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
