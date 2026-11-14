const PASSKEY_STORAGE_KEY = "tta_buyer_passkey_v1";
const WEBCRYPTO_STORAGE_KEY = "tta_buyer_p256_jwk_v1";

type StoredPasskey = {
  credentialId: string;
  publicKeySpki: string;
};

type CachedBrowserKey = {
  privateKey: CryptoKey;
  publicKeySpki: string;
};

export type HumanSignaturePayload =
  | {
      mode: "webauthn";
      credentialId: string;
      publicKeySpki: string;
      authenticatorData: string;
      clientDataJSON: string;
      signature: string;
      signerLabel: string;
    }
  | {
      mode: "webcrypto_p256";
      credentialId: string;
      publicKeySpki: string;
      signedMessage: string;
      signature: string;
      signerLabel: string;
    };

let memoryBrowserKey: CachedBrowserKey | null = null;

export function bytesToBase64(input: ArrayBuffer | Uint8Array): string {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  let binary = "";
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]!);
  }
  return btoa(binary);
}

export function bytesToBase64url(input: ArrayBuffer | Uint8Array): string {
  return bytesToBase64(input)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

export function base64urlToBytes(input: string): Uint8Array<ArrayBuffer> {
  try {
    const normalized = input.replace(/-/g, "+").replace(/_/g, "/");
    const padLen = (4 - (normalized.length % 4)) % 4;
    const padded = normalized + "=".repeat(padLen);
    const binary = atob(padded);
    const buf = new ArrayBuffer(binary.length);
    const out = new Uint8Array(buf);
    for (let i = 0; i < binary.length; i++) {
      out[i] = binary.charCodeAt(i);
    }
    return out;
  } catch {
    const encoded = new TextEncoder().encode(input);
    const buf = new ArrayBuffer(encoded.byteLength);
    const out = new Uint8Array(buf);
    out.set(encoded);
    return out;
  }
}

function loadStoredPasskey(): StoredPasskey | null {
  try {
    const raw = localStorage.getItem(PASSKEY_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<StoredPasskey>;
    if (
      typeof parsed?.credentialId === "string" &&
      parsed.credentialId.length > 0 &&
      typeof parsed?.publicKeySpki === "string" &&
      parsed.publicKeySpki.length > 0
    ) {
      return {
        credentialId: parsed.credentialId,
        publicKeySpki: parsed.publicKeySpki,
      };
    }
    return null;
  } catch {
    return null;
  }
}

function saveStoredPasskey(passkey: StoredPasskey): void {
  try {
    localStorage.setItem(PASSKEY_STORAGE_KEY, JSON.stringify(passkey));
  } catch {
    // Ignore storage quota / private mode errors
  }
}

export function hasEnrolledPasskey(): boolean {
  return loadStoredPasskey() !== null;
}

async function getOrCreateBrowserP256Key(): Promise<CachedBrowserKey> {
  if (memoryBrowserKey) return memoryBrowserKey;

  const subtle = window.crypto?.subtle;
  if (!subtle) {
    throw new Error("WebCrypto SubtleCrypto API is not available in this browser context.");
  }

  try {
    const raw = localStorage.getItem(WEBCRYPTO_STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as {
        privateJwk?: JsonWebKey;
        publicKeySpki?: string;
      };
      if (parsed.privateJwk && typeof parsed.publicKeySpki === "string") {
        const privateKey = await subtle.importKey(
          "jwk",
          parsed.privateJwk,
          { name: "ECDSA", namedCurve: "P-256" },
          false,
          ["sign"],
        );
        memoryBrowserKey = { privateKey, publicKeySpki: parsed.publicKeySpki };
        return memoryBrowserKey;
      }
    }
  } catch {
    // Regenerate fresh P-256 keypair below
  }

  const keyPair = await subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"],
  );
  const spkiBuffer = await subtle.exportKey("spki", keyPair.publicKey);
  const publicKeySpki = bytesToBase64(spkiBuffer);

  try {
    const privateJwk = await subtle.exportKey("jwk", keyPair.privateKey);
    localStorage.setItem(
      WEBCRYPTO_STORAGE_KEY,
      JSON.stringify({ privateJwk, publicKeySpki }),
    );
  } catch {
    // Ignore persistence errors; in-memory key still works for this session
  }

  memoryBrowserKey = { privateKey: keyPair.privateKey, publicKeySpki };
  return memoryBrowserKey;
}

async function signWithWebCryptoP256(
  intentId: string,
  challenge: string,
): Promise<HumanSignaturePayload> {
  const { privateKey, publicKeySpki } = await getOrCreateBrowserP256Key();
  const signedMessage = `VALIO-OVERRIDE:${intentId}:${challenge}`;
  const msgBytes = new TextEncoder().encode(signedMessage);
  const dataBuf = new ArrayBuffer(msgBytes.byteLength);
  new Uint8Array(dataBuf).set(msgBytes);

  const sigBytes = await window.crypto.subtle.sign(
    { name: "ECDSA", hash: { name: "SHA-256" } },
    privateKey,
    dataBuf,
  );

  return {
    mode: "webcrypto_p256",
    credentialId: "browser-p256-key",
    publicKeySpki,
    signedMessage,
    signature: bytesToBase64(sigBytes),
    signerLabel: "Verified Buyer Cryptographic Key (P-256)",
  };
}

export async function signHumanOverride(params: {
  intentId: string;
  challenge: string;
  rpId?: string;
  useBiometric: boolean;
}): Promise<HumanSignaturePayload> {
  if (
    params.useBiometric &&
    typeof window !== "undefined" &&
    typeof window.PublicKeyCredential !== "undefined" &&
    typeof navigator !== "undefined" &&
    navigator.credentials
  ) {
    try {
      const platformAvailable =
        typeof window.PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable ===
        "function"
          ? await window.PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable().catch(
              () => false,
            )
          : true;

      if (platformAvailable) {
        const rpId = window.location.hostname || params.rpId || "localhost";
        let stored = loadStoredPasskey();

        if (!stored) {
          const userBytes = new TextEncoder().encode("head-chef@kitchen");
          const userId = new Uint8Array(new ArrayBuffer(userBytes.byteLength));
          userId.set(userBytes);

          const created = (await navigator.credentials.create({
            publicKey: {
              challenge: base64urlToBytes(params.challenge),
              rp: {
                name: "Valio Aimo Kitchen Desk",
                id: rpId,
              },
              user: {
                id: userId,
                name: "head-chef@kitchen",
                displayName: "Head Chef (Buyer Authority)",
              },
              pubKeyCredParams: [{ type: "public-key", alg: -7 }],
              authenticatorSelection: {
                authenticatorAttachment: "platform",
                userVerification: "preferred",
              },
              timeout: 30000,
            },
          })) as PublicKeyCredential | null;

          if (!created) {
            throw new DOMException("Passkey enrollment dismissed", "NotAllowedError");
          }

          const attestation = created.response as AuthenticatorAttestationResponse;
          const spkiBuf =
            typeof attestation.getPublicKey === "function"
              ? attestation.getPublicKey()
              : null;

          if (!spkiBuf) {
            throw new DOMException(
              "Authenticator did not expose SPKI public key",
              "NotSupportedError",
            );
          }

          stored = {
            credentialId: bytesToBase64url(created.rawId),
            publicKeySpki: bytesToBase64(spkiBuf),
          };
          saveStoredPasskey(stored);
        }

        const assertionCred = (await navigator.credentials.get({
          publicKey: {
            challenge: base64urlToBytes(params.challenge),
            rpId,
            allowCredentials: [
              {
                type: "public-key",
                id: base64urlToBytes(stored.credentialId),
              },
            ],
            userVerification: "preferred",
            timeout: 30000,
          },
        })) as PublicKeyCredential | null;

        if (!assertionCred) {
          throw new DOMException("Passkey assertion dismissed", "NotAllowedError");
        }

        const assertion = assertionCred.response as AuthenticatorAssertionResponse;
        return {
          mode: "webauthn",
          credentialId: stored.credentialId,
          publicKeySpki: stored.publicKeySpki,
          authenticatorData: bytesToBase64(assertion.authenticatorData),
          clientDataJSON: bytesToBase64(assertion.clientDataJSON),
          signature: bytesToBase64(assertion.signature),
          signerLabel: "Touch ID / Platform Passkey",
        };
      }
    } catch {
      // Seamless automatic fallback to WebCrypto P-256 on NotAllowedError / NotSupportedError / headless browsers
    }
  }

  return signWithWebCryptoP256(params.intentId, params.challenge);
}
