import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  randomUUID,
  sign,
  verify,
  type KeyObject,
} from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  BuyerSignatureEnvelopeSchema,
  SimulatedInvoiceDocumentSchema,
  TradeReceiptSchema,
  DisputeRulingSchema,
  type BasketLine,
  type BuyerReceiptPayload,
  type BuyerSignatureEnvelope,
  type DetachedBuyerSignatureInput,
  type DisputeBreachItem,
  type DisputePreset,
  type DisputeRuling,
  type HumanOverrideBinding,
  type Mandate,
  type Need,
  type PolicyVerdict,
  type ReceiptHonouredLine,
  type SimulatedInvoiceDocument,
  type SupplierReceiptPayload,
  type SupplierSignatureEnvelope,
  type TradeReceipt,
} from "@tta/shared";
import { getDb } from "../audit/chain.js";
import {
  fromBase64Any,
  p1363ToDer,
  type HumanSignatureProof,
} from "../auth/humanProof.js";
import { config } from "../config.js";
import { CLAIM_ISSUER, getPublicKeyPem } from "./sign.js";

const BUYER_AGENT_KEY_ID = "buyer-agent-ed25519-01";

function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

function round4(n: number): number {
  return Math.round((n + Number.EPSILON) * 10000) / 10000;
}

function sha256Hex(input: string | Buffer): string {
  return createHash("sha256").update(input).digest("hex");
}

function canon(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canon);
  }
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

/**
 * Deterministic recursive key-sorted JSON serialization (stripping `undefined` properties at every depth).
 */
export function canonicalReceiptJson(value: unknown): string {
  return JSON.stringify(canon(value));
}

/**
 * SHA-256 hex digest over the canonical JSON of a buyer Mandate.
 */
export function computeMandateHash(mandate: Mandate): string {
  return sha256Hex(canonicalReceiptJson(mandate));
}

/**
 * SHA-256 hex digest over the canonical TradeReceipt fields (excluding `receiptHash`).
 */
export function computeReceiptHash(receipt: Omit<TradeReceipt, "receiptHash">): string {
  return sha256Hex(
    canonicalReceiptJson({
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

let cachedSupplierPrivKey: { keysDir: string; key: KeyObject } | null = null;

function getSupplierPrivateKey(): KeyObject {
  if (!cachedSupplierPrivKey || cachedSupplierPrivKey.keysDir !== config.keysDir) {
    const privPath = resolve(config.keysDir, "claim-ed25519-private.pem");
    if (!existsSync(privPath)) {
      throw new Error("Supplier claim private key missing. Run npm run gen-keys -w @tta/gateway");
    }
    cachedSupplierPrivKey = {
      keysDir: config.keysDir,
      key: createPrivateKey(readFileSync(privPath)),
    };
  }
  return cachedSupplierPrivKey.key;
}

let cachedBuyerAgentKeys: {
  keysDir: string;
  privateKey: KeyObject;
  publicKeyPem: string;
} | null = null;

/**
 * Loads `buyer-agent-ed25519-private.pem` & `buyer-agent-ed25519-public.pem` from `config.keysDir`,
 * generating and persisting them on first use if missing (with safe in-memory fallback if `writeFileSync` fails).
 */
export function getBuyerAgentKeyPair(_customerId?: string): {
  keyId: string;
  publicKeyPem: string;
  signCanonical: (canonical: string) => string;
} {
  if (!cachedBuyerAgentKeys || cachedBuyerAgentKeys.keysDir !== config.keysDir) {
    const privPath = resolve(config.keysDir, "buyer-agent-ed25519-private.pem");
    const pubPath = resolve(config.keysDir, "buyer-agent-ed25519-public.pem");

    if (existsSync(privPath) && existsSync(pubPath)) {
      const publicKeyPem = readFileSync(pubPath, "utf8");
      const privateKey = createPrivateKey(readFileSync(privPath));
      cachedBuyerAgentKeys = {
        keysDir: config.keysDir,
        privateKey,
        publicKeyPem,
      };
    } else {
      const generated = generateKeyPairSync("ed25519", {
        publicKeyEncoding: { type: "spki", format: "pem" },
        privateKeyEncoding: { type: "pkcs8", format: "pem" },
      });
      try {
        mkdirSync(config.keysDir, { recursive: true });
        writeFileSync(privPath, generated.privateKey, { mode: 0o600 });
        writeFileSync(pubPath, generated.publicKey);
      } catch {
        // Safe in-memory fallback if filesystem is read-only or unavailable
      }
      cachedBuyerAgentKeys = {
        keysDir: config.keysDir,
        privateKey: createPrivateKey(generated.privateKey),
        publicKeyPem: generated.publicKey,
      };
    }
  }

  const { privateKey, publicKeyPem } = cachedBuyerAgentKeys;
  return {
    keyId: BUYER_AGENT_KEY_ID,
    publicKeyPem,
    signCanonical: (canonical: string): string =>
      sign(null, Buffer.from(canonical, "utf8"), privateKey).toString("base64url"),
  };
}

export type BuyerSignerSpec = {
  algorithm: "Ed25519" | "ECDSA-P256";
  keyId: string;
  privateKeyPem: string;
  publicKeyPem: string;
};

/**
 * Creates a detached buyer signature (Ed25519 or ECDSA-P256 IEEE-P1363 in base64url) over `canonicalReceiptJson(payload)`.
 */
export function createDetachedBuyerSignature(
  payload: BuyerReceiptPayload,
  signer?: BuyerSignerSpec,
): DetachedBuyerSignatureInput {
  const canonical = canonicalReceiptJson(payload);
  if (!signer) {
    const buyerAgent = getBuyerAgentKeyPair(payload.customerId);
    return {
      algorithm: "Ed25519",
      keyId: buyerAgent.keyId,
      publicKeyPem: buyerAgent.publicKeyPem,
      signedAt: payload.signedAt,
      authorizedMaxTotalEur: payload.authorizedMaxTotalEur,
      actingAgentId: payload.actingAgentId,
      signature: buyerAgent.signCanonical(canonical),
    };
  }

  const privKey = createPrivateKey(signer.privateKeyPem);
  const bytes = Buffer.from(canonical, "utf8");
  const sigBuf =
    signer.algorithm === "Ed25519"
      ? sign(null, bytes, privKey)
      : sign("sha256", bytes, { key: privKey, dsaEncoding: "ieee-p1363" });

  return {
    algorithm: signer.algorithm,
    keyId: signer.keyId,
    publicKeyPem: signer.publicKeyPem,
    signedAt: payload.signedAt,
    authorizedMaxTotalEur: payload.authorizedMaxTotalEur,
    actingAgentId: payload.actingAgentId,
    signature: sigBuf.toString("base64url"),
  };
}

const parsedPublicKeyCache = new Map<string, KeyObject>();

function parsePublicKeyPemOrSpki(pemOrSpki: string): KeyObject {
  const trimmed = String(pemOrSpki ?? "").trim();
  if (!trimmed) {
    throw new Error("missing_public_key");
  }
  const cached = parsedPublicKeyCache.get(trimmed);
  if (cached) {
    return cached;
  }
  const parsed = trimmed.includes("BEGIN PUBLIC KEY")
    ? createPublicKey(trimmed)
    : createPublicKey({
        key: fromBase64Any(trimmed),
        format: "der",
        type: "spki",
      });
  if (parsedPublicKeyCache.size >= 256) {
    const oldest = parsedPublicKeyCache.keys().next().value;
    if (oldest !== undefined) {
      parsedPublicKeyCache.delete(oldest);
    }
  }
  parsedPublicKeyCache.set(trimmed, parsed);
  return parsed;
}

/**
 * Verifies a `BuyerSignatureEnvelope` (Ed25519 or ECDSA-P256) against `canonicalReceiptJson(envelope.payload)`.
 */
export function verifyBuyerSignatureEnvelope(
  envelope: BuyerSignatureEnvelope,
  opts?: { skipSchemaParse?: boolean },
): { valid: boolean; reason?: string } {
  if (!opts?.skipSchemaParse) {
    const parsed = BuyerSignatureEnvelopeSchema.safeParse(envelope);
    if (!parsed.success) {
      return { valid: false, reason: "invalid_buyer_envelope_schema" };
    }
  }

  try {
    const pubKey = parsePublicKeyPemOrSpki(envelope.publicKeyPem);
    const data = Buffer.from(canonicalReceiptJson(envelope.payload), "utf8");
    const rawSig = fromBase64Any(envelope.signature);
    if (rawSig.length === 0) {
      return { valid: false, reason: "empty_signature" };
    }

    if (envelope.algorithm === "Ed25519") {
      if (pubKey.asymmetricKeyType !== "ed25519") {
        return { valid: false, reason: "key_algorithm_mismatch_expected_ed25519" };
      }
      const ok = verify(null, data, pubKey, rawSig);
      return ok ? { valid: true } : { valid: false, reason: "bad_ed25519_signature" };
    }

    if (envelope.algorithm === "ECDSA-P256") {
      if (pubKey.asymmetricKeyType !== "ec") {
        return { valid: false, reason: "key_algorithm_mismatch_expected_ec" };
      }
      const curve = pubKey.asymmetricKeyDetails?.namedCurve;
      if (curve && curve !== "prime256v1" && curve !== "P-256") {
        return { valid: false, reason: `unsupported_ec_curve_${curve}` };
      }
      const derSig = rawSig.length === 64 ? p1363ToDer(rawSig) : rawSig;
      const ok = verify("sha256", data, pubKey, derSig);
      return ok ? { valid: true } : { valid: false, reason: "bad_ecdsa_p256_signature" };
    }

    return { valid: false, reason: "unsupported_algorithm" };
  } catch (err) {
    return {
      valid: false,
      reason: err instanceof Error ? err.message : "buyer_verify_error",
    };
  }
}

export type ReceiptIntentInput = {
  id: string;
  customerId: string;
  runId: string;
  need: Need;
  basket: BasketLine[];
  snapshotHash: string;
  totalPrice: number;
  neededBy: string;
  updatedAt?: string;
  policy?: PolicyVerdict;
  meta?: {
    quoteId?: string;
    quoteValidUntil?: string;
    humanSignatureProof?: HumanSignatureProof;
    humanSignatureRaw?: Record<string, unknown>;
    cascadeExecuted?: unknown;
  };
};

export type IssueTradeReceiptParams = {
  orderId: string;
  intent: ReceiptIntentInput;
  mandate: Mandate;
  actingAgentId?: string | null;
  auditHeadHash?: string | null;
  detachedBuyerSignature?: DetachedBuyerSignatureInput;
};

function resolveAuthorityMode(
  intent: ReceiptIntentInput,
  hasDetached: boolean,
): BuyerReceiptPayload["authorityMode"] {
  const humanProof = intent.meta?.humanSignatureProof;
  if (humanProof?.verified) {
    return humanProof.mode === "webauthn"
      ? "human_override_webauthn"
      : "human_override_p256";
  }
  if (hasDetached) {
    return "external_agent_signed";
  }
  return "agent_autonomous";
}

export function buildBuyerReceiptPayload(params: {
  intent: ReceiptIntentInput;
  mandate: Mandate;
  actingAgentId?: string | null;
  signedAt?: string;
  authorizedMaxTotalEur?: number;
  authorityMode?: BuyerReceiptPayload["authorityMode"];
  hasDetachedSignature?: boolean;
}): BuyerReceiptPayload {
  const { intent, mandate } = params;
  return {
    customerId: intent.customerId,
    intentId: intent.id,
    mandateId: mandate.mandateId,
    mandateHash: computeMandateHash(mandate),
    quoteId: intent.meta?.quoteId ?? null,
    snapshotHash: intent.snapshotHash,
    authorizedMaxTotalEur:
      params.authorizedMaxTotalEur !== undefined
        ? params.authorizedMaxTotalEur
        : round2(intent.totalPrice),
    authorityMode:
      params.authorityMode ??
      resolveAuthorityMode(intent, Boolean(params.hasDetachedSignature)),
    actingAgentId: params.actingAgentId ?? null,
    signedAt: params.signedAt ?? new Date().toISOString(),
  };
}

function lineIsLactoseFree(line: BasketLine): boolean {
  if (line.labels?.includes("lactose-free")) return true;
  return /lactose[\s-]?free|laktoositon|laktosfri/i.test(line.productName);
}

function extractExcludedAllergens(mandate: Mandate, need: Need): string[] {
  const fromMandate = (mandate.allergenRestrictions ?? [])
    .filter((r) => r !== "must_be_lactose_free")
    .map((r) => r.replace(/^no_/i, "").trim().toLowerCase())
    .filter(Boolean);
  const fromNeed = (need.constraints?.excludeAllergens ?? [])
    .map((a) => a.trim().toLowerCase())
    .filter(Boolean);
  return [...new Set([...fromMandate, ...fromNeed])];
}

function buildHumanOverrideBinding(intent: ReceiptIntentInput): HumanOverrideBinding | undefined {
  const proof = intent.meta?.humanSignatureProof;
  if (!proof?.verified) return undefined;

  const raw = intent.meta?.humanSignatureRaw;
  const publicKeySpki =
    typeof raw?.publicKeySpki === "string" && raw.publicKeySpki.trim()
      ? raw.publicKeySpki.trim()
      : undefined;
  const signature =
    typeof raw?.signature === "string" && raw.signature.trim()
      ? raw.signature.trim()
      : undefined;
  const signedChallenge =
    typeof raw?.signedMessage === "string" && raw.signedMessage.trim()
      ? raw.signedMessage
      : typeof raw?.signedChallenge === "string" && raw.signedChallenge.trim()
        ? raw.signedChallenge
        : undefined;

  return {
    mode: proof.mode,
    credentialId: proof.credentialId,
    signerLabel: proof.signerLabel,
    signaturePrefix: proof.signaturePrefix,
    verifiedAt: proof.verifiedAt,
    acknowledgedRules: [...(intent.policy?.failingRules ?? [])],
    ...(publicKeySpki ? { publicKeySpki } : {}),
    ...(signedChallenge ? { signedChallenge } : {}),
    ...(signature ? { signature } : {}),
  };
}

/**
 * Issues a dual-signed Bilateral "Zero-Dispute" Liability Receipt (`.vtr.json`).
 */
export function issueTradeReceipt(params: IssueTradeReceiptParams): TradeReceipt {
  const { orderId, intent, mandate, detachedBuyerSignature } = params;
  const nowIso = new Date().toISOString();
  const mandateHash = computeMandateHash(mandate);
  const humanOverride = buildHumanOverrideBinding(intent);
  const committedTotalEur = round2(intent.totalPrice);

  let buyerEnvelope: BuyerSignatureEnvelope;

  if (detachedBuyerSignature) {
    const authorizedMaxTotalEur =
      detachedBuyerSignature.authorizedMaxTotalEur !== undefined
        ? detachedBuyerSignature.authorizedMaxTotalEur
        : committedTotalEur;

    if (authorizedMaxTotalEur + 0.009 < committedTotalEur) {
      throw new Error("invalid_buyer_signature: authorized_max_total_exceeded");
    }

    const actingAgentId =
      detachedBuyerSignature.actingAgentId !== undefined
        ? detachedBuyerSignature.actingAgentId
        : (params.actingAgentId ?? null);

    const primaryMode = resolveAuthorityMode(intent, true);
    const candidateModes: BuyerReceiptPayload["authorityMode"][] = [primaryMode];
    for (const alt of [
      "external_agent_signed",
      "human_override_p256",
      "human_override_webauthn",
      "agent_autonomous",
    ] as const) {
      if (!candidateModes.includes(alt)) candidateModes.push(alt);
    }

    let verifiedEnvelope: BuyerSignatureEnvelope | null = null;
    let firstFailureReason = "bad_signature";

    for (let i = 0; i < candidateModes.length; i++) {
      const candidatePayload: BuyerReceiptPayload = {
        customerId: intent.customerId,
        intentId: intent.id,
        mandateId: mandate.mandateId,
        mandateHash,
        quoteId: intent.meta?.quoteId ?? null,
        snapshotHash: intent.snapshotHash,
        authorizedMaxTotalEur,
        authorityMode: candidateModes[i]!,
        actingAgentId,
        signedAt: detachedBuyerSignature.signedAt,
      };
      const candidateEnvelope: BuyerSignatureEnvelope = {
        payload: candidatePayload,
        algorithm: detachedBuyerSignature.algorithm,
        keyId: detachedBuyerSignature.keyId,
        publicKeyPem: detachedBuyerSignature.publicKeyPem,
        signature: detachedBuyerSignature.signature,
        ...(humanOverride ? { humanOverride } : {}),
      };
      const check = verifyBuyerSignatureEnvelope(candidateEnvelope);
      if (check.valid) {
        verifiedEnvelope = candidateEnvelope;
        break;
      }
      if (i === 0 && check.reason) {
        firstFailureReason = check.reason;
      }
    }

    if (!verifiedEnvelope) {
      throw new Error(`invalid_buyer_signature: ${firstFailureReason}`);
    }
    buyerEnvelope = verifiedEnvelope;
  } else {
    const buyerAgent = getBuyerAgentKeyPair(intent.customerId);
    const buyerPayload: BuyerReceiptPayload = {
      customerId: intent.customerId,
      intentId: intent.id,
      mandateId: mandate.mandateId,
      mandateHash,
      quoteId: intent.meta?.quoteId ?? null,
      snapshotHash: intent.snapshotHash,
      authorizedMaxTotalEur: committedTotalEur,
      authorityMode: resolveAuthorityMode(intent, false),
      actingAgentId: params.actingAgentId ?? null,
      signedAt: nowIso,
    };
    const signature = buyerAgent.signCanonical(canonicalReceiptJson(buyerPayload));
    buyerEnvelope = {
      payload: buyerPayload,
      algorithm: "Ed25519",
      keyId: buyerAgent.keyId,
      publicKeyPem: buyerAgent.publicKeyPem,
      signature,
      ...(humanOverride ? { humanOverride } : {}),
    };
  }

  const honouredLines: ReceiptHonouredLine[] = intent.basket.map((line) => ({
    productId: line.productId,
    productName: line.productName,
    packs: line.packs,
    packSize: line.packSize,
    packUnit: line.packUnit,
    totalQuantity: line.totalQuantity,
    quantityUnit: line.quantityUnit,
    unitPriceEur: round4(line.unitPrice),
    comparisonPricePerUnit: line.comparisonPrice ?? null,
    comparisonUnit: line.comparisonUnit ?? null,
    lineTotalEur: round2(line.totalPrice),
  }));

  const priceBasis: SupplierReceiptPayload["honouredPrice"]["priceBasis"] = intent.meta?.cascadeExecuted
    ? "fallback_cascade"
    : intent.meta?.quoteId
      ? "firm_quote"
      : "live_committed";

  const excludedAllergens = extractExcludedAllergens(mandate, intent.need);
  const lineAttestations = intent.basket.map((line) => ({
    productId: line.productId,
    productName: line.productName,
    allergens: [...(line.allergens ?? [])],
    mayContain: [...(line.mayContain ?? [])],
    lactoseFree: lineIsLactoseFree(line),
    origin: line.origin ?? null,
    certifications: [...(line.certifications ?? [])],
  }));

  const lactoseFreeGuaranteed = Boolean(
    intent.need.constraints?.lactoseFree ||
      mandate.allergenRestrictions?.includes("must_be_lactose_free") ||
      (lineAttestations.length > 0 && lineAttestations.every((l) => l.lactoseFree)),
  );

  const availableDates = intent.basket
    .map((l) => (l.availableDate ? l.availableDate.slice(0, 10) : null))
    .filter((d): d is string => Boolean(d))
    .sort();
  const promisedDate = availableDates.at(-1) ?? intent.neededBy.slice(0, 10);
  const neededByDate = intent.neededBy.slice(0, 10);
  const latestAcceptableDate = promisedDate > neededByDate ? promisedDate : neededByDate;

  const buyerSignatureHash = sha256Hex(buyerEnvelope.signature);

  const supplierPayload: SupplierReceiptPayload = {
    orderId,
    intentId: intent.id,
    customerId: intent.customerId,
    quoteId: intent.meta?.quoteId ?? null,
    quoteFirmUntil: intent.meta?.quoteValidUntil ?? null,
    honouredPrice: {
      currency: "EUR",
      totalEur: committedTotalEur,
      priceBasis,
      lines: honouredLines,
    },
    allergenClaim: {
      excludedAllergens,
      lactoseFreeGuaranteed,
      lineAttestations,
    },
    deliveryCommitment: {
      promisedDate,
      latestAcceptableDate,
      partialFulfilmentAllowed: !(mandate.requireApprovalFor ?? []).includes("partial_fulfil"),
      cascadeApplied: Boolean(intent.meta?.cascadeExecuted),
    },
    buyerSignatureHash,
    committedAt: nowIso,
  };

  const supplierSignature = sign(
    null,
    Buffer.from(canonicalReceiptJson(supplierPayload), "utf8"),
    getSupplierPrivateKey(),
  ).toString("base64url");

  const supplierEnvelope: SupplierSignatureEnvelope = {
    payload: supplierPayload,
    algorithm: "Ed25519",
    issuer: CLAIM_ISSUER,
    keyId: config.claimKeyId,
    publicKeyPem: getPublicKeyPem(),
    signature: supplierSignature,
  };

  const receiptId = `VTR-${orderId.replace(/^ORD-/, "")}`;
  const fileName = `${orderId.toLowerCase()}.vtr.json`;
  const auditAnchor = {
    runId: intent.runId,
    headHash: params.auditHeadHash ?? null,
  };

  const unsignedReceipt: Omit<TradeReceipt, "receiptHash"> = {
    format: "application/vnd.valio.trade-receipt+json",
    specVersion: "1.0",
    receiptId,
    fileName,
    orderId,
    intentId: intent.id,
    runId: intent.runId,
    customerId: intent.customerId,
    issuedAt: nowIso,
    buyer: buyerEnvelope,
    supplier: supplierEnvelope,
    auditAnchor,
  };

  const receipt: TradeReceipt = {
    ...unsignedReceipt,
    receiptHash: computeReceiptHash(unsignedReceipt),
  };

  return TradeReceiptSchema.parse(receipt);
}

export type TradeReceiptVerification = {
  valid: boolean;
  reason?: string;
  receiptHashValid: boolean;
  buyerSignatureValid: boolean;
  supplierSignatureValid: boolean;
  bilateralBindingValid: boolean;
  humanOverrideVerified: boolean;
};

/**
 * Offline cryptographic verifier for `.vtr.json` Bilateral Liability Receipts.
 */
export function verifyTradeReceipt(
  receipt: TradeReceipt,
  opts?: { trustedSupplierPublicKeyPem?: string },
): TradeReceiptVerification {
  const parsed = TradeReceiptSchema.safeParse(receipt);
  if (!parsed.success) {
    return {
      valid: false,
      reason: "invalid_receipt_schema",
      receiptHashValid: false,
      buyerSignatureValid: false,
      supplierSignatureValid: false,
      bilateralBindingValid: false,
      humanOverrideVerified: false,
    };
  }

  const r = parsed.data;
  const expectedReceiptHash = computeReceiptHash(r);
  const receiptHashValid = expectedReceiptHash === r.receiptHash;

  const buyerCheck = verifyBuyerSignatureEnvelope(r.buyer, { skipSchemaParse: true });
  const buyerSignatureValid = buyerCheck.valid;

  let supplierSignatureValid = false;
  let supplierFailReason: string | undefined;
  try {
    const trustedSupplierPem = (opts?.trustedSupplierPublicKeyPem ?? getPublicKeyPem()).trim();
    if (r.supplier.publicKeyPem.trim() !== trustedSupplierPem) {
      supplierFailReason = "untrusted_supplier_public_key";
    } else {
      const supPubKey = parsePublicKeyPemOrSpki(trustedSupplierPem);
      if (supPubKey.asymmetricKeyType !== "ed25519") {
        supplierFailReason = "supplier_key_not_ed25519";
      } else {
        const supBytes = Buffer.from(canonicalReceiptJson(r.supplier.payload), "utf8");
        const supSig = fromBase64Any(r.supplier.signature);
        supplierSignatureValid = supSig.length > 0 && verify(null, supBytes, supPubKey, supSig);
        if (!supplierSignatureValid) {
          supplierFailReason = "bad_supplier_signature";
        }
      }
    }
  } catch (err) {
    supplierFailReason = err instanceof Error ? err.message : "supplier_verify_error";
  }

  const expectedBuyerSigHash = sha256Hex(r.buyer.signature);
  const bilateralBindingValid =
    r.supplier.payload.buyerSignatureHash === expectedBuyerSigHash &&
    r.buyer.payload.intentId === r.intentId &&
    r.supplier.payload.intentId === r.intentId &&
    r.buyer.payload.customerId === r.customerId &&
    r.supplier.payload.customerId === r.customerId &&
    r.buyer.payload.quoteId === r.supplier.payload.quoteId &&
    r.supplier.payload.orderId === r.orderId;

  const humanOverrideVerified = Boolean(
    buyerSignatureValid &&
      r.buyer.humanOverride &&
      r.buyer.humanOverride.credentialId &&
      r.buyer.humanOverride.signaturePrefix &&
      r.buyer.humanOverride.verifiedAt,
  );

  const valid =
    receiptHashValid &&
    buyerSignatureValid &&
    supplierSignatureValid &&
    bilateralBindingValid;

  let reason: string | undefined;
  if (!valid) {
    if (!buyerSignatureValid) {
      reason = buyerCheck.reason ?? "buyer_signature_invalid";
    } else if (!supplierSignatureValid) {
      reason = supplierFailReason ?? "supplier_signature_invalid";
    } else if (!bilateralBindingValid) {
      reason = "bilateral_binding_mismatch";
    } else if (!receiptHashValid) {
      reason = "receipt_hash_mismatch";
    }
  }

  return {
    valid,
    ...(reason ? { reason } : {}),
    receiptHashValid,
    buyerSignatureValid,
    supplierSignatureValid,
    bilateralBindingValid,
    humanOverrideVerified,
  };
}

function addCalendarDays(isoDate: string, days: number): string {
  const ymd = isoDate.slice(0, 10);
  const dt = new Date(`${ymd}T00:00:00.000Z`);
  dt.setUTCDate(dt.getUTCDate() + days);
  return dt.toISOString().slice(0, 10);
}

/**
 * Generates deterministic simulated e-invoice / delivery note scenarios for the 3-Way Invoice Resolver.
 */
export function buildPresetSimulation(
  receipt: TradeReceipt,
  preset: DisputePreset,
): { receiptToEvaluate: TradeReceipt; document: SimulatedInvoiceDocument } {
  const receiptToEvaluate =
    preset === "tampered_receipt" ? structuredClone(receipt) : receipt;
  const sup = receiptToEvaluate.supplier.payload;
  const attByProduct = new Map(
    sup.allergenClaim.lineAttestations.map((a) => [a.productId, a]),
  );

  const baseLines = sup.honouredPrice.lines.map((line) => {
    const att = attByProduct.get(line.productId);
    const basePerQty =
      line.comparisonPricePerUnit ??
      (line.totalQuantity > 0 ? round4(line.lineTotalEur / line.totalQuantity) : line.unitPriceEur);
    return {
      productId: line.productId,
      productName: line.productName,
      billedPacks: line.packs,
      deliveredPacks: line.packs,
      billedQuantity: line.totalQuantity,
      deliveredQuantity: line.totalQuantity,
      billedUnitPriceEur: line.unitPriceEur,
      billedPricePerQtyUnitEur: basePerQty,
      billedLineTotalEur: round2(line.lineTotalEur),
      deliveredAllergens: att ? [...att.allergens] : [],
      deliveredLactoseFree: att ? att.lactoseFree : sup.allergenClaim.lactoseFreeGuaranteed,
    };
  });

  switch (preset) {
    case "price_hike_012": {
      const hikedLines = sup.honouredPrice.lines.map((line, idx) => {
        const base = baseLines[idx]!;
        const hikeEur = round2(line.totalQuantity * 0.12);
        const billedLineTotalEur = round2(line.lineTotalEur + hikeEur);
        const billedPricePerQtyUnitEur = round4((base.billedPricePerQtyUnitEur ?? 0) + 0.12);
        const billedUnitPriceEur =
          line.packs > 0
            ? round4(billedLineTotalEur / line.packs)
            : round4(line.unitPriceEur + 0.12);
        return {
          ...base,
          billedUnitPriceEur,
          billedPricePerQtyUnitEur,
          billedLineTotalEur,
        };
      });
      const billedTotalEur = round2(
        hikedLines.reduce((sum, l) => sum + l.billedLineTotalEur, 0),
      );
      return {
        receiptToEvaluate,
        document: {
          documentId: `INV-${sup.orderId}-HIKE`,
          documentType: "e_invoice",
          deliveredAt: sup.deliveryCommitment.promisedDate,
          buyerDisputeClaim: "price_overcharge",
          buyerDisputeNote: "Supplier e-invoice hiked unit price by +€0.12 above committed quote.",
          billedTotalEur,
          currency: sup.honouredPrice.currency,
          lines: hikedLines,
        },
      };
    }

    case "late_delivery": {
      const lateDate = addCalendarDays(sup.deliveryCommitment.latestAcceptableDate, 2);
      return {
        receiptToEvaluate,
        document: {
          documentId: `DN-${sup.orderId}-LATE`,
          documentType: "combined_3way",
          deliveredAt: lateDate,
          buyerDisputeClaim: "late_delivery",
          buyerDisputeNote: `Delivery arrived on ${lateDate}, 2 days past latest acceptable SLA (${sup.deliveryCommitment.latestAcceptableDate}).`,
          billedTotalEur: round2(sup.honouredPrice.totalEur),
          currency: sup.honouredPrice.currency,
          lines: baseLines,
        },
      };
    }

    case "rogue_agent_chargeback": {
      return {
        receiptToEvaluate,
        document: {
          documentId: `INV-${sup.orderId}-CBK`,
          documentType: "combined_3way",
          deliveredAt: sup.deliveryCommitment.promisedDate,
          buyerDisputeClaim: "rogue_agent_hallucination",
          buyerDisputeNote:
            "Our rogue agent hallucinated this milk order — refusing invoice payment.",
          billedTotalEur: round2(sup.honouredPrice.totalEur),
          currency: sup.honouredPrice.currency,
          lines: baseLines,
        },
      };
    }

    case "allergen_breach": {
      const breachedLines = baseLines.map((line) => ({
        ...line,
        deliveredLactoseFree: false,
        deliveredAllergens: ["milk", "nuts", "gluten"],
      }));
      return {
        receiptToEvaluate,
        document: {
          documentId: `DN-${sup.orderId}-ALG`,
          documentType: "delivery_note",
          deliveredAt: sup.deliveryCommitment.promisedDate,
          buyerDisputeClaim: "allergen_breach",
          buyerDisputeNote:
            "Receiving dock lot scan flagged lactose-containing dairy and undeclared nuts/gluten allergens.",
          billedTotalEur: round2(sup.honouredPrice.totalEur),
          currency: sup.honouredPrice.currency,
          lines: breachedLines,
        },
      };
    }

    case "tampered_receipt": {
      receiptToEvaluate.supplier.payload.honouredPrice.totalEur = round2(
        receiptToEvaluate.supplier.payload.honouredPrice.totalEur + 36,
      );
      return {
        receiptToEvaluate,
        document: {
          documentId: `INV-${sup.orderId}-TMP`,
          documentType: "e_invoice",
          deliveredAt: sup.deliveryCommitment.promisedDate,
          buyerDisputeClaim: "price_overcharge",
          buyerDisputeNote: "Presented receipt payload appears altered post-signing.",
          billedTotalEur: receiptToEvaluate.supplier.payload.honouredPrice.totalEur,
          currency: sup.honouredPrice.currency,
          lines: baseLines,
        },
      };
    }

    case "clean_3way_match": {
      return {
        receiptToEvaluate,
        document: {
          documentId: `INV-${sup.orderId}-3WM`,
          documentType: "combined_3way",
          deliveredAt: sup.deliveryCommitment.promisedDate,
          buyerDisputeClaim: "none",
          billedTotalEur: round2(sup.honouredPrice.totalEur),
          currency: sup.honouredPrice.currency,
          lines: baseLines,
        },
      };
    }
  }
}

/**
 * Instant (<10 ms) deterministic 3-Way Invoice Resolver & Bilateral Liability Arbitrator.
 */
export function arbitrateTradeDispute(input: {
  receipt: TradeReceipt;
  document?: SimulatedInvoiceDocument;
  preset?: DisputePreset;
  trustedSupplierPublicKeyPem?: string;
}): DisputeRuling {
  const start = performance.now();

  let receiptToEvaluate: TradeReceipt;
  let document: SimulatedInvoiceDocument;

  if (input.preset) {
    const built = buildPresetSimulation(input.receipt, input.preset);
    receiptToEvaluate = built.receiptToEvaluate;
    document = input.document
      ? SimulatedInvoiceDocumentSchema.parse(input.document)
      : built.document;
  } else if (input.document) {
    receiptToEvaluate = input.receipt;
    document = SimulatedInvoiceDocumentSchema.parse(input.document);
  } else {
    const built = buildPresetSimulation(input.receipt, "clean_3way_match");
    receiptToEvaluate = built.receiptToEvaluate;
    document = built.document;
  }

  const verification = verifyTradeReceipt(
    receiptToEvaluate,
    input.trustedSupplierPublicKeyPem
      ? { trustedSupplierPublicKeyPem: input.trustedSupplierPublicKeyPem }
      : undefined,
  );

  const cryptographicProof: DisputeRuling["cryptographicProof"] = {
    receiptHashValid: verification.receiptHashValid,
    buyerSignatureValid: verification.buyerSignatureValid,
    supplierSignatureValid: verification.supplierSignatureValid,
    bilateralBindingValid: verification.bilateralBindingValid,
    humanOverrideVerified: verification.humanOverrideVerified,
    mandateHash: receiptToEvaluate?.buyer?.payload?.mandateHash ?? "",
    quoteId:
      receiptToEvaluate?.supplier?.payload?.quoteId ??
      receiptToEvaluate?.buyer?.payload?.quoteId ??
      null,
    snapshotHash: receiptToEvaluate?.buyer?.payload?.snapshotHash ?? "",
    orderId: receiptToEvaluate?.orderId ?? "",
    ...(verification.reason ? { reason: verification.reason } : {}),
  };

  if (!verification.valid) {
    const billedTotalEur = round2(document.billedTotalEur);
    const contractedTotalEur = round2(
      receiptToEvaluate?.supplier?.payload?.honouredPrice?.totalEur ?? 0,
    );
    const currency =
      document.currency ||
      receiptToEvaluate?.supplier?.payload?.honouredPrice?.currency ||
      "EUR";
    const latencyMs = Number(Math.max(0.001, performance.now() - start).toFixed(3));

    return DisputeRulingSchema.parse({
      rulingId: `RUL-${randomUUID().slice(0, 12).toUpperCase()}`,
      evaluatedAt: new Date().toISOString(),
      latencyMs,
      ruling: "TAMPER_REJECTED",
      subVerdict: "CRYPTO_SIGNATURE_INVALID",
      headline: `TAMPER_REJECTED → Cryptographic Signature Invalid (${verification.reason ?? "tampered .vtr.json"})`,
      summary: `Offline verification of ${receiptToEvaluate?.fileName ?? ".vtr.json"} failed (${verification.reason ?? "signature_mismatch"}). Invoice settlement of €${billedTotalEur.toFixed(2)} is blocked automatically.`,
      cryptographicProof,
      reconciliation: {
        contractedTotalEur,
        billedTotalEur,
        autoCreditEur: billedTotalEur,
        netPayableEur: 0,
        currency,
      },
      breaches: [
        {
          code: "RECEIPT_TAMPER_DETECTED",
          party: "tamper",
          clause: "TradeReceipt Cryptographic Envelope",
          expected: "Valid buyer + supplier signatures and matching SHA-256 receiptHash",
          actual: `Verification failed: ${verification.reason ?? "invalid_signature"}`,
          creditImpactEur: billedTotalEur,
        },
      ],
      simulatedDocument: document,
    });
  }

  const sup = receiptToEvaluate.supplier.payload;
  const contractedTotalEur = round2(sup.honouredPrice.totalEur);
  const billedTotalEur = round2(document.billedTotalEur);
  const currency = document.currency || sup.honouredPrice.currency || "EUR";
  const quoteId = sup.quoteId ? sup.quoteId.replace(/^#/, "") : null;
  const orderId = sup.orderId.replace(/^#/, "");

  const honLineByProduct = new Map(
    sup.honouredPrice.lines.map((l) => [l.productId, l]),
  );
  const attByProduct = new Map(
    sup.allergenClaim.lineAttestations.map((a) => [a.productId, a]),
  );

  const breaches: DisputeBreachItem[] = [];

  // 1. Price overcharge check (total overbill or per-line overbill)
  let lineOverbillSum = 0;
  for (const simLine of document.lines) {
    const honLine = honLineByProduct.get(simLine.productId);
    if (!honLine) continue;
    let expectedForBilledQty = honLine.lineTotalEur;
    if (simLine.billedQuantity != null && honLine.totalQuantity > 0) {
      expectedForBilledQty = (honLine.lineTotalEur / honLine.totalQuantity) * simLine.billedQuantity;
    } else if (simLine.billedPacks != null && honLine.packs > 0) {
      expectedForBilledQty = honLine.unitPriceEur * simLine.billedPacks;
    }
    const delta = round2(simLine.billedLineTotalEur - round2(expectedForBilledQty));
    if (delta > 0.009) {
      lineOverbillSum = round2(lineOverbillSum + delta);
    }
  }

  if (billedTotalEur > contractedTotalEur + 0.009 || lineOverbillSum > 0.009) {
    const priceCredit =
      billedTotalEur > contractedTotalEur + 0.009
        ? round2(billedTotalEur - contractedTotalEur)
        : round2(lineOverbillSum);
    breaches.push({
      code: "FIRM_PRICE_VIOLATED",
      party: "supplier",
      clause: quoteId
        ? `Quote #${quoteId} honouredPrice (${sup.honouredPrice.priceBasis})`
        : `Order #${orderId} honouredPrice (${sup.honouredPrice.priceBasis})`,
      expected: `€${contractedTotalEur.toFixed(2)} firm committed total`,
      actual: `€${billedTotalEur.toFixed(2)} billed on ${document.documentId}`,
      creditImpactEur: priceCredit,
    });
  }

  // 2. Short delivery overbilling check
  for (const simLine of document.lines) {
    const honLine = honLineByProduct.get(simLine.productId);
    if (
      simLine.deliveredQuantity != null &&
      simLine.billedQuantity != null &&
      simLine.deliveredQuantity < simLine.billedQuantity
    ) {
      const shortQty = simLine.billedQuantity - simLine.deliveredQuantity;
      const contractedRate =
        honLine && honLine.totalQuantity > 0
          ? honLine.lineTotalEur / honLine.totalQuantity
          : simLine.billedQuantity > 0
            ? simLine.billedLineTotalEur / simLine.billedQuantity
            : 0;
      const shortCredit = round2(shortQty * contractedRate);
      breaches.push({
        code: "SHORT_DELIVERY_OVERBILL",
        party: "supplier",
        clause: `Line ${simLine.productId} deliveredQuantity vs billedQuantity`,
        expected: `${simLine.billedQuantity} units delivered for billed quantity`,
        actual: `${simLine.deliveredQuantity} units delivered (${shortQty} short)`,
        creditImpactEur: shortCredit,
      });
    } else if (
      simLine.deliveredPacks != null &&
      simLine.billedPacks != null &&
      simLine.deliveredPacks < simLine.billedPacks
    ) {
      const shortPacks = simLine.billedPacks - simLine.deliveredPacks;
      const unitRate = honLine
        ? honLine.unitPriceEur
        : simLine.billedUnitPriceEur ??
          (simLine.billedPacks > 0 ? simLine.billedLineTotalEur / simLine.billedPacks : 0);
      const shortCredit = round2(shortPacks * unitRate);
      breaches.push({
        code: "SHORT_DELIVERY_OVERBILL",
        party: "supplier",
        clause: `Line ${simLine.productId} deliveredPacks vs billedPacks`,
        expected: `${simLine.billedPacks} packs delivered`,
        actual: `${simLine.deliveredPacks} packs delivered (${shortPacks} short)`,
        creditImpactEur: shortCredit,
      });
    }
  }

  // 3. Allergen & lactose-free attestation breach check
  const excludedLower = sup.allergenClaim.excludedAllergens.map((a) => a.toLowerCase());
  for (const simLine of document.lines) {
    const honLine = honLineByProduct.get(simLine.productId);
    const lineAtt = attByProduct.get(simLine.productId);

    const lactoseExpected =
      sup.allergenClaim.lactoseFreeGuaranteed || Boolean(lineAtt?.lactoseFree);
    const lactoseViolated = lactoseExpected && simLine.deliveredLactoseFree === false;

    const deliveredAllergens = (simLine.deliveredAllergens ?? []).map((a) =>
      a.trim().toLowerCase(),
    );
    const forbiddenFound = deliveredAllergens.filter((d) =>
      excludedLower.some((ex) => d === ex || d.includes(ex) || ex.includes(d)),
    );
    const declaredAllowlist = lineAtt
      ? new Set(
          [...lineAtt.allergens, ...lineAtt.mayContain].map((a) =>
            a.trim().toLowerCase(),
          ),
        )
      : null;
    const undeclaredFound = declaredAllowlist
      ? deliveredAllergens.filter((d) => !declaredAllowlist.has(d))
      : [];
    const violatingAllergens = [...new Set([...forbiddenFound, ...undeclaredFound])];

    if (lactoseViolated || violatingAllergens.length > 0) {
      const lineCredit = round2(honLine ? honLine.lineTotalEur : simLine.billedLineTotalEur);
      breaches.push({
        code: "ALLERGEN_ATTESTATION_VIOLATED",
        party: "supplier",
        clause: `allergenClaim (${simLine.productName ?? honLine?.productName ?? simLine.productId})`,
        expected: `${lactoseExpected ? "lactoseFree=true" : "attested allergens only"}${excludedLower.length ? `, excluded=[${excludedLower.join(", ")}]` : ""}`,
        actual: `deliveredLactoseFree=${String(simLine.deliveredLactoseFree ?? true)}, deliveredAllergens=[${(simLine.deliveredAllergens ?? []).join(", ")}]`,
        creditImpactEur: lineCredit,
      });
    }
  }

  // 4. Delivery SLA breach check
  const deliveredDate = document.deliveredAt ? document.deliveredAt.slice(0, 10) : null;
  const latestAcceptableDate = sup.deliveryCommitment.latestAcceptableDate.slice(0, 10);
  if (deliveredDate && deliveredDate > latestAcceptableDate) {
    const slaCredit = round2(contractedTotalEur * 0.15);
    breaches.push({
      code: "DELIVERY_SLA_VIOLATED",
      party: "supplier",
      clause: "deliveryCommitment.latestAcceptableDate",
      expected: `Delivered on or before ${latestAcceptableDate}`,
      actual: `Delivered on ${deliveredDate}`,
      creditImpactEur: slaCredit,
    });
  }

  if (breaches.length > 0) {
    const rawCredit = round2(breaches.reduce((sum, b) => sum + b.creditImpactEur, 0));
    const autoCreditEur = round2(Math.min(billedTotalEur, rawCredit));
    const netPayableEur = round2(Math.max(0, billedTotalEur - autoCreditEur));

    let breachReason: string;
    if (breaches.some((b) => b.code === "FIRM_PRICE_VIOLATED")) {
      breachReason = quoteId
        ? `Quote #${quoteId} firm price violated`
        : `Order #${orderId} committed price violated`;
    } else if (breaches.some((b) => b.code === "ALLERGEN_ATTESTATION_VIOLATED")) {
      breachReason = `Order #${orderId} allergen attestation violated`;
    } else if (breaches.some((b) => b.code === "DELIVERY_SLA_VIOLATED")) {
      breachReason = `Order #${orderId} delivery SLA violated`;
    } else {
      breachReason = `Order #${orderId} short delivery overbill`;
    }

    const headline = `SUPPLIER_BREACH → Auto-Credit €${autoCreditEur.toFixed(2)} (${breachReason})`;
    const summary = `Valio counter-signed receipt ${receiptToEvaluate.receiptId} proves supplier breach (${breaches.map((b) => b.code).join(", ")}). Issued instant auto-credit of €${autoCreditEur.toFixed(2)}; net payable settled at €${netPayableEur.toFixed(2)}.`;
    const latencyMs = Number(Math.max(0.001, performance.now() - start).toFixed(3));

    return DisputeRulingSchema.parse({
      rulingId: `RUL-${randomUUID().slice(0, 12).toUpperCase()}`,
      evaluatedAt: new Date().toISOString(),
      latencyMs,
      ruling: "SUPPLIER_BREACH",
      subVerdict: "AUTO_CREDIT_ISSUED",
      headline,
      summary,
      cryptographicProof,
      reconciliation: {
        contractedTotalEur,
        billedTotalEur,
        autoCreditEur,
        netPayableEur,
        currency,
      },
      breaches,
      simulatedDocument: document,
    });
  }

  const hasBuyerDispute = document.buyerDisputeClaim !== "none";
  const subVerdict: DisputeRuling["subVerdict"] = hasBuyerDispute
    ? "CHARGEBACK_DENIED_BUYER_LIABLE"
    : "CLEAN_3WAY_SETTLEMENT";
  const headline = hasBuyerDispute
    ? "BUYER_LIABLE → Valid Mandate + Counter-Signed Intent (Chargeback Refused)"
    : "BUYER_LIABLE → Valid Mandate + Counter-Signed Intent (3-Way Match Settled)";
  const summary = hasBuyerDispute
    ? `Buyer chargeback claim ("${document.buyerDisputeClaim}") denied: ${receiptToEvaluate.receiptId} carries a verified ${receiptToEvaluate.buyer.algorithm} buyer signature over mandateHash ${receiptToEvaluate.buyer.payload.mandateHash.slice(0, 12)}…${cryptographicProof.humanOverrideVerified ? " plus verified human cryptographic override" : ""}, and supplier fulfilled all price, allergen, and delivery commitments. Full €${billedTotalEur.toFixed(2)} payable.`
    : `3-way match verified across counter-signed receipt ${receiptToEvaluate.receiptId}, delivery commitment (${sup.deliveryCommitment.latestAcceptableDate}), and invoice ${document.documentId}. Full €${billedTotalEur.toFixed(2)} approved for instant settlement.`;

  const latencyMs = Number(Math.max(0.001, performance.now() - start).toFixed(3));

  return DisputeRulingSchema.parse({
    rulingId: `RUL-${randomUUID().slice(0, 12).toUpperCase()}`,
    evaluatedAt: new Date().toISOString(),
    latencyMs,
    ruling: "BUYER_LIABLE",
    subVerdict,
    headline,
    summary,
    cryptographicProof,
    reconciliation: {
      contractedTotalEur,
      billedTotalEur,
      autoCreditEur: 0,
      netPayableEur: billedTotalEur,
      currency,
    },
    breaches: [],
    simulatedDocument: document,
  });
}

// ── PostgreSQL / PGlite Persistence Helpers ──

let tableInitState: { db: unknown; promise: Promise<void> } | null = null;

export async function ensureTradeReceiptsTable(): Promise<void> {
  const db = getDb();
  if (!tableInitState || tableInitState.db !== db) {
    const promise = db.exec(`
      CREATE TABLE IF NOT EXISTS trade_receipts (
        receipt_id TEXT PRIMARY KEY,
        order_id TEXT NOT NULL,
        intent_id TEXT NOT NULL,
        run_id TEXT NOT NULL,
        customer_id TEXT NOT NULL,
        receipt_hash TEXT NOT NULL,
        issued_at TEXT NOT NULL,
        json TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_trade_receipts_customer ON trade_receipts(customer_id, issued_at DESC);
      CREATE INDEX IF NOT EXISTS idx_trade_receipts_order ON trade_receipts(order_id, customer_id);
      CREATE INDEX IF NOT EXISTS idx_trade_receipts_intent ON trade_receipts(intent_id, customer_id);
    `);
    tableInitState = { db, promise };
  }
  await tableInitState.promise;
}

export async function saveTradeReceipt(receipt: TradeReceipt): Promise<TradeReceipt> {
  const validated = TradeReceiptSchema.parse(receipt);
  await ensureTradeReceiptsTable();
  await getDb().execute(
    `INSERT INTO trade_receipts (
      receipt_id, order_id, intent_id, run_id, customer_id, receipt_hash, issued_at, json
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
    ON CONFLICT (receipt_id) DO UPDATE SET
      order_id = excluded.order_id,
      intent_id = excluded.intent_id,
      run_id = excluded.run_id,
      customer_id = excluded.customer_id,
      receipt_hash = excluded.receipt_hash,
      issued_at = excluded.issued_at,
      json = excluded.json`,
    [
      validated.receiptId,
      validated.orderId,
      validated.intentId,
      validated.runId,
      validated.customerId,
      validated.receiptHash,
      validated.issuedAt,
      JSON.stringify(validated),
    ],
  );
  return validated;
}

export async function getTradeReceipt(
  id: string,
  customerId: string,
): Promise<TradeReceipt | null> {
  await ensureTradeReceiptsTable();
  const row = await getDb().queryOne<{ json: string }>(
    `SELECT json FROM trade_receipts
     WHERE customer_id = $2 AND (receipt_id = $1 OR order_id = $1 OR intent_id = $1)
     ORDER BY issued_at DESC
     LIMIT 1`,
    [id, customerId],
  );
  if (!row) return null;
  return TradeReceiptSchema.parse(JSON.parse(row.json));
}

export async function listTradeReceipts(customerId: string): Promise<TradeReceipt[]> {
  await ensureTradeReceiptsTable();
  const rows = await getDb().query<{ json: string }>(
    `SELECT json FROM trade_receipts WHERE customer_id = $1 ORDER BY issued_at DESC`,
    [customerId],
  );
  return rows.map((r) => TradeReceiptSchema.parse(JSON.parse(r.json)));
}
