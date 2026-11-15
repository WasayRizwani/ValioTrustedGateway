/**
 * End-to-End Headless Multi-Agent Bilateral Signing & 3-Way Dispute Arbitration Demo
 *
 * Orchestrates the narrowly scoped specialist agent team against the Agent Gateway REST API
 * (or seamlessly in-process when the live gateway is offline):
 *
 *   planner      (hotel_planner_key_001)     → reads kitchen stock, proves 403 on /v1/quotes
 *   sourcing     (hotel_sourcing_key_001)    → searches SKUs, locks 300 L firm quote, verifies Ed25519 claim, proves 403 on /v1/orders/intent
 *   procurement  (hotel_procurement_key_001) → reads mandate, creates intent, generates detached ECDSA P-256 signature, commits .vtr.json
 *   buyer        (hotel_buyer_key_001)       → hardware-grade ECDSA P-256 challenge/override counter-signer for out-of-mandate orders
 *   arbitrator   (/v1/receipts/arbitrate)    → deterministic <10 ms 3-way resolver across Supplier Breach, CFO Chargeback & Tamper Forgery
 *
 * Run:
 *   npx tsx apps/external-agent/src/bilateral-team-demo.ts
 *   GATEWAY_URL=http://localhost:8787 npx tsx apps/external-agent/src/bilateral-team-demo.ts --reset
 */

import {
  createHash,
  createPublicKey,
  generateKeyPairSync,
  randomUUID,
  sign,
  verify,
  type JsonWebKey,
} from "node:crypto";
import { copyFileSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  BuyerReceiptPayloadSchema,
  DetachedBuyerSignatureInputSchema,
  DisputeRulingSchema,
  TradeReceiptSchema,
  type BuyerReceiptPayload,
  type DetachedBuyerSignatureInput,
  type DisputePreset,
  type DisputeRuling,
  type Mandate,
  type Need,
  type SignedClaim,
  type SimulatedInvoiceDocument,
  type TradeReceipt,
} from "@tta/shared";

// ── Environment & Scoped Multi-Agent Credentials ─────────────────────────────

const GATEWAY_URL =
  process.env.GATEWAY_URL ??
  process.env.GATEWAY_PUBLIC_URL ??
  "http://localhost:8787";

const KEYS = {
  planner: process.env.DEMO_AGENT_KEY_PLANNER ?? "hotel_planner_key_001",
  sourcing: process.env.DEMO_AGENT_KEY_SOURCING ?? "hotel_sourcing_key_001",
  procurement:
    process.env.DEMO_AGENT_KEY_PROCUREMENT ?? "hotel_procurement_key_001",
  valio: process.env.DEMO_AGENT_KEY_VALIO ?? "valio_account_key_001",
  buyer: process.env.DEMO_BUYER_KEY_HOTEL ?? "hotel_buyer_key_001",
} as const;

type Who = keyof typeof KEYS;

// ── ANSI Styling Helpers (matches team-demo / executive CLI output) ──────────

const USE_COLOR = !("NO_COLOR" in process.env);
const c = {
  reset: USE_COLOR ? "\x1b[0m" : "",
  bold: USE_COLOR ? "\x1b[1m" : "",
  dim: USE_COLOR ? "\x1b[2m" : "",
  red: USE_COLOR ? "\x1b[31m" : "",
  green: USE_COLOR ? "\x1b[32m" : "",
  yellow: USE_COLOR ? "\x1b[33m" : "",
  blue: USE_COLOR ? "\x1b[34m" : "",
  magenta: USE_COLOR ? "\x1b[35m" : "",
  cyan: USE_COLOR ? "\x1b[36m" : "",
  white: USE_COLOR ? "\x1b[37m" : "",
  bgBlue: USE_COLOR ? "\x1b[44m\x1b[97m" : "",
  bgGreen: USE_COLOR ? "\x1b[42m\x1b[30m" : "",
  bgRed: USE_COLOR ? "\x1b[41m\x1b[97m" : "",
  bgYellow: USE_COLOR ? "\x1b[43m\x1b[30m" : "",
};

const ROLE_COLOR: Record<Who | "arbitrator", string> = {
  planner: c.cyan,
  sourcing: c.blue,
  procurement: c.magenta,
  valio: c.yellow,
  buyer: c.green,
  arbitrator: c.yellow,
};

const line = (s = "") => console.log(s);

function banner(title: string, subtitle?: string) {
  const rule = "━".repeat(92);
  line(`\n${c.bold}${c.cyan}${rule}${c.reset}`);
  line(`${c.bold}${c.white}  ${title}${c.reset}`);
  if (subtitle) line(`${c.dim}  ${subtitle}${c.reset}`);
  line(`${c.bold}${c.cyan}${rule}${c.reset}`);
}

function section(title: string) {
  line(`\n${c.bold}${c.blue}▸ ${title}${c.reset}`);
}

// ── Assertion Tracker ────────────────────────────────────────────────────────

let passedAssertions = 0;
let failedAssertions = 0;
const failureMessages: string[] = [];

function check(condition: boolean, label: string, detail?: string): void {
  if (condition) {
    passedAssertions++;
    line(
      `  ${c.green}✓${c.reset} ${label}${detail ? ` ${c.dim}(${detail})${c.reset}` : ""}`,
    );
  } else {
    failedAssertions++;
    const msg = `${label}${detail ? ` (${detail})` : ""}`;
    failureMessages.push(msg);
    line(`  ${c.red}✗ FAILED${c.reset} ${msg}`);
  }
}

function expectStatus(
  label: string,
  who: Who,
  r: { status: number; json?: any },
  want: number | number[],
): void {
  const allowed = Array.isArray(want) ? want : [want];
  const ok = allowed.includes(r.status);
  const tagColor = ROLE_COLOR[who] ?? c.white;
  const tag = `${tagColor}${who.padEnd(11)}${c.reset}`;
  const suffix =
    r.status === 403
      ? `${c.yellow} (refused by least-privilege scope, as designed)${c.reset}`
      : !ok
        ? ` ${c.red}${JSON.stringify(r.json ?? {}).slice(0, 140)}${c.reset}`
        : "";
  if (ok) {
    passedAssertions++;
    line(
      `  ${c.green}✓${c.reset} ${tag} ${label.padEnd(50)} → ${c.bold}${r.status}${c.reset}${suffix}`,
    );
  } else {
    failedAssertions++;
    const errText = `${who} ${label} expected ${allowed.join("|")}, got ${r.status}`;
    failureMessages.push(errText);
    line(
      `  ${c.red}✗ UNEXPECTED${c.reset} ${tag} ${label.padEnd(50)} → ${c.red}${r.status}${c.reset}${suffix}`,
    );
  }
}

// ── Canonical JSON, Hashing & Client-Side Cryptographic Primitives ───────────

function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

function sha256Hex(input: string | Buffer): string {
  return createHash("sha256").update(input).digest("hex");
}

function fromBase64Any(input: string): Buffer {
  const clean = String(input ?? "").trim().replace(/\s+/g, "");
  const norm = clean.replace(/-/g, "+").replace(/_/g, "/");
  const padded = norm + "=".repeat((4 - (norm.length % 4)) % 4);
  return Buffer.from(padded, "base64");
}

function encodeDerInt(buf: Buffer): Buffer {
  let i = 0;
  while (i < buf.length - 1 && buf[i] === 0) i++;
  let slice = buf.subarray(i);
  if ((slice[0] ?? 0) & 0x80) {
    slice = Buffer.concat([Buffer.from([0x00]), slice]);
  }
  return Buffer.concat([Buffer.from([0x02, slice.length]), slice]);
}

function p1363ToDer(sig: Buffer): Buffer {
  if (sig.length !== 64) return sig;
  const r = encodeDerInt(sig.subarray(0, 32));
  const s = encodeDerInt(sig.subarray(32, 64));
  const body = Buffer.concat([r, s]);
  return Buffer.concat([Buffer.from([0x30, body.length]), body]);
}

/** Recursive key-sorted JSON stripping `undefined` at every depth (matches gateway canonicalization). */
function canon(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canon);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, v]) => v !== undefined)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([k, v]) => [k, canon(v)]),
    );
  }
  return value;
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(canon(value));
}

function computeMandateHash(mandate: Mandate): string {
  return sha256Hex(canonicalJson(mandate));
}

function computeReceiptHashClient(receipt: Omit<TradeReceipt, "receiptHash">): string {
  return sha256Hex(
    canonicalJson({
      format: receipt.format,
      specVersion: receipt.specVersion,
      receiptId: receipt.receiptId,
      fileName: receipt.fileName,
      orderId: receipt.orderId,
      intentId: receipt.intentId,
      runId: receipt.runId,
      customerId: receipt.customerId,
      issuedAt: receipt.issuedAt,
      buyer: receipt.buyer,
      supplier: receipt.supplier,
      auditAnchor: receipt.auditAnchor,
    }),
  );
}

/** Verifies a v2 SignedClaim envelope offline against the gateway's Ed25519 JWKS key. */
function verifySignedClaimOffline(
  envelope: SignedClaim,
  jwk: { kty: string; crv: string; x: string; kid?: string },
  expectedQuoteId?: string,
): { valid: boolean; reason?: string } {
  try {
    if (jwk.kid && envelope.keyId !== jwk.kid) {
      return { valid: false, reason: "kid_mismatch" };
    }
    if (expectedQuoteId && envelope.subject?.quoteId !== expectedQuoteId) {
      return { valid: false, reason: "quote_subject_mismatch" };
    }
    const pubKey = createPublicKey({
      key: { kty: jwk.kty, crv: jwk.crv, x: jwk.x } as JsonWebKey,
      format: "jwk",
    });
    const canonical = canonicalJson({
      version: envelope.version,
      claimId: envelope.claimId,
      issuer: envelope.issuer,
      keyId: envelope.keyId,
      asOf: envelope.asOf,
      subject: envelope.subject,
      claim: envelope.claim,
    });
    const ok = verify(
      null,
      Buffer.from(canonical, "utf8"),
      pubKey,
      fromBase64Any(envelope.signature),
    );
    return ok ? { valid: true } : { valid: false, reason: "bad_ed25519_claim_sig" };
  } catch (err) {
    return {
      valid: false,
      reason: err instanceof Error ? err.message : "claim_verify_error",
    };
  }
}

/** Zero-trust offline verifier for portable `.vtr.json` Bilateral Liability Receipts using JWKS. */
function verifyTradeReceiptOfflineWithJwks(
  rawReceipt: unknown,
  jwksKeys: Array<{ kid?: string; kty: string; crv: string; x: string }>,
): {
  valid: boolean;
  receiptHashValid: boolean;
  buyerSignatureValid: boolean;
  supplierSignatureValid: boolean;
  bilateralBindingValid: boolean;
  humanOverridePresent: boolean;
  reason?: string;
} {
  const parsed = TradeReceiptSchema.safeParse(rawReceipt);
  if (!parsed.success) {
    return {
      valid: false,
      receiptHashValid: false,
      buyerSignatureValid: false,
      supplierSignatureValid: false,
      bilateralBindingValid: false,
      humanOverridePresent: false,
      reason: "invalid_vtr_schema",
    };
  }
  const r = parsed.data;
  const receiptHashValid = computeReceiptHashClient(r) === r.receiptHash;

  // 1. Verify Buyer signature (ECDSA-P256 or Ed25519)
  let buyerSignatureValid = false;
  try {
    const buyerPub = createPublicKey(r.buyer.publicKeyPem);
    const buyerBytes = Buffer.from(canonicalJson(r.buyer.payload), "utf8");
    const buyerSig = fromBase64Any(r.buyer.signature);
    if (r.buyer.algorithm === "ECDSA-P256") {
      const derSig = buyerSig.length === 64 ? p1363ToDer(buyerSig) : buyerSig;
      buyerSignatureValid = verify("sha256", buyerBytes, buyerPub, derSig);
    } else {
      buyerSignatureValid = verify(null, buyerBytes, buyerPub, buyerSig);
    }
  } catch {
    buyerSignatureValid = false;
  }

  // 2. Verify Supplier Ed25519 signature strictly against /.well-known/jwks.json
  let supplierSignatureValid = false;
  try {
    const jwk =
      jwksKeys.find((k) => k.kid === r.supplier.keyId) ?? jwksKeys[0];
    if (jwk) {
      const supplierPub = createPublicKey({
        key: { kty: jwk.kty, crv: jwk.crv, x: jwk.x } as JsonWebKey,
        format: "jwk",
      });
      const supBytes = Buffer.from(canonicalJson(r.supplier.payload), "utf8");
      const supSig = fromBase64Any(r.supplier.signature);
      supplierSignatureValid =
        supSig.length > 0 && verify(null, supBytes, supplierPub, supSig);
    }
  } catch {
    supplierSignatureValid = false;
  }

  // 3. Verify bilateral hash cross-binding (Supplier countersigned Buyer's exact signature)
  const expectedBuyerSigHash = sha256Hex(r.buyer.signature);
  const bilateralBindingValid =
    r.supplier.payload.buyerSignatureHash === expectedBuyerSigHash &&
    r.buyer.payload.intentId === r.intentId &&
    r.supplier.payload.intentId === r.intentId &&
    r.buyer.payload.quoteId === r.supplier.payload.quoteId &&
    r.supplier.payload.orderId === r.orderId;

  const humanOverridePresent = Boolean(
    buyerSignatureValid &&
      r.buyer.humanOverride?.credentialId &&
      r.buyer.humanOverride?.signaturePrefix &&
      r.buyer.humanOverride?.verifiedAt,
  );

  const valid =
    receiptHashValid &&
    buyerSignatureValid &&
    supplierSignatureValid &&
    bilateralBindingValid;

  let reason: string | undefined;
  if (!valid) {
    if (!buyerSignatureValid) reason = "buyer_signature_invalid";
    else if (!supplierSignatureValid) reason = "supplier_signature_invalid";
    else if (!bilateralBindingValid) reason = "bilateral_binding_mismatch";
    else if (!receiptHashValid) reason = "receipt_hash_mismatch";
  }

  return {
    valid,
    receiptHashValid,
    buyerSignatureValid,
    supplierSignatureValid,
    bilateralBindingValid,
    humanOverridePresent,
    reason,
  };
}

/** Generates an ephemeral ECDSA P-256 keypair and signs a BuyerReceiptPayload using IEEE-P1363 SHA-256. */
function signDetachedBuyerCommitP256(params: {
  intent: {
    id: string;
    customerId: string;
    snapshotHash: string;
    totalPrice: number;
    meta?: { quoteId?: string | null };
  };
  mandate: Mandate;
  authorityMode: BuyerReceiptPayload["authorityMode"];
  actingAgentId: string;
  keyId: string;
}): {
  mandateHash: string;
  payload: BuyerReceiptPayload;
  buyerSignature: DetachedBuyerSignatureInput;
} {
  const { publicKey, privateKey } = generateKeyPairSync("ec", {
    namedCurve: "prime256v1",
  });
  const publicKeyPem = publicKey
    .export({ type: "spki", format: "pem" })
    .toString();

  const mandateHash = computeMandateHash(params.mandate);
  const signedAt = new Date().toISOString();
  const authorizedMaxTotalEur = round2(params.intent.totalPrice);

  const payload: BuyerReceiptPayload = BuyerReceiptPayloadSchema.parse({
    customerId: params.intent.customerId,
    intentId: params.intent.id,
    mandateId: params.mandate.mandateId,
    mandateHash,
    quoteId: params.intent.meta?.quoteId ?? null,
    snapshotHash: params.intent.snapshotHash,
    authorizedMaxTotalEur,
    authorityMode: params.authorityMode,
    actingAgentId: params.actingAgentId,
    signedAt,
  });

  const canonical = canonicalJson(payload);
  const sigBuf = sign("sha256", Buffer.from(canonical, "utf8"), {
    key: privateKey,
    dsaEncoding: "ieee-p1363",
  });

  const buyerSignature: DetachedBuyerSignatureInput =
    DetachedBuyerSignatureInputSchema.parse({
      algorithm: "ECDSA-P256",
      keyId: params.keyId,
      publicKeyPem,
      signedAt,
      authorizedMaxTotalEur,
      actingAgentId: params.actingAgentId,
      signature: sigBuf.toString("base64url"),
    });

  return { mandateHash, payload, buyerSignature };
}

/** Signs a human mandate-override approval challenge with hardware-grade ECDSA P-256 (IEEE-P1363). */
function signHumanOverrideChallengeP256(params: {
  intentId: string;
  snapshotHash: string;
  challenge: string;
  credentialId: string;
  signerLabel: string;
}) {
  const { publicKey, privateKey } = generateKeyPairSync("ec", {
    namedCurve: "prime256v1",
  });
  const publicKeySpki = publicKey
    .export({ type: "spki", format: "pem" })
    .toString();
  const signedMessage = `VALIO_AIMO_HUMAN_OVERRIDE:${params.intentId}:${params.snapshotHash}:${params.challenge}`;
  const signature = sign("sha256", Buffer.from(signedMessage, "utf8"), {
    key: privateKey,
    dsaEncoding: "ieee-p1363",
  }).toString("base64url");

  return {
    mode: "webcrypto_p256" as const,
    credentialId: params.credentialId,
    publicKeySpki,
    signedMessage,
    signature,
    signerLabel: params.signerLabel,
  };
}

// ── Gateway Transport (Live HTTP Gateway OR Seamless In-Process Harness) ─────

type ApiResponse = { status: number; json: any };
type Transport = {
  mode: "live" | "in-process";
  label: string;
  request: (
    method: string,
    path: string,
    headers: Record<string, string>,
    body?: unknown,
  ) => Promise<ApiResponse>;
  cleanup: () => Promise<void>;
};

function nextMondayIso(): string {
  const d = new Date();
  const day = d.getDay();
  let delta = (1 - day + 7) % 7;
  if (delta === 0) delta = 7;
  d.setDate(d.getDate() + delta);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${dd}`;
}

async function parseFetchResponse(res: Response): Promise<ApiResponse> {
  const text = await res.text();
  let json: any;
  try {
    json = JSON.parse(text);
  } catch {
    json = { error: text };
  }
  return { status: res.status, json };
}

async function createInProcessTransport(): Promise<Transport> {
  process.env.PGLITE_DATA_DIR = "memory://";
  process.env.DATABASE_URL = "";

  const __dirname = dirname(fileURLToPath(import.meta.url));
  const repoRoot = resolve(__dirname, "../../..");
  const tempKeysDir = mkdtempSync(join(tmpdir(), "tta-bilateral-demo-keys-"));

  const origPriv = resolve(repoRoot, "keys/claim-ed25519-private.pem");
  const origPub = resolve(repoRoot, "keys/claim-ed25519-public.pem");
  if (existsSync(origPriv) && existsSync(origPub)) {
    copyFileSync(origPriv, join(tempKeysDir, "claim-ed25519-private.pem"));
    copyFileSync(origPub, join(tempKeysDir, "claim-ed25519-public.pem"));
  } else {
    const generated = generateKeyPairSync("ed25519");
    const { writeFileSync } = await import("node:fs");
    writeFileSync(
      join(tempKeysDir, "claim-ed25519-private.pem"),
      generated.privateKey.export({ type: "pkcs8", format: "pem" }),
    );
    writeFileSync(
      join(tempKeysDir, "claim-ed25519-public.pem"),
      generated.publicKey.export({ type: "spki", format: "pem" }),
    );
  }

  // Deterministic offline fallback if external Valio sandbox endpoint is unreachable
  const realFetch = globalThis.fetch;
  const promisedArrival = nextMondayIso();
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const urlStr =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;
    if (urlStr.includes("junction26.valioaimo.fi")) {
      try {
        return await realFetch(input, {
          ...init,
          signal: AbortSignal.timeout(1200),
        });
      } catch {
        const body = init?.body ? JSON.parse(String(init.body)) : {};
        const ids: string[] = Array.isArray(body.products) ? body.products : [];
        if (urlStr.endsWith("/api/price")) {
          // €14.80 per 10 L novobox = €1.48/L -> 300 L = €444.00; 3,000 L = €4,440.00
          const priceForSku = (id: string) =>
            id === "463038" || id === "464179"
              ? { unit: 14.8, perL: 1.48 }
              : id === "464768"
                ? { unit: 17.76, perL: 1.48 }
                : id === "469330"
                  ? { unit: 7.4, perL: 1.48 }
                  : { unit: 1.48, perL: 1.48 };
          return new Response(
            JSON.stringify({
              currency: "EUR",
              products: ids.map((id) => {
                const p = priceForSku(id);
                return {
                  productId: id,
                  catalogPrice: { value: p.unit, valueWithTax: round2(p.unit * 1.14) },
                  comparisonPrice: { value: p.perL },
                  comparisonUnit: "litre",
                };
              }),
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }
        if (urlStr.endsWith("/api/availability")) {
          return new Response(
            JSON.stringify({
              products: ids.map((id) => ({
                productId: id,
                salesBlock: false,
                logisticModel: "STOCK",
                scheduleLines: [
                  {
                    availableAmount: 5000,
                    availableDate: promisedArrival,
                    salesUnit: "pack",
                  },
                ],
              })),
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }
      }
    }
    return realFetch(input, init);
  }) as typeof fetch;

  const { config } = await import("../../gateway/src/config.js");
  config.keysDir = tempKeysDir;

  const chainMod = await import("../../gateway/src/audit/chain.js");
  await chainMod.initDb();

  const catalogMod = await import("../../gateway/src/catalog/index.js");
  catalogMod.loadCatalog();

  // First try the full Gateway Hono app if all async bilateral routes are already wired
  let fullAppReady = false;
  let honoApp: { request: (path: string, init?: RequestInit) => Promise<Response> } | null = null;
  try {
    const apiMod = await import("../../gateway/src/routes/api.js");
    const candidate = apiMod.createApi();
    const mandateProbe = await candidate.request("/v1/mandate", {
      headers: { "X-API-Key": KEYS.procurement },
    });
    const mandateJson: any = await mandateProbe.json().catch(() => ({}));
    const arbProbe = await candidate.request("/v1/receipts/arbitrate", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-API-Key": KEYS.buyer,
      },
      body: JSON.stringify({}),
    });
    if (
      mandateProbe.status === 200 &&
      typeof mandateJson?.mandateId === "string" &&
      arbProbe.status !== 404
    ) {
      honoApp = candidate;
      fullAppReady = true;
    }
  } catch {
    fullAppReady = false;
  }

  if (!fullAppReady || !honoApp) {
    // Mount an in-process Hono router backed directly by @tta/gateway's real auth, policy, quote, order & receipt engines
    const { Hono } = await import("hono");
    const { NeedSchema, SignedClaimSchema } = await import("@tta/shared");
    const customersMod = await import("../../gateway/src/auth/customers.js");
    const registryMod = await import("../../gateway/src/agents/registry.js");
    const contextMod = await import("../../gateway/src/agents/context.js");
    const kitchenMod = await import("../../gateway/src/hotel/kitchen.js");
    const offersMod = await import("../../gateway/src/catalog/offers.js");
    const signMod = await import("../../gateway/src/claims/sign.js");
    const quotesMod = await import("../../gateway/src/orders/quotes.js");
    const storeMod = await import("../../gateway/src/orders/store.js");
    const humanProofMod = await import("../../gateway/src/auth/humanProof.js");
    const receiptMod = await import("../../gateway/src/claims/receipt.js");

    type Vars = { auth: Awaited<ReturnType<typeof customersMod.authenticate>> & {} };
    const app = new Hono<{ Variables: Vars }>();
    const rawHumanSigs = new Map<string, Record<string, unknown>>();

    const BUYER_ONLY_PATTERNS: Array<[string, RegExp]> = [
      ["PUT", /^\/v1\/mandate$/],
      ["POST", /^\/v1\/orders\/[^/]+\/approve$/],
      ["POST", /^\/v1\/orders\/[^/]+\/approve-challenge$/],
      ["POST", /^\/v1\/orders\/[^/]+\/reject$/],
      ["POST", /^\/v1\/admin\//],
    ];

    app.get("/health", (ctx) =>
      ctx.json({ ok: true, service: "valio-aimo-agent-gateway" }),
    );

    app.get("/.well-known/jwks.json", (ctx) =>
      ctx.json({
        keys: [
          {
            ...signMod.getPublicJwk(),
            pem: signMod.getPublicKeyPem(),
            issuer: "valio-aimo-gateway",
          },
        ],
      }),
    );

    app.use("/v1/*", async (ctx, next) => {
      const apiKey = ctx.req.header("X-API-Key") ?? ctx.req.header("x-api-key");
      const auth = customersMod.authenticate(apiKey);
      if (!auth) return ctx.json({ error: "unauthorized" }, 401);

      const method = ctx.req.method;
      const path = ctx.req.path;

      // Allow any authenticated participant to call /v1/receipts/*
      const isReceiptEndpoint = /^\/v1\/receipts(\/|$)/.test(path);

      if (auth.role !== "buyer") {
        if (
          BUYER_ONLY_PATTERNS.some(
            ([m, re]) => m.split(" ").includes(method) && re.test(path),
          )
        ) {
          await chainMod.appendAudit("scope", auth.customerId, "agent_blocked", {
            agent: auth.agentId ?? auth.role,
            method,
            path,
            reason: "buyer_only",
          });
          return ctx.json(
            { error: "forbidden", message: "Requires a human buyer credential." },
            403,
          );
        }
        if (auth.agentId && !isReceiptEndpoint) {
          const checkScope = registryMod.agentAllows(
            auth.agentId as any,
            method,
            path,
          );
          if (!checkScope.allowed) {
            await chainMod.appendAudit("scope", auth.customerId, "agent_blocked", {
              agent: auth.agentId,
              method,
              path,
              needs: checkScope.needs ?? "buyer",
            });
            return ctx.json(
              {
                error: "forbidden_scope",
                agent: auth.agentId,
                needs: checkScope.needs ?? "buyer",
              },
              403,
            );
          }
        }
      }

      ctx.set("auth", auth);
      if (auth.agentId) {
        return await contextMod.withAgent(auth.agentId as any, () => next());
      }
      await next();
    });

    app.get("/v1/kitchen/inventory", async (ctx) => {
      const auth = ctx.get("auth");
      const inv = await kitchenMod.getInventory(auth.customerId);
      if (!inv) return ctx.json({ error: "no_kitchen_profile" }, 404);
      return ctx.json(inv);
    });

    app.get("/v1/mandate", async (ctx) => {
      const auth = ctx.get("auth");
      return ctx.json(await customersMod.getMandate(auth.customerId));
    });

    app.post("/v1/products/search", async (ctx) => {
      const body = await ctx.req.json();
      if (body.need) {
        const need = NeedSchema.parse(body.need);
        return ctx.json({
          products: catalogMod.searchFromNeed(need, body.limit ?? 20),
        });
      }
      return ctx.json({
        products: catalogMod.searchProducts({
          q: body.q,
          lactoseFree: body.lactoseFree,
          organic: body.organic,
          category: body.category,
          limit: body.limit ?? 20,
        }),
      });
    });

    app.post("/v1/offers/rank", async (ctx) => {
      const auth = ctx.get("auth");
      const body = await ctx.req.json();
      const mandate = await customersMod.getMandate(auth.customerId);
      const need = NeedSchema.parse(body.need);
      const offers = await contextMod.withAgent("sourcing", () =>
        offersMod.buildOffers(auth.customerId, need, {
          productIds: body.productIds,
          includeSubstitutions: body.includeSubstitutions ?? true,
          mandate: mandate ?? undefined,
        }),
      );
      return ctx.json({
        offers,
        explanation: offersMod.explainOffers(offers, need, mandate),
      });
    });

    app.post("/v1/claims/verify", async (ctx) => {
      const auth = ctx.get("auth");
      const body = await ctx.req.json();
      const envelope = SignedClaimSchema.parse(body.claim ?? body);
      if (envelope.claim.customerId !== auth.customerId) {
        return ctx.json({ valid: false, reason: "customer_mismatch" });
      }
      return ctx.json(
        signMod.verifyClaim(
          envelope,
          body.expect?.subject ? { subject: body.expect.subject } : undefined,
        ),
      );
    });

    app.post("/v1/quotes", async (ctx) => {
      const auth = ctx.get("auth");
      const body = await ctx.req.json();
      try {
        const need = NeedSchema.parse(body.need);
        const quote = await quotesMod.createQuote(auth.customerId, need, {
          productIds: Array.isArray(body.productIds)
            ? body.productIds
            : undefined,
          includeSubstitutions: body.includeSubstitutions,
          runId: body.runId,
        });
        return ctx.json(quote, 201);
      } catch (e) {
        return ctx.json(
          { error: e instanceof Error ? e.message : "quote_failed" },
          400,
        );
      }
    });

    app.post("/v1/orders/intent", async (ctx) => {
      const auth = ctx.get("auth");
      const body = await ctx.req.json();
      const mandate = await customersMod.getMandate(auth.customerId);
      if (!mandate) return ctx.json({ error: "no_mandate" }, 400);
      try {
        let rawNeed = body.need;
        if (body.quoteId && !body.need) {
          const q = await quotesMod.getQuote(
            String(body.quoteId),
            auth.customerId,
          );
          if (!q) {
            return ctx.json(
              { error: "quote_not_found: Quote does not exist" },
              400,
            );
          }
          rawNeed = q.need;
        }
        const need = NeedSchema.parse(rawNeed);
        const result = await storeMod.createOrderIntent({
          customerId: auth.customerId,
          mandate,
          need,
          runId: body.runId,
          offerProductId: body.offerProductId,
          includeSubstitutions: body.includeSubstitutions,
          quoteId: body.quoteId,
        });
        return ctx.json(result);
      } catch (e) {
        return ctx.json(
          { error: e instanceof Error ? e.message : "intent_failed" },
          400,
        );
      }
    });

    app.post("/v1/orders/:id/approve-challenge", async (ctx) => {
      const auth = ctx.get("auth");
      const intent = await storeMod.getIntent(
        ctx.req.param("id"),
        auth.customerId,
      );
      if (!intent) return ctx.json({ error: "not_found" }, 404);
      const challenge = humanProofMod.computeApprovalChallenge(intent);
      return ctx.json({
        challenge,
        rpId: "localhost",
        customerId: auth.customerId,
        payloadSummary: `${intent.id}:${intent.totalPrice}`,
      });
    });

    app.post("/v1/orders/:id/approve", async (ctx) => {
      const auth = ctx.get("auth");
      const body = await ctx.req.json();
      try {
        const id = ctx.req.param("id");
        const intent = await storeMod.approveOrder(
          id,
          auth.customerId,
          String(body.snapshotHash),
          {
            authorizeMandateOverride: Boolean(body.authorizeMandateOverride),
            acknowledgedRules: Array.isArray(body.acknowledgedRules)
              ? body.acknowledgedRules.map(String)
              : undefined,
            humanSignature: body.humanSignature,
            authorizedFallback: body.authorizedFallback,
          },
        );
        if (body.humanSignature && typeof body.humanSignature === "object") {
          rawHumanSigs.set(id, body.humanSignature as Record<string, unknown>);
        }
        return ctx.json(intent);
      } catch (e) {
        return ctx.json(
          { error: e instanceof Error ? e.message : "approve_failed" },
          400,
        );
      }
    });

    app.post("/v1/orders/:id/commit", async (ctx) => {
      const auth = ctx.get("auth");
      const body = await ctx.req.json();
      try {
        const detachedSigRaw =
          body.buyerSignature ?? body.detachedBuyerSignature;
        const detachedBuyerSignature = detachedSigRaw
          ? DetachedBuyerSignatureInputSchema.parse(detachedSigRaw)
          : undefined;

        const intent = await storeMod.commitOrder({
          intentId: ctx.req.param("id"),
          customerId: auth.customerId,
          idempotencyKey: String(body.idempotencyKey ?? randomUUID()),
        });

        const mandate = await customersMod.getMandate(auth.customerId);
        if (!mandate) throw new Error("mandate_missing");
        const auditVer = await chainMod.verifyAuditChain(
          intent.runId,
          auth.customerId,
        );
        const humanRaw = rawHumanSigs.get(intent.id);
        const receiptIntent = humanRaw
          ? {
              ...intent,
              meta: { ...(intent.meta ?? {}), humanSignatureRaw: humanRaw },
            }
          : intent;

        const receipt = receiptMod.issueTradeReceipt({
          orderId: intent.committedOrderId!,
          intent: receiptIntent,
          mandate,
          actingAgentId: auth.agentId ?? null,
          auditHeadHash: auditVer.headHash ?? null,
          detachedBuyerSignature,
        });
        await receiptMod.saveTradeReceipt(receipt);

        return ctx.json({
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
        });
      } catch (e) {
        return ctx.json(
          { error: e instanceof Error ? e.message : "commit_failed" },
          400,
        );
      }
    });

    app.get("/v1/receipts/:id", async (ctx) => {
      const auth = ctx.get("auth");
      const receipt = await receiptMod.getTradeReceipt(
        ctx.req.param("id"),
        auth.customerId,
      );
      if (!receipt) return ctx.json({ error: "receipt_not_found" }, 404);
      return ctx.json({ receipt });
    });

    app.post("/v1/receipts/arbitrate", async (ctx) => {
      const auth = ctx.get("auth");
      const body = await ctx.req.json();
      try {
        let receipt: TradeReceipt | null = body.receipt ?? null;
        if (!receipt && typeof body.receiptId === "string") {
          receipt = await receiptMod.getTradeReceipt(
            body.receiptId,
            auth.customerId,
          );
        }
        if (!receipt) {
          return ctx.json({ error: "receipt_required" }, 400);
        }
        const ruling = receiptMod.arbitrateTradeDispute({
          receipt,
          preset: body.preset as DisputePreset | undefined,
          document: body.document as SimulatedInvoiceDocument | undefined,
        });
        return ctx.json(ruling);
      } catch (e) {
        return ctx.json(
          { error: e instanceof Error ? e.message : "arbitrate_failed" },
          400,
        );
      }
    });

    app.get("/v1/audit/:runId", async (ctx) => {
      const auth = ctx.get("auth");
      const runId = ctx.req.param("runId");
      return ctx.json({
        events: await chainMod.getAuditTrail(runId, auth.customerId),
        verification: await chainMod.verifyAuditChain(runId, auth.customerId),
      });
    });

    honoApp = app;
  }

  return {
    mode: "in-process",
    label: fullAppReady
      ? "IN-PROCESS GATEWAY (Hono createApi + PGlite memory://)"
      : "IN-PROCESS GATEWAY (Direct @tta/gateway Engine + PGlite memory://)",
    request: async (method, path, headers, body) => {
      const res = await honoApp!.request(path, {
        method,
        headers,
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
      return parseFetchResponse(res);
    },
    cleanup: async () => {
      globalThis.fetch = realFetch;
      await chainMod.closeDb().catch(() => {});
      rmSync(tempKeysDir, { recursive: true, force: true });
    },
  };
}

async function resolveTransport(): Promise<Transport> {
  if (!process.argv.includes("--in-process")) {
    try {
      const health = await fetch(`${GATEWAY_URL}/health`, {
        signal: AbortSignal.timeout(1500),
      });
      if (health.ok) {
        // Verify the running gateway includes the bilateral receipt arbitrator route
        const probe = await fetch(`${GATEWAY_URL}/v1/receipts/arbitrate`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-API-Key": KEYS.buyer,
          },
          body: JSON.stringify({}),
          signal: AbortSignal.timeout(1500),
        });
        if (probe.status !== 404) {
          return {
            mode: "live",
            label: `LIVE GATEWAY (${GATEWAY_URL})`,
            request: async (method, path, headers, body) => {
              const res = await fetch(`${GATEWAY_URL}${path}`, {
                method,
                headers,
                body: body !== undefined ? JSON.stringify(body) : undefined,
              });
              return parseFetchResponse(res);
            },
            cleanup: async () => {},
          };
        }
      }
    } catch {
      // Fall through cleanly to in-process gateway
    }
  }
  return createInProcessTransport();
}

function unwrapReceipt(commitJson: any): TradeReceipt | null {
  const candidate =
    commitJson?.receipt ??
    commitJson?.tradeReceipt ??
    commitJson?.confirmation?.receipt ??
    null;
  const parsed = TradeReceiptSchema.safeParse(candidate);
  return parsed.success ? parsed.data : null;
}

function unwrapRuling(arbJson: any): DisputeRuling {
  const raw =
    arbJson &&
    typeof arbJson === "object" &&
    typeof arbJson.ruling === "object" &&
    arbJson.ruling !== null
      ? arbJson.ruling
      : arbJson;
  return DisputeRulingSchema.parse(raw);
}

// ── Main Multi-Agent Orchestration ───────────────────────────────────────────

type ScenarioSummaryRow = {
  scenario: string;
  receiptId: string;
  signatures: string;
  ruling: string;
  latencyMs: number;
  autoCreditEur: number;
  netPayableEur: number;
};

async function main() {
  const transport = await resolveTransport();
  const summaryRows: ScenarioSummaryRow[] = [];

  const call = (who: Who, method: string, path: string, body?: unknown) =>
    transport.request(
      method,
      path,
      {
        "Content-Type": "application/json",
        "X-API-Key": KEYS[who],
      },
      body,
    );

  const callPublic = (path: string) =>
    transport.request("GET", path, { Accept: "application/json" });

  try {
    banner(
      "VALIO AIMO · MULTI-AGENT BILATERAL SIGNING & 3-WAY DISPUTE ARBITRATION",
      `Transport: ${transport.label} · Customer: HOTEL-001 · Zero-Dispute .vtr.json Protocol`,
    );

    if (transport.mode === "live" && process.argv.includes("--reset")) {
      const resetRes = await transport.request(
        "POST",
        "/v1/admin/demo-reset",
        {
          "Content-Type": "application/json",
          "X-API-Key": KEYS.buyer,
          "X-Demo-Reset": "confirm",
          "X-Reset-Source": "bilateral-team-demo --reset",
        },
      );
      line(`${c.dim}  Demo state wiped (--reset → ${resetRes.status})${c.reset}`);
    }

    const neededBy = nextMondayIso();

    // Fetch public JWKS up-front for offline Ed25519 claim & .vtr.json verification
    const jwksRes = await callPublic("/.well-known/jwks.json");
    check(
      jwksRes.status === 200 && Array.isArray(jwksRes.json?.keys) && jwksRes.json.keys.length > 0,
      "Fetched Supplier Ed25519 public key from GET /.well-known/jwks.json",
      `kid=${jwksRes.json?.keys?.[0]?.kid ?? "n/a"}, crv=${jwksRes.json?.keys?.[0]?.crv ?? "n/a"}`,
    );
    const jwksKeys = jwksRes.json.keys as Array<{
      kid?: string;
      kty: string;
      crv: string;
      x: string;
    }>;

    // ═══════════════════════════════════════════════════════════════════════════
    // SCENARIO 1 — 300 L Firm Quote -> Detached P-256 Commit -> +€0.12/L Hike
    // ═══════════════════════════════════════════════════════════════════════════
    banner(
      "SCENARIO 1 · Multi-Agent Firm Quote → Detached P-256 Commit → Supplier Price Hike (+€0.12/L)",
      "planner → sourcing → procurement → (buyer if cap exceeded) → 3-Way Arbitrator (€36.00 Auto-Credit on 300 L)",
    );

    const need300: Need = {
      productIntent: "lactose-free milk",
      quantity: 300,
      unit: "litre",
      neededBy,
      constraints: {
        lactoseFree: true,
        keywords: ["lactose-free", "milk"],
      },
    };

    section("1.1 Planner Agent (hotel_planner_key_001) inspects kitchen stock & hits spend firewall");
    const invRes = await call("planner", "GET", "/v1/kitchen/inventory");
    expectStatus("GET /v1/kitchen/inventory", "planner", invRes, 200);
    const milkStock = (invRes.json?.inventory ?? []).find((item: any) =>
      /milk/i.test(String(item.name ?? item.ingredientId ?? "")),
    );
    if (milkStock) {
      line(
        `     ${c.dim}Kitchen telemetry: ${milkStock.name} — ${milkStock.onHand} ${milkStock.unit} on hand vs ${milkStock.parLevel} ${milkStock.unit} par (${milkStock.status})${c.reset}`,
      );
    }
    const plannerQuoteAttempt = await call("planner", "POST", "/v1/quotes", {
      need: need300,
    });
    expectStatus(
      "POST /v1/quotes (blocked: planner cannot spend)",
      "planner",
      plannerQuoteAttempt,
      403,
    );

    section("1.2 Sourcing Agent (hotel_sourcing_key_001) searches catalog, locks 300 L firm quote & verifies Ed25519 claim");
    const searchRes = await call("sourcing", "POST", "/v1/products/search", {
      need: need300,
      limit: 10,
    });
    expectStatus("POST /v1/products/search (lactose-free milk)", "sourcing", searchRes, 200);
    check(
      Array.isArray(searchRes.json?.products) && searchRes.json.products.length > 0,
      "Catalog shortlist returned lactose-free milk SKUs",
      `${searchRes.json?.products?.length ?? 0} candidates`,
    );

    const rankRes = await call("sourcing", "POST", "/v1/offers/rank", {
      need: need300,
    });
    expectStatus("POST /v1/offers/rank (300 L pack math)", "sourcing", rankRes, 200);
    const rankedOffers: any[] = rankRes.json?.offers ?? [];
    const exact300Offer =
      rankedOffers.find(
        (o) =>
          o.canFulfil &&
          Math.abs(Number(o.totalQuantity) - 300) < 1e-6 &&
          /valio/i.test(String(o.productName ?? "")),
      ) ??
      rankedOffers.find(
        (o) => o.canFulfil && Math.abs(Number(o.totalQuantity) - 300) < 1e-6,
      ) ??
      rankedOffers.find((o) => o.canFulfil) ??
      rankedOffers[0];

    const chosenSkuId: string | undefined =
      exact300Offer?.productId ?? searchRes.json?.products?.[0]?.productId;

    const quoteRes = await call("sourcing", "POST", "/v1/quotes", {
      need: need300,
      productIds: chosenSkuId ? [chosenSkuId] : undefined,
    });
    expectStatus("POST /v1/quotes (lock 300 L firm-price quote)", "sourcing", quoteRes, [200, 201]);

    const quote1 = quoteRes.json;
    const quote1Line = quote1?.lines?.[0];
    line(
      `     ${c.dim}Locked Quote ${c.reset}${c.bold}${quote1.quoteId}${c.reset}${c.dim}: ${quote1Line?.packs}× ${quote1Line?.productName} (${quote1Line?.totalQuantity} ${quote1Line?.quantityUnit}) · Firm €${Number(quote1.totalPrice).toFixed(2)} until ${quote1.validUntil}${c.reset}`,
    );
    check(
      Number(quote1Line?.totalQuantity) === 300,
      "Firm quote locked exact 300 L quantity",
      `${quote1Line?.packs} packs × ${quote1Line?.packSize} ${quote1Line?.packUnit} = ${quote1Line?.totalQuantity} L`,
    );

    const quoteClaim: SignedClaim | undefined = quote1?.claims?.[0];
    const gwClaimVerify = await call("sourcing", "POST", "/v1/claims/verify", {
      claim: quoteClaim,
      expect: { subject: { quoteId: quote1.quoteId } },
    });
    expectStatus("POST /v1/claims/verify (Ed25519 quote claim)", "sourcing", gwClaimVerify, 200);
    check(
      gwClaimVerify.json?.valid === true,
      "Gateway verified Ed25519 quote claim bound to subject.quoteId",
      `claimId=${quoteClaim?.claimId?.slice(0, 12)}…`,
    );

    const offlineClaimVerify = quoteClaim
      ? verifySignedClaimOffline(quoteClaim, jwksKeys[0]!, quote1.quoteId)
      : { valid: false, reason: "missing_claim" };
    check(
      offlineClaimVerify.valid === true,
      "Offline JWKS Ed25519 verification passed on quote price/availability claim",
      `issuer=${quoteClaim?.issuer}`,
    );

    const sourcingIntentAttempt = await call(
      "sourcing",
      "POST",
      "/v1/orders/intent",
      { quoteId: quote1.quoteId },
    );
    expectStatus(
      "POST /v1/orders/intent (blocked: sourcing cannot order)",
      "sourcing",
      sourcingIntentAttempt,
      403,
    );

    section("1.3 Procurement Agent (hotel_procurement_key_001) binds Mandate + Quote into Order Intent");
    const mandateRes = await call("procurement", "GET", "/v1/mandate");
    expectStatus("GET /v1/mandate", "procurement", mandateRes, 200);
    const mandate: Mandate = mandateRes.json;
    const mandateHash = computeMandateHash(mandate);
    check(
      Boolean(mandate?.mandateId) && mandateHash.length === 64,
      "Computed canonical SHA-256 mandateHash",
      `${mandate.mandateId} → ${mandateHash.slice(0, 16)}…`,
    );

    const intent1Res = await call("procurement", "POST", "/v1/orders/intent", {
      quoteId: quote1.quoteId,
    });
    expectStatus(
      "POST /v1/orders/intent (consume firm quoteId)",
      "procurement",
      intent1Res,
      200,
    );
    let intent1 = intent1Res.json.intent;
    line(
      `     ${c.dim}Intent ${c.reset}${c.bold}${intent1.id}${c.reset}${c.dim} · status=${intent1.status} · €${Number(intent1.totalPrice).toFixed(2)} · snapshotHash=${intent1.snapshotHash.slice(0, 16)}…${c.reset}`,
    );

    // Procurement can NEVER approve an order itself (even if pending_approval or auto_eligible)
    const procApproveAttempt1 = await call(
      "procurement",
      "POST",
      `/v1/orders/${intent1.id}/approve`,
      { snapshotHash: intent1.snapshotHash },
    );
    expectStatus(
      "POST /v1/orders/:id/approve (blocked: procurement cannot self-approve)",
      "procurement",
      procApproveAttempt1,
      403,
    );

    let scenario1HumanOverride = false;
    if (intent1.status === "pending_approval") {
      line(
        `     ${c.yellow}↳ 300 L order triggered Mandate Gate (${(intent1.policy?.failingRules ?? []).join(", ")}) — escalating to human buyer ECDSA P-256 counter-signature${c.reset}`,
      );
      const ch1Res = await call(
        "buyer",
        "POST",
        `/v1/orders/${intent1.id}/approve-challenge`,
        {},
      );
      expectStatus(
        "POST /v1/orders/:id/approve-challenge",
        "buyer",
        ch1Res,
        200,
      );
      const humanSig1 = signHumanOverrideChallengeP256({
        intentId: intent1.id,
        snapshotHash: intent1.snapshotHash,
        challenge: ch1Res.json.challenge,
        credentialId: "hotel-buyer-p256-ephemeral-s1",
        signerLabel: "Hotel F&B Buyer Key (ECDSA P-256)",
      });
      const app1Res = await call(
        "buyer",
        "POST",
        `/v1/orders/${intent1.id}/approve`,
        {
          snapshotHash: intent1.snapshotHash,
          authorizeMandateOverride: true,
          acknowledgedRules: intent1.policy?.failingRules ?? [],
          humanSignature: humanSig1,
        },
      );
      expectStatus(
        "POST /v1/orders/:id/approve (ECDSA P-256 counter-signed)",
        "buyer",
        app1Res,
        200,
      );
      intent1 = app1Res.json;
      scenario1HumanOverride = true;
    }

    section("1.4 Detached Client-Side ECDSA P-256 Buyer Signing & Bilateral .vtr.json Commit");
    const signed1 = signDetachedBuyerCommitP256({
      intent: {
        id: intent1.id,
        customerId: intent1.customerId,
        snapshotHash: intent1.snapshotHash,
        totalPrice: intent1.totalPrice,
        meta: { quoteId: quote1.quoteId },
      },
      mandate,
      authorityMode: scenario1HumanOverride
        ? "human_override_p256"
        : "external_agent_signed",
      actingAgentId: "procurement",
      keyId: "procurement-agent-p256-s1",
    });
    line(
      `     ${c.dim}Generated asymmetric ECDSA P-256 keypair (prime256v1) · IEEE-P1363 sig=${signed1.buyerSignature.signature.slice(0, 24)}…${c.reset}`,
    );

    const commit1Res = await call(
      "procurement",
      "POST",
      `/v1/orders/${intent1.id}/commit`,
      {
        idempotencyKey: `bilateral-s1-${intent1.id}`,
        buyerSignature: signed1.buyerSignature,
      },
    );
    expectStatus(
      "POST /v1/orders/:id/commit (with detached buyerSignature)",
      "procurement",
      commit1Res,
      200,
    );

    let receipt1 = unwrapReceipt(commit1Res.json);
    if (!receipt1 && commit1Res.json?.confirmation?.orderId) {
      const fetchReceipt = await call(
        "procurement",
        "GET",
        `/v1/receipts/${commit1Res.json.confirmation.orderId}`,
      );
      receipt1 = unwrapReceipt(fetchReceipt.json);
    }
    check(
      receipt1 !== null,
      "Received portable dual-signed .vtr.json TradeReceipt from commit",
      receipt1 ? `${receipt1.receiptId} (${receipt1.fileName})` : "missing",
    );
    if (!receipt1) {
      throw new Error("Scenario 1 cannot proceed without TradeReceipt (.vtr.json)");
    }

    check(
      receipt1.buyer.algorithm === "ECDSA-P256" &&
        receipt1.buyer.keyId === "procurement-agent-p256-s1",
      "TradeReceipt preserves client-generated detached ECDSA P-256 buyer envelope",
      `authorityMode=${receipt1.buyer.payload.authorityMode}`,
    );

    const offlineVer1 = verifyTradeReceiptOfflineWithJwks(receipt1, jwksKeys);
    check(
      offlineVer1.valid,
      "Offline .vtr.json verification passed against GET /.well-known/jwks.json Ed25519 key",
      `buyerP256=${offlineVer1.buyerSignatureValid}, supplierEd25519=${offlineVer1.supplierSignatureValid}, binding=${offlineVer1.bilateralBindingValid}`,
    );

    section("1.5 3-Way Invoice Arbitrator — Supplier +€0.12/L Price Hike (preset: 'price_hike_012')");
    const arb1Res = await call("buyer", "POST", "/v1/receipts/arbitrate", {
      receipt: receipt1,
      preset: "price_hike_012",
    });
    expectStatus(
      "POST /v1/receipts/arbitrate (preset: price_hike_012)",
      "buyer",
      arb1Res,
      200,
    );
    const ruling1 = unwrapRuling(arb1Res.json);

    check(
      ruling1.ruling === "SUPPLIER_BREACH",
      "Arbitrator ruled SUPPLIER_BREACH on +€0.12/L invoice overcharge",
      ruling1.subVerdict,
    );
    check(
      ruling1.latencyMs < 10,
      "Deterministic 3-way arbitration completed in <10 ms",
      `${ruling1.latencyMs.toFixed(3)} ms`,
    );
    check(
      Math.abs(ruling1.reconciliation.autoCreditEur - 36) < 0.005,
      "Issued exact €36.00 Auto-Credit on 300 L milk (+€0.12/L × 300 L)",
      `Auto-Credit €${ruling1.reconciliation.autoCreditEur.toFixed(2)}`,
    );
    line(
      `     ${c.bgGreen}${c.bold} RULING ${c.reset} ${c.bold}${c.green}${ruling1.headline}${c.reset}`,
    );
    line(
      `     ${c.dim}Contracted: €${ruling1.reconciliation.contractedTotalEur.toFixed(2)} · Billed: €${ruling1.reconciliation.billedTotalEur.toFixed(2)} · ${c.reset}${c.bold}${c.green}Auto-Credit €${ruling1.reconciliation.autoCreditEur.toFixed(2)}${c.reset}${c.dim} · Net Payable: €${ruling1.reconciliation.netPayableEur.toFixed(2)} (${ruling1.latencyMs.toFixed(3)} ms)${c.reset}`,
    );

    summaryRows.push({
      scenario: "1. Supplier +€0.12/L Price Hike (300 L)",
      receiptId: receipt1.receiptId,
      signatures: "P-256 + Ed25519",
      ruling: `${ruling1.ruling} (Auto-Credit €${ruling1.reconciliation.autoCreditEur.toFixed(2)})`,
      latencyMs: ruling1.latencyMs,
      autoCreditEur: ruling1.reconciliation.autoCreditEur,
      netPayableEur: ruling1.reconciliation.netPayableEur,
    });

    // ═══════════════════════════════════════════════════════════════════════════
    // SCENARIO 2 — 3,000 L Hallucination Chargeback Defense
    // ═══════════════════════════════════════════════════════════════════════════
    banner(
      'SCENARIO 2 · Hallucination Chargeback Defense ("Our rogue agent hallucinated 3,000 L of milk!")',
      "procurement (3,000 L) → Mandate Gate → buyer P-256 Override → Detached Commit → Chargeback Denied",
    );

    const need3000: Need = {
      productIntent: "lactose-free milk",
      quantity: 3000,
      unit: "litre",
      neededBy,
      constraints: {
        lactoseFree: true,
        keywords: ["lactose-free", "milk"],
      },
    };

    section("2.1 Procurement Agent proposes massive 3,000 L milk order → caught by Mandate Gate");
    const intent2Res = await call("procurement", "POST", "/v1/orders/intent", {
      need: need3000,
      ...(chosenSkuId ? { offerProductId: chosenSkuId } : {}),
    });
    expectStatus(
      "POST /v1/orders/intent (3,000 L milk)",
      "procurement",
      intent2Res,
      200,
    );
    const intent2 = intent2Res.json.intent;
    const failing2: string[] = intent2.policy?.failingRules ?? [];
    check(
      intent2.status === "pending_approval" && failing2.length > 0,
      "Mandate Gate intercepted 3,000 L order as pending_approval",
      `total=€${Number(intent2.totalPrice).toFixed(2)}, failingRules=[${failing2.join(", ")}]`,
    );

    const prematureCommit = await call(
      "procurement",
      "POST",
      `/v1/orders/${intent2.id}/commit`,
      { idempotencyKey: `premature-${intent2.id}` },
    );
    expectStatus(
      "POST /v1/orders/:id/commit (blocked until human approves)",
      "procurement",
      prematureCommit,
      400,
    );

    const procApproveAttempt2 = await call(
      "procurement",
      "POST",
      `/v1/orders/${intent2.id}/approve`,
      { snapshotHash: intent2.snapshotHash },
    );
    expectStatus(
      "POST /v1/orders/:id/approve (blocked: agent cannot self-approve)",
      "procurement",
      procApproveAttempt2,
      403,
    );

    section("2.2 Human Buyer (hotel_buyer_key_001) counter-signs override challenge with ECDSA P-256");
    const ch2Res = await call(
      "buyer",
      "POST",
      `/v1/orders/${intent2.id}/approve-challenge`,
      {},
    );
    expectStatus("POST /v1/orders/:id/approve-challenge", "buyer", ch2Res, 200);
    check(
      typeof ch2Res.json?.challenge === "string" && ch2Res.json.challenge.length > 16,
      "Issued deterministic SHA-256 approval challenge bound to snapshotHash & failingRules",
      `challenge=${String(ch2Res.json?.challenge ?? "").slice(0, 20)}…`,
    );

    const humanSig2 = signHumanOverrideChallengeP256({
      intentId: intent2.id,
      snapshotHash: intent2.snapshotHash,
      challenge: ch2Res.json.challenge,
      credentialId: "hotel-cfo-yubikey-p256-01",
      signerLabel: "Hotel Executive Passkey (ECDSA P-256)",
    });

    const approve2Res = await call(
      "buyer",
      "POST",
      `/v1/orders/${intent2.id}/approve`,
      {
        snapshotHash: intent2.snapshotHash,
        authorizeMandateOverride: true,
        acknowledgedRules: failing2,
        humanSignature: humanSig2,
      },
    );
    expectStatus(
      "POST /v1/orders/:id/approve (hardware-grade ECDSA P-256 override)",
      "buyer",
      approve2Res,
      200,
    );
    check(
      approve2Res.json?.status === "approved",
      "Order intent transitioned to approved with verified P-256 human signature proof",
      `acknowledged=[${failing2.join(", ")}]`,
    );

    section("2.3 Procurement Agent commits with detached ECDSA P-256 signature → dual-signed .vtr.json");
    const signed2 = signDetachedBuyerCommitP256({
      intent: {
        id: intent2.id,
        customerId: intent2.customerId,
        snapshotHash: intent2.snapshotHash,
        totalPrice: intent2.totalPrice,
        meta: { quoteId: intent2.meta?.quoteId ?? null },
      },
      mandate,
      authorityMode: "human_override_p256",
      actingAgentId: "procurement",
      keyId: "procurement-agent-p256-s2",
    });

    const commit2Res = await call(
      "procurement",
      "POST",
      `/v1/orders/${intent2.id}/commit`,
      {
        idempotencyKey: `bilateral-s2-${intent2.id}`,
        buyerSignature: signed2.buyerSignature,
      },
    );
    expectStatus(
      "POST /v1/orders/:id/commit (3,000 L dual-signed commit)",
      "procurement",
      commit2Res,
      200,
    );

    let receipt2 = unwrapReceipt(commit2Res.json);
    if (!receipt2 && commit2Res.json?.confirmation?.orderId) {
      const fetchReceipt2 = await call(
        "procurement",
        "GET",
        `/v1/receipts/${commit2Res.json.confirmation.orderId}`,
      );
      receipt2 = unwrapReceipt(fetchReceipt2.json);
    }
    check(
      receipt2 !== null,
      "Issued dual-signed .vtr.json carrying Mandate + Human P-256 Override + Supplier Commitment",
      receipt2 ? `${receipt2.receiptId} (${receipt2.fileName})` : "missing",
    );
    if (!receipt2) {
      throw new Error("Scenario 2 cannot proceed without TradeReceipt (.vtr.json)");
    }

    const offlineVer2 = verifyTradeReceiptOfflineWithJwks(receipt2, jwksKeys);
    check(
      offlineVer2.valid && offlineVer2.humanOverridePresent,
      "Offline JWKS verification confirmed Buyer P-256 + Human Override + Valio Ed25519",
      `credentialId=${receipt2.buyer.humanOverride?.credentialId}`,
    );

    section("2.4 3-Way Arbitrator — CFO 'Rogue Agent Hallucination' Chargeback (preset: 'rogue_agent_chargeback')");
    const arb2Res = await call("buyer", "POST", "/v1/receipts/arbitrate", {
      receipt: receipt2,
      preset: "rogue_agent_chargeback",
    });
    expectStatus(
      "POST /v1/receipts/arbitrate (preset: rogue_agent_chargeback)",
      "buyer",
      arb2Res,
      200,
    );
    const ruling2 = unwrapRuling(arb2Res.json);

    check(
      ruling2.ruling === "BUYER_LIABLE" &&
        ruling2.headline.startsWith(
          "BUYER_LIABLE → Valid Mandate + Counter-Signed Intent",
        ),
      "Arbitrator ruled BUYER_LIABLE → Valid Mandate + Counter-Signed Intent",
      ruling2.subVerdict,
    );
    check(
      ruling2.latencyMs < 10,
      "Chargeback defense cryptographically resolved in <10 ms",
      `${ruling2.latencyMs.toFixed(3)} ms`,
    );
    check(
      ruling2.reconciliation.autoCreditEur === 0 &&
        Math.abs(
          ruling2.reconciliation.netPayableEur -
            ruling2.reconciliation.billedTotalEur,
        ) < 0.005,
      "Zero auto-credit issued (autoCreditEur === 0) — full 3,000 L invoice payable",
      `Net Payable €${ruling2.reconciliation.netPayableEur.toFixed(2)}`,
    );
    check(
      ruling2.cryptographicProof.buyerSignatureValid &&
        ruling2.cryptographicProof.humanOverrideVerified &&
        ruling2.cryptographicProof.supplierSignatureValid,
      "Cryptographic proof confirmed Mandate + P-256 Human Counter-Signature + Valio Delivery Commitment",
      `mandateHash=${ruling2.cryptographicProof.mandateHash.slice(0, 12)}…`,
    );
    line(
      `     ${c.bgBlue}${c.bold} RULING ${c.reset} ${c.bold}${c.cyan}${ruling2.headline}${c.reset}`,
    );
    line(
      `     ${c.dim}Claim: "${ruling2.simulatedDocument.buyerDisputeNote}"${c.reset}`,
    );
    line(
      `     ${c.dim}Auto-Credit: €${ruling2.reconciliation.autoCreditEur.toFixed(2)} · ${c.reset}${c.bold}${c.cyan}Full Invoice Payable: €${ruling2.reconciliation.netPayableEur.toFixed(2)}${c.reset}${c.dim} (${ruling2.latencyMs.toFixed(3)} ms)${c.reset}`,
    );

    summaryRows.push({
      scenario: "2. Rogue-Agent 3,000 L Chargeback",
      receiptId: receipt2.receiptId,
      signatures: "P-256 + Override + Ed25519",
      ruling: "BUYER_LIABLE (Chargeback Refused)",
      latencyMs: ruling2.latencyMs,
      autoCreditEur: ruling2.reconciliation.autoCreditEur,
      netPayableEur: ruling2.reconciliation.netPayableEur,
    });

    // ═══════════════════════════════════════════════════════════════════════════
    // SCENARIO 3 — Offline 1-Cent Forgery Attempt (preset: "tampered_receipt")
    // ═══════════════════════════════════════════════════════════════════════════
    banner(
      'SCENARIO 3 · Offline Forgery Attempt (preset: "tampered_receipt" & +€0.01 Mutation)',
      "Mutates .vtr.json honouredPrice.totalEur by €0.01 without private key → Arbitrator rejects in <10 ms",
    );

    section("3.1 Attacker mutates .vtr.json honouredPrice.totalEur by 1 cent without private key");
    const oneCentMutated: TradeReceipt = structuredClone(receipt1);
    const originalTotalEur = oneCentMutated.supplier.payload.honouredPrice.totalEur;
    oneCentMutated.supplier.payload.honouredPrice.totalEur = round2(
      originalTotalEur + 0.01,
    );

    const localTamperCheck = verifyTradeReceiptOfflineWithJwks(
      oneCentMutated,
      jwksKeys,
    );
    check(
      localTamperCheck.valid === false &&
        localTamperCheck.supplierSignatureValid === false &&
        localTamperCheck.receiptHashValid === false,
      "Offline JWKS verifier caught 1-cent mutation (€" +
        originalTotalEur.toFixed(2) +
        " → €" +
        oneCentMutated.supplier.payload.honouredPrice.totalEur.toFixed(2) +
        ")",
      `reason=${localTamperCheck.reason}`,
    );

    // Direct 1-cent forged receipt submission + preset: "tampered_receipt" submission
    const arb3OneCentRes = await call("buyer", "POST", "/v1/receipts/arbitrate", {
      receipt: oneCentMutated,
      document: {
        documentId: `INV-${oneCentMutated.orderId}-FORGED-1C`,
        documentType: "e_invoice",
        deliveredAt: oneCentMutated.supplier.payload.deliveryCommitment.promisedDate,
        buyerDisputeClaim: "price_overcharge",
        buyerDisputeNote: "honouredPrice.totalEur altered offline by +€0.01 without signing key.",
        billedTotalEur: oneCentMutated.supplier.payload.honouredPrice.totalEur,
        currency: "EUR",
        lines: oneCentMutated.supplier.payload.honouredPrice.lines.map((l) => ({
          productId: l.productId,
          productName: l.productName,
          billedPacks: l.packs,
          deliveredPacks: l.packs,
          billedQuantity: l.totalQuantity,
          deliveredQuantity: l.totalQuantity,
          billedUnitPriceEur: l.unitPriceEur,
          billedLineTotalEur: l.lineTotalEur,
        })),
      },
    });
    expectStatus(
      "POST /v1/receipts/arbitrate (1-cent mutated .vtr.json)",
      "buyer",
      arb3OneCentRes,
      200,
    );
    const ruling3OneCent = unwrapRuling(arb3OneCentRes.json);
    check(
      ruling3OneCent.ruling === "TAMPER_REJECTED" && ruling3OneCent.latencyMs < 10,
      "Arbitrator rejected 1-cent forged .vtr.json as TAMPER_REJECTED in <10 ms",
      `${ruling3OneCent.latencyMs.toFixed(3)} ms`,
    );

    const arb3PresetRes = await call("buyer", "POST", "/v1/receipts/arbitrate", {
      receipt: oneCentMutated,
      preset: "tampered_receipt",
    });
    expectStatus(
      "POST /v1/receipts/arbitrate (preset: tampered_receipt)",
      "buyer",
      arb3PresetRes,
      200,
    );
    const ruling3 = unwrapRuling(arb3PresetRes.json);
    check(
      ruling3.ruling === "TAMPER_REJECTED" &&
        ruling3.subVerdict === "CRYPTO_SIGNATURE_INVALID",
      "Arbitrator rejected preset 'tampered_receipt' as TAMPER_REJECTED (CRYPTO_SIGNATURE_INVALID)",
      `netPayableEur=€${ruling3.reconciliation.netPayableEur.toFixed(2)}`,
    );
    check(
      ruling3.latencyMs < 10,
      "Tamper rejection completed in <10 ms",
      `${ruling3.latencyMs.toFixed(3)} ms`,
    );
    line(
      `     ${c.bgRed}${c.bold} RULING ${c.reset} ${c.bold}${c.red}${ruling3.headline}${c.reset}`,
    );
    line(
      `     ${c.dim}Settlement blocked automatically · Net Payable: €${ruling3.reconciliation.netPayableEur.toFixed(2)} (${ruling3.latencyMs.toFixed(3)} ms)${c.reset}`,
    );

    summaryRows.push({
      scenario: "3. Offline 1c Forgery (tampered_receipt)",
      receiptId: receipt1.receiptId,
      signatures: "FORGED (Invalid Ed25519)",
      ruling: "TAMPER_REJECTED (Settlement Blocked)",
      latencyMs: ruling3.latencyMs,
      autoCreditEur: ruling3.reconciliation.autoCreditEur,
      netPayableEur: ruling3.reconciliation.netPayableEur,
    });

    // ═══════════════════════════════════════════════════════════════════════════
    // EXECUTIVE MULTI-AGENT & 3-WAY ARBITRATION SUMMARY TABLE
    // ═══════════════════════════════════════════════════════════════════════════
    banner(
      "EXECUTIVE SUMMARY · MULTI-AGENT LEAST-PRIVILEGE & BILATERAL ARBITRATION MATRIX",
      `Gateway Mode: ${transport.label}`,
    );

    line(`${c.bold}  Agent Scope & Zero-Trust Authority Boundaries:${c.reset}`);
    line(
      `  ┌──────────────┬─────────────────────────────┬───────────────────────────────────────────┬────────────────────┐`,
    );
    line(
      `  │ Agent        │ Credential                  │ Verified Authorized Action                │ Proven 403 / Gate  │`,
    );
    line(
      `  ├──────────────┼─────────────────────────────┼───────────────────────────────────────────┼────────────────────┤`,
    );
    line(
      `  │ planner      │ ${KEYS.planner.padEnd(27)} │ GET /v1/kitchen/inventory (200)           │ POST /v1/quotes    │`,
    );
    line(
      `  │ sourcing     │ ${KEYS.sourcing.padEnd(27)} │ Search + 300 L Firm Quote + Ed25519 Check │ POST /orders/intent│`,
    );
    line(
      `  │ procurement  │ ${KEYS.procurement.padEnd(27)} │ Intent + Detached P-256 Sign + Commit     │ POST /:id/approve  │`,
    );
    line(
      `  │ buyer (CFO)  │ ${KEYS.buyer.padEnd(27)} │ Hardware-Grade P-256 Challenge & Override │ Mandate Gate Owner │`,
    );
    line(
      `  └──────────────┴─────────────────────────────┴───────────────────────────────────────────┴────────────────────┘`,
    );

    line(`\n${c.bold}  Bilateral .vtr.json & <10 ms 3-Way Dispute Arbitration Verdicts:${c.reset}`);
    line(
      `  ┌────────────────────────────────────────────┬──────────────────┬───────────┬───────────────────────────────────────┬─────────────┬──────────────┐`,
    );
    line(
      `  │ Scenario                                   │ Receipt ID       │ Latency   │ Verdict                               │ Auto-Credit │ Net Payable  │`,
    );
    line(
      `  ├────────────────────────────────────────────┼──────────────────┼───────────┼───────────────────────────────────────┼─────────────┼──────────────┤`,
    );
    for (const row of summaryRows) {
      const lat = `${row.latencyMs.toFixed(2)} ms`.padStart(9);
      const cred = `€${row.autoCreditEur.toFixed(2)}`.padStart(11);
      const net = `€${row.netPayableEur.toFixed(2)}`.padStart(12);
      line(
        `  │ ${row.scenario.padEnd(42)} │ ${row.receiptId.padEnd(16)} │ ${lat} │ ${row.ruling.padEnd(37)} │ ${cred} │ ${net} │`,
      );
    }
    line(
      `  └────────────────────────────────────────────┴──────────────────┴───────────┴───────────────────────────────────────┴─────────────┴──────────────┘`,
    );

    if (failedAssertions > 0) {
      line(
        `\n${c.bgRed}${c.bold} FAILED ${c.reset} ${c.red}${failedAssertions} assertion(s) failed (${passedAssertions} passed):${c.reset}`,
      );
      for (const f of failureMessages) line(`  - ${f}`);
      await transport.cleanup();
      process.exit(1);
    }

    line(
      `\n${c.bgGreen}${c.bold} ALL ${passedAssertions} CRYPTOGRAPHIC & MULTI-AGENT ASSERTIONS PASSED ${c.reset} ${c.green}Zero-Dispute Bilateral Protocol verified end-to-end.${c.reset}\n`,
    );
  } finally {
    await transport.cleanup();
  }
}

main()
  .then(() => {
    process.exit(0);
  })
  .catch((err) => {
    console.error(`\n${c.red}Fatal orchestration error:${c.reset}`, err);
    process.exit(1);
  });
