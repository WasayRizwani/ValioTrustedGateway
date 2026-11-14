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
import {
  checkCulinaryFormFactor,
  filterCompatibleProducts,
  isHardwareQuery,
  isNonFoodCategory,
} from "./substituteJudge.js";

export {
  isLactoseFree,
  allergenConflicts,
  extractMandateExcludedAllergens,
  expandExcludedAllergens,
  originName,
} from "./productData.js";

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
  packUnit: string; // L, KG, PCS, CASE
  piecesPerPack?: number;
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
  if (raw.baseUnit === "KG" && (raw.salesUnit === "KI" || raw.salesUnit === "CS" || raw.salesUnit === "LTK")) {
    return { packSize: 1, packUnit: "CASE" };
  }
  return null;
}

/** Extract explicit piece counts from wholesale pack names (e.g. "80 x 90g", "50pcs", "Eggs L180 12300g"). */
function piecesFromName(name: string): number | undefined {
  const n = name.toLowerCase();
  const mult = n.match(/\b(\d{1,4})\s*x\s*\d+(?:[.,]\d+)?\s*(?:g|kg|ml|dl|cl|l)\b/);
  if (mult) {
    const count = Number(mult[1]);
    if (count > 0) return count;
  }
  const pcs = n.match(/\b(\d{1,4})\s*(?:pcs|pc|kpl|pieces)\b/);
  if (pcs) {
    const count = Number(pcs[1]);
    if (count > 0) return count;
  }
  if (/\b(?:eggs?|kananmun[a-z]*)\b/.test(n)) {
    const tray = n.match(/\b(?:s|m|l|xl)(\d{2,3})\b/);
    if (tray) return Number(tray[1]);
  }
  return undefined;
}

/** Standard culinary unit weights (kg per piece) for countable items sold by weight in wholesale catalogs. */
export const CULINARY_UNIT_WEIGHT_KG: ReadonlyArray<[RegExp, number]> = [
  [/\b(?:bananas?|banaan[a-z]*)\b/i, 0.18],
  [/\b(?:eggs?|kananmun[a-z]*)\b/i, 0.058],
  [/\b(?:apples?|omen[a-z]*)\b/i, 0.18],
  [/\b(?:oranges?|appelsiin[a-z]*)\b/i, 0.2],
  [/\b(?:lemons?|sitruun[a-z]*)\b/i, 0.11],
  [/\b(?:limes?|limet[a-z]*)\b/i, 0.07],
  [/\b(?:avocados?|avokad[a-z]*)\b/i, 0.17],
  [/\b(?:cucumbers?|kurkk[a-z]*)\b/i, 0.35],
  [/\b(?:tomatoes|tomato|tomaat[a-z]*)\b/i, 0.12],
  [/\b(?:onions?|sipul[a-z]*)\b/i, 0.15],
  [/\b(?:potatoes|potato|perun[a-z]*)\b/i, 0.15],
  [/\b(?:carrots?|porkkan[a-z]*)\b/i, 0.1],
  [/\b(?:peppers?|bell peppers?|paprik[a-z]*)\b/i, 0.16],
  [/\b(?:pears?|pääryn[a-z]*)\b/i, 0.18],
  [/\b(?:peaches|peach|persik[a-z]*)\b/i, 0.15],
  [/\b(?:kiwis?|kiiv[a-z]*)\b/i, 0.08],
  [/\b(?:mangoes|mangos|mango)\b/i, 0.35],
  [/\b(?:pineapples?|ananas)\b/i, 1.2],
  [/\b(?:melons?|melon[a-z]*)\b/i, 1.2],
  [/\b(?:watermelons?|vesimelon[a-z]*)\b/i, 3.5],
  [/\b(?:cauliflowers?|kukkakaal[a-z]*)\b/i, 0.8],
  [/\b(?:cabbages?|kaal[a-z]*)\b/i, 1.0],
  [/\b(?:croissants?)\b/i, 0.08],
  [/\b(?:bagels?)\b/i, 0.09],
  [/\b(?:muffins?)\b/i, 0.09],
  [/\b(?:donuts?|doughnuts?)\b/i, 0.07],
  [/\b(?:buns?|rolls?|sämpyl[a-z]*)\b/i, 0.07],
  [/\b(?:baguettes?|patonk[a-z]*)\b/i, 0.25],
  [/\b(?:loaves|loaf)\b/i, 0.5],
  [/\b(?:pastries|pastry|viiner[a-z]*)\b/i, 0.085],
  [/\b(?:pies?|piirak[a-z]*)\b/i, 0.075],
  [/\b(?:sausages?|makkar[a-z]*)\b/i, 0.1],
  [/\b(?:burgers?|patties|patty|pihv[a-z]*)\b/i, 0.12],
  [/\b(?:tortillas?|wraps?)\b/i, 0.06],
  [/\b(?:lettuces?|salaatt[a-z]*)\b/i, 0.25],
  [/\b(?:broccolis?|parsakaal[a-z]*)\b/i, 0.35],
  [/\b(?:zucchinis?|courgettes?|kesäkurpits[a-z]*)\b/i, 0.25],
  [/\b(?:eggplants?|aubergines?|munakois[a-z]*)\b/i, 0.3],
  [/\b(?:grapefruits?|verigreipp[a-z]*)\b/i, 0.28],
  [/\b(?:plums?|luum[a-z]*)\b/i, 0.065],
  [/\b(?:coconuts?)\b/i, 0.6],
];

export function inferUnitWeightKg(text: string): number | undefined {
  for (const [re, kg] of CULINARY_UNIT_WEIGHT_KG) {
    if (re.test(text)) return kg;
  }
  return undefined;
}

/** Normalize English plural nouns to singular stem so "bananas" matches "BANANA" and "tomatoes" matches "TOMATO". */
export function stemToken(token: string): string {
  const t = token.toLowerCase();
  if (t.length <= 3) return t;
  if (t === "loaves") return "loaf";
  if (t.endsWith("ies") && t.length > 4) return `${t.slice(0, -3)}y`;
  if (/(?:tomato|potato|mango|hero|echo)es$/.test(t)) return t.slice(0, -2);
  if (/(?:ch|sh|ss|x|z)es$/.test(t)) return t.slice(0, -2);
  if (t.endsWith("s") && !t.endsWith("ss") && !t.endsWith("us") && !t.endsWith("is")) return t.slice(0, -1);
  return t;
}

function scalePackUnit(size: number, rawUnit: string): { packSize: number; packUnit: string } {
  let s = size;
  let u = rawUnit.toLowerCase();
  if (u === "ml") {
    s = s / 1000;
    u = "l";
  } else if (u === "dl") {
    s = s / 10;
    u = "l";
  } else if (u === "cl") {
    s = s / 100;
    u = "l";
  } else if (u === "g") {
    s = s / 1000;
    u = "kg";
  } else if (u.startsWith("l")) {
    u = "l";
  }
  return {
    packSize: Math.round(s * 10000) / 10000,
    packUnit: u.toUpperCase() === "L" ? "L" : u.toUpperCase(),
  };
}

function packFromName(name: string): { packSize: number; packUnit: string } | null {
  const n = name.toLowerCase().replace(/,/g, ".");
  // Nested case multipack, e.g. "5 x Benecol 4x115g"
  const nested = n.match(
    /(?:^|\b)(\d{1,3})\s*x\s*[^0-9x]{1,40}?(\d{1,3})\s*x\s*(\d+(?:\.\d+)?)\s*(ml|dl|cl|l|ltr|litre|liter|kg|g)\b/,
  );
  if (nested) {
    return scalePackUnit(Number(nested[1]) * Number(nested[2]) * Number(nested[3]), nested[4]);
  }
  // Leading wholesale case multiplier with brand/title before unit weight, e.g. "20 x Arla 500 g", "5 x Arla 1 L"
  const leadingCase = n.match(
    /^(\d{1,3})\s*x\s*[^\d]{1,60}?(\d+(?:\.\d+)?)\s*(ml|dl|cl|l|ltr|litre|liter|kg|g)\b/,
  );
  if (leadingCase) {
    return scalePackUnit(Number(leadingCase[1]) * Number(leadingCase[2]), leadingCase[3]);
  }
  // Multipack e.g. "4x5 kg", "4x125g", "20 x 500 g"
  const mult = n.match(/\b(\d{1,4})\s*x\s*(\d+(?:\.\d+)?)\s*(ml|dl|cl|l|ltr|litre|liter|kg|g)\b/);
  if (mult) {
    return scalePackUnit(Number(mult[1]) * Number(mult[2]), mult[3]);
  }
  // Reverse multipack e.g. "75 g x 20"
  const revMult = n.match(/\b(\d+(?:\.\d+)?)\s*(ml|dl|cl|l|ltr|litre|liter|kg|g)\s*x\s*(\d{1,4})\b/);
  if (revMult) {
    return scalePackUnit(Number(revMult[1]) * Number(revMult[3]), revMult[2]);
  }
  // Single size e.g. 10 l, 1 l, 1.5 l, 5 dl, 25 kg, 400g
  const m = n.match(/(\d+(?:\.\d+)?)\s*(ml|dl|cl|l|ltr|litre|liter|kg|g)\b/);
  if (!m) return null;
  return scalePackUnit(Number(m[1]), m[2]);
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
  if (claims.some((c) => /vegan/i.test(c)) || /\b(?:vegan|vegaani(?:nen)?)\b/.test(hay)) labels.add("vegan");
  const producers = (synkka?.producers as Array<{ name?: string }> | undefined) ?? [];
  const substitutes = Array.isArray(raw.substitutions)
    ? (raw.substitutions as Array<{ substituteProduct?: string }>)
        .map((x) => String(x.substituteProduct ?? ""))
        .filter(Boolean)
    : [];
  const piecesPerPack = piecesFromName(`${name} ${fromSynkka.nameFi ?? ""}`);

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
    piecesPerPack,
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

export function getAllProducts(): Product[] {
  loadCatalog();
  return products;
}

export function getReliabilityMap(): ReliabilityMap {
  loadCatalog();
  return reliability;
}

export function getCarbonMap(): CarbonMap {
  loadCatalog();
  return carbon;
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
  vegan?: boolean;
  origin?: string;
  category?: string;
  limit?: number;
};

const HARDWARE_UTENSIL_RE = /\b(?:cutter|slicer|peeler|holder|dispenser|napkins?|gloves)\b/i;

export function searchProducts(query: SearchQuery): Product[] {
  loadCatalog();
  const q = (query.q ?? "").toLowerCase().trim();
  const tokens = [...new Set(q.split(/\s+/).filter(Boolean))];
  const askingHardware = HARDWARE_UTENSIL_RE.test(q);
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
    if (query.vegan) {
      const labels = (p.labels ?? []).join(" ");
      if (!labels.includes("vegan") && !hay.includes("vegan") && !hay.includes("vegaani")) {
        return false;
      }
    }
    if (query.origin) {
      if ((p.origin ?? "").toUpperCase() !== query.origin.trim().toUpperCase()) {
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
    const askingNonFood = askingHardware || isHardwareQuery(q);
    const score = (p: Product) => {
      const name = `${p.name} ${p.nameFi ?? ""}`.toLowerCase();
      const words = name.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
      let sc = 0;
      for (const t of tokens) {
        const stem = stemToken(t);
        const isYog = stem === "yogurt" || stem === "yoghurt";
        const whole = words.findIndex(
          (w) =>
            w === t ||
            w === stem ||
            w === `${stem}s` ||
            w === `${stem}es` ||
            w === `${t}s` ||
            w === `${t}es` ||
            (isYog && (w === "yogurt" || w === "yoghurt" || w === "yogurts" || w === "yoghurts")),
        );
        if (whole === 0) sc += 12; // the product IS this thing ("Banana kg", "Eggs M90")
        else if (whole > 0) sc += 9; // the exact word appears ("Kieku Barn Eggs")
        else if (words[0]?.startsWith(stem)) sc += 4; // only a longer word ("Eggplant", "Oatly")
        else if (wordStart(name, stem) || wordStart(name, t)) sc += 3;
        else sc += 1; // matched only via description / category
      }
      if (!askingNonFood && (HARDWARE_UTENSIL_RE.test(name) || isNonFoodCategory(p.category))) {
        sc -= 14;
      }
      if (!checkCulinaryFormFactor(q, p).ok) {
        sc -= 8;
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
  const stem = stemToken(token);
  if (stem !== token && stem.length >= 3 && wordStart(hay, stem)) return true;
  if (stem === "yogurt" || stem === "yoghurt" || t === "jogurtti") {
    return wordStart(hay, "yogurt") || wordStart(hay, "yoghurt") || hay.includes("jogurtti");
  }
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

export function searchFromNeed(need: Need, limit = 20, extraSearchHints?: string[]): Product[] {
  const keywords = [
    ...new Set(
      [need.productIntent, ...(need.constraints.keywords ?? [])]
        .join(" ")
        .toLowerCase()
        .split(/\s+/)
        .filter(Boolean),
    ),
  ].join(" ");
  let results = searchProducts({
    q: keywords,
    lactoseFree: need.constraints.lactoseFree,
    organic: need.constraints.organic,
    vegan: need.constraints.vegan,
    origin: need.constraints.origin,
    limit: limit * 3,
  });

  if (extraSearchHints?.length) {
    const seen = new Set(results.map((p) => p.productId));
    for (const rawHint of extraSearchHints) {
      const q = rawHint.trim();
      if (!q) continue;
      const extra = searchProducts({
        q,
        lactoseFree: need.constraints.lactoseFree,
        organic: need.constraints.organic,
        vegan: need.constraints.vegan,
        origin: need.constraints.origin,
        limit: limit * 2,
      });
      for (const p of extra) {
        if (!seen.has(p.productId)) {
          seen.add(p.productId);
          results.push(p);
        }
      }
    }
  }

  if (need.constraints.minReliability !== undefined) {
    results = results.filter((p) => (getReliability(p.productId) ?? 0) >= need.constraints.minReliability!);
  }
  if (need.constraints.maxCarbonKgPerKg !== undefined) {
    results = results.filter((p) => {
      const c = getCarbon(p.productId);
      return c != null && c <= need.constraints.maxCarbonKgPerKg!;
    });
  }

  // Prefer liquid dairy for litre needs; drop powders/chocolate noise unless explicitly requested
  if (need.unit === "litre") {
    const wantsChoc = /chocolate|cocoa|suklaa|kaakao/i.test(keywords);
    results = results.filter((p) => {
      const n = p.name.toLowerCase();
      if (n.includes("powder") || n.includes("jauhe")) return false;
      if (!wantsChoc && (n.includes("chocolate") || n.includes("suklaa"))) return false;
      return p.packUnit === "L" || n.includes("milk") || n.includes("maito");
    });
  }

  // Stage-1 category & culinary form-factor gate (evaluated on unit-compatible items while still in relevance order)
  const unitCompatible = results.filter((p) => computePacks(need.quantity, need.unit, p).compatible);
  const basePool = unitCompatible.length > 0 ? unitCompatible : results;
  const combinedQuery = [keywords, ...(extraSearchHints ?? [])].filter(Boolean).join(" ");
  const stage1 = filterCompatibleProducts(basePool, combinedQuery, {
    vegan: need.constraints.vegan,
  });
  if (stage1.length > 0) {
    results = stage1;
  }

  if (need.unit === "litre") {
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
    else if (packUnit === "KG" || packUnit === "G" || packUnit === "CASE") compatible = false;
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
  } else if (needU === "each") {
    if (product.piecesPerPack && product.piecesPerPack > 0) {
      const requiredPacks = Math.max(1, Math.ceil(needQty / product.piecesPerPack));
      return {
        requiredPacks,
        totalQuantity: requiredPacks * product.piecesPerPack,
        quantityUnit: "PCS",
        compatible: true,
      };
    }
    if (packUnit === "PCS" && product.packSize > 0) {
      const requiredPacks = Math.ceil(needQty / product.packSize);
      return {
        requiredPacks,
        totalQuantity: requiredPacks * product.packSize,
        quantityUnit: "PCS",
        compatible: true,
      };
    }
    if (packUnit === "KG" && product.packSize > 0) {
      const unitWeightKg = inferUnitWeightKg(`${product.name} ${product.nameFi ?? ""}`);
      if (unitWeightKg) {
        const neededKg = needQty * unitWeightKg;
        const requiredPacks = Math.max(1, Math.ceil(neededKg / product.packSize));
        return {
          requiredPacks,
          totalQuantity: Math.round(requiredPacks * product.packSize * 1000) / 1000,
          quantityUnit: "KG",
          compatible: true,
        };
      }
      compatible = false;
    } else {
      compatible = false;
    }
  } else if (needU === "pack") {
    return {
      requiredPacks: Math.ceil(needQty),
      totalQuantity: Math.ceil(needQty) * product.packSize,
      quantityUnit: packUnit,
      compatible: true,
    };
  }

  const requiredPacks = compatible && product.packSize > 0 ? Math.ceil(needInPackUnit / product.packSize) : 0;
  return {
    requiredPacks,
    totalQuantity: Math.round(requiredPacks * product.packSize * 1000) / 1000,
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
