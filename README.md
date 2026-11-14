# Valio Aimo Agent Gateway — Trusted Trade Agents

**Product:** a safe open interface for *external* purchasing agents to look up products, compare fixed prices/availability, and commit orders under an explicit purchasing mandate — with human approval APIs when authority is exceeded.

We do **not** compete on how smart our LLM is. We compete on **how safely someone else’s agent can transact with Valio**.

## Architecture

```
External agent (MCP or REST) ─┐
                              ├─► Agent Gateway ─► Valio mock (price + availability)
React Approval Desk (REST) ───┘         │
                                        ├ mandate + policy (deterministic)
                                        ├ signed claim envelopes (Ed25519)
                                        ├ two-phase intent → revalidate → commit
                                        └ hash-chained audit
```

## Quick start

```bash
cp .env.example .env   # already filled for the challenge API key
npm install
npm run download-data -w @tta/gateway
npm run build -w @tta/shared
npm run dev:gateway    # http://localhost:8787
npm run dev:desk       # http://localhost:5173
```

Or with Docker Compose:

```bash
cp .env.example .env
docker compose up --build   # gateway on :8787, desk on :5173
```

Demo API keys (bound to customer — cannot spoof another customer’s prices/orders):

| Key | Customer |
|-----|----------|
| `hotel_demo_key_001` | HOTEL-001 **agent** (max €500 / order; can quote and order inside the mandate) |
| `hotel_buyer_key_001` | HOTEL-001 **buyer** (human side: the only key that can approve / override / change the mandate) |
| `school_demo_key_001` / `school_buyer_key_001` | SCHOOL-001 agent / buyer |

**Authority boundary:** agent credentials get `403 forbidden` on approve, reject, `PUT /v1/mandate`, recurring-order
management, restock-automation settings and admin calls — and every refused attempt is written to the audit log. The desk
runs with the buyer key; `npm run demo:a|b` run as the agent key. Run `npm test` for the parser, policy and authority tests.

## Purchasing agent chat (AI)

The desk opens on **Agent chat** — a tool-using purchasing agent (not a FAQ bot). Two starter actions run the autonomous 100 L order and the 3,000 L approval case.

1. Put Verda credentials in `.env` (`OPENAI_BASE_URL=https://inference.verda.com/v1`, `LLM_MODEL=kimi-k3-1-pro`, inference API key)
2. Restart the gateway
3. Open http://localhost:5173 → Agent chat
4. Try: *“I need 100 litres of lactose-free milk by Monday…”*

The model only orchestrates tools (`rank_offers`, `create_order_intent`, `commit_order`, …). **Mandate / approval / commit stay deterministic.** Without an LLM key, a heuristic tool agent still executes the same purchase flow.

Check: `GET /v1/agent/status`

## Dual-client demo (judging)

The desk chat is optional UX. The scoring story is **someone else’s agent** hitting the open gateway.

**Scenario A — autonomous (external agent only)**

```bash
# terminal 1: gateway running
npm run demo:a
```

100 L lactose-free milk → within mandate → `auto_eligible` → commit + audit verify.
HOTEL mandate sets `autoPurchaseIf.reliabilityUnknownOk: true` so missing reliability CSV rows do not block small within-mandate orders (flip to `false` via `PUT /v1/mandate` to force approval).

**Scenario B — human intervention**

```bash
npm run demo:b
```

3,000 L → over spend / policy → `pending_approval`. Open the desk → Approval → acknowledge failing rules → **Authorize mandate override** → Approve → Commit (gateway revalidates; LLM cannot override).

## Quote → order lifecycle

The challenge asks for a defined path from inquiry to commitment on **fixed prices, not a negotiated quote**. The gateway models it as a first-class, signed **Quote**:

1. `POST /v1/quotes` (`request_quote`) with `{ need, productIds? }` prices the shortlisted SKUs live and returns `quoteId`, `lines` (pack maths), `totalPrice`, `validUntil` and Ed25519 `claims` bound to the quote. Price is **firm until `validUntil`** (default 30 min, `QUOTE_TTL_MINUTES`). `availabilityHeld` is always `false`: stock is not reserved.
2. `POST /v1/orders/intent` with `{ quoteId }` (`create_order_intent`) builds the intent from the quote with no re-pricing. The quote is single-use; expired, used or another customer's quotes are refused. The mandate/approval policy is evaluated on the quoted basket.
3. `POST /v1/orders/:id/commit` re-checks mandate, policy and **availability** against live Valio. Inside the firm window the quoted price is honoured even if the live price has risen (audited as `quote_price_honoured`); outside it, the normal price-drift tolerance (`priceDriftTolerancePct`, default 2%) applies.

Quote status: `open` → `used` | `expired` | `withdrawn` (`GET /v1/quotes/:id`). Audit events: `quote_issued`, `quote_accepted`, `quote_price_honoured`. Agent scopes: Sourcing creates/reads quotes, Procurement reads them and uses them in intents.

## Open interface

- REST OpenAPI: `http://localhost:8787/openapi.json`
- Claim public key: `http://localhost:8787/.well-known/jwks.json`
- MCP stdio server: `VALIO_GATEWAY_API_KEY=hotel_demo_key_001 npm run mcp -w @tta/gateway`
- Path-to-production notes: [`docs/PATH_TO_PRODUCTION.md`](docs/PATH_TO_PRODUCTION.md)

### Tool / API surface

Trade: `search_products` · `get_prices` · `get_availability` · `rank_offers` · `verify_claim` · `get_mandate` · `request_quote` · `get_quote` · `create_order_intent` · `list_pending_approvals` · `approve_order` (override params) · `reject_order` · `commit_order` · `get_audit_trail` · `verify_audit_chain`

Kitchen (buyer context): `get_inventory` · `get_recipes` · `get_order_history` · `recommend_restock` (standing-order drift flags)

## What works extremely well & how we improve next

Full evaluation, honest prototype boundaries, and phased architecture roadmap: **[`docs/PATH_TO_PRODUCTION.md`](docs/PATH_TO_PRODUCTION.md)**.

### Working end-to-end today (verified by 164 passing tests — `npm test`)

1. **Deterministic authority & least-privilege multi-agent isolation** — Four scoped agent identities (`sourcing`, `planner`, `procurement`, `valio-account`) enforced in gateway middleware across both **REST and MCP**. Agents get `403 forbidden` on approvals, mandate edits, and admin routes (every refusal audited). Valio's account agent flags stock-outs without seeing private kitchen inventory or recipes (`npm run demo:team`).
2. **Two-phase transaction safety (`Quote → Intent → Revalidated Commit`)** — Single-use fixed-price `Quote` (`validUntil` window, `availabilityHeld: false`), `snapshotHash`-bound `OrderIntent`, live Valio `/api/price` + `/api/availability` revalidation at commit, `priceDriftTolerancePct` enforcement, and synchronous check-and-set + SQLite `idempotency_key` deduplication so parallel retries never double-order (`npm run demo:a`, `npm run demo:b`).
3. **17-rule deterministic policy & food-safety engine** — Per-order and cumulative daily/weekly/monthly spend caps, order velocity & **anti-order-splitting detection** (3+ orders in 24h >80% of cap), dairy-scoped `lactose-free` checks (`"low lactose"` rejected; non-dairy unaffected), `CONTAINS` + `MAY_CONTAIN` allergen exclusions, and rule-by-rule `acknowledgedRules` human overrides.
4. **Cryptographic claim envelopes & tamper-evident audit chain** — Canonical Ed25519 v2 envelopes binding `issuer`, `keyId`, `asOf`, `subject` (`quoteId`/`intentId`), price/stock, and product origin/allergens/certifications (verifiable via `/.well-known/jwks.json`), paired with a SHA-256 hash-chained SQLite audit trail (`POST /v1/audit/:runId/verify`).
5. **17,546-SKU catalog ranking & upstream Valio protection** — Pack-size math, bidirectional Valio substitutes, Pareto-optimal scoring across price, delivery cut-off (`closingTime`), reliability (4,429 SKUs), and carbon (11,033 SKUs), protected by `MAX_SHORTLIST_SIZE = 25`, per-key token buckets, and a serialized `<10 req/s` upstream queue with `Retry-After` handling.
6. **Defense-in-depth AI & kitchen operations** — Nonce-fenced prompt-injection sanitization (`<<<UNTRUSTED_TOOL_DATA>>>`), a deterministic NL constraint floor (an LLM cannot drop allergy rules or turn a read-only question into an order), backward lead-time event planning, shelf-life-aware `smart_restock`, and a non-ordering phone proposal flow (Vapi + single-use POST approval links).

### Honest current gaps & highest-leverage improvements

| Current prototype boundary | Product & production improvement |
|----------------------------|----------------------------------|
| **Single-SKU `OrderIntent` execution** (multi-line schema ready, 1 SKU committed per intent) | **Multi-line consolidated carts** — bundle full menu/restock runs into one PO with supplier MOV, delivery consolidation, and line-level batch approval |
| **No stock hold during approval** (`availabilityHeld: false`; stock-out before sign-off aborts at commit) | **Time-boxed ERP soft-holds + pre-approved fallback SKUs** — reserve stock during `pending_approval` TTL or auto-cascade to a buyer-approved backup before `closingTime` |
| **Polling UI & email-only escalations** (10–15s Desk polling) | **Proactive cut-off push alerts & Mandate Shadow-Mode** — SSE + Slack/Teams/mobile alerts 2h before `closingTime`, plus 30-day historical backtesting before activating mandate edits |
| **Gateway-signed claims & per-run SQLite chains** (buyer key proves authority, not individual identity) | **WebAuthn human override signatures + upstream Valio HSM & WORM Merkle log** — passkey-signed human overrides, supplier-signed VCs, and cross-run WORM/SIEM anchoring |
| **Static API keys, single-node locks & `stdio` MCP** (mock `ORD-*` commit) | **OAuth 2.1 tiered org approvals, Streamable HTTP MCP & ERP/ASN loop** — multi-tier sign-off (Kitchen Lead / Director / Finance), Postgres + Redis HA, real ERP order commit, live ASNs & 3-way invoice match |

## Important challenge constraints

- Query Valio price/availability **only** for shortlisted SKUs — never the full catalog.
- Mocking today’s webshop backend, not a new marketplace.
- Not a chatbot: the desk is an approval client of the same gateway APIs.


## Hotel data sync, recipes & recipe-driven sourcing

The hotel's kitchen data (inventory, recipes, order history) is the **buyer's** data, not Valio's. It is persisted in SQLite
(`data/gateway.db`), seeded with demo data on first run, and kept in sync three ways:

| How | Endpoint |
|-----|----------|
| Push from the hotel's own system (PMS / inventory / recipe app) | `PUT /v1/kitchen/inventory`, `POST /v1/kitchen/recipes`, `POST /v1/kitchen/import` |
| Committed orders become *stock on order* (no double-ordering) | automatic on `commit` |
| Receive deliveries / cook recipes / stock-take | `POST /v1/kitchen/deliveries`, `POST /v1/kitchen/recipes/:id/cook`, `POST /v1/kitchen/inventory/adjust` |

Recipe-driven scenarios (also available as agent + MCP tools `plan_menu_sourcing`, `handle_stockout`):

- `POST /v1/kitchen/plan` `{neededBy, recipes:[{recipeId,batches}], createIntents}` — menu / last-minute event: ingredient needs →
  shortfall → Valio offers, flags what can't arrive in time and proposes **recipe-compatible** good/better/best substitutes
  (lactose/allergen rules kept, trade-off explained). Substitutions always go to human approval under the default mandate.
- `POST /v1/kitchen/stockout` `{ingredientId, productId?, neededBy}` — supplier stock-out: affected recipes + substitute.
- `POST /v1/admin/demo-reset` — reset kitchen, mandate and intents to the seed (the audit log is append-only and kept). Destructive, so it needs the header `X-Demo-Reset: confirm`; the Desk shows a notice afterwards and the live feed restarts from the reset.

Order-flow hardening: identical open intents are reused (no duplicates), stale intents auto-expire, committing twice is a no-op,
mandates persist across restarts, and the lactose rule applies to dairy lines only (by catalog label, not product name).


## The agent team (multi-agent, least privilege)

Four specialist agents, each with its own credential and a narrow capability set that the **gateway enforces on every
request** (not prompt wording). See `apps/gateway/src/agents/registry.ts`.

| Agent | Side | Key | Can | Cannot |
|-------|------|-----|-----|--------|
| **Sourcing** | buyer | `hotel_sourcing_key_001` | search, compare offers, verify claims | propose orders, see the kitchen |
| **Kitchen planner** | buyer | `hotel_planner_key_001` | read recipes/stock/recurring, plan menus & stock-outs | spend money, create orders |
| **Procurement** | buyer | `hotel_procurement_key_001` | propose + commit orders inside the mandate | approve, override, read recipes/inventory |
| **Valio account agent** | **Valio** | `valio_account_key_001` | watch your usual products, flag stock-outs, suggest cheaper options | see inventory/recipes, place orders, accept its own suggestions |

The **mandate guardian** is deterministic code, and **only the buyer key can approve**. Hand-offs are explicit
(`Planner → Sourcing → Procurement`), every audit event is attributed to the agent that performed it, and refused attempts
are logged too.

```bash
npm run demo:team   # scripted walkthrough: each agent does its job, and is refused outside it (add `-- --reset` to wipe demo data first; it never resets by default)
```

`GET /v1/agents` returns the roster with each agent's last action. The Valio agent runs via `POST /v1/valio-agent/run`;
suggestions are at `GET /v1/suggestions` and are accepted by the buyer side (`POST /v1/suggestions/:id/accept`), where the
normal mandate applies (a substitute always needs human sign-off). `POST /v1/admin/simulate-stockout` is a demo hook that
makes the mock backend report a product as out of stock.

### Connecting your own agent

Open **Agent → Connect an agent** in the app (buyer view): endpoints (OpenAPI, JWKS, MCP), the five identities with
exactly what each may call, copy-paste samples (curl / TypeScript / Python / MCP config), a "test this key" button, a
"try something it must not do" button, and a live **verify a signed claim** demo (tampering is detected).

Scopes are enforced identically over **REST and MCP**: over MCP an agent key only *sees* its tools and is refused
(and audited) if it calls any other by name. `GET /v1/connect` returns the same information as JSON and is buyer-only.

## Events & busy days

Weddings, banquets and school parties need far more than the usual week. Add an event (Kitchen → Events, or just tell the
chat agent) with its date, guests and dishes. The **Planner** then:

1. computes the **extra** demand on top of your usual usage until that day (recipe portions + safety margin + extras, minus
   stock and what's already on order),
2. works backwards: *event day − prep days = on site by*, *− Valio's lead time = order by*,
3. checks live Valio offers and **warns early** if something can't arrive in time (at risk, with the reasons),
4. orders at the right moment — Sourcing picks offers, Procurement places them inside the mandate (the rest waits in
   *Needs approval*). Turn off "order automatically" to keep the decision with you.

API (buyer-only writes; the Planner may read): `GET/POST /v1/events`, `PUT/DELETE /v1/events/:id`,
`POST /v1/events/:id/replan`, `POST /v1/events/:id/order`. Chat tools: `list_events`, `create_event`, `order_event`.

## Smart restock (quantity, expiry, use-first)

- `GET /v1/kitchen/restock/smart` (MCP/chat tool `smart_restock`) prices the exact shortfall against other pack sizes. Valio prices are flat per pack, so the lever is pack size: it compares cost per unit **actually used** (surplus only counts up to what recipes use within ~60% of shelf life). A modest step up (≤2× the exact cost) is ordered automatically when `smartQuantities` is on; a bulk buy is offered, never assumed.
- Stock carries `shelfLifeDays`, `expiresOn` and `lastUsedAt`. Deliveries set expiry, recipe usage stamps last use. "Use these first" lists stock that will not be used before it expires, or has not been touched for 14+ days, with the recipes that would use it.
- `POST /v1/kitchen/restock/run` accepts `choice: "exact" | "smart"`. The mandate still gates every order.
