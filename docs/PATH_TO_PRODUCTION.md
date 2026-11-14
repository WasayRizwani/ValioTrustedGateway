# Product Assessment & Path to Production

This document outlines **what works extremely well in the current Valio Aimo Agent Gateway**, **where the weekend prototype deliberately draws honest boundaries**, and **the prioritized engineering & product roadmap** to take the operating model into enterprise production at Valio Aimo.

> **Core thesis:** The product to commercialize is the **Agent Gateway operating model** — deterministic mandates, signed claims, least-privilege scopes, and revalidated two-phase commits — not a proprietary purchasing chatbot.

---

## 1. What Works Extremely Well Today

Every capability below is running end-to-end in this repository and verified by **164 passing automated tests** across **17 test suites** (`npm test`).

### 1.1 Deterministic Authority & Least-Privilege Multi-Agent Isolation
- **Middleware-enforced capability scopes (REST + MCP parity):** Four specialist agent identities (`sourcing`, `planner`, `procurement`, `valio-account`) plus human `buyer` keys are enforced on every HTTP route and MCP tool call (`apps/gateway/src/agents/registry.ts`). Over MCP, an agent key only *sees* the tools it is permitted to call and is refused if it invokes any other by name.
- **Hard human-only boundary:** Agent credentials receive deterministic `403 forbidden` on `approve`, `reject`, `PUT /v1/mandate`, standing-order edits, restock automation settings, and admin routes — and every blocked escalation attempt is recorded in the audit log (`forbidden_action`).
- **Tenant & cross-company privacy boundaries:** Credentials bind `customerId` server-side (`HOTEL-001` vs. `SCHOOL-001`), defeating cross-tenant spoofing. Valio's own account agent (`valio_account_key_001`) can monitor a buyer's Valio order history and propose stock-out substitutes **without ever seeing private kitchen inventory or recipes**.
- **Verify live:** `npm run demo:team`, Desk → **Gateway & Trust → Connect Agent & 403 / Tamper Lab**, or `apps/gateway/test/agents.test.ts` & `authority.test.ts`.

### 1.2 Safe Inquiry-to-Commitment Lifecycle (Quote → Snapshot Intent → Revalidated Commit)
- **First-class fixed-price Quotes (`POST /v1/quotes`):** Converts shortlisted live Valio prices into a single-use `Quote` with a firm price window (`validUntil`, default 30 min), explicit `availabilityHeld: false`, and quote-bound Ed25519 claims (`subject.quoteId`).
- **Two-phase commit with live revalidation (`POST /v1/orders/:id/commit`):** Before placing an order, the gateway re-checks:
  1. Current mandate validity, expiry, and revocation status.
  2. Live Valio `/api/price` and `/api/availability` (`salesBlock`, stock drop, delivery date).
  3. Firm-quote price protection (honours quoted price inside `validUntil` even if live price rose, audited as `quote_price_honoured`; enforces `priceDriftTolerancePct` outside it).
  4. Policy re-evaluation — if a rule newly fails that was not acknowledged at human approval, the intent transitions back to `pending_approval` (`commit_requires_reapproval`) with a fresh `snapshotHash`.
- **Concurrency, idempotency & deduplication:** Synchronous check-and-set (`revalidating`), in-flight promise joining, and a unique SQLite index on `idempotency_key` guarantee exactly-once order placement under parallel retries while flagging cross-intent key reuse (`idempotency_key_conflict`). Identical open intents deduplicate automatically; newer proposals supersede unapproved ones without double-counting spend.
- **Verify live:** `npm run demo:a`, `npm run demo:b`, or `apps/gateway/test/quote.test.ts` & `commit.test.ts`.

### 1.3 Expressive Mandate Policy & Anti-Gaming Guardrails
- **17 deterministic policy & commit rule codes (`apps/gateway/src/policy/engine.ts`):** Enforces per-order caps, cumulative daily/weekly/monthly spend caps, daily order velocity (`maxOrdersPerDay`), **anti-order-splitting detection** (flags 3+ orders in 24h each >80% of the per-order limit), per-unit quantity caps, unit-price ceilings, category/brand allowlists, delivery deadline & `closingTime` cut-off checks, unknown-reliability gating, partial fulfilment, and substitution sign-off.
- **Food-safety allergen & dietary precision:** Distinguishes catalog-attested `lactose-free` from `"low lactose"` (rejected), scopes dairy rules intelligently so non-dairy items (e.g., bananas or eggs, plus whole-word Finnish `voi`/`voita`) are never falsely flagged, and checks both `CONTAINS` and cross-contamination `MAY_CONTAIN` declarations for schools and hospitals.
- **Rule-by-rule human override:** Approving a halted intent requires `snapshotHash` integrity + `authorizeMandateOverride: true` + explicit `acknowledgedRules` covering every failing rule — preventing rubber-stamp approvals or silent basket swaps.
- **Verify live:** Desk → **Approvals & Mandate**, or `apps/gateway/test/policy.test.ts`.

### 1.4 Cryptographic Claim Envelopes & Tamper-Evident Audit Chain
- **Ed25519 Envelope v2 + JWKS (`apps/gateway/src/claims/sign.ts`):** Canonicalized JSON signatures cover the full v2 envelope (`version`, `claimId` nonce, `issuer`, `keyId`, `asOf`, `subject`, and `claim` including product origin, allergens, and certifications), verifiable offline against `/.well-known/jwks.json`. Legacy unsigned-metadata v1 envelopes are rejected.
- **SHA-256 hash-chained audit trail (`apps/gateway/src/audit/chain.ts`):** Append-only SQLite transactions link `prevHash → hash` with automatic `AsyncLocalStorage` agent attribution and one-click chain verification (`POST /v1/audit/:runId/verify`).
- **Verify live:** Desk → **Gateway & Trust**, or `apps/gateway/test/claims.test.ts`.

### 1.5 Real Catalog Grounding, Multi-Criteria Ranking & Upstream Rate Protection
- **17,546 Valio SKUs + 4,429 reliability + 11,033 carbon records:** Pack-size math, bidirectional Valio catalog substitutes, normalized `0..1` scoring across price, delivery earliness, historical reliability, and carbon (`kg CO2e/kg`), plus **Pareto-optimal** offer flagging.
- **Strict upstream Valio API protection (`valio/client.ts`, `middleware/ratelimit.ts`):** Enforces shortlist-only lookups (`MAX_SHORTLIST_SIZE = 25`), per-key token buckets (burst-10 agent cap with 30s cooldown vs. responsive UI buyer bucket), serialized `<10 req/s` upstream pacing, and `Retry-After` handling.
- **Verify live:** `apps/gateway/test/catalog-data.test.ts`, `offers.test.ts`, `ratelimit.test.ts`, `valio-client.test.ts`.

### 1.6 Defense-in-Depth AI & Real Kitchen Workflows
- **Prompt-injection hardening & deterministic constraint floor (`agent/sanitize.ts`, `need/parse.ts`):** Untrusted catalog text and tool outputs are stripped of instruction-like directives and wrapped in random-nonce `<<<UNTRUSTED_TOOL_DATA>>>` fences; a deterministic NL parser locks hard allergen, unit-price, and self-correction constraints so an LLM cannot drop an allergy exclusion or turn a read-only question into an order.
- **Operational kitchen depth:** Backward lead-time scheduling for banquets/events (`event day − prep days − Valio lead time`), shelf-life-aware pack-size optimization (`smart_restock`), and a non-ordering **phone event proposal** flow (Vapi + hashed single-use POST email approval tokens invalidated on edit).
- **Verify live:** `apps/gateway/test/injection.test.ts`, `parse.test.ts`, `events.test.ts`, `voice.test.ts`.

---

## 2. Honest Current Limitations (What Is Scoped in the Prototype)

Being explicit about what is mocked or simplified today ensures zero hidden surprises on the path to production:

1. **Single-SKU `OrderIntent` execution despite multi-line schemas:** While `BasketLine[]` is an array in `@tta/shared`, `createOrderIntent` currently commits one SKU per intent (`quotes.ts` prices alternatives for a single `Need`). Ordering a 12-ingredient banquet or weekly restock produces 12 separate intents/orders rather than one consolidated purchase order and delivery drop.
2. **No upstream stock reservation (`availabilityHeld: false`):** Because the challenge sandbox exposes read-only `/api/price` and `/api/availability`, stock is not held while a high-value intent awaits human approval. If inventory sells out before sign-off, `commitOrder` cleanly aborts (`stale_offer`) rather than holding stock.
3. **Gateway-local signing key & per-run SQLite audit chains:** Ed25519 claims are signed by the gateway's local keypair rather than an upstream Valio KMS/HSM, and SHA-256 chains link events per `(run_id, customer_id)` inside local SQLite (`data/gateway.db`) without external WORM/transparency anchoring.
4. **Static API keys, single-node memory locks & `stdio` MCP:** Credentials come from static config; token-bucket counters (`buckets`), `inFlightCommits`, and the `<10 req/s` `valioQueue` live in single-process memory; MCP runs over local `stdio` rather than remote Streamable HTTP with OAuth.
5. **Mocked ERP commit & polling Desk UX:** Committed orders generate a local `ORD-*` confirmation rather than submitting to Valio's ERP/EDI pipeline, and the React Desk polls `/v1/overview` every 10–15 seconds instead of receiving push webhooks/SSE for urgent cut-off risks.

---

## 3. Prioritized Product Improvements & Production Roadmap

### Phase 1 — High-Impact Product Improvements (Immediate Next Sprint)
- **Multi-line consolidated carts & batch approval:** Upgrade `POST /v1/quotes` and `POST /v1/orders/intent` to bundle full menu/restock runs into a single multi-line basket — enforcing supplier minimum order value (MOV), cold-chain delivery consolidation, and line-level accept/substitute/drop in one buyer review.
- **Pre-approved backup substitutes before `closingTime`:** Allow buyers (or standing rules) to attach a ranked fallback SKU to an intent so commit-time stock-outs near the picking cut-off auto-recover within pre-authorized price/allergen bounds instead of failing cold.
- **Proactive cut-off push alerts (SSE + Slack/Teams/Mobile):** Replace 10–15s UI polling with Server-Sent Events and outbound webhooks that alert buyers when a `pending_approval` order is within 2 hours of Valio's `closingTime` picking deadline.
- **Mandate Shadow-Mode (30-day policy backtesting):** Let buyers simulate mandate edits ("What if we lower max autonomous spend from €500 to €300 or disable `reliabilityUnknownOk`?") against the past 30 days of order history to preview approval load vs. autonomous throughput before saving.
- **Contract & tiered pricing awareness:** Incorporate customer-specific contract tiers, volume breaks, and deposit/logistics fees into `smart_restock` and `buildOffers`.

### Phase 2 — Identity, Cryptographic Non-Repudiation & Remote MCP
- **WebAuthn / Passkey human override signatures:** Require a FIDO2/WebAuthn assertion when clicking **Authorize mandate override**, binding the human approver's cryptographic signature into the `human_approved` audit event (proving *which authorized person* approved, not merely possession of a buyer API key).
- **OAuth 2.1 / OIDC + multi-tier org approvals:** Replace static keys with scoped JWTs and RFC 8693 On-Behalf-Of delegation, supporting tiered buyer workflows (e.g., Kitchen Lead ≤ €1,500, F&B Director ≤ €5,000, Finance > €5,000, dual-control on mandate changes).
- **Valio-hosted Streamable HTTP MCP:** Expose the MCP server over remote HTTPS with OAuth discovery so third-party kitchen ERPs and autonomous agents connect with zero local CLI setup.
- **Upstream Valio KMS/HSM attestation:** Shift Ed25519 / W3C Verifiable Credential signing into Valio Aimo's core pricing & product-master services with automated JWKS key rotation.

### Phase 3 — Valio Aimo ERP Integration & Horizontal Scale
- **Time-boxed ERP inventory soft-holds:** Add a reservation TTL on `pending_approval` intents (bounded per customer quota so rogue agents cannot hoard stock) without changing the external `Quote → Intent → Commit` agent contract.
- **End-to-end ERP order, ASN & e-invoice loop:** Wire `commitOrder` to Valio's order management / EDI system, ingest real Advance Shipping Notices (ASNs) and partial-delivery adjustments into `/v1/kitchen/deliveries`, and enable automated 3-way invoice matching against the signed `Quote` claim.
- **PostgreSQL + Redis + global WORM Merkle audit:** Migrate SQLite and in-memory rate-limit/idempotency locks to PostgreSQL and Redis for multi-replica HA, and anchor cross-run tenant Merkle roots to immutable WORM storage / enterprise SIEM.

---

## 4. Weekend Prototype vs. Valio Production Matrix

| Dimension | Working Prototype Today | Enterprise Valio Aimo Production |
|-----------|-------------------------|----------------------------------|
| **Discovery & Transport** | OpenAPI 3.1 + local `stdio` MCP | Valio-hosted API Gateway + remote Streamable HTTP MCP |
| **Order Granularity** | Single-SKU `OrderIntent` (multi-line schema ready) | Multi-line consolidated carts, MOV & split-shipment rules |
| **Auth & Delegation** | Customer-bound API keys + 4 scoped agent roles | OAuth 2.1 / OIDC, RFC 8693 delegation & multi-tier org sign-off |
| **Human Override Proof** | Buyer key + `snapshotHash` + `acknowledgedRules` | Same + WebAuthn / Passkey cryptographic human signature |
| **Claim Signing** | Gateway Ed25519 v2 envelopes + `/.well-known/jwks.json` | Upstream Valio HSM/KMS signing + key rotation / optional W3C VCs |
| **Inventory Guarantee** | Live revalidation at commit (`availabilityHeld: false`) | Time-boxed ERP soft-hold during approval window + backup SKU cascade |
| **Order Fulfilment** | SQLite `ORD-*` commit + manual delivery receipt | ERP / EDI submission, live ASN webhooks & 3-way e-invoice match |
| **State & Pacing** | Single-node SQLite + in-memory token buckets & `<10/s` queue | PostgreSQL + Redis distributed locks & edge rate limiting |
| **Audit Integrity** | Per-run SHA-256 hash chain in append-only SQLite | Global tenant Merkle log anchored to WORM storage / SIEM |

### Openness Invariants (Preserved Across Every Phase)
1. **Same external contract:** Publish OpenAPI + MCP with stable tool names and versioned Zod / JSON Schemas.
2. **Deterministic gateway authority:** Keep mandate evaluation, scope checks, and commit revalidation inside gateway code — an LLM is never the source of truth.
3. **Explicit breach accountability:** Require `snapshotHash` + `authorizeMandateOverride` + `acknowledgedRules` for every policy exception.
4. **Verifiable facts:** Sign price, availability, and allergen/origin attestations; expose public keys via JWKS; hash-chain every state transition and `403` refusal.
