/**
 * Real product facts from the Valio Aimo catalog (synkkaData): allergens, certifications,
 * nutritional claims, origin and producer — instead of guessing from product names.
 */

export type AllergenInfo = { contains: string[]; mayContain: string[] };

/**
 * Catalog allergen codes (GS1-style) → plain-language groups. Codes verified against product names in the
 * dataset (e.g. AM on milk products, AF on fish, BM on mustard dressings, AC on lobster fond).
 * Codes not listed here are shown verbatim and still count as "something is declared".
 */
const CODE_NAME: Record<string, string> = {
  AM: "milk", ML: "milk", AE: "egg", AF: "fish", AC: "crustaceans", UM: "molluscs",
  AY: "soy", AP: "peanut", AS: "sesame", BM: "mustard", BC: "celery", AU: "sulphites",
  AW: "wheat", UW: "wheat", GB: "barley", GO: "oats", GS: "spelt", GK: "khorasan wheat", NR: "rye",
  AN: "tree nuts", SA: "almond", SH: "hazelnut", SW: "walnut", SP: "pecan", SR: "brazil nut",
  SM: "macadamia", ST: "pistachio", SC: "cashew", NL: "lupin",
};

/** User-facing exclusion words → the allergen names that satisfy them. */
const EXCLUSION_GROUPS: Record<string, string[]> = {
  milk: ["milk"], dairy: ["milk"], lactose: ["milk"],
  egg: ["egg"], eggs: ["egg"],
  fish: ["fish"], shellfish: ["crustaceans", "molluscs"], crustaceans: ["crustaceans"], molluscs: ["molluscs"],
  soy: ["soy"], soya: ["soy"],
  peanut: ["peanut"], peanuts: ["peanut"],
  nuts: ["tree nuts", "almond", "hazelnut", "walnut", "pecan", "brazil nut", "macadamia", "pistachio", "cashew"],
  "tree nuts": ["tree nuts", "almond", "hazelnut", "walnut", "pecan", "brazil nut", "macadamia", "pistachio", "cashew"],
  sesame: ["sesame"], mustard: ["mustard"], celery: ["celery"], sulphites: ["sulphites"], lupin: ["lupin"],
  gluten: ["wheat", "barley", "oats", "spelt", "khorasan wheat", "rye"],
  wheat: ["wheat"], oats: ["oats"], barley: ["barley"], rye: ["rye"],
};

export function allergenName(code: string): string {
  return CODE_NAME[code] ?? `allergen code ${code}`;
}

export function parseAllergens(classifications: unknown): AllergenInfo {
  const contains = new Set<string>();
  const may = new Set<string>();
  for (const c of (classifications as Array<Record<string, unknown>>) ?? []) {
    if (c.name !== "allergen") continue;
    for (const v of (c.values as Array<{ id: string; unit?: string }>) ?? []) {
      if (v.unit === "CONTAINS") contains.add(allergenName(v.id));
      else if (v.unit === "MAY_CONTAIN") may.add(allergenName(v.id));
    }
  }
  for (const n of contains) may.delete(n);
  return { contains: [...contains].sort(), mayContain: [...may].sort() };
}

/** Does this product declare any of the excluded allergens? `strict` also counts "may contain". */
export function allergenConflicts(
  info: { contains: string[]; mayContain: string[] },
  excluded: string[],
  strict = true,
): Array<{ excluded: string; found: string; level: "contains" | "may contain" }> {
  const out: Array<{ excluded: string; found: string; level: "contains" | "may contain" }> = [];
  for (const ex of excluded) {
    const key = ex.toLowerCase().trim();
    const group = EXCLUSION_GROUPS[key] ?? [key];
    for (const a of info.contains) if (group.some((g) => a.includes(g))) out.push({ excluded: ex, found: a, level: "contains" });
    if (strict)
      for (const a of info.mayContain) if (group.some((g) => a.includes(g))) out.push({ excluded: ex, found: a, level: "may contain" });
  }
  return out;
}

/**
 * Extract non-lactose allergen exclusions from `mandate.allergenRestrictions` (e.g. "nuts", "gluten", "milk", "egg", "soy", "fish").
 * Blocking "nuts" in Kitchen Rules also blocks "peanut" so peanut butter and peanut traces are caught too.
 */
export function extractMandateExcludedAllergens(allergenRestrictions?: string[] | null): string[] {
  const out: string[] = [];
  for (const raw of allergenRestrictions ?? []) {
    if (!raw || raw === "must_be_lactose_free") continue;
    const cleaned = raw
      .trim()
      .toLowerCase()
      .replace(/^must_be_/, "")
      .replace(/_free$/, "")
      .replace(/_/g, " ")
      .trim();
    if (!cleaned || cleaned === "lactose") continue;
    out.push(cleaned);
    if (cleaned === "nuts" || cleaned === "tree nuts" || cleaned === "nut") {
      if (cleaned === "nut") out.push("nuts");
      out.push("peanut");
    }
  }
  return [...new Set(out)];
}

/** Expand explicit `excludeAllergens` entries so `"nuts"` also covers `"peanut"`. */
export function expandExcludedAllergens(excluded?: string[] | null): string[] {
  const out: string[] = [];
  for (const raw of excluded ?? []) {
    const k = raw.trim().toLowerCase();
    if (!k) continue;
    out.push(k);
    if (k === "nuts" || k === "tree nuts" || k === "nut") {
      if (k === "nut") out.push("nuts");
      out.push("peanut");
    }
  }
  return [...new Set(out)];
}

const CERT_NAME: Record<string, string> = {
  EU_ORGANIC_FARMING: "EU Organic",
  SVANEN: "Nordic Swan Ecolabel",
  EU_ECO_LABEL: "EU Ecolabel",
  RAINFOREST_ALLIANCE: "Rainforest Alliance",
  MARINE_STEWARDSHIP_COUNCIL_LABEL: "MSC (sustainable fishing)",
  AQUACULTURE_STEWARDSHIP_COUNCIL: "ASC (responsible aquaculture)",
  FAIR_TRADE_MARK: "Fairtrade",
  KRAV_MARK: "KRAV",
  OFFICIAL_ECO_LABEL_SUN: "Official eco label",
  SOIL_ASSOCIATION_ORGANIC_SYMBOL: "Soil Association Organic",
  UTZ_CERTIFIED: "UTZ certified",
  DOLPHIN_SAFE: "Dolphin safe",
  GOODS_FROM_FINLAND_BLUE_SWAN: "Hyvää Suomesta (Finnish goods)",
  MADE_IN_FINLAND_FLAG_WITH_KEY: "Key Flag (made in Finland)",
  FINNISH_HEART_SYMBOL: "Finnish Heart Symbol",
  PUHTAASTI_KOTIMAINEN: "Puhtaasti kotimainen",
};

/** Packaging labels that are certifications / origin marks (temperature markers are not). */
export function parseCertifications(classifications: unknown): string[] {
  const out = new Set<string>();
  for (const c of (classifications as Array<Record<string, unknown>>) ?? []) {
    if (c.name !== "packagingMarkedLabel") continue;
    for (const v of (c.values as Array<{ id: string }>) ?? []) if (CERT_NAME[v.id]) out.add(CERT_NAME[v.id]);
  }
  return [...out];
}

export function parseClaims(classifications: unknown): string[] {
  const out: string[] = [];
  for (const c of (classifications as Array<Record<string, unknown>>) ?? []) {
    if (c.name !== "nutritionalClaim") continue;
    for (const v of (c.values as Array<{ id: string }>) ?? []) out.push(v.id.toLowerCase().replace(/_/g, "-"));
  }
  return out;
}

/** Lactose-free per the catalog's own nutritional claim, falling back to the product name. */
export function isLactoseFree(p: { name: string; nameFi?: string; labels?: string[]; claims?: string[] }): boolean {
  if (p.claims?.includes("free-from-lactose")) return true;
  if (p.labels?.includes("lactose-free")) return true;
  const hay = `${p.name} ${p.nameFi ?? ""}`.toLowerCase();
  return /lactose[\s-]?free|laktoositon|laktosfri/.test(hay);
}

const REGION = new Intl.DisplayNames(["en"], { type: "region" });
export function originName(code: string | null | undefined): string | null {
  if (!code) return null;
  try {
    return REGION.of(code.toUpperCase()) ?? code.toUpperCase();
  } catch {
    return code.toUpperCase();
  }
}
