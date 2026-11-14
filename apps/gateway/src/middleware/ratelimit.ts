/**
 * Per-API-key token-bucket rate limiting + shortlist cap, shared by REST and MCP.
 * Two buckets per key: "general" (every call) and "sensitive" (search / rank / price / availability, which also
 * enforces the "query price & availability only for shortlisted SKUs" rule). Limits are injectable for tests.
 */
import type { MiddlewareHandler } from "hono";
import { randomUUID } from "node:crypto";
import { appendAudit } from "../audit/chain.js";

export type RateLimits = {
  /** requests per minute, all endpoints */
  generalPerMin: number;
  /** requests per minute on search / rank / price / availability */
  sensitivePerMin: number;
  /** max product ids per price/availability/rank request */
  maxShortlist: number;
};

function envNum(name: string, dflt: number): number {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? n : dflt;
}

export function defaultLimits(): RateLimits {
  return {
    generalPerMin: envNum("RATE_LIMIT_GENERAL_PER_MIN", 300),
    sensitivePerMin: envNum("RATE_LIMIT_SENSITIVE_PER_MIN", 300),
    maxShortlist: envNum("MAX_SHORTLIST_SIZE", 25),
  };
}

let limits: RateLimits = defaultLimits();
let now: () => number = () => Date.now();
type Bucket = { tokens: number; last: number; audited: number; blockedUntil: number };
const buckets = new Map<string, Bucket>();
const BLOCK_MS = 30_000;
const AGENT_MAX_BURST = 10;
// The desk fans out several read-only requests on startup; its buyer credential gets a larger burst.
// Valio API traffic is separately serialized and paced in valio/client.ts.
const BUYER_MAX_BURST = 300;

/** Test hook: override limits and/or clock; call with no args to reset to env defaults. */
export function configureRateLimits(over?: Partial<RateLimits>, clock?: () => number) {
  limits = { ...defaultLimits(), ...over };
  now = clock ?? (() => Date.now());
  buckets.clear();
}
export function getRateLimits(): RateLimits {
  return limits;
}

export type LimitDecision =
  | { ok: true }
  | { ok: false; bucket: "general" | "sensitive"; retryAfterSec: number; limit: number };

function take(
  id: string,
  perMin: number,
  maxBurst = AGENT_MAX_BURST,
  blockMs = BLOCK_MS,
): { ok: boolean; retryAfterSec: number } {
  const t = now();
  const burst = Math.min(maxBurst, perMin);
  const b = buckets.get(id) ?? { tokens: burst, last: t, audited: 0, blockedUntil: 0 };
  if (t < b.blockedUntil) {
    buckets.set(id, b);
    return { ok: false, retryAfterSec: Math.max(1, Math.ceil((b.blockedUntil - t) / 1000)) };
  }
  const refillPerMs = perMin / 60_000;
  b.tokens = Math.min(burst, b.tokens + (t - b.last) * refillPerMs);
  b.last = t;
  buckets.set(id, b);
  if (b.tokens >= 1) {
    b.tokens -= 1;
    return { ok: true, retryAfterSec: 0 };
  }
  if (blockMs > 0) {
    b.blockedUntil = t + blockMs;
    return { ok: false, retryAfterSec: Math.max(1, Math.ceil(blockMs / 1000)) };
  }
  const waitMs = (1 - b.tokens) / refillPerMs;
  return { ok: false, retryAfterSec: Math.max(1, Math.ceil(waitMs / 1000)) };
}

/** A person's desk polls many panels at once, so a buyer credential gets a roomier general bucket than an agent. */
export const BUYER_GENERAL_MULTIPLIER = 6;

export function checkLimit(apiKey: string, sensitive: boolean, role?: string): LimitDecision {
  const isBuyer = role === "buyer";
  const maxBurst = isBuyer ? BUYER_MAX_BURST : AGENT_MAX_BURST;
  const blockMs = isBuyer ? 0 : BLOCK_MS;
  if (sensitive) {
    const s = take(`${apiKey}|sensitive`, limits.sensitivePerMin, maxBurst, blockMs);
    if (!s.ok) return { ok: false, bucket: "sensitive", retryAfterSec: s.retryAfterSec, limit: limits.sensitivePerMin };
  }
  const general = limits.generalPerMin * (isBuyer ? BUYER_GENERAL_MULTIPLIER : 1);
  const g = take(`${apiKey}|general`, general, maxBurst, blockMs);
  if (!g.ok) return { ok: false, bucket: "general", retryAfterSec: g.retryAfterSec, limit: general };
  return { ok: true };
}

const SENSITIVE_REST: Array<{ method: string; pattern: RegExp }> = [
  { method: "POST", pattern: /^\/v1\/(products\/search|prices|availability|offers\/rank)$/ },
  { method: "POST", pattern: /^\/v1\/quotes$/ },
];
export const SENSITIVE_TOOLS = new Set([
  "search_products",
  "get_prices",
  "get_availability",
  "rank_offers",
  "request_quote",
]);

/** Audit a refusal (at most once per key+bucket per 10 s so a flood cannot bloat the chain). */
export function auditRefusal(apiKey: string, customerId: string, d: Extract<LimitDecision, { ok: false }>, what: string, agent?: string) {
  const b = buckets.get(`${apiKey}|${d.bucket}`);
  if (b && now() - b.audited < 10_000) return;
  if (b) b.audited = now();
  appendAudit(randomUUID(), customerId, "rate_limited", {
    action: what,
    bucket: d.bucket,
    limitPerMin: d.limit,
    retryAfterSec: d.retryAfterSec,
    agent: agent ?? null,
  });
}

export const RATE_LIMITED = "rate_limited";
export const SHORTLIST_TOO_LARGE = "shortlist_too_large";

export function rateLimitBody(d: Extract<LimitDecision, { ok: false }>) {
  return {
    error: RATE_LIMITED,
    message: `Rate limit exceeded (${d.limit}/min on the ${d.bucket} bucket). Retry in ${d.retryAfterSec}s.`,
    retryAfterSec: d.retryAfterSec,
  };
}

/** Returns an error body when a product-id list is larger than the allowed shortlist. */
export function shortlistError(ids: unknown): { error: string; message: string; max: number; got: number } | null {
  if (!Array.isArray(ids) || ids.length <= limits.maxShortlist) return null;
  return {
    error: SHORTLIST_TOO_LARGE,
    message: `Price/availability lookups are limited to a shortlist of ${limits.maxShortlist} products per request (got ${ids.length}). Narrow with search_products first.`,
    max: limits.maxShortlist,
    got: ids.length,
  };
}

/** Hono middleware: mount AFTER authentication on /v1/*. */
export function rateLimitMiddleware(): MiddlewareHandler {
  return async (c, next) => {
    const auth = c.get("auth") as { apiKey: string; customerId: string; agentId?: string } | undefined;
    if (!auth) return next();
    const sensitive = SENSITIVE_REST.some((r) => r.method === c.req.method && r.pattern.test(c.req.path));
    const deskRead = c.req.method === "GET" && c.req.header("x-desk-ui") === "1";
    const effectiveRole = deskRead ? "buyer" : (auth as { role?: string }).role;
    const d = checkLimit(auth.apiKey, sensitive, effectiveRole);
    if (!d.ok) {
      auditRefusal(auth.apiKey, auth.customerId, d, `${c.req.method} ${c.req.path}`, auth.agentId);
      c.header("Retry-After", String(d.retryAfterSec));
      return c.json(rateLimitBody(d), 429);
    }
    if (
      sensitive &&
      (c.req.path === "/v1/prices" ||
        c.req.path === "/v1/availability" ||
        c.req.path === "/v1/offers/rank" ||
        c.req.path === "/v1/quotes")
    ) {
      let body: { productIds?: unknown } | null = null;
      try {
        body = await c.req.raw.clone().json();
      } catch {
        body = null;
      }
      const err = shortlistError(body?.productIds);
      if (err) return c.json(err, 400);
    }
    await next();
  };
}
