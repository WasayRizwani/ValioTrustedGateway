import { Hono } from "hono";
import { cors } from "hono/cors";
import { NeedSchema, MandateSchema, SignedClaimSchema, PreferencesSchema } from "@tta/shared";
import { randomUUID } from "node:crypto";
import {
  authenticate,
  assertCustomerAccess,
  getMandate,
  setMandate,
  resetMandate,
  type AuthContext,
} from "../auth/customers.js";
import { searchProducts, searchFromNeed, loadCatalog } from "../catalog/index.js";
import { buildOffers, explainOffers } from "../catalog/offers.js";
import { getPrices, getAvailability, pingValio } from "../valio/client.js";
import {
  getPublicKeyPem,
  verifyClaim,
  getPublicJwk,
} from "../claims/sign.js";
import {
  createOrderIntent,
  getIntent,
  listPending,
  listOrders,
  approveOrder,
  rejectOrder,
  commitOrder,
  resetIntents,
} from "../orders/store.js";
import { createQuote, getQuote } from "../orders/quotes.js";
import { appendAudit, getAuditTrail, verifyAuditChain } from "../audit/chain.js";
import { config } from "../config.js";
import { parseNeedFromText } from "../need/parse.js";
import { draftExceptionFollowup } from "../orders/exceptions.js";
import { getLlmStatus, runPurchasingAgent, type ChatMessage } from "../agent/chat.js";
import {
  getInventory,
  getRecipes,
  getOrderHistory,
  recommendRestock,
  upsertInventory,
  deleteIngredient,
  upsertRecipe,
  deleteRecipe,
  importKitchen,
  receiveDelivery,
  adjustStock,
  recordUsage,
  resetKitchen,
} from "../hotel/kitchen.js";
import { planSourcing, handleStockout } from "../hotel/planner.js";
import {
  listStanding,
  createStanding,
  updateStanding,
  deleteStanding,
  suggestFromHistory,
  resetStanding,
  runDueStanding,
} from "../hotel/standing.js";
import { getOrderHistory as getOrdersOverview } from "../ops/orders.js";
import { runValioAgent, listSuggestions, acceptSuggestion, dismissSuggestion, resetSuggestions } from "../agents/valioAgent.js";
import { simulatedStockouts } from "../valio/client.js";
import { listEvents, createEvent, updateEvent, replanEvent, orderEvent, cancelEvent, resetEvents, schedule, todayIso } from "../hotel/events.js";
import { agentAllows, AGENTS, CAPABILITY_ROUTES, TOOL_CAPABILITY, mcpToolsFor, type AgentId } from "../agents/registry.js";
import { withAgent } from "../agents/context.js";
import { getSystemStatus, runSelfTest, getActivity, getOverview, getAuditRuns, getAgentRoster } from "../ops/overview.js";
import {
  getLastRestockRun,
  getRestockAutomationPolicy,
  runAutomatedRestock,
  setRestockAutomationPolicy,
} from "../hotel/restock-automation.js";
import { smartRestock } from "../hotel/optimizer.js";
import { explainOrder } from "../ops/explain.js";
import { rateLimitMiddleware, shortlistError } from "../middleware/ratelimit.js";
import { allowVoiceAttempt, approvalPreview, approveVoicePlan, createVoiceProposal, eventDishNames, getSavedRecipes, getVoiceState, publicError, resolveCaller, retryVoiceEmail, voiceReadiness } from "../hotel/voice.js";
import { timingSafeEqual } from "node:crypto";

type Variables = { auth: AuthContext };
const escapeHtml = (value: string) => value.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const viewEventDates = (ev: { date: string; prepDays: number; leadDays: number }) => schedule(ev.date, ev.prepDays, ev.leadDays);

/** [methods, path pattern, description] — endpoints that move authority, so agents may not call them. */
const BUYER_ONLY: Array<[string, RegExp, string]> = [
  ["PUT", /^\/v1\/mandate$/, "change the purchasing mandate"],
  ["POST", /^\/v1\/orders\/[^/]+\/approve$/, "approve an order"],
  ["POST", /^\/v1\/orders\/[^/]+\/reject$/, "reject an order"],
  ["POST PUT DELETE", /^\/v1\/standing-orders/, "manage recurring orders"],
  ["PUT", /^\/v1\/kitchen\/restock\/automation$/, "change restock automation"],
  ["POST", /^\/v1\/kitchen\/restock\/run$/, "run automated restock"],
  ["PUT", /^\/v1\/kitchen\/inventory$/, "modify kitchen inventory"],
  ["DELETE", /^\/v1\/kitchen\/inventory\/[^/]+$/, "delete kitchen inventory"],
  ["POST", /^\/v1\/kitchen\/inventory\/adjust$/, "adjust kitchen inventory"],
  ["POST", /^\/v1\/kitchen\/recipes$/, "modify kitchen recipes"],
  ["DELETE", /^\/v1\/kitchen\/recipes\/[^/]+$/, "delete kitchen recipes"],
  ["POST", /^\/v1\/kitchen\/recipes\/[^/]+\/cook$/, "record recipe usage"],
  ["POST", /^\/v1\/kitchen\/import$/, "import kitchen data"],
  ["POST", /^\/v1\/kitchen\/deliveries$/, "record deliveries"],
  ["POST", /^\/v1\/admin\//, "run admin operations"],
  ["GET", /^\/v1\/connect$/, "see integration credentials"],
  ["POST PUT DELETE", /^\/v1\/events/, "manage events"],
  ["GET", /^\/v1\/voice\//, "see voice integration details"],
];

export function createApi() {
  loadCatalog();
  const app = new Hono<{ Variables: Variables }>();

  app.use("*", cors());

  app.onError((err, c) => {
    if (err.name === "ZodError" || err instanceof SyntaxError) {
      return c.json({ error: err.message }, 400);
    }
    return c.json({ error: err.message || "Internal server error" }, 500);
  });

  app.get("/health", (c) => c.json({ ok: true, service: "valio-aimo-agent-gateway" }));

  app.get("/.well-known/jwks.json", (c) =>
    c.json({
      keys: [
        {
          ...getPublicJwk(),
          pem: getPublicKeyPem(),
          issuer: "valio-aimo-gateway",
        },
      ],
    }),
  );

  app.get("/openapi.json", (c) => c.json(openApiDoc()));

  const voiceToolHandler = async (c: any, mock = false) => {
    const secret = config.vapiWebhookSecret;
    const supplied = c.req.header("authorization")?.replace(/^Bearer\s+/i, "") ?? "";
    const suppliedBytes = Buffer.from(supplied);
    const secretBytes = Buffer.from(secret);
    const sameSecret = Boolean(secret && suppliedBytes.length === secretBytes.length && timingSafeEqual(suppliedBytes, secretBytes));
    const localHost = /^(localhost|127\.0\.0\.1)(:\d+)?$/.test(c.req.header("host") ?? "");
    if (mock && !(config.voiceMockMode && localHost)) return c.json(publicError("mock_mode_local_only", 404), 404);
    if (!mock && config.voiceMockMode) return c.json(publicError("live_voice_disabled_in_mock_mode", 503), 503);
    if (!(mock && config.voiceMockMode && localHost) && !sameSecret) return c.json(publicError("unauthorized", 401), 401);
    const body = await c.req.json().catch(() => null) as any;
    const message = body?.message ?? body;
    const call = message?.call ?? body?.call ?? {};
    const callId = String(call?.id ?? message?.call?.id ?? body?.callId ?? "");
    const phone = String(call?.customer?.number ?? call?.from ?? call?.phoneNumber ?? message?.call?.customer?.number ?? "");
    if (!allowVoiceAttempt(phone)) return c.json(publicError("caller_rate_limited", 429), 429, { "Retry-After": "300" });
    const caller = resolveCaller(phone);
    const calls = message?.toolCallList ?? message?.toolWithToolCallList ?? [];
    if (!Array.isArray(calls) || calls.length === 0) return c.json(publicError("invalid_tool_payload", 400), 400);
    const results = [];
    for (const entry of calls) {
      const toolCall = entry?.toolCall ?? entry;
      const id = String(toolCall?.id ?? "");
      const name = String(toolCall?.name ?? toolCall?.function?.name ?? "");
      let args: any = toolCall?.parameters ?? toolCall?.arguments ?? {};
      if (typeof args === "string") { try { args = JSON.parse(args); } catch { args = null; } }
      try {
        if (!id || !callId || !args || typeof args !== "object") throw Object.assign(new Error("invalid_tool_payload"), { code: "invalid_tool_payload" });
        if (name === "list_saved_recipes") {
          if (!caller) throw Object.assign(new Error("caller_not_allowed"), { code: "caller_not_allowed" });
          results.push({ toolCallId: id, result: { recipes: getSavedRecipes(caller.customerId) } });
          continue;
        }
        if (name !== "create_event_proposal") throw Object.assign(new Error("unknown_tool"), { code: "unknown_tool" });
        if (!caller) throw Object.assign(new Error("caller_not_allowed"), { code: "caller_not_allowed" });
        if (args.confirmed !== true) throw Object.assign(new Error("spoken_confirmation_required"), { code: "spoken_confirmation_required" });
        const recipeIds: string[] = Array.isArray(args.recipeIds) ? Array.from(new Set<string>(args.recipeIds.map((r: unknown) => String(r)))) : [];
        const available = new Map(getSavedRecipes(caller.customerId).map((r) => [r.id, r.name]));
        if (!recipeIds.length || recipeIds.length > 20 || recipeIds.some((id) => !available.has(id))) throw Object.assign(new Error("unknown_or_missing_recipe"), { code: "unknown_or_missing_recipe" });
        const event = {
          name: String(args.name ?? "").trim(), date: String(args.date ?? ""), guests: Number(args.guests), autoOrder: false,
          recipes: recipeIds.map((recipeId) => ({ recipeId, servings: Number(args.guests) })),
        };
        const date = new Date(`${event.date}T00:00:00Z`);
        if (!event.name || event.name.length > 120 || !/^\d{4}-\d{2}-\d{2}$/.test(event.date) || Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== event.date || event.date < todayIso() || !Number.isInteger(event.guests) || event.guests < 1 || event.guests > 50_000) throw Object.assign(new Error("invalid_event_details"), { code: "invalid_event_details" });
        const result = await createVoiceProposal({ caller, callId, toolCallId: id, payload: args, event });
        results.push({ toolCallId: id, result });
      } catch (error) {
        const code = (error as { code?: string }).code ?? "voice_request_failed";
        const status = code === "caller_not_allowed" || code === "unauthorized" ? 403 : code === "request_in_progress" ? 409 : 400;
        results.push({ toolCallId: id || "unknown", result: { ok: false, code, requestId: randomUUID(), message: "The request did not complete. No purchase was made. Please tell the caller the plan was not confirmed and offer a safe next step." } });
        if (!caller || !callId) return c.json(publicError(code, status), status);
      }
    }
    return c.json({ results });
  };
  app.post("/vapi/tools", (c) => voiceToolHandler(c));
  app.post("/vapi/mock/tools", (c) => voiceToolHandler(c, true));

  const voicePageShell = (title: string, body: string) =>
    `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)} — Valio Aimo</title><style>:root{color-scheme:light}*{box-sizing:border-box}body{font:15px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;color:#0c1a24;margin:0;background:#e8edf2;padding:1.25rem 1rem}header{max-width:680px;margin:0 auto .85rem;display:flex;align-items:center;gap:.65rem}.logo{width:32px;height:32px;border-radius:4px;background:#0057a8;color:#fff;display:grid;place-items:center;font-weight:700;font-size:.78rem;letter-spacing:.06em}main{max-width:680px;margin:0 auto;padding:1.35rem 1.4rem;background:#fff;border:1px solid #d0d8e0;border-radius:8px;box-shadow:0 1px 2px rgba(12,26,36,.06),0 8px 24px rgba(12,26,36,.04)}h1{font-size:1.3rem;margin:0 0 .35rem;letter-spacing:-.02em}h2{font-size:.82rem;text-transform:uppercase;letter-spacing:.05em;color:#5a6b7a;margin:1.15rem 0 .4rem}.meta{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:.55rem;margin:.85rem 0}.card{border:1px solid #d0d8e0;border-radius:6px;padding:.6rem .75rem;background:#f4f6f8}.card b{display:block;font-size:.7rem;text-transform:uppercase;letter-spacing:.04em;color:#5a6b7a;font-weight:600}.card span{font-weight:600;font-size:.98rem}ul{margin:.35rem 0;padding-left:1.2rem}li{margin:.4rem 0}.risks{background:#f9e8e6;border:1px solid #e8b4af;color:#a11c14;border-radius:6px;padding:.75rem .9rem;margin-top:.85rem}.notice{padding:.85rem 1rem;background:#e6f0f8;border:1px solid #b8cce0;color:#003d7a;border-radius:6px;font-size:.88rem;margin:1rem 0}.ok-banner{padding:.85rem 1rem;background:#e4f3ec;border:1px solid #b5d9c6;color:#0d6b45;border-radius:6px}button{padding:.7rem 1.25rem;background:#0057a8;color:#fff;border:1px solid #0057a8;border-radius:6px;font:600 .95rem inherit;cursor:pointer;width:100%}button:hover{background:#00448a}button:focus-visible{outline:3px solid #9ec5e8;outline-offset:2px}</style><header><div class="logo">VA</div><div><strong>Valio Aimo</strong> · <span style="color:#5a6b7a;font-size:.82rem">Approval Desk</span></div></header><main>${body}</main></html>`;

  app.get("/approval/voice/:token", (c) => {
    if (config.voiceMockMode && !/^(localhost|127\.0\.0\.1)(:\d+)?$/.test(c.req.header("host") ?? "")) return c.html(voicePageShell("Unavailable", "<h1>Local demo only</h1>"), 404);
    const preview = approvalPreview(c.req.param("token"));
    if (!preview) return c.html(voicePageShell("Link unavailable", "<h1>This approval link is no longer available</h1><p>It may have expired, been used, or the event plan changed. Contact your buyer or open the current event in the dashboard.</p>"), 410);
    const ev = preview.event;
    const items = ev.plan?.lines.filter((line) => line.shortfall > 0) ?? [];
    const dishes = eventDishNames(ev).map((dish) => `<li>${escapeHtml(dish.name)} · ${dish.servings} portion${dish.servings === 1 ? "" : "s"}</li>`).join("");
    const unpriced = items.filter((line) => !line.chosen).length;
    const hasPriced = items.some((line) => line.chosen);
    const spend = unpriced ? hasPriced ? `At least €${(ev.plan?.estTotal ?? 0).toFixed(2)} for priced items · ${unpriced} item${unpriced === 1 ? "" : "s"} not priced` : `${unpriced} item${unpriced === 1 ? "" : "s"} not priced · total estimate unavailable` : `€${(ev.plan?.estTotal ?? 0).toFixed(2)}`;
    const rows = items.map((line) => `<li><b>${escapeHtml(line.name)}</b>: ${escapeHtml(String(line.shortfall))} ${escapeHtml(line.unit)} · ${line.chosen ? `€${line.chosen.totalPrice.toFixed(2)} · ${escapeHtml(line.chosen.productName)}` : "No matching offer"}</li>`).join("");
    const risks = ev.plan?.flags.map((flag) => `<li>${escapeHtml(flag)}</li>`).join("") ?? "";
    const dates = viewEventDates(ev);
    const html = voicePageShell(
      "Review event plan",
      `<h1>Review event purchase plan</h1><p style="margin:0;color:#5a6b7a"><b>${escapeHtml(ev.name)}</b> · ${escapeHtml(ev.date)} · ${ev.guests} guest${ev.guests === 1 ? "" : "s"}</p><div class="meta"><div class="card"><b>Event date</b><span>${escapeHtml(ev.date)}</span></div><div class="card"><b>Guests</b><span>${ev.guests}</span></div><div class="card"><b>Order by</b><span>${escapeHtml(dates.orderBy)}</span></div><div class="card"><b>Delivery by</b><span>${escapeHtml(dates.deliverBy)}</span></div></div><p>Estimated additional spend: <b>${spend}</b></p><h2>Dishes</h2><ul>${dishes}</ul><h2>Items to purchase</h2>${rows ? `<ul>${rows}</ul>` : "<p>Everything appears covered by stock or existing orders.</p>"}<p style="color:#5a6b7a;font-size:.85rem">Order by ${escapeHtml(dates.orderBy)} · planned delivery by ${escapeHtml(dates.deliverBy)}</p>${risks ? `<div class="risks"><h2 style="color:#a11c14;margin-top:0">Risks</h2><ul>${risks}</ul></div>` : ""}<p class="notice">Approval schedules a purchasing attempt after live price and availability checks. Purchases remain subject to your mandate. Any mandate exception needs separate approval. This page approves a plan, not an individual order. Approval link expires after seven days.</p><form method="post"><button type="submit">Approve plan and schedule ordering</button></form>`,
    );
    return c.html(html, 200, {
      "Cache-Control": "no-store",
      "Referrer-Policy": "no-referrer",
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
    });
  });
  app.post("/approval/voice/:token", (c) => {
    if (config.voiceMockMode && !/^(localhost|127\.0\.0\.1)(:\d+)?$/.test(c.req.header("host") ?? "")) return c.html(voicePageShell("Unavailable", "<h1>Local demo only</h1>"), 404);
    return approveVoicePlan(c.req.param("token"))
    ? c.html(voicePageShell("Plan approved", `<div class="ok-banner"><h1 style="color:#0d6b45">Plan approved</h1><p style="margin:0">The event is scheduled for a fresh price and availability check. This did not place an order.</p></div>`), 200, { "Cache-Control": "no-store" })
    : c.html(voicePageShell("Link unavailable", "<h1>This approval link is no longer available</h1><p>It may have expired, been used, or the event plan changed. Open the current event in the dashboard.</p>"), 410, { "Cache-Control": "no-store" });
  });

  app.use("/v1/*", async (c, next) => {
    const key =
      c.req.header("x-api-key") ||
      c.req.header("authorization")?.replace(/^Bearer\s+/i, "");
    const auth = key && !(key in Object.prototype) ? authenticate(key) : null;
    if (!auth) return c.json({ error: "unauthorized" }, 401);
    c.set("auth", auth);

    // Least privilege: a scoped agent key may only call what that agent's job needs.
    if (auth.agentId) {
      const verdict = agentAllows(auth.agentId as AgentId, c.req.method, c.req.path);
      if (!verdict.allowed) {
        const def = AGENTS[auth.agentId as AgentId];
        appendAudit(randomUUID(), auth.customerId, "forbidden_action", {
          action: `${c.req.method} ${c.req.path}`,
          role: def.short + " agent",
          agent: auth.agentId,
          missing: verdict.needs ?? null,
        });
        return c.json(
          {
            error: "forbidden",
            message: `${def.name} is not allowed to ${c.req.method} ${c.req.path}${verdict.needs ? ` (needs capability "${verdict.needs}")` : ""}. Its job: ${def.job}`,
          },
          403,
        );
      }
    }

    // Authority boundary: agent credentials can never approve, override or change standing authority.
    const rule = BUYER_ONLY.find(([m, re]) => m.includes(c.req.method) && re.test(c.req.path));
    if (rule && auth.role !== "buyer") {
      appendAudit(randomUUID(), auth.customerId, "forbidden_action", {
        action: rule[2],
        method: c.req.method,
        path: c.req.path,
        role: auth.role,
      });
      return c.json(
        {
          error: "forbidden",
          message: `Agent credentials cannot ${rule[2]}. Use a buyer credential (human approval client).`,
        },
        403,
      );
    }
    if (auth.agentId) {
      await withAgent(auth.agentId as AgentId, () => next());
    } else {
      await next();
    }
  });

  // Per-API-key token buckets (general + tighter on search/rank/price) and the shortlist cap. After auth.
  app.use("/v1/*", rateLimitMiddleware());

  app.get("/v1/me", (c) => {
    const auth = c.get("auth");
    return c.json({
      customerId: auth.customerId,
      role: auth.role,
      agent: auth.agentId ? AGENTS[auth.agentId as AgentId] : null,
      canApprove: auth.role === "buyer",
      hotelName: getInventory(auth.customerId)?.hotelName ?? null,
      mandate: getMandate(auth.customerId),
    });
  });

  app.get("/v1/mandate", (c) => {
    const auth = c.get("auth");
    return c.json(getMandate(auth.customerId));
  });

  app.put("/v1/mandate", async (c) => {
    const auth = c.get("auth");
    const body = MandateSchema.parse(await c.req.json());
    if (body.customerId !== auth.customerId) {
      return c.json({ error: "customer_mismatch" }, 403);
    }
    return c.json(setMandate(body));
  });

  app.post("/v1/need/parse", async (c) => {
    const auth = c.get("auth");
    const body = await c.req.json();
    const text = String(body.text ?? "");
    const neededBy = body.neededBy as string | undefined;
    const parsed = parseNeedFromText(text, neededBy);
    appendAudit(randomUUID(), auth.customerId, "need_parsed", { text, parsed });
    return c.json(parsed);
  });

  app.post("/v1/products/search", async (c) => {
    const body = await c.req.json();
    if (body.need) {
      const need = NeedSchema.parse(body.need);
      return c.json({ products: searchFromNeed(need, body.limit ?? 20) });
    }
    return c.json({
      products: searchProducts({
        q: body.q,
        lactoseFree: body.lactoseFree,
        organic: body.organic,
        category: body.category,
        limit: body.limit ?? 20,
      }),
    });
  });

  app.post("/v1/prices", async (c) => {
    const auth = c.get("auth");
    const body = await c.req.json();
    try {
      assertCustomerAccess(auth, body.customerId);
    } catch (e) {
      return c.json(
        { error: e instanceof Error ? e.message : "forbidden" },
        403,
      );
    }
    const results = await getPrices(
      auth.customerId,
      body.requestedDate,
      body.productIds,
    );
    return c.json({ products: results });
  });

  app.post("/v1/availability", async (c) => {
    const auth = c.get("auth");
    const body = await c.req.json();
    try {
      assertCustomerAccess(auth, body.customerId);
    } catch (e) {
      return c.json(
        { error: e instanceof Error ? e.message : "forbidden" },
        403,
      );
    }
    const results = await getAvailability(
      auth.customerId,
      body.requestedDate,
      body.productIds,
    );
    return c.json({ products: results });
  });

  app.post("/v1/offers/rank", async (c) => {
    const auth = c.get("auth");
    const body = await c.req.json();
    const need = NeedSchema.parse(body.need);
    const mandate = getMandate(auth.customerId);
    const offers = await withAgent("sourcing", () =>
      buildOffers(auth.customerId, need, {
        productIds: body.productIds,
        includeSubstitutions: body.includeSubstitutions ?? true,
        preferences: body.preferences ? PreferencesSchema.parse(body.preferences) : undefined,
      }),
    );
    return c.json({
      offers,
      explanation: explainOffers(offers, need, mandate),
    });
  });

  app.post("/v1/claims/verify", async (c) => {
    const auth = c.get("auth");
    const body = await c.req.json();
    const envelope = SignedClaimSchema.parse(body.claim ?? body);
    if (envelope.claim.customerId !== auth.customerId) {
      return c.json({ valid: false, reason: "customer_mismatch" });
    }
    return c.json(verifyClaim(envelope, body.expect?.subject ? { subject: body.expect.subject } : undefined));
  });

  app.post("/v1/orders/intent", async (c) => {
    const auth = c.get("auth");
    const body = await c.req.json();
    const mandate = getMandate(auth.customerId);
    if (!mandate) return c.json({ error: "no_mandate" }, 400);
    // With a quoteId the need comes from the quote; a body need is optional.
    try {
      let rawNeed = body.need;
      if (body.quoteId && !body.need) {
        const q = getQuote(String(body.quoteId), auth.customerId);
        if (!q) return c.json({ error: "quote_not_found: Quote does not exist" }, 400);
        rawNeed = q.need;
      }
      const need = NeedSchema.parse(rawNeed);
      const result = await createOrderIntent({
        customerId: auth.customerId,
        mandate,
        need,
        runId: body.runId,
        offerProductId: body.offerProductId,
        includeSubstitutions: body.includeSubstitutions,
        quoteId: body.quoteId,
      });
      return c.json(result);
    } catch (e) {
      return c.json(
        { error: e instanceof Error ? e.message : "intent_failed" },
        400,
      );
    }
  });

  app.post("/v1/quotes", async (c) => {
    const auth = c.get("auth");
    const body = await c.req.json();
    if (Array.isArray(body.productIds)) {
      const err = shortlistError(body.productIds);
      if (err) return c.json(err, 400);
    }
    const need = NeedSchema.parse(body.need);
    try {
      const quote = await createQuote(auth.customerId, need, {
        productIds: Array.isArray(body.productIds) ? body.productIds : undefined,
        includeSubstitutions: body.includeSubstitutions,
        runId: body.runId,
      });
      return c.json(quote, 201);
    } catch (e) {
      return c.json({ error: e instanceof Error ? e.message : "quote_failed" }, 400);
    }
  });

  app.get("/v1/quotes/:id", (c) => {
    const auth = c.get("auth");
    const quote = getQuote(c.req.param("id"), auth.customerId);
    if (!quote) return c.json({ error: "not_found" }, 404);
    return c.json(quote);
  });

  app.get("/v1/orders/pending", (c) => {
    const auth = c.get("auth");
    return c.json({ intents: listPending(auth.customerId) });
  });

  app.get("/v1/orders", (c) => {
    const auth = c.get("auth");
    return c.json({ orders: listOrders(auth.customerId) });
  });

  app.get("/v1/orders/:id/explain", (c) => {
    const auth = c.get("auth");
    const explanation = explainOrder(c.req.param("id"), auth.customerId);
    if (!explanation) return c.json({ error: "not_found" }, 404);
    return c.json(explanation);
  });

  app.get("/v1/orders/:id", (c) => {
    const auth = c.get("auth");
    const intent = getIntent(c.req.param("id"), auth.customerId);
    if (!intent) return c.json({ error: "not_found" }, 404);
    return c.json(intent);
  });

  app.post("/v1/orders/:id/approve", async (c) => {
    const auth = c.get("auth");
    const body = await c.req.json();
    try {
      const intent = approveOrder(
        c.req.param("id"),
        auth.customerId,
        String(body.snapshotHash),
        {
          authorizeMandateOverride: Boolean(body.authorizeMandateOverride),
          acknowledgedRules: Array.isArray(body.acknowledgedRules)
            ? body.acknowledgedRules.map(String)
            : undefined,
        },
      );
      return c.json(intent);
    } catch (e) {
      return c.json(
        { error: e instanceof Error ? e.message : "approve_failed" },
        400,
      );
    }
  });

  app.post("/v1/orders/:id/reject", async (c) => {
    const auth = c.get("auth");
    const body = await c.req.json();
    try {
      const intent = rejectOrder(
        c.req.param("id"),
        auth.customerId,
        String(body.snapshotHash),
        body.reason,
      );
      return c.json(intent);
    } catch (e) {
      return c.json(
        { error: e instanceof Error ? e.message : "reject_failed" },
        400,
      );
    }
  });

  app.post("/v1/orders/:id/commit", async (c) => {
    const auth = c.get("auth");
    const body = await c.req.json();
    try {
      const intent = await commitOrder({
        intentId: c.req.param("id"),
        customerId: auth.customerId,
        idempotencyKey: String(body.idempotencyKey ?? randomUUID()),
      });
      return c.json({
        confirmation: {
          orderId: intent.committedOrderId,
          status: intent.status,
          lines: intent.basket,
          totalPrice: intent.totalPrice,
          confirmedAt: intent.updatedAt,
          runId: intent.runId,
        },
        intent,
      });
    } catch (e) {
      return c.json(
        { error: e instanceof Error ? e.message : "commit_failed" },
        400,
      );
    }
  });

  app.get("/v1/audit/:runId", (c) => {
    const auth = c.get("auth");
    const runId = c.req.param("runId");
    return c.json({
      events: getAuditTrail(runId, auth.customerId),
      verification: verifyAuditChain(runId, auth.customerId),
    });
  });

  app.post("/v1/audit/:runId/verify", (c) => {
    const auth = c.get("auth");
    return c.json(verifyAuditChain(c.req.param("runId"), auth.customerId));
  });

  app.post("/v1/exceptions/followup", async (c) => {
    const auth = c.get("auth");
    const body = await c.req.json();
    const draft = draftExceptionFollowup({
      customerId: auth.customerId,
      intentId: body.intentId,
      problem: body.problem,
      details: body.details,
    });
    appendAudit(body.runId ?? randomUUID(), auth.customerId, "exception_followup_drafted", draft);
    return c.json(draft);
  });

  app.get("/v1/valio/ping", async (c) => c.json(await pingValio()));

  app.get("/v1/kitchen/inventory", (c) => {
    const auth = c.get("auth");
    const data = getInventory(auth.customerId);
    if (!data) return c.json({ error: "no_kitchen_profile" }, 404);
    return c.json(data);
  });

  app.get("/v1/kitchen/recipes", (c) => {
    const auth = c.get("auth");
    const data = getRecipes(auth.customerId);
    if (!data) return c.json({ error: "no_kitchen_profile" }, 404);
    return c.json(data);
  });

  app.get("/v1/kitchen/order-history", (c) => {
    const auth = c.get("auth");
    const data = getOrderHistory(auth.customerId);
    if (!data) return c.json({ error: "no_kitchen_profile" }, 404);
    return c.json(data);
  });

  app.get("/v1/kitchen/restock", (c) => {
    const auth = c.get("auth");
    const days = Number(c.req.query("daysCover") ?? 7);
    const data = recommendRestock(auth.customerId, { daysCover: days });
    if (!data) return c.json({ error: "no_kitchen_profile" }, 404);
    return c.json(data);
  });

  app.get("/v1/kitchen/restock/smart", async (c) => {
    const auth = c.get("auth");
    const days = Number(c.req.query("daysCover") ?? 7);
    const r = await smartRestock(auth.customerId, { daysCover: Number.isFinite(days) && days > 0 ? days : 7 });
    if (!r) return c.json({ error: "no_kitchen_profile" }, 404);
    return c.json(r);
  });

  app.get("/v1/kitchen/restock/automation", (c) => {
    const auth = c.get("auth");
    return c.json({
      policy: getRestockAutomationPolicy(auth.customerId),
      lastRun: getLastRestockRun(auth.customerId),
    });
  });

  app.put("/v1/kitchen/restock/automation", async (c) => {
    const auth = c.get("auth");
    const body = (await c.req.json()) as Record<string, unknown>;
    const policy = setRestockAutomationPolicy(auth.customerId, {
      enabled: body.enabled as boolean | undefined,
      daysCover: body.daysCover as number | undefined,
      maxItems: body.maxItems as number | undefined,
      urgencies: body.urgencies as Array<"critical" | "low"> | undefined,
      pauseOnStandingOrderDrift: body.pauseOnStandingOrderDrift as
        | boolean
        | undefined,
      smartQuantities: body.smartQuantities as boolean | undefined,
      intervalMinutes: body.intervalMinutes as number | undefined,
    });
    return c.json({
      policy,
      lastRun: getLastRestockRun(auth.customerId),
    });
  });

  app.post("/v1/kitchen/restock/run", async (c) => {
    const auth = c.get("auth");
    const body = (await c.req.json().catch(() => ({}))) as {
      force?: boolean;
      only?: string[];
      all?: boolean;
      choice?: "exact" | "smart";
    };
    try {
      const result = await runAutomatedRestock(auth.customerId, {
        // Desk "Run now" always executes even if the standing toggle is off.
        force: body.force !== false,
        only: Array.isArray(body.only) ? body.only.map(String) : undefined,
        all: body.all === true,
        choice: body.choice === "exact" || body.choice === "smart" ? body.choice : undefined,
      });
      return c.json({
        result,
        policy: getRestockAutomationPolicy(auth.customerId),
      });
    } catch (e) {
      return c.json(
        { error: e instanceof Error ? e.message : String(e) },
        500,
      );
    }
  });

  // ── Hotel data sync: the buyer's own inventory / recipes (write APIs) ──
  const kitchenErr = (c: any, e: unknown) =>
    c.json({ error: e instanceof Error ? e.message : String(e) }, 400);

  app.put("/v1/kitchen/inventory", async (c) => {
    const auth = c.get("auth");
    const body = await c.req.json();
    try {
      const items = Array.isArray(body) ? body : (body.items ?? [body]);
      const saved = upsertInventory(auth.customerId, items);
      appendAudit(randomUUID(), auth.customerId, "kitchen_inventory_updated", {
        ingredients: saved.map((i) => i.ingredientId),
      });
      return c.json({ saved });
    } catch (e) {
      return kitchenErr(c, e);
    }
  });

  app.delete("/v1/kitchen/inventory/:id", (c) => {
    const auth = c.get("auth");
    try {
      return c.json({ deleted: deleteIngredient(auth.customerId, c.req.param("id")) });
    } catch (e) {
      return kitchenErr(c, e);
    }
  });

  app.post("/v1/kitchen/inventory/adjust", async (c) => {
    const auth = c.get("auth");
    try {
      return c.json({ item: adjustStock(auth.customerId, await c.req.json()) });
    } catch (e) {
      return kitchenErr(c, e);
    }
  });

  app.post("/v1/kitchen/recipes", async (c) => {
    const auth = c.get("auth");
    try {
      const recipe = upsertRecipe(auth.customerId, await c.req.json());
      appendAudit(randomUUID(), auth.customerId, "kitchen_recipe_saved", {
        recipeId: recipe.recipeId,
      });
      return c.json({ recipe });
    } catch (e) {
      return kitchenErr(c, e);
    }
  });

  app.delete("/v1/kitchen/recipes/:id", (c) => {
    const auth = c.get("auth");
    return c.json({ deleted: deleteRecipe(auth.customerId, c.req.param("id")) });
  });

  app.post("/v1/kitchen/recipes/:id/cook", async (c) => {
    const auth = c.get("auth");
    const body = (await c.req.json().catch(() => ({}))) as { batches?: number };
    try {
      return c.json(recordUsage(auth.customerId, c.req.param("id"), Number(body.batches ?? 1)));
    } catch (e) {
      return kitchenErr(c, e);
    }
  });

  app.post("/v1/kitchen/import", async (c) => {
    const auth = c.get("auth");
    try {
      const result = importKitchen(auth.customerId, await c.req.json());
      appendAudit(randomUUID(), auth.customerId, "kitchen_imported", result);
      return c.json(result);
    } catch (e) {
      return kitchenErr(c, e);
    }
  });

  app.post("/v1/kitchen/deliveries", async (c) => {
    const auth = c.get("auth");
    const body = (await c.req.json()) as {
      orderId: string;
      received?: Record<string, number>;
    };
    try {
      const res = receiveDelivery(auth.customerId, body.orderId, body.received);
      appendAudit(randomUUID(), auth.customerId, "delivery_received", res);
      return c.json(res);
    } catch (e) {
      return kitchenErr(c, e);
    }
  });

  // ── Recipe-driven sourcing (menu plan, last-minute event, supplier stock-out) ──
  app.post("/v1/kitchen/plan", async (c) => {
    const auth = c.get("auth");
    const mandate = getMandate(auth.customerId);
    if (!mandate) return c.json({ error: "no_mandate" }, 400);
    const body = await c.req.json();
    if (body.createIntents && auth.agentId && !AGENTS[auth.agentId as AgentId].capabilities.includes("orders:propose")) {
      const def = AGENTS[auth.agentId as AgentId];
      appendAudit(randomUUID(), auth.customerId, "forbidden_action", {
        action: `POST ${c.req.path} (createIntents)`,
        role: def.short + " agent",
        agent: auth.agentId,
        missing: "orders:propose",
      });
      return c.json(
        { error: "forbidden", message: `${def.name} can plan but cannot create orders — hand the plan to the Procurement agent.` },
        403,
      );
    }
    try {
      return c.json(
        await planSourcing(auth.customerId, mandate, {
          neededBy: String(body.neededBy),
          recipes: body.recipes,
          createIntents: Boolean(body.createIntents),
        }),
      );
    } catch (e) {
      return kitchenErr(c, e);
    }
  });

  app.post("/v1/kitchen/stockout", async (c) => {
    const auth = c.get("auth");
    const mandate = getMandate(auth.customerId);
    if (!mandate) return c.json({ error: "no_mandate" }, 400);
    const body = await c.req.json();
    if (body.createIntents && auth.agentId && !AGENTS[auth.agentId as AgentId].capabilities.includes("orders:propose")) {
      const def = AGENTS[auth.agentId as AgentId];
      appendAudit(randomUUID(), auth.customerId, "forbidden_action", {
        action: `POST ${c.req.path} (createIntents)`,
        role: def.short + " agent",
        agent: auth.agentId,
        missing: "orders:propose",
      });
      return c.json(
        { error: "forbidden", message: `${def.name} can plan but cannot create orders — hand the plan to the Procurement agent.` },
        403,
      );
    }
    try {
      return c.json(
        await handleStockout(auth.customerId, mandate, {
          ingredientId: String(body.ingredientId),
          neededBy: String(body.neededBy),
          productId: body.productId,
          createIntents: Boolean(body.createIntents),
        }),
      );
    } catch (e) {
      return kitchenErr(c, e);
    }
  });

  // ── Recurring (standing) orders ──
  app.get("/v1/standing-orders", (c) => {
    const id = c.get("auth").customerId;
    return c.json({ standingOrders: listStanding(id), suggestions: suggestFromHistory(id) });
  });
  app.post("/v1/standing-orders", async (c) => {
    try {
      return c.json({ standingOrder: createStanding(c.get("auth").customerId, await c.req.json()) });
    } catch (e) {
      return kitchenErr(c, e);
    }
  });
  app.put("/v1/standing-orders/:id", async (c) => {
    try {
      return c.json({ standingOrder: updateStanding(c.get("auth").customerId, c.req.param("id"), await c.req.json()) });
    } catch (e) {
      return kitchenErr(c, e);
    }
  });
  app.delete("/v1/standing-orders/:id", (c) =>
    c.json({ deleted: deleteStanding(c.get("auth").customerId, c.req.param("id")) }),
  );
  app.post("/v1/standing-orders/run", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { standingId?: string; force?: boolean };
    return c.json({ results: await runDueStanding(c.get("auth").customerId, body) });
  });

  // ── Operator views: health, self-test, activity, overview ──
  app.get("/v1/system/status", async (c) => c.json(await getSystemStatus()));
  app.post("/v1/system/selftest", async (c) => c.json(await runSelfTest(c.get("auth").customerId)));
  app.get("/v1/activity", (c) =>
    c.json({
      events: getActivity(c.get("auth").customerId, Number(c.req.query("limit") ?? 30), c.req.query("runId") || undefined),
    }),
  );
  // "Connect an agent": everything an external developer needs — endpoints, identities, scopes, how to verify.
  app.get("/v1/connect", (c) => {
    const auth = c.get("auth");
    const base = config.publicUrl;
    const mcpEnv = (key: string) => ({ VALIO_GATEWAY_API_KEY: key });
    return c.json({
      baseUrl: base,
      openapi: `${base}/openapi.json`,
      jwks: `${base}/.well-known/jwks.json`,
      mcp: { command: "npm run mcp -w @tta/gateway", transport: "stdio", note: "Local MCP server (hosted MCP is the production path)." },
      claimIssuer: "valio-aimo-gateway",
      customerId: auth.customerId,
      identities: [
        ...Object.values(AGENTS).map((a) => {
          const agentKey = authenticate(a.apiKey)?.customerId === auth.customerId ? a.apiKey : "<not-configured-for-this-customer>";
          return {
            id: a.id,
            name: a.name,
            side: a.side,
            job: a.job,
            capabilities: a.capabilities,
            cannot: a.cannot,
            routes: [...new Set(a.capabilities.flatMap((cap) => CAPABILITY_ROUTES[cap]))],
            mcpTools: mcpToolsFor(a),
            apiKey: agentKey,
            mcpEnv: mcpEnv(agentKey),
          };
        }),
        {
          id: "full-agent",
          name: "Your own agent (all buyer-side powers, no approvals)",
          side: "buyer",
          job: "A general purchasing agent: everything the specialists can do together — but it still cannot approve, override the mandate or change authority.",
          capabilities: [],
          cannot: ["approve or reject orders", "change the mandate", "manage recurring orders or admin"],
          routes: ["All /v1 endpoints except buyer-only ones"],
          mcpTools: Object.entries(TOOL_CAPABILITY).filter(([, n]) => n !== "buyer").map(([t]) => t),
          apiKey: Object.entries(config.apiKeys).find(([, cust]) => cust === auth.customerId)?.[0] ?? "",
          mcpEnv: mcpEnv(Object.entries(config.apiKeys).find(([, cust]) => cust === auth.customerId)?.[0] ?? ""),
        },
      ],
    });
  });
  app.get("/v1/agents", (c) => c.json({ agents: getAgentRoster(c.get("auth").customerId) }));
  app.get("/v1/audit-runs", (c) => c.json({ runs: getAuditRuns(c.get("auth").customerId) }));
  app.get("/v1/orders-overview", (c) => c.json(getOrdersOverview(c.get("auth").customerId)));
  app.get("/v1/overview", (c) => c.json(getOverview(c.get("auth").customerId)));

  // ── Events & peak demand ──
  app.get("/v1/voice/readiness", (c) => c.json(voiceReadiness()));
  app.get("/v1/events", (c) => {
    const customerId = c.get("auth").customerId;
    const includeVoiceState = c.get("auth").role === "buyer";
    return c.json({ events: listEvents(customerId, c.req.query("all") === "1").map((event) => ({ ...event, voice: includeVoiceState ? getVoiceState(customerId, event.id) : null })) });
  });
  app.post("/v1/events/:id/voice-email/retry", async (c) => {
    try { return c.json({ voice: await retryVoiceEmail(c.get("auth").customerId, c.req.param("id")) }); }
    catch (e) {
      const code = (e as { code?: string }).code ?? "voice_delivery_failed";
      const status = code === "not_found" ? 404 : code === "delivery_unknown" ? 409 : code === "retry_after" ? 429 : 400;
      const retry = (e as { retryAfterSeconds?: number }).retryAfterSeconds;
      return c.json(publicError(code, status), status, retry ? { "Retry-After": String(retry) } : {});
    }
  });
  app.post("/v1/events", async (c) => {
    try {
      return c.json({ event: await createEvent(c.get("auth").customerId, await c.req.json()) });
    } catch (e) {
      return kitchenErr(c, e);
    }
  });
  app.put("/v1/events/:id", async (c) => {
    try {
      return c.json({ event: await updateEvent(c.get("auth").customerId, c.req.param("id"), await c.req.json()) });
    } catch (e) {
      return kitchenErr(c, e);
    }
  });
  app.post("/v1/events/:id/replan", async (c) => {
    try {
      return c.json({ event: await replanEvent(c.get("auth").customerId, c.req.param("id")) });
    } catch (e) {
      return kitchenErr(c, e);
    }
  });
  app.post("/v1/events/:id/order", async (c) => {
    try {
      return c.json({ event: await orderEvent(c.get("auth").customerId, c.req.param("id")) });
    } catch (e) {
      return kitchenErr(c, e);
    }
  });
  app.delete("/v1/events/:id", (c) => {
    try {
      return c.json(cancelEvent(c.get("auth").customerId, c.req.param("id")));
    } catch (e) {
      return kitchenErr(c, e);
    }
  });

  // ── Valio's account agent + suggestions ──
  app.get("/v1/suggestions", (c) => c.json({ suggestions: listSuggestions(c.get("auth").customerId) }));
  app.post("/v1/valio-agent/run", async (c) => c.json(await runValioAgent(c.get("auth").customerId)));
  app.post("/v1/suggestions/:id/accept", async (c) => {
    const auth = c.get("auth");
    const mandate = getMandate(auth.customerId);
    if (!mandate) return c.json({ error: "no_mandate" }, 400);
    try {
      return c.json({ intent: await acceptSuggestion(auth.customerId, c.req.param("id"), mandate) });
    } catch (e) {
      return kitchenErr(c, e);
    }
  });
  app.post("/v1/suggestions/:id/dismiss", (c) => {
    try {
      return c.json({ suggestion: dismissSuggestion(c.get("auth").customerId, c.req.param("id")) });
    } catch (e) {
      return kitchenErr(c, e);
    }
  });
  // Demo hook (buyer-only): make the mock backend report a product as out of stock.
  app.post("/v1/admin/simulate-stockout", async (c) => {
    const body = (await c.req.json()) as { productId: string; active?: boolean };
    if (body.active === false) simulatedStockouts.delete(String(body.productId));
    else simulatedStockouts.add(String(body.productId));
    return c.json({ simulated: [...simulatedStockouts] });
  });

  // ── Demo hygiene ──
  // Destructive, so it must be explicit: callers have to send `X-Demo-Reset: confirm`. A bare POST is refused,
  // which stops scripts/tests/other clients from silently wiping a running demo. The caller is recorded in the audit.
  app.post("/v1/admin/demo-reset", (c) => {
    const auth = c.get("auth");
    if (c.req.header("x-demo-reset") !== "confirm")
      return c.json({ error: "confirmation_required", hint: "Send header X-Demo-Reset: confirm (the Desk's 'Reset demo data' button does)." }, 400);
    const source = c.req.header("x-reset-source") ?? c.req.header("user-agent")?.slice(0, 80) ?? "unknown";
    const removedIntents = resetIntents(auth.customerId, source);
    resetKitchen(auth.customerId);
    resetStanding(auth.customerId);
    resetSuggestions(auth.customerId);
    resetEvents(auth.customerId);
    simulatedStockouts.clear();
    resetMandate(auth.customerId);
    return c.json({ ok: true, removedIntents });
  });

  app.get("/v1/agent/status", (c) => c.json(getLlmStatus()));

  app.post("/v1/agent/chat", async (c) => {
    const auth = c.get("auth");
    const body = await c.req.json();
    const message = String(body.message ?? "").trim();
    if (!message) return c.json({ error: "message_required" }, 400);
    const history: ChatMessage[] = Array.isArray(body.history)
      ? (body.history as ChatMessage[])
          .filter((m) => m && (m.role === "user" || m.role === "assistant"))
          .map((m) => ({
            role: m.role as "user" | "assistant",
            content: String(m.content ?? ""),
          }))
      : [];
    try {
      const result = await runPurchasingAgent({
        customerId: auth.customerId,
        message,
        history,
        callerRole: auth.role,
      });
      appendAudit(randomUUID(), auth.customerId, "agent_chat_turn", {
        provider: result.provider,
        model: result.model,
        tools: result.toolTrace.map((t) => ({
          name: t.name,
          ok: t.ok,
        })),
        messagePreview: message.slice(0, 200),
      });
      return c.json(result);
    } catch (e) {
      return c.json(
        { error: e instanceof Error ? e.message : "agent_failed" },
        500,
      );
    }
  });

  return app;
}

function openApiDoc() {
  return {
    openapi: "3.1.0",
    info: {
      title: "Valio Aimo Agent Gateway",
      version: "0.1.0",
      description:
        "Open interface for *external* purchasing agents (MCP or REST). Auth: X-API-Key bound to customer + mandate. Desk and LLM chat are clients of the same APIs — they do not bypass policy. Path to production: OAuth2 scoped tokens.",
    },
    servers: [{ url: config.publicUrl }],
    components: {
      securitySchemes: {
        ApiKeyAuth: { type: "apiKey", in: "header", name: "X-API-Key" },
      },
      schemas: {
        ApproveOrderBody: {
          type: "object",
          required: ["snapshotHash"],
          properties: {
            snapshotHash: {
              type: "string",
              description: "Must match the intent basket snapshotHash exactly",
            },
            authorizeMandateOverride: {
              type: "boolean",
              description:
                "Required true when policy.failingRules is non-empty. Silent override is rejected.",
            },
            acknowledgedRules: {
              type: "array",
              items: { type: "string" },
              description:
                "Must cover every failing rule when authorizeMandateOverride=true (e.g. over_spend, partial_fulfil).",
            },
          },
        },
      },
    },
    security: [{ ApiKeyAuth: [] }],
    paths: {
      "/v1/me": { get: { summary: "Authenticated customer + mandate" } },
      "/v1/products/search": {
        post: {
          summary: "search_products",
          description: "Local catalog shortlist only — never bulk Valio price query",
        },
      },
      "/v1/prices": { post: { summary: "get_prices (signed claims)" } },
      "/v1/availability": { post: { summary: "get_availability (signed claims)" } },
      "/v1/offers/rank": {
        post: {
          summary: "rank_offers",
          description:
            "Pack math + price/availability + reliability/carbon. Surfaces canFulfil, shortfall, good/better/best substitutionLabel.",
        },
      },
      "/v1/claims/verify": { post: { summary: "verify_claim" } },
      "/v1/mandate": {
        get: { summary: "get_mandate" },
        put: {
          summary: "update_mandate",
          description:
            "Includes autoPurchaseIf.reliabilityUnknownOk — when true, unknown delivery reliability does not block auto-commit.",
        },
      },
      "/v1/quotes": {
        post: {
          summary: "request_quote (firm price for a shortlist)",
          description:
            "Body: { need, productIds? }. Returns a signed quote with a firm-price window (validUntil, default 30 min). Price is guaranteed until then; availability is not held and is re-checked at commit.",
        },
      },
      "/v1/quotes/{id}": { get: { summary: "get_quote (status open|used|expired|withdrawn)" } },
      "/v1/orders/intent": {
        post: {
          summary: "create_order_intent (fixed-price, not committed)",
          description:
            "Optional quoteId: lines and prices come from the quote (no re-pricing); the quote is consumed (single use). At commit the quoted price is honoured while inside its firm window.",
        },
      },
      "/v1/orders/pending": { get: { summary: "list_pending_approvals" } },
      "/v1/orders/{id}/approve": {
        post: {
          summary: "approve_order",
          description:
            "Human approval of exact snapshot. Mandate overrides require authorizeMandateOverride + acknowledgedRules.",
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/ApproveOrderBody" },
              },
            },
          },
        },
      },
      "/v1/orders/{id}/reject": { post: { summary: "reject_order" } },
      "/v1/orders/{id}/commit": {
        post: { summary: "commit_order (revalidates price/availability)" },
      },
      "/v1/audit/{runId}": { get: { summary: "get_audit_trail" } },
      "/v1/audit/{runId}/verify": { post: { summary: "verify_audit_chain" } },
      "/v1/kitchen/inventory": {
        get: { summary: "Buyer-side kitchen on-hand + par levels" },
      },
      "/v1/kitchen/recipes": { get: { summary: "Kitchen recipes + weekly demand" } },
      "/v1/kitchen/order-history": {
        get: { summary: "Standing-order / recent purchase history" },
      },
      "/v1/kitchen/restock": {
        get: {
          summary: "recommend_restock",
          description:
            "Prioritized restock from inventory+recipes+history; includes standingOrderDrift flags. Query: daysCover",
        },
      },
      "/v1/kitchen/restock/automation": {
        get: { summary: "Get restock automation policy + last run" },
        put: {
          summary: "Update restock automation policy",
          description:
            "enabled, daysCover, maxItems, urgencies, pauseOnStandingOrderDrift, intervalMinutes. Mandate still gates every commit.",
        },
      },
      "/v1/kitchen/restock/run": {
        post: {
          summary: "Run automated restock now",
          description:
            "recommend_restock → intents → commit if auto_eligible; pending_approval otherwise. Body: { force?: boolean }",
        },
      },
      "/v1/agent/status": { get: { summary: "LLM provider status (optional)" } },
      "/v1/agent/chat": {
        post: {
          summary: "Desk purchasing agent (tools only; mandate still deterministic)",
        },
      },
    },
  };
}
