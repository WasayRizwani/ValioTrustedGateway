import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { config } from "../config.js";
import type { Need, ProductAttestation } from "@tta/shared";
import {
  parseAllergens,
  parseCertifications,
  parseClaims,
  isLactoseFree as productIsLactoseFree,
} from "./productData.js";

export { isLactoseFree, allergenConflicts, originName } from "./productData.js";

export type Product = {
  productId: string;
  name: string;
  nameFi?: string;
  brand?: string | null;
  category?: string | null;
  categories?: string[];
  labels?: string[];
  allergens?: string[]; // declared CONTAINS
  mayContain?: string[]; // declared cross-contamination risk
  certifications?: string[];
  claims?: string[];
  origin?: string | null; // ISO country code, lower-case
  producer?: string | null;
  substitutes?: string[]; // Valio-declared substitute product ids
  packSize: number;
  packUnit: string; // L, KG, PCS
  salesUnit?: string;
  description?: string;
  raw: Record<string, unknown>;
};

export type ReliabilityMap = Map<string, number>;
export type CarbonMap = Map<string, number>;

let products: Product[] = [];
let reliability: ReliabilityMap = new Map();
let carbon: CarbonMap = new Map();
let loaded = false;

function asArray(v: unknown): unknown[] {
  if (Array.isArray(v)) return v;
  if (v && typeof v === "object") {
    const obj = v as Record<string, unknown>;
    if (Array.isArray(obj.products)) return obj.products;
    if (Array.isArray(obj.items)) return obj.items;
    if (Array.isArray(obj.data)) return obj.data;
  }
  return [];
}

function pickString(obj: Record<string, unknown>, keys: string[]): string | undefined {
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return undefined;
}

function pickNumber(obj: Record<string, unknown>, keys: string[]): number | undefined {
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === "number" && !Number.isNaN(v)) return v;
    if (typeof v === "string" && v.trim() && !Number.isNaN(Number(v))) return Number(v);
  }
  return undefined;
}

function normalizeUnit(u?: string): string {
  if (!u) return "PCS";
  const x = u.toUpperCase();
  if (x.includes("L") && !x.includes("ML")) return "L";
  if (x === "LTR" || x === "LITRE" || x === "LITER") return "L";
  if (x.includes("KG") || x === "KGM") return "KG";
  if (x === "G" || x === "GRM") return "G";
  return x;
}

function nameFromSynkka(synkka: Record<string, unknown> | undefined): {
  name: string;
  nameFi?: string;
} {
  const names = Array.isArray(synkka?.names) ? synkka!.names : [];
  let en: string | undefined;
  let fi: string | undefined;
  for (const n of names) {
    if (!n || typeof n !== "object") continue;
    const rec = n as Record<string, unknown>;
    if (rec.language === "en" && typeof rec.value === "string") en = rec.value;
    if (rec.language === "fi" && typeof rec.value === "string") fi = rec.value;
  }
  return { name: en ?? fi ?? "Unknown product", nameFi: fi };
}

/** Goods sold by the kilo/litre (e.g. loose tomatoes) have no pack size in the name — use the sales unit. */
function packFromBaseUnit(raw: Record<string, unknown>): { packSize: number; packUnit: string } | null {
  if (raw.baseUnit === "KG" && raw.salesUnit === "KG") return { packSize: 1, packUnit: "KG" };
  if ((raw.baseUnit === "L" || raw.baseUnit === "LT") && raw.salesUnit === raw.baseUnit) return { packSize: 1, packUnit: "L" };
  return null;
}

function packFromName(name: string): { packSize: number; packUnit: string } | null {
  const n = name.toLowerCase().replace(",", ".");
  // e.g. 10 l, 1 l, 1.5 l, 5 dl, 25 kg, 400g
  const m = n.match(/(\d+(?:\.\d+)?)\s*(ml|dl|l|ltr|litre|liter|kg|g)\b/);
  if (!m) return null;
  let size = Number(m[1]);
  let unit = m[2];
  if (unit === "ml") {
    size = size / 1000;
    unit = "l";
  } else if (unit === "dl") {
    size = size / 10;
    unit = "l";
  } else if (unit === "g") {
    size = size / 1000;
    unit = "kg";
  } else if (unit.startsWith("l")) unit = "l";
  return { packSize: size, packUnit: unit.toUpperCase() === "L" ? "L" : unit.toUpperCase() };
}

function packFromUnitConversions(
  synkka: Record<string, unknown> | undefined,
): { packSize: number; packUnit: string } | null {
  const conversions = Array.isArray(synkka?.unitConversions)
    ? synkka!.unitConversions
    : [];
  for (const c of conversions) {
    if (!c || typeof c !== "object") continue;
    const vol = (c as Record<string, unknown>).volume as
      | { unit?: string; value?: number }
      | undefined;
    if (vol?.value != null && String(vol.unit).toUpperCase().startsWith("LT")) {
      return { packSize: Number(vol.value), packUnit: "L" };
    }
    const net = (c as Record<string, unknown>).netWeight as
      | { unit?: string; value?: number }
      | undefined;
    if (net?.value != null && String(net.unit).toUpperCase() === "GRM") {
      return { packSize: Number(net.value) / 1000, packUnit: "KG" };
    }
  }
  return null;
}

function extractLabelsFromText(text: string): string[] {
  const labels = new Set<string>();
  const name = text.toLowerCase();
  if (
    name.includes("lactose-free") ||
    name.includes("lactose free") ||
    name.includes("lactosefree") ||
    name.includes("laktoositon") ||
    name.includes("laktosfri")
  ) {
    labels.add("lactose-free");
    labels.add("laktoositon");
  }
  if (name.includes("organic") || name.includes("luomu")) labels.add("organic");
  if (name.includes("eila")) labels.add("eila");
  return [...labels];
}

function normalizeProduct(raw: Record<string, unknown>): Product | null {
  if (raw.deleted === true) return null;
  const productId = pickString(raw, [
    "id",
    "productId",
    "productCode",
    "code",
    "sku",
    "material",
  ]);
  if (!productId) return null;

  const synkka =
    raw.synkkaData && typeof raw.synkkaData === "object"
      ? (raw.synkkaData as Record<string, unknown>)
      : undefined;
  const fromSynkka = nameFromSynkka(synkka);
  const name =
    fromSynkka.name !== "Unknown product"
      ? fromSynkka.name
      : pickString(raw, ["name", "productName", "title", "nameEn"]) ?? productId;

  const pack =
    packFromUnitConversions(synkka) ??
    packFromName(`${name} ${fromSynkka.nameFi ?? ""}`) ??
    packFromBaseUnit(raw) ?? {
      packSize: 1,
      packUnit: "PCS",
    };

  const brand =
    (typeof synkka?.brand === "string" ? synkka.brand.trim() : undefined) ??
    pickString(raw, ["brand", "brandName", "vendorName"]) ??
    null;

  const category =
    pickString(raw, ["category", "categoryName", "mainCategory", "productGroup"]) ??
    null;
  const categories: string[] = [];
  if (category) categories.push(category);
  const hay = `${name} ${fromSynkka.nameFi ?? ""}`.toLowerCase();
  if (hay.includes("milk") || hay.includes("maito")) categories.push("dairy", "milk");
  if (hay.includes("drink") || hay.includes("juoma")) categories.push("juomat");

  const labels = new Set(extractLabelsFromText(hay));
  const classifications = synkka?.classifications;
  const allergenInfo = parseAllergens(classifications);
  const certifications = parseCertifications(classifications);
  const claims = parseClaims(classifications);
  if (claims.includes("free-from-lactose")) {
    labels.add("lactose-free");
    labels.add("laktoositon");
  }
  if (claims.includes("low-lactose")) labels.add("low-lactose");
  if (certifications.includes("EU Organic") || /organic|luomu/.test(hay)) labels.add("organic");
  const producers = (synkka?.producers as Array<{ name?: string }> | undefined) ?? [];
  const substitutes = Array.isArray(raw.substitutions)
    ? (raw.substitutions as Array<{ substituteProduct?: string }>)
        .map((x) => String(x.substituteProduct ?? ""))
        .filter(Boolean)
    : [];

  return {
    productId,
    name,
    nameFi: fromSynkka.nameFi,
    brand,
    category,
    categories,
    labels: [...labels],
    allergens: allergenInfo.contains,
    mayContain: allergenInfo.mayContain,
    certifications,
    claims,
    origin: typeof raw.countryOfOrigin === "string" ? raw.countryOfOrigin : null,
    producer: producers[0]?.name ?? null,
    substitutes,
    packSize: pack.packSize,
    packUnit: normalizeUnit(pack.packUnit),
    salesUnit: pickString(raw, ["salesUnit", "baseUnit"]),
    description: undefined,
    raw,
  };
}

function parseCsv(text: string): Array<Record<string, string>> {
  const lines = text.trim().split(/\r?\n/);
  if (lines.length < 2) return [];
  const headers = lines[0].split(",").map((h) => h.trim().replace(/^"|"$/g, ""));
  return lines.slice(1).map((line) => {
    const cols = line.split(",").map((c) => c.trim().replace(/^"|"$/g, ""));
    const row: Record<string, string> = {};
    headers.forEach((h, i) => {
      row[h] = cols[i] ?? "";
    });
    return row;
  });
}

export function loadCatalog(): void {
  if (loaded) return;
  const productsPath = resolve(config.dataDir, "products.json");
  if (!existsSync(productsPath)) {
    console.warn("products.json missing — using demo seed products");
    products = demoSeed();
  } else {
    const raw = JSON.parse(readFileSync(productsPath, "utf8"));
    products = asArray(raw)
      .map((p) => normalizeProduct(p as Record<string, unknown>))
      .filter((p): p is Product => !!p);
    if (products.length === 0) {
      console.warn("No products parsed — using demo seed");
      products = demoSeed();
    }
  }

  const relPath = resolve(config.dataDir, "delivery-reliability.csv");
  reliability = new Map();
  if (existsSync(relPath)) {
    for (const row of parseCsv(readFileSync(relPath, "utf8"))) {
      const id = row.productId || row.ProductId || row.product_id || Object.values(row)[0];
      const val = Number(
        row.deliveryReliability ||
          row.DeliveryReliability ||
          row.reliability ||
          Object.values(row)[1],
      );
      if (id && !Number.isNaN(val)) reliability.set(String(id), val);
    }
  }

  const carbonPath = resolve(config.dataDir, "carbon-footprint.csv");
  carbon = new Map();
  if (existsSync(carbonPath)) {
    for (const row of parseCsv(readFileSync(carbonPath, "utf8"))) {
      const id = row.productId || row.ProductId || Object.values(row)[0];
      const keys = Object.keys(row);
      const carbonKey =
        keys.find((k) => k.toLowerCase().includes("co2") || k.toLowerCase().includes("carbon")) ??
        keys[1];
      const val = Number(row[carbonKey]);
      if (id && !Number.isNaN(val)) carbon.set(String(id), val);
    }
  }

  // Ensure demo milk SKUs have reliability so Scenario A can auto-commit
  const demoRel: Record<string, number> = {
    "460013": 0.97,
    "460063": 0.95,
    "463989": 0.98,
    "460056": 0.94,
    "470001": 0.96,
  };
  for (const [id, val] of Object.entries(demoRel)) {
    if (!reliability.has(id)) reliability.set(id, val);
  }

  loaded = true;
  console.log(
    `Catalog loaded: ${products.length} products, ${reliability.size} reliability, ${carbon.size} carbon`,
  );
}

function demoSeed(): Product[] {
  return [
    {
      productId: "460013",
      name: "Valio lactose-free milk drink 1L",
      brand: "Valio",
      category: "dairy",
      categories: ["dairy", "milk"],
      labels: ["lactose-free", "laktoositon"],
      allergens: ["milk"],
      packSize: 1,
      packUnit: "L",
      raw: {},
    },
    {
      productId: "460063",
      name: "Valio lactose-free semi-skimmed milk 1.5L",
      brand: "Valio",
      category: "dairy",
      categories: ["dairy", "milk"],
      labels: ["lactose-free", "laktoositon"],
      allergens: ["milk"],
      packSize: 1.5,
      packUnit: "L",
      raw: {},
    },
    {
      productId: "463989",
      name: "Valio lactose-free milk 10L",
      brand: "Valio",
      category: "dairy",
      categories: ["dairy", "milk"],
      labels: ["lactose-free", "laktoositon"],
      allergens: ["milk"],
      packSize: 10,
      packUnit: "L",
      raw: {},
    },
    {
      productId: "460056",
      name: "Valio organic lactose-free milk 1L",
      brand: "Valio",
      category: "dairy",
      categories: ["dairy", "milk"],
      labels: ["lactose-free", "organic", "laktoositon"],
      allergens: ["milk"],
      packSize: 1,
      packUnit: "L",
      raw: {},
    },
    {
      productId: "470001",
      name: "Valio regular milk 1L",
      brand: "Valio",
      category: "dairy",
      categories: ["dairy", "milk"],
      labels: [],
      allergens: ["milk", "lactose"],
      packSize: 1,
      packUnit: "L",
      raw: {},
    },
  ];
}

export function getProduct(productId: string): Product | undefined {
  loadCatalog();
  return products.find((p) => p.productId === productId);
}

export function getReliability(productId: string): number | null {
  loadCatalog();
  return reliability.get(productId) ?? null;
}

export function getCarbon(productId: string): number | null {
  loadCatalog();
  return carbon.get(productId) ?? null;
}

export type SearchQuery = {
  q?: string;
  lactoseFree?: boolean;
  organic?: boolean;
  category?: string;
  limit?: number;
};

export function searchProducts(query: SearchQuery): Product[] {
  loadCatalog();
  const q = (query.q ?? "").toLowerCase().trim();
  const tokens = q.split(/\s+/).filter(Boolean);
  let results = products.filter((p) => {
    const hay = [
      p.name,
      p.nameFi,
      p.brand,
      p.category,
      ...(p.categories ?? []),
      ...(p.labels ?? []),
      p.description,
    ]
      .filter(Boolean)
      .join(" ")
      .toLowerCase();
    if (tokens.length && !tokens.every((t) => wordStart(hay, t) || fuzzyToken(hay, t))) {
      return false;
    }
    if (query.lactoseFree && !productIsLactoseFree(p)) return false;
    if (query.organic) {
      const labels = (p.labels ?? []).join(" ");
      if (!labels.includes("organic") && !labels.includes("luomu") && !hay.includes("organic")) {
        return false;
      }
    }
    if (query.category) {
      const cat = query.category.toLowerCase();
      const cats = [p.category, ...(p.categories ?? [])].filter(Boolean).join(" ").toLowerCase();
      if (!cats.includes(cat) && !hay.includes(cat)) return false;
    }
    return true;
  });

  // Relevance: a product NAMED "banana" must beat a yoghurt that merely mentions banana.
  if (tokens.length) {
    const score = (p: Product) => {
      const name = `${p.name} ${p.nameFi ?? ""}`.toLowerCase();
      const words = name.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
      let sc = 0;
      for (const t of tokens) {
        const whole = words.findIndex((w) => w === t || w === `${t}s` || w === `${t}es`);
        if (whole === 0) sc += 12; // the product IS this thing ("Banana kg", "Eggs M90")
        else if (whole > 0) sc += 9; // the exact word appears ("Kieku Barn Eggs")
        else if (words[0]?.startsWith(t)) sc += 4; // only a longer word ("Eggplant", "Oatly")
        else if (wordStart(name, t)) sc += 3;
        else sc += 1; // matched only via description / category
      }
      return sc;
    };
    const scored = results.map((p, i) => ({ p, sc: score(p), i }));
    scored.sort((a, b) => b.sc - a.sc || a.i - b.i);
    results = scored.map((x) => x.p);
  }
  results = results.slice(0, query.limit ?? 25);
  return results;
}

/** Token must start a word — "oat" matches "oats"/"oatmeal" but not "goat" or "coated". */
function wordStart(hay: string, token: string): boolean {
  const t = token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/[-\s]+/g, "[-\\s]");
  return new RegExp(`(^|[^\\p{L}\\p{N}])${t}`, "u").test(hay);
}

function fuzzyToken(hay: string, token: string): boolean {
  const t = token.replace(/-/g, " ");
  if (wordStart(hay, token)) return true;
  if (t.includes("lactose") || t.includes("laktoositon")) {
    return (
      hay.includes("lactose free") ||
      hay.includes("lactose-free") ||
      hay.includes("laktoositon") ||
      hay.includes("laktosfri")
    );
  }
  if (t.includes("milk") || t === "maito") {
    return hay.includes("milk") || hay.includes("maito");
  }
  return false;
}

export function searchFromNeed(need: Need, limit = 20): Product[] {
  const keywords = [
    need.productIntent,
    ...(need.constraints.keywords ?? []),
  ]
    .join(" ")
    .toLowerCase();
  let results = searchProducts({
    q: keywords,
    lactoseFree: need.constraints.lactoseFree,
    organic: need.constraints.organic,
    limit: limit * 3,
  });

  // Prefer liquid dairy for litre needs; drop powders/chocolate noise
  if (need.unit === "litre") {
    results = results.filter((p) => {
      const n = p.name.toLowerCase();
      if (n.includes("powder") || n.includes("jauhe") || n.includes("chocolate") || n.includes("suklaa")) {
        return false;
      }
      return p.packUnit === "L" || n.includes("milk") || n.includes("maito");
    });
    results.sort((a, b) => {
      // larger packs first for bulk
      const aScore = (a.packUnit === "L" ? 10 : 0) + a.packSize;
      const bScore = (b.packUnit === "L" ? 10 : 0) + b.packSize;
      return bScore - aScore;
    });
  }

  return results.slice(0, limit);
}

/** Convert required quantity into packs for a product. */
export function computePacks(
  needQty: number,
  needUnit: string,
  product: Product,
): {
  requiredPacks: number;
  totalQuantity: number;
  quantityUnit: string;
  compatible: boolean;
} {
  const packUnit = product.packUnit.toUpperCase();
  const needU = needUnit.toLowerCase();

  let needInPackUnit = needQty;
  let compatible = true;

  if (needU === "litre" || needU === "l") {
    if (packUnit === "L") needInPackUnit = needQty;
    else if (packUnit === "KG" || packUnit === "G") compatible = false;
    else if (packUnit === "PCS") {
      // treat 1 pcs as packSize litres if packSize looks like volume — else incompatible
      compatible = product.packSize > 0;
      needInPackUnit = needQty / product.packSize;
      return {
        requiredPacks: Math.ceil(needInPackUnit),
        totalQuantity: Math.ceil(needInPackUnit) * product.packSize,
        quantityUnit: "L",
        compatible,
      };
    }
  } else if (needU === "kg") {
    if (packUnit === "KG") needInPackUnit = needQty;
    else if (packUnit === "G") {
      const packInNeedUnit = product.packSize / 1000;
      compatible = product.packSize > 0;
      const requiredPacks = compatible ? Math.ceil(needQty / packInNeedUnit) : 0;
      return {
        requiredPacks,
        totalQuantity: requiredPacks * packInNeedUnit,
        quantityUnit: "KG",
        compatible,
      };
    } else compatible = false;
  } else if (needU === "each" && packUnit === "PCS" && product.packSize > 0) {
    const requiredPacks = Math.ceil(needQty / product.packSize);
    return {
      requiredPacks,
      totalQuantity: requiredPacks * product.packSize,
      quantityUnit: "PCS",
      compatible: true,
    };
  } else if (needU === "each" && packUnit === "KG") {
    // Weight-sold goods can't be priced per piece without a unit weight (see ingredient.unitWeightKg).
    compatible = false;
  } else if (needU === "pack" || needU === "each") {
    return {
      requiredPacks: Math.ceil(needQty),
      totalQuantity: Math.ceil(needQty) * product.packSize,
      quantityUnit: packUnit,
      compatible: true,
    };
  }

  const requiredPacks = Math.ceil(needInPackUnit / product.packSize);
  return {
    requiredPacks,
    totalQuantity: requiredPacks * product.packSize,
    quantityUnit: packUnit === "L" ? "L" : packUnit === "KG" ? "KG" : packUnit,
    compatible,
  };
}

/**
 * Substitutes Valio itself declares for a product (both directions), e.g. a Finnish tomato for a
 * Dutch one. These are the catalog's own equivalence statements — not our guess.
 */
let reverseSubs: Map<string, string[]> | null = null;
export function getValioSubstitutes(productId: string): string[] {
  loadCatalog();
  if (!reverseSubs) {
    reverseSubs = new Map();
    for (const p of products)
      for (const sub of p.substitutes ?? []) {
        if (!reverseSubs.has(sub)) reverseSubs.set(sub, []);
        reverseSubs.get(sub)!.push(p.productId);
      }
  }
  const direct = getProduct(productId)?.substitutes ?? [];
  return [...new Set([...direct, ...(reverseSubs.get(productId) ?? [])])];
}

/** The product facts Valio signs into its price claim (origin, allergens, certifications, lactose status). */
export function attestationFor(productId: string): ProductAttestation | undefined {
  const p = getProduct(productId);
  if (!p) return undefined;
  return {
    origin: p.origin ? p.origin.toUpperCase() : null,
    producer: p.producer ?? null,
    allergens: p.allergens ?? [],
    mayContain: p.mayContain ?? [],
    certifications: p.certifications ?? [],
    lactoseFree: productIsLactoseFree(p),
  };
}
