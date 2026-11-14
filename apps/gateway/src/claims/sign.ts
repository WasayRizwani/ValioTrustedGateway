import {
  createPrivateKey,
  createPublicKey,
  sign,
  verify,
  createHash,
  randomUUID,
} from "node:crypto";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import type { ClaimPayload, ClaimSubject, SignedClaim } from "@tta/shared";
import { config } from "../config.js";

function loadKeys() {
  const privPath = resolve(config.keysDir, "claim-ed25519-private.pem");
  const pubPath = resolve(config.keysDir, "claim-ed25519-public.pem");
  if (!existsSync(privPath) || !existsSync(pubPath)) {
    throw new Error("Claim keys missing. Run npm run gen-keys -w @tta/gateway");
  }
  return {
    privateKey: createPrivateKey(readFileSync(privPath)),
    publicKey: createPublicKey(readFileSync(pubPath)),
    publicPem: readFileSync(pubPath, "utf8"),
  };
}

let cached: ReturnType<typeof loadKeys> | null = null;

function keys() {
  if (!cached) cached = loadKeys();
  return cached;
}

/** Deterministic JSON: object keys sorted at EVERY level (nested attestation fields are signed too). */
function canon(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(canon);
  if (v && typeof v === "object")
    return Object.fromEntries(
      Object.entries(v as Record<string, unknown>)
        .filter(([, x]) => x !== undefined)
        .sort(([a], [b]) => (a < b ? -1 : 1))
        .map(([k, x]) => [k, canon(x)]),
    );
  return v;
}

export const CLAIM_ISSUER = "valio-aimo-gateway";
export const CLAIM_VERSION = 2;

export function canonicalClaimJson(claim: ClaimPayload): string {
  return JSON.stringify(canon(claim));
}

/** Bytes that are actually signed (v2): envelope metadata AND the claim, so issuer/keyId/asOf are tamper-evident. */
export function canonicalEnvelopeJson(e: Omit<SignedClaim, "signature">): string {
  return JSON.stringify(
    canon({
      version: e.version,
      claimId: e.claimId,
      issuer: e.issuer,
      keyId: e.keyId,
      asOf: e.asOf,
      subject: e.subject,
      claim: e.claim,
    }),
  );
}

export function signClaim(claim: ClaimPayload, opts?: { subject?: ClaimSubject }): SignedClaim {
  const { privateKey } = keys();
  const unsigned: Omit<SignedClaim, "signature"> = {
    version: CLAIM_VERSION,
    claimId: randomUUID(), // nonce: every issued claim is unique, enabling replay detection downstream
    claim,
    issuer: CLAIM_ISSUER,
    keyId: config.claimKeyId,
    asOf: new Date().toISOString(),
    ...(opts?.subject ? { subject: opts.subject } : {}),
  };
  const signature = sign(null, Buffer.from(canonicalEnvelopeJson(unsigned)), privateKey).toString("base64url");
  return { ...unsigned, signature };
}

/**
 * Verifies signature over the full v2 envelope, expiry, and (optionally) that the claim is bound to the
 * expected subject. Legacy v1 envelopes (signature over `claim` only) are rejected: their issuer/asOf were unprotected.
 */
export function verifyClaim(
  envelope: SignedClaim,
  expect?: { subject?: ClaimSubject; customerId?: string },
): {
  valid: boolean;
  reason?: string;
} {
  try {
    const { publicKey } = keys();
    if (envelope.version !== CLAIM_VERSION || !envelope.claimId) {
      return { valid: false, reason: "unsupported_version" };
    }
    if (envelope.issuer !== CLAIM_ISSUER) {
      return { valid: false, reason: "unknown_issuer" };
    }
    if (envelope.keyId !== config.claimKeyId) {
      return { valid: false, reason: "unknown_key_id" };
    }
    const ok = verify(
      null,
      Buffer.from(canonicalEnvelopeJson(envelope)),
      publicKey,
      Buffer.from(envelope.signature, "base64url"),
    );
    if (!ok) return { valid: false, reason: "bad_signature" };
    if (new Date(envelope.claim.validUntil).getTime() < Date.now()) {
      return { valid: false, reason: "expired" };
    }
    if (expect?.customerId && envelope.claim.customerId !== expect.customerId) {
      return { valid: false, reason: "customer_mismatch" };
    }
    if (expect?.subject) {
      for (const k of ["quoteId", "intentId"] as const) {
        const want = expect.subject[k];
        if (want !== undefined && envelope.subject?.[k] !== want) {
          return { valid: false, reason: "subject_mismatch" };
        }
      }
    }
    return { valid: true };
  } catch (e) {
    return { valid: false, reason: e instanceof Error ? e.message : "verify_error" };
  }
}

/** Standard OKP/Ed25519 JWK (kid, x) for the current key; extra fields kept by the JWKS route for compatibility. */
export function getPublicJwk() {
  const jwk = keys().publicKey.export({ format: "jwk" }) as { kty: string; crv: string; x: string };
  return { kid: config.claimKeyId, kty: jwk.kty, crv: jwk.crv, x: jwk.x, alg: "EdDSA", use: "sig" };
}

export function getPublicKeyPem(): string {
  return keys().publicPem;
}

export function snapshotHash(value: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(canon(value)))
    .digest("hex");
}
