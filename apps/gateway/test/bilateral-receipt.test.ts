process.env.PGLITE_DATA_DIR = "memory://";
process.env.DATABASE_URL = "";

import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { copyFileSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, before, test } from "node:test";
import type { BasketLine, Mandate, Need } from "@tta/shared";

let receiptMod: typeof import("../src/claims/receipt.js");
let humanProofMod: typeof import("../src/auth/humanProof.js");
let signMod: typeof import("../src/claims/sign.js");
let chainMod: typeof import("../src/audit/chain.js");
let tempKeysDir = "";
let originalKeysDir = "";

before(async () => {
  const { config } = await import("../src/config.js");
  originalKeysDir = config.keysDir;
  tempKeysDir = mkdtempSync(join(tmpdir(), "tta-vtr-keys-"));
  copyFileSync(
    resolve(originalKeysDir, "claim-ed25519-private.pem"),
    join(tempKeysDir, "claim-ed25519-private.pem"),
  );
  copyFileSync(
    resolve(originalKeysDir, "claim-ed25519-public.pem"),
    join(tempKeysDir, "claim-ed25519-public.pem"),
  );
  config.keysDir = tempKeysDir;

  receiptMod = await import("../src/claims/receipt.js");
  humanProofMod = await import("../src/auth/humanProof.js");
  signMod = await import("../src/claims/sign.js");
  chainMod = await import("../src/audit/chain.js");
  await chainMod.initDb();
});

after(async () => {
  await chainMod.closeDb();
  if (tempKeysDir) {
    rmSync(tempKeysDir, { recursive: true, force: true });
  }
});

function makeMandate(overrides?: Partial<Mandate>): Mandate {
  return {
    mandateId: "MND-HOTEL-2026",
    customerId: "HOTEL-001",
    allowedCategories: ["dairy", "milk"],
    maxOrderValueEur: 600,
    maxQuantity: { unit: "litre", value: 500 },
    allowedBrands: ["*"],
    allowedSubstitutions: false,
    allergenRestrictions: ["must_be_lactose_free", "nuts", "gluten"],
    autoPurchaseIf: {
      deliveryOnOrBeforeNeededBy: true,
      withinMaxOrderValue: true,
      reliabilityUnknownOk: false,
    },
    requireApprovalFor: [
      "over_spend",
      "unknown_reliability",
      "price_change_on_revalidate",
      "late_delivery",
      "substitution",
      "partial_fulfil",
    ],
    expiresAt: "2099-12-31T23:59:59.000Z",
    ...overrides,
  };
}

function makeMilkBasketLine(litres: number, unitPriceEur = 1.48): BasketLine {
  const totalPrice = Math.round(litres * unitPriceEur * 100) / 100;
  return {
    productId: "VALIO-LF-MILK-1L",
    productName: "Valio Eila Laktoositon Kevytmaitojuoma 1L",
    packs: litres,
    packSize: 1,
    packUnit: "litre",
    totalQuantity: litres,
    quantityUnit: "litre",
    unitPrice: unitPriceEur,
    totalPrice,
    comparisonPrice: unitPriceEur,
    comparisonUnit: "litre",
    availableQuantity: 5000,
    availableDate: "2026-11-16",
    deliveryReliability: 0.99,
    claimIds: ["CLM-001"],
    isSubstitution: false,
    labels: ["lactose-free", "finnish"],
    allergens: ["milk"],
    mayContain: [],
    certifications: ["Heart Symbol", "Hyvää Suomesta"],
    origin: "Finland",
    producer: "Valio Oy",
  };
}

function makeMilkNeed(litres: number): Need {
  return {
    productIntent: "lactose-free milk",
    quantity: litres,
    unit: "litre",
    neededBy: "2026-11-16",
    constraints: {
      lactoseFree: true,
      excludeAllergens: ["nuts", "gluten"],
    },
  };
}

test("canonicalReceiptJson strips undefined recursively and sorts keys deterministically", () => {
  const a = {
    z: 1,
    a: { d: "ok", b: undefined, c: [3, { y: 2, x: 1, skip: undefined }] },
    omit: undefined,
  };
  const b = {
    a: { c: [3, { x: 1, y: 2 }], d: "ok" },
    z: 1,
  };
  assert.equal(receiptMod.canonicalReceiptJson(a), receiptMod.canonicalReceiptJson(b));

  const m1 = makeMandate();
  const m2 = { ...m1, maxDailySpendEur: undefined };
  assert.equal(receiptMod.computeMandateHash(m1), receiptMod.computeMandateHash(m2));
});

test("1. Dual-signed .vtr.json emission & offline verification for Ed25519 autonomous agent and ECDSA P-256 detached buyer signature + human override", () => {
  const mandate = makeMandate();
  const line = makeMilkBasketLine(200, 1.48); // €296.00 (within €600 mandate)
  const need = makeMilkNeed(200);
  const snap = signMod.snapshotHash([line]);

  // (A) Autonomous Ed25519 buyer agent receipt
  const autonomousReceipt = receiptMod.issueTradeReceipt({
    orderId: "ORD-AUTO-101",
    intent: {
      id: "INT-AUTO-101",
      customerId: "HOTEL-001",
      runId: "RUN-AUTO-101",
      need,
      basket: [line],
      snapshotHash: snap,
      totalPrice: line.totalPrice,
      neededBy: need.neededBy,
      policy: { decision: "auto_commit", reasons: [], failingRules: [] },
      meta: { quoteId: "QUO-A101", quoteValidUntil: "2026-11-15T12:00:00.000Z" },
    },
    mandate,
    actingAgentId: "procurement",
    auditHeadHash: "abc123def456",
  });

  assert.equal(autonomousReceipt.receiptId, "VTR-AUTO-101");
  assert.equal(autonomousReceipt.fileName, "ord-auto-101.vtr.json");
  assert.equal(autonomousReceipt.buyer.algorithm, "Ed25519");
  assert.equal(autonomousReceipt.buyer.keyId, "buyer-agent-ed25519-01");
  assert.equal(autonomousReceipt.buyer.payload.authorityMode, "agent_autonomous");
  assert.equal(autonomousReceipt.supplier.algorithm, "Ed25519");
  assert.equal(autonomousReceipt.supplier.payload.honouredPrice.priceBasis, "firm_quote");
  assert.ok(existsSync(join(tempKeysDir, "buyer-agent-ed25519-private.pem")));
  assert.ok(existsSync(join(tempKeysDir, "buyer-agent-ed25519-public.pem")));

  const autoVerify = receiptMod.verifyTradeReceipt(autonomousReceipt);
  assert.equal(autoVerify.valid, true);
  assert.equal(autoVerify.receiptHashValid, true);
  assert.equal(autoVerify.buyerSignatureValid, true);
  assert.equal(autoVerify.supplierSignatureValid, true);
  assert.equal(autoVerify.bilateralBindingValid, true);
  assert.equal(autoVerify.humanOverrideVerified, false);

  // (B) External ECDSA P-256 detached buyer signature + cryptographic human override proof
  const p256 = generateKeyPairSync("ec", {
    namedCurve: "prime256v1",
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });

  const bigLine = makeMilkBasketLine(800, 1.48); // €1,184.00 > €600 mandate
  const bigNeed = makeMilkNeed(800);
  const bigSnap = signMod.snapshotHash([bigLine]);
  const policy = {
    decision: "pending_approval" as const,
    reasons: ["Exceeds mandate max order value and quantity"],
    failingRules: ["over_spend", "over_quantity"],
  };

  const challenge = humanProofMod.computeApprovalChallenge({
    id: "INT-P256-202",
    snapshotHash: bigSnap,
    policy,
  });
  const signedMessage = `APPROVE_INTENT:INT-P256-202:${challenge}`;
  const humanRawSig = sign("sha256", Buffer.from(signedMessage, "utf8"), {
    key: p256.privateKey,
    dsaEncoding: "ieee-p1363",
  }).toString("base64url");

  const humanSignatureRaw = {
    mode: "webcrypto_p256",
    credentialId: "cfo-yubikey-p256-01",
    publicKeySpki: p256.publicKey,
    signedMessage,
    signature: humanRawSig,
    signerLabel: "CFO Hardware Key (ECDSA P-256)",
  };
  const humanProof = humanProofMod.verifyHumanSignature(
    { id: "INT-P256-202", snapshotHash: bigSnap, policy },
    humanSignatureRaw,
  );

  const intentForP256 = {
    id: "INT-P256-202",
    customerId: "HOTEL-001",
    runId: "RUN-P256-202",
    need: bigNeed,
    basket: [bigLine],
    snapshotHash: bigSnap,
    totalPrice: bigLine.totalPrice,
    neededBy: bigNeed.neededBy,
    policy,
    meta: {
      quoteId: "QUO-P202",
      quoteValidUntil: "2026-11-15T12:00:00.000Z",
      humanSignatureProof: humanProof,
      humanSignatureRaw,
    },
  };

  const buyerPayload = receiptMod.buildBuyerReceiptPayload({
    intent: intentForP256,
    mandate,
    actingAgentId: "cfo-approver",
    signedAt: "2026-11-15T01:55:00.000Z",
    hasDetachedSignature: true,
  });
  const detachedBuyerSignature = receiptMod.createDetachedBuyerSignature(buyerPayload, {
    algorithm: "ECDSA-P256",
    keyId: "cfo-yubikey-p256-01",
    privateKeyPem: p256.privateKey,
    publicKeyPem: p256.publicKey,
  });

  const p256Receipt = receiptMod.issueTradeReceipt({
    orderId: "ORD-P256-202",
    intent: intentForP256,
    mandate,
    actingAgentId: "cfo-approver",
    auditHeadHash: "feedface999",
    detachedBuyerSignature,
  });

  assert.equal(p256Receipt.buyer.algorithm, "ECDSA-P256");
  assert.equal(p256Receipt.buyer.payload.authorityMode, "human_override_p256");
  assert.ok(p256Receipt.buyer.humanOverride);
  assert.deepEqual(p256Receipt.buyer.humanOverride.acknowledgedRules, [
    "over_spend",
    "over_quantity",
  ]);
  assert.equal(p256Receipt.buyer.humanOverride.signature, humanRawSig);

  const p256Verify = receiptMod.verifyTradeReceipt(p256Receipt);
  assert.equal(p256Verify.valid, true);
  assert.equal(p256Verify.buyerSignatureValid, true);
  assert.equal(p256Verify.supplierSignatureValid, true);
  assert.equal(p256Verify.bilateralBindingValid, true);
  assert.equal(p256Verify.humanOverrideVerified, true);
});

test("2. Forged or mismatched detached buyer signature on commit is cryptographically rejected", () => {
  const mandate = makeMandate();
  const line = makeMilkBasketLine(100, 1.48);
  const need = makeMilkNeed(100);
  const snap = signMod.snapshotHash([line]);

  const intent = {
    id: "INT-FORGE-01",
    customerId: "HOTEL-001",
    runId: "RUN-FORGE-01",
    need,
    basket: [line],
    snapshotHash: snap,
    totalPrice: line.totalPrice,
    neededBy: need.neededBy,
    meta: { quoteId: "QUO-F01" },
  };

  const p256Good = generateKeyPairSync("ec", {
    namedCurve: "prime256v1",
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });
  const p256Wrong = generateKeyPairSync("ec", {
    namedCurve: "prime256v1",
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });

  const payload = receiptMod.buildBuyerReceiptPayload({
    intent,
    mandate,
    hasDetachedSignature: true,
  });

  // Signed by wrong private key while claiming p256Good public key
  const wrongKeyDetached = receiptMod.createDetachedBuyerSignature(payload, {
    algorithm: "ECDSA-P256",
    keyId: "attacker-key",
    privateKeyPem: p256Wrong.privateKey,
    publicKeyPem: p256Good.publicKey,
  });

  assert.throws(
    () =>
      receiptMod.issueTradeReceipt({
        orderId: "ORD-FORGE-01",
        intent,
        mandate,
        detachedBuyerSignature: wrongKeyDetached,
      }),
    /invalid_buyer_signature/,
  );

  // Valid signature over a DIFFERENT snapshotHash must also fail when intent basket changed
  const validDetached = receiptMod.createDetachedBuyerSignature(payload, {
    algorithm: "ECDSA-P256",
    keyId: "buyer-p256",
    privateKeyPem: p256Good.privateKey,
    publicKeyPem: p256Good.publicKey,
  });

  assert.throws(
    () =>
      receiptMod.issueTradeReceipt({
        orderId: "ORD-FORGE-02",
        intent: { ...intent, snapshotHash: "tampered_snapshot_hash_000" },
        mandate,
        detachedBuyerSignature: validDetached,
      }),
    /invalid_buyer_signature/,
  );
});

test("3. 300 L milk order under Quote #QUO-Q91 at €1.48/L (€444.00) vs €1.60/L (+€0.12/L = €480.00) rules SUPPLIER_BREACH with Auto-Credit €36.00 in <10 ms", () => {
  const mandate = makeMandate();
  const line = makeMilkBasketLine(300, 1.48); // 300 * 1.48 = €444.00
  assert.equal(line.totalPrice, 444);

  const need = makeMilkNeed(300);
  const receipt = receiptMod.issueTradeReceipt({
    orderId: "ORD-Q91-300L",
    intent: {
      id: "INT-Q91-300L",
      customerId: "HOTEL-001",
      runId: "RUN-Q91-300L",
      need,
      basket: [line],
      snapshotHash: signMod.snapshotHash([line]),
      totalPrice: 444,
      neededBy: "2026-11-16",
      policy: { decision: "auto_commit", reasons: [], failingRules: [] },
      meta: {
        quoteId: "QUO-Q91",
        quoteValidUntil: "2026-11-15T18:00:00.000Z",
      },
    },
    mandate,
    actingAgentId: "procurement",
  });

  const ruling = receiptMod.arbitrateTradeDispute({
    receipt,
    preset: "price_hike_012",
  });

  assert.ok(ruling.latencyMs < 10, `Expected <10 ms ruling latency, got ${ruling.latencyMs} ms`);
  assert.equal(ruling.ruling, "SUPPLIER_BREACH");
  assert.equal(ruling.subVerdict, "AUTO_CREDIT_ISSUED");
  assert.equal(ruling.reconciliation.contractedTotalEur, 444);
  assert.equal(ruling.reconciliation.billedTotalEur, 480);
  assert.equal(ruling.reconciliation.autoCreditEur, 36);
  assert.equal(ruling.reconciliation.netPayableEur, 444);
  assert.ok(
    ruling.headline.includes("Auto-Credit €36.00"),
    `Expected headline to include "Auto-Credit €36.00", got: ${ruling.headline}`,
  );
  assert.ok(
    ruling.headline.includes("Quote #QUO-Q91 firm price violated"),
    `Expected headline to include "Quote #QUO-Q91 firm price violated", got: ${ruling.headline}`,
  );
  assert.equal(ruling.breaches.length, 1);
  assert.equal(ruling.breaches[0]?.code, "FIRM_PRICE_VIOLATED");
  assert.equal(ruling.breaches[0]?.creditImpactEur, 36);
});

test("4. 3,000 L milk order with P-256 human override + buyer signature vs CFO 'rogue agent hallucination' chargeback rules BUYER_LIABLE in <10 ms", () => {
  const mandate = makeMandate();
  const line = makeMilkBasketLine(3000, 1.48); // 3,000 L * €1.48 = €4,440.00
  assert.equal(line.totalPrice, 4440);

  const need = makeMilkNeed(3000);
  const snap = signMod.snapshotHash([line]);
  const policy = {
    decision: "pending_approval" as const,
    reasons: ["Total €4440.00 exceeds €600 mandate cap; 3000 L exceeds 500 L cap"],
    failingRules: ["over_spend", "over_quantity"],
  };

  const buyerEcKey = generateKeyPairSync("ec", {
    namedCurve: "prime256v1",
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });

  const challenge = humanProofMod.computeApprovalChallenge({
    id: "INT-3000L-OVR",
    snapshotHash: snap,
    policy,
  });
  const signedMessage = `HOTEL-001:APPROVE_OVERRIDE:${challenge}`;
  const overrideSig = sign("sha256", Buffer.from(signedMessage, "utf8"), {
    key: buyerEcKey.privateKey,
    dsaEncoding: "ieee-p1363",
  }).toString("base64url");

  const humanSignatureRaw = {
    mode: "webcrypto_p256",
    credentialId: "hotel-exec-p256-key",
    publicKeySpki: buyerEcKey.publicKey,
    signedMessage,
    signature: overrideSig,
    signerLabel: "Hotel F&B Director Passkey",
  };
  const humanSignatureProof = humanProofMod.verifyHumanSignature(
    { id: "INT-3000L-OVR", snapshotHash: snap, policy },
    humanSignatureRaw,
  );

  const intent = {
    id: "INT-3000L-OVR",
    customerId: "HOTEL-001",
    runId: "RUN-3000L-OVR",
    need,
    basket: [line],
    snapshotHash: snap,
    totalPrice: 4440,
    neededBy: "2026-11-16",
    policy,
    meta: {
      quoteId: "QUO-BIG-3000",
      quoteValidUntil: "2026-11-15T20:00:00.000Z",
      humanSignatureProof,
      humanSignatureRaw,
    },
  };

  const buyerPayload = receiptMod.buildBuyerReceiptPayload({
    intent,
    mandate,
    actingAgentId: "procurement",
    hasDetachedSignature: true,
  });
  const detachedBuyerSignature = receiptMod.createDetachedBuyerSignature(buyerPayload, {
    algorithm: "ECDSA-P256",
    keyId: "hotel-exec-p256-key",
    privateKeyPem: buyerEcKey.privateKey,
    publicKeyPem: buyerEcKey.publicKey,
  });

  const receipt = receiptMod.issueTradeReceipt({
    orderId: "ORD-3000L-OVR",
    intent,
    mandate,
    actingAgentId: "procurement",
    detachedBuyerSignature,
  });

  // Warm up OpenSSL ECDSA-P256 verification path once before strict <10 ms latency assertion
  receiptMod.verifyTradeReceipt(receipt);

  const ruling = receiptMod.arbitrateTradeDispute({
    receipt,
    preset: "rogue_agent_chargeback",
  });

  assert.ok(ruling.latencyMs < 10, `Expected <10 ms ruling latency, got ${ruling.latencyMs} ms`);
  assert.equal(ruling.ruling, "BUYER_LIABLE");
  assert.equal(ruling.subVerdict, "CHARGEBACK_DENIED_BUYER_LIABLE");
  assert.equal(ruling.reconciliation.contractedTotalEur, 4440);
  assert.equal(ruling.reconciliation.autoCreditEur, 0);
  assert.equal(ruling.reconciliation.netPayableEur, ruling.reconciliation.contractedTotalEur);
  assert.equal(ruling.cryptographicProof.humanOverrideVerified, true);
  assert.equal(
    ruling.headline,
    "BUYER_LIABLE → Valid Mandate + Counter-Signed Intent (Chargeback Refused)",
  );
});

test("5. Late delivery (+2 days), allergen breach, clean 3-way match, tampered .vtr.json, and PGlite round-trip", async () => {
  const mandate = makeMandate();
  const line = makeMilkBasketLine(200, 1.5); // €300.00
  const need = makeMilkNeed(200);

  const receipt = receiptMod.issueTradeReceipt({
    orderId: "ORD-MULTI-500",
    intent: {
      id: "INT-MULTI-500",
      customerId: "HOTEL-001",
      runId: "RUN-MULTI-500",
      need,
      basket: [line],
      snapshotHash: signMod.snapshotHash([line]),
      totalPrice: 300,
      neededBy: "2026-11-16",
      meta: { quoteId: "QUO-M500" },
    },
    mandate,
  });

  // Late delivery (+2 days -> 15% SLA credit = €45.00)
  const lateRuling = receiptMod.arbitrateTradeDispute({
    receipt,
    preset: "late_delivery",
  });
  assert.ok(lateRuling.latencyMs < 10);
  assert.equal(lateRuling.ruling, "SUPPLIER_BREACH");
  assert.equal(lateRuling.subVerdict, "AUTO_CREDIT_ISSUED");
  assert.equal(lateRuling.simulatedDocument.deliveredAt, "2026-11-18");
  assert.equal(lateRuling.reconciliation.autoCreditEur, 45);
  assert.equal(lateRuling.reconciliation.netPayableEur, 255);
  assert.equal(lateRuling.breaches[0]?.code, "DELIVERY_SLA_VIOLATED");

  // Allergen & lactose-free breach -> 100% credit of affected line (€300.00)
  const allergenRuling = receiptMod.arbitrateTradeDispute({
    receipt,
    preset: "allergen_breach",
  });
  assert.ok(allergenRuling.latencyMs < 10);
  assert.equal(allergenRuling.ruling, "SUPPLIER_BREACH");
  assert.equal(allergenRuling.subVerdict, "AUTO_CREDIT_ISSUED");
  assert.equal(allergenRuling.reconciliation.autoCreditEur, 300);
  assert.equal(allergenRuling.reconciliation.netPayableEur, 0);
  assert.equal(allergenRuling.breaches[0]?.code, "ALLERGEN_ATTESTATION_VIOLATED");

  // Tampered .vtr.json -> TAMPER_REJECTED, netPayableEur = 0, original receipt unmutated
  const tamperedRuling = receiptMod.arbitrateTradeDispute({
    receipt,
    preset: "tampered_receipt",
  });
  assert.ok(tamperedRuling.latencyMs < 10);
  assert.equal(tamperedRuling.ruling, "TAMPER_REJECTED");
  assert.equal(tamperedRuling.subVerdict, "CRYPTO_SIGNATURE_INVALID");
  assert.equal(tamperedRuling.cryptographicProof.supplierSignatureValid, false);
  assert.equal(tamperedRuling.cryptographicProof.receiptHashValid, false);
  assert.equal(tamperedRuling.reconciliation.netPayableEur, 0);
  assert.equal(receipt.supplier.payload.honouredPrice.totalEur, 300);

  // Clean 3-way match -> BUYER_LIABLE / CLEAN_3WAY_SETTLEMENT
  const cleanRuling = receiptMod.arbitrateTradeDispute({
    receipt,
    preset: "clean_3way_match",
  });
  assert.ok(cleanRuling.latencyMs < 10);
  assert.equal(cleanRuling.ruling, "BUYER_LIABLE");
  assert.equal(cleanRuling.subVerdict, "CLEAN_3WAY_SETTLEMENT");
  assert.equal(cleanRuling.reconciliation.autoCreditEur, 0);
  assert.equal(cleanRuling.reconciliation.netPayableEur, 300);

  // PGlite persistence round-trip
  await receiptMod.ensureTradeReceiptsTable();
  await receiptMod.saveTradeReceipt(receipt);

  const byReceiptId = await receiptMod.getTradeReceipt(receipt.receiptId, "HOTEL-001");
  assert.deepEqual(byReceiptId, receipt);
  assert.equal(receiptMod.verifyTradeReceipt(byReceiptId!).valid, true);

  const byOrderId = await receiptMod.getTradeReceipt(receipt.orderId, "HOTEL-001");
  assert.deepEqual(byOrderId, receipt);

  const wrongTenant = await receiptMod.getTradeReceipt(receipt.receiptId, "SCHOOL-001");
  assert.equal(wrongTenant, null);

  const listed = await receiptMod.listTradeReceipts("HOTEL-001");
  assert.equal(listed.length, 1);
  assert.equal(listed[0]?.receiptId, receipt.receiptId);
});

test("6. HTTP API end-to-end: quote -> intent -> detached P-256 commit -> .vtr.json download -> 3-way arbitration -> Security Arena", async () => {
  const realFetch = globalThis.fetch;
  const tomorrowIso = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
  const { getProduct } = await import("../src/catalog/index.js");

  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    const body = JSON.parse(String(init?.body ?? "{}"));
    const ids: string[] = Array.isArray(body.products) ? body.products : [];
    const json = u.endsWith("/api/price")
      ? {
          currency: "EUR",
          products: ids.map((id) => {
            const packSize = Math.max(1, getProduct(id)?.packSize ?? 1);
            return {
              productId: id,
              catalogPrice: { value: Math.round(packSize * 1.48 * 100) / 100 },
            };
          }),
        }
      : {
          products: ids.map((id) => ({
            productId: id,
            salesBlock: false,
            scheduleLines: [
              { availableAmount: 5000, availableDate: tomorrowIso, salesUnit: "pack" },
            ],
          })),
        };
    return new Response(JSON.stringify(json), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;

  try {
    const { createApi } = await import("../src/routes/api.js");
    const app = createApi();
    const buyerHeaders = {
      "content-type": "application/json",
      "x-api-key": "hotel_buyer_key_001",
      host: "localhost:8787",
    };

    // 1. JWKS exposes both Valio supplier key and buyer autonomous key
    const jwksRes = await app.request("/.well-known/jwks.json");
    assert.equal(jwksRes.status, 200);
    const jwksBody = (await jwksRes.json()) as { keys: Array<{ role?: string }> };
    assert.ok(jwksBody.keys.length >= 2);

    // 2. Lock a firm quote via POST /v1/quotes
    const need: Need = {
      productIntent: "lactose-free milk",
      quantity: 10,
      unit: "litre",
      neededBy: tomorrowIso,
      constraints: { lactoseFree: true },
    };

    const quoteRes = await app.request("/v1/quotes", {
      method: "POST",
      headers: buyerHeaders,
      body: JSON.stringify({ need }),
    });
    assert.equal(quoteRes.status, 201);
    const quoteBody = (await quoteRes.json()) as { quoteId: string };
    assert.match(quoteBody.quoteId, /^QUO-/);

    // 3. Create intent bound to the firm quote
    const intentRes = await app.request("/v1/orders/intent", {
      method: "POST",
      headers: buyerHeaders,
      body: JSON.stringify({
        quoteId: quoteBody.quoteId,
      }),
    });
    assert.equal(intentRes.status, 200);
    const intentWrap = (await intentRes.json()) as {
      intent: {
        id: string;
        customerId: string;
        runId: string;
        need: Need;
        basket: BasketLine[];
        snapshotHash: string;
        totalPrice: number;
        neededBy: string;
        meta?: { quoteId?: string };
      };
    };
    const intentBody = intentWrap.intent;

    // 4. Sign detached ECDSA-P256 buyer envelope and commit via HTTP (procurement agent)
    const { getMandate } = await import("../src/auth/customers.js");
    const mandate = (await getMandate("HOTEL-001"))!;
    const ecKey = generateKeyPairSync("ec", {
      namedCurve: "prime256v1",
      publicKeyEncoding: { type: "spki", format: "pem" },
      privateKeyEncoding: { type: "pkcs8", format: "pem" },
    });
    const buyerPayload = receiptMod.buildBuyerReceiptPayload({
      intent: intentBody,
      mandate,
      actingAgentId: "procurement",
      hasDetachedSignature: true,
    });
    const detachedSig = receiptMod.createDetachedBuyerSignature(buyerPayload, {
      algorithm: "ECDSA-P256",
      keyId: "http-buyer-ecdsa-01",
      privateKeyPem: ecKey.privateKey,
      publicKeyPem: ecKey.publicKey,
    });

    const commitRes = await app.request(`/v1/orders/${intentBody.id}/commit`, {
      method: "POST",
      headers: {
        ...buyerHeaders,
        "x-acting-agent": "procurement",
      },
      body: JSON.stringify({
        idempotencyKey: "http-vtr-e2e-001",
        buyerSignature: detachedSig,
      }),
    });
    assert.equal(commitRes.status, 200);
    const commitBody = (await commitRes.json()) as {
      confirmation: { orderId: string; status: string; receiptId: string };
      receipt: import("@tta/shared").TradeReceipt;
    };
    assert.equal(commitBody.confirmation.status, "committed");
    assert.equal(commitBody.receipt.buyer.algorithm, "ECDSA-P256");
    assert.equal(commitBody.receipt.buyer.payload.quoteId, quoteBody.quoteId);

    // 5. Download portable .vtr.json & verify offline endpoint
    const dlRes = await app.request(
      `/v1/orders/${commitBody.confirmation.orderId}/receipt?download=1`,
      { headers: buyerHeaders },
    );
    assert.equal(dlRes.status, 200);
    assert.match(dlRes.headers.get("content-disposition") ?? "", /\.vtr\.json/);
    const downloadedReceipt = (await dlRes.json()) as import("@tta/shared").TradeReceipt;

    const verifyRes = await app.request("/v1/receipts/verify", {
      method: "POST",
      headers: buyerHeaders,
      body: JSON.stringify({ receipt: downloadedReceipt }),
    });
    assert.equal(verifyRes.status, 200);
    const verifyBody = (await verifyRes.json()) as { valid: boolean };
    assert.equal(verifyBody.valid, true);

    // 6. 1-Click Arbitrator over HTTP (+€0.12 hike & tampered receipt)
    const arbRes = await app.request(
      `/v1/orders/${commitBody.confirmation.orderId}/arbitrate`,
      {
        method: "POST",
        headers: buyerHeaders,
        body: JSON.stringify({ preset: "price_hike_012" }),
      },
    );
    assert.equal(arbRes.status, 200);
    const arbBody = (await arbRes.json()) as import("@tta/shared").DisputeRuling;
    assert.equal(arbBody.ruling, "SUPPLIER_BREACH");
    assert.ok(arbBody.reconciliation.autoCreditEur > 0);
    assert.ok(arbBody.latencyMs < 10);

    const tamperedCopy = structuredClone(downloadedReceipt);
    tamperedCopy.supplier.payload.honouredPrice.totalEur += 99;
    const tamperRes = await app.request("/v1/receipts/arbitrate", {
      method: "POST",
      headers: buyerHeaders,
      body: JSON.stringify({ receipt: tamperedCopy }),
    });
    assert.equal(tamperRes.status, 200);
    const tamperBody = (await tamperRes.json()) as import("@tta/shared").DisputeRuling;
    assert.equal(tamperBody.ruling, "TAMPER_REJECTED");

    // 7. Security Arena "bilateral_dispute" scenario passes 3/3 probes
    const arenaRes = await app.request("/v1/arena/run", {
      method: "POST",
      headers: buyerHeaders,
      body: JSON.stringify({ scenario: "bilateral_dispute" }),
    });
    assert.equal(arenaRes.status, 200);
    const arenaBody = (await arenaRes.json()) as {
      scenario: string;
      passed: boolean;
      blocked: boolean;
      details: {
        receipt: import("@tta/shared").TradeReceipt;
        priceHikeRuling: import("@tta/shared").DisputeRuling;
        chargebackRuling: import("@tta/shared").DisputeRuling;
        tamperRuling: import("@tta/shared").DisputeRuling;
      };
    };
    assert.equal(arenaBody.scenario, "bilateral_dispute");
    assert.equal(arenaBody.passed, true);
    assert.equal(arenaBody.blocked, true);
    assert.equal(arenaBody.details.priceHikeRuling.ruling, "SUPPLIER_BREACH");
    assert.equal(arenaBody.details.priceHikeRuling.reconciliation.autoCreditEur, 36);
    assert.equal(arenaBody.details.chargebackRuling.ruling, "BUYER_LIABLE");
    assert.equal(arenaBody.details.tamperRuling.ruling, "TAMPER_REJECTED");
    assert.ok(arenaBody.details.receipt?.receiptId);
  } finally {
    globalThis.fetch = realFetch;
  }
});
