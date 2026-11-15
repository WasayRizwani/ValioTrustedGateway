/**
 * The agent team. Each agent has ONE job and a narrow set of capabilities — enforced by the gateway on
 * every request, not by prompt wording. Least privilege: the agent that finds products cannot place
 * orders, the agent that places orders cannot approve them, and Valio's own agent never sees the buyer's
 * inventory or recipes.
 */
import type { AgentId } from "./context.js";
export type { AgentId } from "./context.js";

export type Capability =
  | "catalog:read"
  | "mandate:read"
  | "kitchen:read"
  | "plan:run"
  | "standing:read"
  | "events:read"
  | "orders:read"
  | "quotes:create"
  | "quotes:read"
  | "orders:propose"
  | "orders:commit"
  | "history:read"
  | "suggest:read"
  | "suggest:write";

/** capability → the HTTP calls it unlocks */
export const CAPABILITIES: Record<Capability, Array<[string, RegExp]>> = {
  "catalog:read": [
    ["POST", /^\/v1\/(products\/search|prices|availability|offers\/rank|claims\/verify|receipts\/verify|need\/parse)$/],
  ],
  "mandate:read": [["GET", /^\/v1\/mandate$/]],
  "kitchen:read": [["GET", /^\/v1\/kitchen\/(inventory|recipes|order-history|restock|restock\/smart)$/]],
  "plan:run": [["POST", /^\/v1\/kitchen\/(plan|stockout)$/]],
  "standing:read": [["GET", /^\/v1\/standing-orders$/]],
  "events:read": [["GET", /^\/v1\/events$/]],
  "orders:read": [
    [
      "GET",
      /^\/v1\/(orders|orders-overview|orders\/pending|orders\/[^/]+|orders\/[^/]+\/explain|orders\/[^/]+\/receipt|receipts|receipts\/[^/]+|activity|audit-runs|audit\/[^/]+)$/,
    ],
    ["POST", /^\/v1\/(audit\/[^/]+\/verify|orders\/[^/]+\/arbitrate|receipts\/arbitrate|receipts\/verify)$/],
  ],
  "quotes:create": [["POST", /^\/v1\/quotes$/]],
  "quotes:read": [["GET", /^\/v1\/quotes\/[^/]+$/]],
  "orders:propose": [
    ["POST", /^\/v1\/orders\/intent$/],
    ["POST", /^\/v1\/suggestions\/[^/]+\/(accept|dismiss)$/],
  ],
  "orders:commit": [["POST", /^\/v1\/orders\/[^/]+\/commit$/]],
  "history:read": [["GET", /^\/v1\/kitchen\/order-history$/]],
  "suggest:read": [["GET", /^\/v1\/suggestions$/]],
  "suggest:write": [["POST", /^\/v1\/valio-agent\/run$/]],
};

/** Allowed for any authenticated caller (health / identity), regardless of scope. */
const ALWAYS: Array<[string, RegExp]> = [
  ["GET", /^\/v1\/(me|agents|system\/status)$/],
];

export type AgentDef = {
  id: AgentId;
  name: string;
  short: string;
  side: "buyer" | "valio";
  job: string;
  capabilities: Capability[];
  cannot: string[];
  /** Demo credential (static key for the weekend; OAuth client in production). */
  apiKey: string;
};

export const AGENTS: Record<AgentId, AgentDef> = {
  sourcing: {
    id: "sourcing",
    name: "Sourcing agent",
    short: "Sourcing",
    side: "buyer",
    job: "Finds products and compares live offers: price, delivery, allergens, certificates, substitutes.",
    capabilities: ["catalog:read", "mandate:read", "quotes:create", "quotes:read"],
    cannot: ["place or propose orders", "see kitchen data", "approve anything"],
    apiKey: process.env.DEMO_AGENT_KEY_SOURCING ?? "hotel_sourcing_key_001",
  },
  planner: {
    id: "planner",
    name: "Kitchen planner",
    short: "Planner",
    side: "buyer",
    job: "Reads recipes, stock and recurring orders; works out what is missing and when it must arrive.",
    capabilities: ["kitchen:read", "plan:run", "standing:read", "events:read", "mandate:read"],
    cannot: ["spend money", "place orders", "approve anything"],
    apiKey: process.env.DEMO_AGENT_KEY_PLANNER ?? "hotel_planner_key_001",
  },
  procurement: {
    id: "procurement",
    name: "Procurement agent",
    short: "Procurement",
    side: "buyer",
    job: "Turns a chosen offer into an order — inside the mandate. Anything bigger waits for a human.",
    capabilities: ["orders:propose", "orders:commit", "orders:read", "catalog:read", "mandate:read", "quotes:read"],
    cannot: ["approve its own orders", "override the mandate", "read kitchen inventory or recipes"],
    apiKey: process.env.DEMO_AGENT_KEY_PROCUREMENT ?? "hotel_procurement_key_001",
  },
  "valio-account": {
    id: "valio-account",
    name: "Valio account agent",
    short: "Valio",
    side: "valio",
    job: "Valio's own agent: watches your usual products, warns about stock-outs and suggests better options.",
    capabilities: ["catalog:read", "history:read", "suggest:write", "suggest:read"],
    cannot: ["see your inventory or recipes", "place orders for you", "see other customers' data"],
    apiKey: process.env.DEMO_AGENT_KEY_VALIO ?? "valio_account_key_001",
  },
};

export function agentAllows(agentId: AgentId, method: string, path: string): { allowed: boolean; needs?: Capability } {
  if (ALWAYS.some(([m, re]) => m === method && re.test(path))) return { allowed: true };
  const def = AGENTS[agentId];
  for (const cap of def.capabilities)
    if (CAPABILITIES[cap].some(([m, re]) => m.split(" ").includes(method) && re.test(path))) return { allowed: true };
  // which capability would have unlocked it?
  for (const [cap, rules] of Object.entries(CAPABILITIES) as Array<[Capability, Array<[string, RegExp]>]>)
    if (rules.some(([m, re]) => m.split(" ").includes(method) && re.test(path))) return { allowed: false, needs: cap };
  return { allowed: false };
}

/** Which agent performs which internal tool call (used to attribute the chat coordinator's work). */
export const TOOL_OWNER: Record<string, AgentId> = {
  parse_need: "sourcing",
  search_products: "sourcing",
  rank_offers: "sourcing",
  get_prices: "sourcing",
  get_availability: "sourcing",
  verify_claim: "sourcing",
  get_mandate: "sourcing",
  get_inventory: "planner",
  get_recipes: "planner",
  get_order_history: "planner",
  recommend_restock: "planner",
  smart_restock: "planner",
  plan_menu_sourcing: "planner",
  list_events: "planner",
  create_event: "planner",
  order_event: "procurement",
  handle_stockout: "planner",
  request_quote: "sourcing",
  get_quote: "sourcing",
  create_order_intent: "procurement",
  commit_order: "procurement",
  list_pending_approvals: "procurement",
  list_orders: "procurement",
  get_order_intent: "procurement",
  explain_order: "procurement",
  get_audit_trail: "procurement",
  verify_audit_chain: "procurement",
  get_trade_receipt: "procurement",
  verify_trade_receipt: "sourcing",
  arbitrate_dispute: "procurement",
  accept_suggestion: "procurement",
  dismiss_suggestion: "procurement",
  list_recurring_orders: "planner",
  list_suggestions: "valio-account",
  run_account_check: "valio-account",
};

/** MCP tool → capability that unlocks it ("buyer" = human-side only, "open" = harmless public info). */
export const TOOL_CAPABILITY: Record<string, Capability | "buyer" | "open"> = {
  search_products: "catalog:read",
  get_prices: "catalog:read",
  get_availability: "catalog:read",
  rank_offers: "catalog:read",
  verify_claim: "catalog:read",
  parse_need: "catalog:read",
  get_public_key: "open",
  get_mandate: "mandate:read",
  get_inventory: "kitchen:read",
  get_recipes: "kitchen:read",
  recommend_restock: "kitchen:read",
  smart_restock: "kitchen:read",
  get_order_history: "history:read",
  plan_menu_sourcing: "plan:run",
  handle_stockout: "plan:run",
  list_recurring_orders: "standing:read",
  list_events: "events:read",
  request_quote: "quotes:create",
  get_quote: "quotes:read",
  create_order_intent: "orders:propose",
  accept_suggestion: "orders:propose",
  dismiss_suggestion: "orders:propose",
  commit_order: "orders:commit",
  list_pending_approvals: "orders:read",
  get_order_intent: "orders:read",
  explain_order: "orders:read",
  get_audit_trail: "orders:read",
  verify_audit_chain: "orders:read",
  get_trade_receipt: "orders:read",
  verify_trade_receipt: "open",
  arbitrate_dispute: "orders:read",
  list_suggestions: "suggest:read",
  run_account_check: "suggest:write",
  approve_order: "buyer",
  reject_order: "buyer",
};

/**
 * Same least-privilege rules as REST, applied to MCP tools. Buyer: everything. Scoped agent: only its
 * capabilities. Unscoped legacy agent key: everything except the buyer-only tools.
 */
export function mcpToolAllowed(auth: { role: string; agentId?: string }, tool: string): boolean {
  const need = TOOL_CAPABILITY[tool];
  if (!need) return false;
  if (need === "open") return true;
  if (auth.role === "buyer") return true;
  if (need === "buyer") return false;
  if (auth.agentId) {
    const caps = AGENTS[auth.agentId as AgentId]?.capabilities ?? [];
    if (tool === "get_order_history") {
      return caps.includes("history:read") || caps.includes("kitchen:read");
    }
    return caps.includes(need);
  }
  return true;
}

/** Human-readable routes per capability (for the "Connect an agent" page and docs). */
export const CAPABILITY_ROUTES: Record<Capability, string[]> = {
  "catalog:read": [
    "POST /v1/products/search",
    "POST /v1/prices",
    "POST /v1/availability",
    "POST /v1/offers/rank",
    "POST /v1/claims/verify",
    "POST /v1/receipts/verify",
    "POST /v1/need/parse",
  ],
  "mandate:read": ["GET /v1/mandate"],
  "kitchen:read": ["GET /v1/kitchen/inventory", "GET /v1/kitchen/recipes", "GET /v1/kitchen/order-history", "GET /v1/kitchen/restock", "GET /v1/kitchen/restock/smart"],
  "plan:run": ["POST /v1/kitchen/plan", "POST /v1/kitchen/stockout"],
  "standing:read": ["GET /v1/standing-orders"],
  "events:read": ["GET /v1/events"],
  "orders:read": [
    "GET /v1/orders",
    "GET /v1/orders/pending",
    "GET /v1/orders/:id/explain",
    "GET /v1/orders/:id/receipt",
    "GET /v1/receipts",
    "GET /v1/receipts/:id",
    "POST /v1/orders/:id/arbitrate",
    "POST /v1/receipts/arbitrate",
    "POST /v1/receipts/verify",
    "GET /v1/orders-overview",
    "GET /v1/activity",
    "GET /v1/audit/:runId",
    "POST /v1/audit/:runId/verify",
  ],
  "quotes:create": ["POST /v1/quotes"],
  "quotes:read": ["GET /v1/quotes/:id"],
  "orders:propose": ["POST /v1/orders/intent", "POST /v1/suggestions/:id/accept", "POST /v1/suggestions/:id/dismiss"],
  "orders:commit": ["POST /v1/orders/:id/commit"],
  "history:read": ["GET /v1/kitchen/order-history"],
  "suggest:read": ["GET /v1/suggestions"],
  "suggest:write": ["POST /v1/valio-agent/run"],
};

export function mcpToolsFor(def: { capabilities: Capability[] }): string[] {
  return Object.entries(TOOL_CAPABILITY)
    .filter(([tool, need]) =>
      need === "open" ||
      (tool === "get_order_history" && (def.capabilities.includes("history:read") || def.capabilities.includes("kitchen:read"))) ||
      (need !== "buyer" && def.capabilities.includes(need as Capability)),
    )
    .map(([tool]) => tool);
}
