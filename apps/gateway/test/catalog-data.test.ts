import "./setup-db.js";
import { test, before } from "node:test";
import assert from "node:assert/strict";
import {
  parseAllergens,
  parseCertifications,
  allergenConflicts,
  isLactoseFree,
} from "../src/catalog/productData.js";

test("allergen codes become plain names, CONTAINS vs MAY_CONTAIN", () => {
  const a = parseAllergens([
    { name: "allergen", values: [{ id: "AM", unit: "CONTAINS" }, { id: "SH", unit: "MAY_CONTAIN" }, { id: "AM", unit: "MAY_CONTAIN" }] },
  ]);
  assert.deepEqual(a.contains, ["milk"]);
  assert.deepEqual(a.mayContain, ["hazelnut"]); // a MAY_CONTAIN duplicate of a CONTAINS is dropped
});

test("exclusion words expand to the right allergen groups", () => {
  const c = (info: { contains: string[]; mayContain: string[] }, ex: string[], strict = true) => allergenConflicts(info, ex, strict).length;
  assert.equal(c({ contains: ["wheat"], mayContain: [] }, ["gluten"]), 1);
  assert.equal(c({ contains: ["oats"], mayContain: [] }, ["gluten"]), 1);
  assert.equal(c({ contains: ["hazelnut"], mayContain: [] }, ["nuts"]), 1);
  assert.equal(c({ contains: ["milk"], mayContain: [] }, ["nuts", "gluten"]), 0);
  assert.equal(c({ contains: [], mayContain: ["egg"] }, ["egg"]), 1);
  assert.equal(c({ contains: [], mayContain: ["egg"] }, ["egg"], false), 0, "non-strict ignores 'may contain'");
});

test("only real certifications are exposed (temperature markers are not certificates)", () => {
  const certs = parseCertifications([
    {
      name: "packagingMarkedLabel",
      values: [{ id: "coolTemperature" }, { id: "EU_ORGANIC_FARMING" }, { id: "MARINE_STEWARDSHIP_COUNCIL_LABEL" }],
    },
  ]);
  assert.deepEqual(certs, ["EU Organic", "MSC (sustainable fishing)"]);
});

test("lactose-free comes from the catalog claim; 'low lactose' never qualifies", () => {
  assert.equal(isLactoseFree({ name: "Milk", claims: ["free-from-lactose"] }), true);
  assert.equal(isLactoseFree({ name: "Valio Eila milk lactose free" }), true);
  assert.equal(isLactoseFree({ name: "Valio low lactose milk", claims: ["low-lactose"] }), false);
  assert.equal(isLactoseFree({ name: "Plain milk" }), false);
});

// ---- against the real catalog + signing ----
let cat: typeof import("../src/catalog/index.js");
let sign: typeof import("../src/claims/sign.js");
before(async () => {
  cat = await import("../src/catalog/index.js");
  sign = await import("../src/claims/sign.js");
  cat.loadCatalog();
});

test("real product facts are loaded (Valio Eila 10 L lactose-free milk)", () => {
  const p = cat.getProduct("463038");
  assert.ok(p);
  assert.equal(p.origin, "fi");
  assert.equal(p.producer, "Valio Oy");
  assert.ok(p.allergens?.includes("milk"));
  assert.ok(p.certifications?.includes("Hyvää Suomesta (Finnish goods)"));
  assert.ok(cat.isLactoseFree(p));
});

test("Valio-declared substitutes work in both directions", () => {
  assert.ok(cat.getValioSubstitutes("460027").includes("460065"));
  assert.ok(cat.getValioSubstitutes("460065").includes("460027"));
});

test("searching lactose-free never returns a product that isn't", () => {
  const res = cat.searchProducts({ q: "milk", lactoseFree: true, limit: 200 });
  assert.ok(res.length > 5);
  assert.ok(res.every((p) => cat.isLactoseFree(p)));
});

test("origin, allergens and certifications are inside the signed claim — and tamper-evident", () => {
  const attestation = cat.attestationFor("463038")!;
  assert.equal(attestation.origin, "FI");
  const env = sign.signClaim({
    customerId: "C",
    productId: "463038",
    unitPrice: 31.31,
    currency: "EUR",
    availableQuantity: null,
    salesUnit: null,
    validUntil: "2999-01-01T00:00:00Z",
    claimType: "price",
    attestation,
  });
  assert.equal(sign.verifyClaim(env).valid, true);
  // An agent (or middleman) that edits a *nested* attested fact must break the signature.
  const forged = structuredClone(env);
  forged.claim.attestation!.allergens = [];
  assert.equal(sign.verifyClaim(forged).valid, false);
  const forged2 = structuredClone(env);
  forged2.claim.attestation!.origin = "XX";
  assert.equal(sign.verifyClaim(forged2).valid, false);
});

test("search matches whole words — 'oat' is not 'goat' or 'coated'", () => {
  const res = cat.searchProducts({ q: "oat", limit: 300 });
  assert.ok(res.length > 3);
  assert.ok(res.every((p) => /(^|[^\p{L}\p{N}])oat/iu.test(`${p.name} ${p.nameFi ?? ""} ${(p.labels ?? []).join(" ")} ${p.brand ?? ""} ${p.category ?? ""} ${p.description ?? ""}`)));
  assert.ok(!res.some((p) => /goat cheese/i.test(p.name)));
});

test("hyphenated queries still match ('semi-skimmed', 'lactose-free')", () => {
  assert.ok(cat.searchProducts({ q: "semi-skimmed milk", limit: 5 }).length > 0);
  assert.ok(cat.searchProducts({ q: "lactose-free milk", limit: 5 }).length > 0);
});

test("goods sold per kilo get a 1 kg pack instead of being incompatible with kg needs", () => {
  const t = cat.getProduct("460027"); // loose tomatoes, sold by KG
  assert.ok(t);
  assert.equal(t.packUnit, "KG");
  assert.equal(t.packSize, 1);
});

test("relevance: products NAMED for the query rank above ones that merely mention it", () => {
  const res = cat.searchProducts({ q: "banana", limit: 5 });
  assert.ok(res.length >= 3);
  assert.ok(/^banana/i.test(res[0].name), `top hit should be a banana product, got: ${res[0].name}`);
  assert.ok(res.slice(0, 3).every((p) => /banana/i.test(p.name.split(/[^A-Za-z]+/)[0] ?? "")), "top 3 should all start with 'banana'");
});

test("relevance: a whole-word match beats a longer word that merely starts with it (egg ≠ eggplant, oat ≠ Oatly)", () => {
  const eggs = cat.searchProducts({ q: "egg", limit: 8 });
  assert.ok(!/^eggplant/i.test(eggs[0].name), `egg search led with: ${eggs[0].name}`);
  assert.ok(/\beggs?\b/i.test(eggs[0].name));
  const oats = cat.searchProducts({ q: "rolled oats", limit: 5 });
  assert.ok(oats.length > 0);
  assert.ok(oats.every((p) => /rolled/i.test(p.name) && /oats?/i.test(p.name)), `got: ${oats.map((p) => p.name).join(" | ")}`);
});
