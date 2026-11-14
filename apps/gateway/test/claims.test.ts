import "./setup-db.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import * as sign from "../src/claims/sign.js";

const base = {
  customerId: "C", productId: "P1", unitPrice: 1, currency: "EUR", availableQuantity: null,
  salesUnit: null, validUntil: "2999-01-01T00:00:00Z", claimType: "price" as const,
};

test("v2 claim carries version, claimId, issuer, keyId, asOf and verifies", () => {
  const e = sign.signClaim(base);
  assert.equal(e.version, 2);
  assert.ok(e.claimId && e.asOf && e.issuer && e.keyId);
  assert.notEqual(sign.signClaim(base).claimId, e.claimId); // unique nonce
  assert.equal(sign.verifyClaim(e).valid, true);
});

test("tampering with any signed envelope field fails", () => {
  const e = sign.signClaim(base, { subject: { quoteId: "Q1" } });
  const muts: Array<(x: typeof e) => void> = [
    (x) => { x.asOf = "2020-01-01T00:00:00.000Z"; },
    (x) => { x.claimId = "other"; },
    (x) => { x.subject = { quoteId: "Q2" }; },
    (x) => { delete x.subject; },
    (x) => { x.claim.unitPrice = 0.01; },
    (x) => { x.claim.validUntil = "3999-01-01T00:00:00Z"; },
    (x) => { x.signature = `${x.signature[0] === "A" ? "B" : "A"}${x.signature.slice(1)}`; },
  ];
  for (const m of muts) {
    const f = structuredClone(e);
    m(f);
    assert.equal(sign.verifyClaim(f).valid, false);
  }
  // issuer / keyId are checked explicitly
  assert.equal(sign.verifyClaim({ ...structuredClone(e), issuer: "evil" }).reason, "unknown_issuer");
  assert.equal(sign.verifyClaim({ ...structuredClone(e), keyId: "k2" }).reason, "unknown_key_id");
});

test("legacy v1 envelopes are rejected", () => {
  const e = sign.signClaim(base);
  assert.equal(sign.verifyClaim({ ...e, version: 1 }).reason, "unsupported_version");
});

test("subject binding", () => {
  const e = sign.signClaim(base, { subject: { quoteId: "Q1" } });
  assert.equal(sign.verifyClaim(e, { subject: { quoteId: "Q1" } }).valid, true);
  assert.equal(sign.verifyClaim(e, { subject: { quoteId: "Q9" } }).reason, "subject_mismatch");
  assert.equal(sign.verifyClaim(sign.signClaim(base), { subject: { intentId: "I" } }).reason, "subject_mismatch");
});

test("expired claims fail; JWK is well-formed", () => {
  assert.equal(sign.verifyClaim(sign.signClaim({ ...base, validUntil: "2000-01-01T00:00:00Z" })).reason, "expired");
  const jwk = sign.getPublicJwk();
  assert.equal(jwk.kty, "OKP");
  assert.equal(jwk.crv, "Ed25519");
  assert.ok(jwk.x.length >= 43 && jwk.kid);
});

test("customer binding rejects claims issued to another customer", () => {
  const signed = sign.signClaim({ ...base, customerId: "HOTEL-001" });
  assert.deepEqual(sign.verifyClaim(signed, { customerId: "SCHOOL-001" }), {
    valid: false,
    reason: "customer_mismatch",
  });
});
