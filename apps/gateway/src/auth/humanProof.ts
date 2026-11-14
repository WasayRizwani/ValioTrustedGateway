import { createHash, createPublicKey, verify } from "node:crypto";
import type { PolicyVerdict } from "@tta/shared";

export type WebAuthnSignatureInput = {
  mode: "webauthn";
  credentialId: string;
  publicKeySpki: string;
  authenticatorData: string;
  clientDataJSON: string;
  signature: string;
  signerLabel?: string;
};

export type WebCryptoP256SignatureInput = {
  mode: "webcrypto_p256";
  credentialId: string;
  publicKeySpki: string;
  signedMessage: string;
  signature: string;
  signerLabel?: string;
};

export type HumanSignatureInput = WebAuthnSignatureInput | WebCryptoP256SignatureInput;

export type HumanSignatureProof = {
  verified: boolean;
  mode: string;
  credentialId: string;
  signerLabel: string;
  signaturePrefix: string;
  verifiedAt: string;
};

export function fromBase64Any(input: string): Buffer {
  const clean = String(input ?? "").trim().replace(/\s+/g, "");
  const norm = clean.replace(/-/g, "+").replace(/_/g, "/");
  const padded = norm + "=".repeat((4 - (norm.length % 4)) % 4);
  return Buffer.from(padded, "base64");
}

function toBase64UrlClean(input: string): string {
  return String(input ?? "")
    .trim()
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
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

/**
 * Converts a 64-byte IEEE P1363 raw ECDSA signature `(r || s)` from WebCrypto into ASN.1 DER
 * for Node's `crypto.verify("sha256", ...)`. Passes existing DER signatures through untouched.
 */
export function p1363ToDer(sig: Buffer): Buffer {
  if (sig.length !== 64) return sig;
  if (sig[0] === 0x30 && sig[1] === 62 && sig[2] === 0x02) {
    const rLen = sig[3] ?? 0;
    if (4 + rLen < sig.length && sig[4 + rLen] === 0x02 && 6 + rLen + (sig[5 + rLen] ?? 0) === 64) {
      return sig;
    }
  }
  const r = encodeDerInt(sig.subarray(0, 32));
  const s = encodeDerInt(sig.subarray(32, 64));
  const body = Buffer.concat([r, s]);
  return Buffer.concat([Buffer.from([0x30, body.length]), body]);
}

/**
 * Deterministic approval challenge bound to intent ID, basket snapshotHash, and sorted failing rules.
 */
export function computeApprovalChallenge(intent: {
  id: string;
  snapshotHash: string;
  policy: Pick<PolicyVerdict, "failingRules">;
}): string {
  const rules = (intent.policy.failingRules ?? []).slice().sort().join(",");
  return createHash("sha256")
    .update(`${intent.id}:${intent.snapshotHash}:${rules}`, "utf8")
    .digest("base64url");
}

function loadSpkiPublicKey(publicKeySpki: string) {
  const trimmed = String(publicKeySpki ?? "").trim();
  if (!trimmed) throw new Error("invalid_human_signature: missing publicKeySpki");
  if (trimmed.includes("BEGIN PUBLIC KEY")) {
    return createPublicKey(trimmed);
  }
  return createPublicKey({
    key: fromBase64Any(trimmed),
    format: "der",
    type: "spki",
  });
}

export function verifyHumanSignature(
  intent: { id: string; snapshotHash: string; policy: Pick<PolicyVerdict, "failingRules"> },
  input: unknown,
): HumanSignatureProof {
  if (!input || typeof input !== "object") {
    throw new Error("invalid_human_signature: signature payload must be an object");
  }
  const sig = input as Record<string, unknown>;
  const mode = String(sig.mode ?? "");
  const credentialId = String(sig.credentialId ?? "").trim();
  if (!credentialId) {
    throw new Error("invalid_human_signature: credentialId is required");
  }
  const expectedChallenge = computeApprovalChallenge(intent);

  if (mode === "webauthn") {
    const authDataStr = String(sig.authenticatorData ?? "");
    const clientDataStr = String(sig.clientDataJSON ?? "");
    const signatureStr = String(sig.signature ?? "");
    if (!authDataStr || !clientDataStr || !signatureStr) {
      throw new Error("invalid_human_signature: webauthn requires authenticatorData, clientDataJSON, and signature");
    }
    const authDataBuf = fromBase64Any(authDataStr);
    if (authDataBuf.length < 37) {
      throw new Error("invalid_human_signature: authenticatorData too short");
    }
    const clientDataBuf = clientDataStr.trim().startsWith("{")
      ? Buffer.from(clientDataStr, "utf8")
      : fromBase64Any(clientDataStr);
    let clientData: { challenge?: string; type?: string };
    try {
      clientData = JSON.parse(clientDataBuf.toString("utf8")) as { challenge?: string; type?: string };
    } catch {
      throw new Error("invalid_human_signature: malformed clientDataJSON");
    }
    if (clientData.type && clientData.type !== "webauthn.get") {
      throw new Error(`invalid_human_signature: unexpected clientData type "${clientData.type}"`);
    }
    const gotChallenge = toBase64UrlClean(String(clientData.challenge ?? ""));
    const utf8ChallengeB64 = Buffer.from(expectedChallenge, "utf8").toString("base64url");
    if (!gotChallenge || (gotChallenge !== expectedChallenge && gotChallenge !== utf8ChallengeB64)) {
      throw new Error("invalid_human_signature: WebAuthn challenge mismatch");
    }

    const pubKey = loadSpkiPublicKey(String(sig.publicKeySpki ?? ""));
    const rawSig = fromBase64Any(signatureStr);
    const signedBytes = Buffer.concat([authDataBuf, createHash("sha256").update(clientDataBuf).digest()]);
    const ok =
      pubKey.asymmetricKeyType === "ed25519"
        ? verify(null, signedBytes, pubKey, rawSig)
        : verify("sha256", signedBytes, pubKey, rawSig.length === 64 ? p1363ToDer(rawSig) : rawSig);
    if (!ok) {
      throw new Error("invalid_human_signature: WebAuthn cryptographic verification failed");
    }
    return {
      verified: true,
      mode: "webauthn",
      credentialId,
      signerLabel: String(sig.signerLabel ?? "").trim() || "Hardware Passkey (WebAuthn)",
      signaturePrefix: rawSig.toString("hex").slice(0, 16),
      verifiedAt: new Date().toISOString(),
    };
  }

  if (mode === "webcrypto_p256") {
    const signedMessage = String(sig.signedMessage ?? "");
    const signatureStr = String(sig.signature ?? "");
    if (!signedMessage || !signatureStr) {
      throw new Error("invalid_human_signature: webcrypto_p256 requires signedMessage and signature");
    }
    if (!signedMessage.includes(expectedChallenge)) {
      throw new Error("invalid_human_signature: signedMessage does not contain expected approval challenge");
    }
    const pubKey = loadSpkiPublicKey(String(sig.publicKeySpki ?? ""));
    const rawSig = fromBase64Any(signatureStr);
    const derSig = p1363ToDer(rawSig);
    const ok = verify("sha256", Buffer.from(signedMessage, "utf8"), pubKey, derSig);
    if (!ok) {
      throw new Error("invalid_human_signature: ECDSA P-256 signature verification failed");
    }
    return {
      verified: true,
      mode: "webcrypto_p256",
      credentialId,
      signerLabel: String(sig.signerLabel ?? "").trim() || "Cryptographic Buyer Key (ECDSA P-256)",
      signaturePrefix: rawSig.toString("hex").slice(0, 16),
      verifiedAt: new Date().toISOString(),
    };
  }

  throw new Error(`invalid_human_signature: unsupported signature mode "${mode}"`);
}
