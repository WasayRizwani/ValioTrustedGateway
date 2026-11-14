import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import type Database from "better-sqlite3";
import { getDb } from "../audit/chain.js";
import { config } from "../config.js";
import {
  getAllProducts,
  getCarbonMap,
  getProduct,
  getReliabilityMap,
  getValioSubstitutes,
  isLactoseFree,
  searchProducts,
  stemToken,
  type Product,
} from "./index.js";
import { allergenConflicts } from "./productData.js";
import {
  getAvailability,
  getPrices,
  type AvailabilityResult,
  type PriceResult,
} from "../valio/client.js";
import { getInventory, getKitchen, upsertInventory } from "../hotel/kitchen.js";

let schemaInitializedDb: Database.Database | null = null;
let syncedCatalogDb: Database.Database | null = null;
let ftsAvailable = true;

function parseCsvRows(text: string): Array<Record<string, string>> {
  const lines = text
    .replace(/^\uFEFF/, "")
    .trim()
    .split(/\r?\n/)
    .filter((l) => l.trim().length > 0);
  if (lines.length < 2) return [];
  const splitLine = (line: string): string[] => {
    const out: string[] = [];
    let cur = "";
    let inQuotes = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === '"') {
        if (inQuotes && line[i + 1] === '"') {
          cur += '"';
          i++;
        } else {
          inQuotes = !inQuotes;
        }
      } else if (ch === "," && !inQuotes) {
        out.push(cur.trim());
        cur = "";
      } else {
        cur += ch;
      }
    }
    out.push(cur.trim());
    return out;
  };
  const headers = splitLine(lines[0]);
  return lines.slice(1).map((line) => {
    const cols = splitLine(line);
    const row: Record<string, string> = {};
    headers.forEach((h, idx) => {
      row[h] = cols[idx] ?? "";
    });
    return row;
  });
}

export function ensureCatalogSchema(): Database.Database {
  const d = getDb();
  if (schemaInitializedDb === d) return d;

  d.exec(`
    CREATE TABLE IF NOT EXISTS catalog_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS catalog_delivery_reliability (
      product_id TEXT PRIMARY KEY,
      delivery_reliability REAL NOT NULL,
      source_csv TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS catalog_carbon_footprint (
      product_id TEXT PRIMARY KEY,
      carbon_kg_per_kg REAL NOT NULL,
      source_csv TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS catalog_products (
      product_id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      name_fi TEXT,
      brand TEXT,
      category TEXT,
      categories_json TEXT NOT NULL,
      labels_json TEXT NOT NULL,
      allergens_json TEXT NOT NULL,
      may_contain_json TEXT NOT NULL,
      certifications_json TEXT NOT NULL,
      claims_json TEXT NOT NULL,
      substitutes_json TEXT NOT NULL,
      origin TEXT,
      producer TEXT,
      pack_size REAL NOT NULL,
      pack_unit TEXT NOT NULL,
      pieces_per_pack INTEGER,
      sales_unit TEXT,
      lactose_free INTEGER NOT NULL DEFAULT 0,
      organic INTEGER NOT NULL DEFAULT 0,
      vegan INTEGER NOT NULL DEFAULT 0,
      delivery_reliability REAL,
      carbon_kg_per_kg REAL
    );

    CREATE INDEX IF NOT EXISTS idx_catalog_products_lf ON catalog_products(lactose_free);
    CREATE INDEX IF NOT EXISTS idx_catalog_products_org ON catalog_products(organic);
    CREATE INDEX IF NOT EXISTS idx_catalog_products_vegan ON catalog_products(vegan);
    CREATE INDEX IF NOT EXISTS idx_catalog_products_unit ON catalog_products(pack_unit);
    CREATE INDEX IF NOT EXISTS idx_catalog_products_origin ON catalog_products(origin);
    CREATE INDEX IF NOT EXISTS idx_catalog_products_rel ON catalog_products(delivery_reliability);
    CREATE INDEX IF NOT EXISTS idx_catalog_products_carbon ON catalog_products(carbon_kg_per_kg);

    CREATE TABLE IF NOT EXISTS catalog_availability_snapshots (
      customer_id TEXT NOT NULL,
      product_id TEXT NOT NULL,
      requested_date TEXT NOT NULL,
      available_amount REAL,
      availability_unknown INTEGER NOT NULL DEFAULT 0,
      available_date TEXT,
      sales_unit TEXT,
      sales_block INTEGER NOT NULL DEFAULT 0,
      logistic_model TEXT,
      closing_at TEXT,
      unit_price REAL,
      comparison_price REAL,
      comparison_unit TEXT,
      currency TEXT,
      source TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (customer_id, product_id, requested_date)
    );

    CREATE INDEX IF NOT EXISTS idx_avail_snap_product
      ON catalog_availability_snapshots(product_id, customer_id);

    CREATE TABLE IF NOT EXISTS catalog_csv_imports (
      import_id INTEGER PRIMARY KEY AUTOINCREMENT,
      kind TEXT NOT NULL,
      source_name TEXT NOT NULL,
      row_count INTEGER NOT NULL,
      imported_at TEXT NOT NULL
    );
  `);

  try {
    d.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS catalog_products_fts USING fts5(
        product_id UNINDEXED,
        name,
        name_fi,
        brand,
        category,
        labels_text,
        tokenize = 'porter unicode61 remove_diacritics 2'
      );
    `);
    ftsAvailable = true;
  } catch {
    ftsAvailable = false;
  }

  schemaInitializedDb = d;
  return d;
}

function computeDataFingerprint(): string {
  const parts: string[] = [];
  if (existsSync(config.dataDir)) {
    const files = readdirSync(config.dataDir)
      .filter((f) => f === "products.json" || f.toLowerCase().endsWith(".csv"))
      .sort();
    for (const f of files) {
      const full = resolve(config.dataDir, f);
      try {
        const st = statSync(full);
        parts.push(`${f}:${st.size}:${Math.floor(st.mtimeMs)}`);
      } catch {
        // ignore transient read race
      }
    }
  }
  return parts.join("|") || "seed-only";
}

function detectCsvKind(
  headers: string[],
  fileName = "",
): "availability" | "reliability" | "carbon" | "kitchen_inventory" | null {
  const lower = headers.map((h) => h.toLowerCase());
  const fn = fileName.toLowerCase();
  if (
    lower.some((h) => h.includes("onhand") || h.includes("on_hand") || h.includes("parlevel") || h.includes("par_level")) ||
    fn.includes("kitchen") ||
    fn.includes("pantry")
  ) {
    return "kitchen_inventory";
  }
  if (
    lower.some(
      (h) =>
        h.includes("availableamount") ||
        h.includes("available_amount") ||
        h.includes("availabledate") ||
        h.includes("available_date") ||
        h.includes("salesblock") ||
        h.includes("sales_block") ||
        h === "stock" ||
        h === "available_qty",
    ) ||
    fn.includes("avail") ||
    fn.includes("stock")
  ) {
    return "availability";
  }
  if (lower.some((h) => h.includes("reliability")) || fn.includes("reliability")) {
    return "reliability";
  }
  if (lower.some((h) => h.includes("co2") || h.includes("carbon")) || fn.includes("carbon")) {
    return "carbon";
  }
  return null;
}

export function ensureCatalogSynced(force = false): Database.Database {
  const d = ensureCatalogSchema();
  if (!force && syncedCatalogDb === d) return d;

  const fingerprint = computeDataFingerprint();
  if (!force) {
    const existingFp = d
      .prepare(`SELECT value FROM catalog_meta WHERE key = 'sync_fingerprint'`)
      .get() as { value: string } | undefined;
    const countRow = d
      .prepare(`SELECT COUNT(*) as c FROM catalog_products`)
      .get() as { c: number };
    if (existingFp?.value === fingerprint && countRow.c > 0) {
      syncedCatalogDb = d;
      return d;
    }
  }

  const allProducts = getAllProducts();
  const relMap = getReliabilityMap();
  const carbonMap = getCarbonMap();
  const now = new Date().toISOString();

  const relFileExists = existsSync(resolve(config.dataDir, "delivery-reliability.csv"));
  const carbonFileExists = existsSync(resolve(config.dataDir, "carbon-footprint.csv"));

  d.transaction(() => {
    d.prepare(`DELETE FROM catalog_delivery_reliability`).run();
    d.prepare(`DELETE FROM catalog_carbon_footprint`).run();
    d.prepare(`DELETE FROM catalog_products`).run();
    if (ftsAvailable) {
      d.prepare(`DELETE FROM catalog_products_fts`).run();
    }

    const insRel = d.prepare(`
      INSERT OR REPLACE INTO catalog_delivery_reliability
        (product_id, delivery_reliability, source_csv, updated_at)
      VALUES (?, ?, ?, ?)
    `);
    const relSource = relFileExists ? "delivery-reliability.csv" : "seed";
    for (const [pid, val] of relMap.entries()) {
      insRel.run(pid, val, relSource, now);
    }

    const insCarbon = d.prepare(`
      INSERT OR REPLACE INTO catalog_carbon_footprint
        (product_id, carbon_kg_per_kg, source_csv, updated_at)
      VALUES (?, ?, ?, ?)
    `);
    const carbonSource = carbonFileExists ? "carbon-footprint.csv" : "seed";
    for (const [pid, val] of carbonMap.entries()) {
      insCarbon.run(pid, val, carbonSource, now);
    }

    const insProd = d.prepare(`
      INSERT OR REPLACE INTO catalog_products (
        product_id, name, name_fi, brand, category,
        categories_json, labels_json, allergens_json, may_contain_json,
        certifications_json, claims_json, substitutes_json,
        origin, producer, pack_size, pack_unit, pieces_per_pack, sales_unit,
        lactose_free, organic, vegan, delivery_reliability, carbon_kg_per_kg
      ) VALUES (
        ?, ?, ?, ?, ?,
        ?, ?, ?, ?,
        ?, ?, ?,
        ?, ?, ?, ?, ?, ?,
        ?, ?, ?, ?, ?
      )
    `);

    const insFts = ftsAvailable
      ? d.prepare(`
          INSERT INTO catalog_products_fts
            (product_id, name, name_fi, brand, category, labels_text)
          VALUES (?, ?, ?, ?, ?, ?)
        `)
      : null;

    for (const p of allProducts) {
      const labels = p.labels ?? [];
      const lf = isLactoseFree(p) ? 1 : 0;
      const org = labels.includes("organic") ? 1 : 0;
      const veg = labels.includes("vegan") ? 1 : 0;
      const rel = relMap.get(p.productId) ?? null;
      const carb = carbonMap.get(p.productId) ?? null;

      insProd.run(
        p.productId,
        p.name,
        p.nameFi ?? null,
        p.brand ?? null,
        p.category ?? null,
        JSON.stringify(p.categories ?? []),
        JSON.stringify(labels),
        JSON.stringify(p.allergens ?? []),
        JSON.stringify(p.mayContain ?? []),
        JSON.stringify(p.certifications ?? []),
        JSON.stringify(p.claims ?? []),
        JSON.stringify(p.substitutes ?? []),
        p.origin ? p.origin.toUpperCase() : null,
        p.producer ?? null,
        p.packSize,
        p.packUnit,
        p.piecesPerPack ?? null,
        p.salesUnit ?? null,
        lf,
        org,
        veg,
        rel,
        carb,
      );

      if (insFts) {
        insFts.run(
          p.productId,
          p.name,
          p.nameFi ?? "",
          p.brand ?? "",
          [p.category, ...(p.categories ?? [])].filter(Boolean).join(" "),
          [...labels, ...(p.certifications ?? []), ...(p.claims ?? [])].join(" "),
        );
      }
    }

    const insImport = d.prepare(`
      INSERT INTO catalog_csv_imports (kind, source_name, row_count, imported_at)
      VALUES (?, ?, ?, ?)
    `);
    if (relMap.size > 0) insImport.run("reliability", relSource, relMap.size, now);
    if (carbonMap.size > 0) insImport.run("carbon", carbonSource, carbonMap.size, now);

    d.prepare(`INSERT OR REPLACE INTO catalog_meta (key, value) VALUES ('sync_fingerprint', ?)`).run(
      fingerprint,
    );
    d.prepare(`INSERT OR REPLACE INTO catalog_meta (key, value) VALUES ('synced_at', ?)`).run(now);
  })();

  // Auto-ingest any additional CSV files present in dataDir (e.g. availability.csv, inventory.csv)
  if (existsSync(config.dataDir)) {
    const extraCsvs = readdirSync(config.dataDir).filter(
      (f) =>
        f.toLowerCase().endsWith(".csv") &&
        f !== "delivery-reliability.csv" &&
        f !== "carbon-footprint.csv",
    );
    for (const csvFile of extraCsvs) {
      try {
        const text = readFileSync(resolve(config.dataDir, csvFile), "utf8");
        importCsvToDatabase({ kind: "auto", csvText: text, sourceName: csvFile, skipSync: true });
      } catch {
        // ignore malformed custom files during auto-scan
      }
    }
  }

  syncedCatalogDb = d;
  return d;
}

export function recordPriceSnapshots(
  customerId: string,
  requestedDate: string,
  prices: PriceResult[],
): void {
  if (!prices.length) return;
  const d = ensureCatalogSchema();
  const now = new Date().toISOString();
  const stmt = d.prepare(`
    INSERT INTO catalog_availability_snapshots (
      customer_id, product_id, requested_date,
      unit_price, comparison_price, comparison_unit, currency,
      source, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, 'valio_live', ?)
    ON CONFLICT(customer_id, product_id, requested_date) DO UPDATE SET
      unit_price = excluded.unit_price,
      comparison_price = excluded.comparison_price,
      comparison_unit = excluded.comparison_unit,
      currency = excluded.currency,
      updated_at = excluded.updated_at
  `);
  d.transaction(() => {
    for (const p of prices) {
      if (p.error || p.unitPrice == null) continue;
      stmt.run(
        customerId,
        p.productId,
        requestedDate,
        p.unitPrice,
        p.comparisonPrice,
        p.comparisonUnit,
        p.currency,
        now,
      );
    }
  })();
}

export function recordAvailabilitySnapshots(
  customerId: string,
  requestedDate: string,
  availabilities: AvailabilityResult[],
): void {
  if (!availabilities.length) return;
  const d = ensureCatalogSchema();
  const now = new Date().toISOString();
  const stmt = d.prepare(`
    INSERT INTO catalog_availability_snapshots (
      customer_id, product_id, requested_date,
      available_amount, availability_unknown, available_date,
      sales_unit, sales_block, logistic_model, closing_at,
      source, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'valio_live', ?)
    ON CONFLICT(customer_id, product_id, requested_date) DO UPDATE SET
      available_amount = excluded.available_amount,
      availability_unknown = excluded.availability_unknown,
      available_date = excluded.available_date,
      sales_unit = excluded.sales_unit,
      sales_block = excluded.sales_block,
      logistic_model = excluded.logistic_model,
      closing_at = excluded.closing_at,
      source = excluded.source,
      updated_at = excluded.updated_at
  `);
  d.transaction(() => {
    for (const a of availabilities) {
      stmt.run(
        customerId,
        a.productId,
        requestedDate,
        a.availableAmount,
        a.availabilityUnknown ? 1 : 0,
        a.availableDate,
        a.salesUnit,
        a.salesBlock ? 1 : 0,
        a.logisticModel,
        a.closingAt,
        now,
      );
    }
  })();
}

export type CsvImportParams = {
  kind?: "auto" | "availability" | "reliability" | "carbon" | "kitchen_inventory";
  csvText: string;
  customerId?: string;
  sourceName?: string;
  skipSync?: boolean;
};

export function importCsvToDatabase(params: CsvImportParams): {
  kind: string;
  sourceName: string;
  importedRows: number;
} {
  const d = params.skipSync ? ensureCatalogSchema() : ensureCatalogSynced();
  const rows = parseCsvRows(params.csvText);
  if (rows.length === 0) {
    throw new Error("CSV contains no data rows");
  }
  const headers = Object.keys(rows[0]);
  const sourceName = params.sourceName?.trim() || "uploaded.csv";
  const resolvedKind =
    params.kind && params.kind !== "auto"
      ? params.kind
      : detectCsvKind(headers, sourceName);
  if (!resolvedKind) {
    throw new Error(
      `Could not detect CSV kind from headers [${headers.join(", ")}]. Specify kind: availability | reliability | carbon | kitchen_inventory.`,
    );
  }

  const now = new Date().toISOString();
  const defaultDate = now.slice(0, 10);
  const customerId = params.customerId || "HOTEL-001";
  let importedRows = 0;

  const pick = (row: Record<string, string>, candidates: string[]): string | undefined => {
    const lowerMap = new Map<string, string>();
    for (const [k, v] of Object.entries(row)) lowerMap.set(k.toLowerCase(), v);
    for (const c of candidates) {
      const val = lowerMap.get(c.toLowerCase());
      if (val !== undefined && val !== "") return val;
    }
    return undefined;
  };

  if (resolvedKind === "availability") {
    const stmt = d.prepare(`
      INSERT INTO catalog_availability_snapshots (
        customer_id, product_id, requested_date,
        available_amount, availability_unknown, available_date,
        sales_unit, sales_block, unit_price, currency,
        source, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(customer_id, product_id, requested_date) DO UPDATE SET
        available_amount = COALESCE(excluded.available_amount, catalog_availability_snapshots.available_amount),
        availability_unknown = excluded.availability_unknown,
        available_date = COALESCE(excluded.available_date, catalog_availability_snapshots.available_date),
        sales_unit = COALESCE(excluded.sales_unit, catalog_availability_snapshots.sales_unit),
        sales_block = excluded.sales_block,
        unit_price = COALESCE(excluded.unit_price, catalog_availability_snapshots.unit_price),
        currency = COALESCE(excluded.currency, catalog_availability_snapshots.currency),
        source = excluded.source,
        updated_at = excluded.updated_at
    `);
    d.transaction(() => {
      for (const row of rows) {
        const productId = pick(row, ["productId", "product_id", "sku", "code", "id"]) ?? Object.values(row)[0];
        if (!productId) continue;
        const rowCust = pick(row, ["customerId", "customer_id", "customer"]) ?? customerId;
        const availDate = pick(row, ["availableDate", "available_date", "deliveryDate", "delivery_date", "date"]) ?? null;
        const reqDate = pick(row, ["requestedDate", "requested_date", "date"]) ?? availDate ?? defaultDate;
        const rawAmt = pick(row, ["availableAmount", "available_amount", "available_qty", "quantity", "stock", "amount"]);
        const parsedAmt = rawAmt !== undefined ? Number(rawAmt) : null;
        const availAmt = parsedAmt != null && Number.isFinite(parsedAmt) ? parsedAmt : null;
        const salesUnit = pick(row, ["salesUnit", "sales_unit", "unit"]) ?? null;
        const rawBlock = pick(row, ["salesBlock", "sales_block", "blocked"]);
        const salesBlock = rawBlock && /^(1|true|yes)$/i.test(rawBlock) ? 1 : 0;
        const rawPrice = pick(row, ["unitPrice", "unit_price", "price"]);
        const unitPrice = rawPrice !== undefined && Number.isFinite(Number(rawPrice)) ? Number(rawPrice) : null;
        const currency = pick(row, ["currency"]) ?? (unitPrice != null ? "EUR" : null);
        stmt.run(
          rowCust,
          productId,
          reqDate,
          availAmt,
          availAmt == null ? 1 : 0,
          availDate ?? reqDate,
          salesUnit,
          salesBlock,
          unitPrice,
          currency,
          `csv:${sourceName}`,
          now,
        );
        importedRows++;
      }
    })();
  } else if (resolvedKind === "reliability") {
    const ins = d.prepare(`
      INSERT OR REPLACE INTO catalog_delivery_reliability
        (product_id, delivery_reliability, source_csv, updated_at)
      VALUES (?, ?, ?, ?)
    `);
    const updProd = d.prepare(`
      UPDATE catalog_products SET delivery_reliability = ? WHERE product_id = ?
    `);
    const relMap = getReliabilityMap();
    d.transaction(() => {
      for (const row of rows) {
        const productId = pick(row, ["productId", "product_id", "sku", "id"]) ?? Object.values(row)[0];
        const rawVal = pick(row, ["deliveryReliability", "delivery_reliability", "reliability"]) ?? Object.values(row)[1];
        const val = Number(rawVal);
        if (!productId || !Number.isFinite(val)) continue;
        ins.run(productId, val, sourceName, now);
        updProd.run(val, productId);
        relMap.set(productId, val);
        importedRows++;
      }
    })();
  } else if (resolvedKind === "carbon") {
    const ins = d.prepare(`
      INSERT OR REPLACE INTO catalog_carbon_footprint
        (product_id, carbon_kg_per_kg, source_csv, updated_at)
      VALUES (?, ?, ?, ?)
    `);
    const updProd = d.prepare(`
      UPDATE catalog_products SET carbon_kg_per_kg = ? WHERE product_id = ?
    `);
    const carbonMap = getCarbonMap();
    d.transaction(() => {
      for (const row of rows) {
        const productId = pick(row, ["productId", "product_id", "sku", "id"]) ?? Object.values(row)[0];
        const keys = Object.keys(row);
        const carbonKey =
          keys.find((k) => k.toLowerCase().includes("co2") || k.toLowerCase().includes("carbon")) ?? keys[1];
        const val = Number(row[carbonKey]);
        if (!productId || !Number.isFinite(val)) continue;
        ins.run(productId, val, sourceName, now);
        updProd.run(val, productId);
        carbonMap.set(productId, val);
        importedRows++;
      }
    })();
  } else if (resolvedKind === "kitchen_inventory") {
    const items = rows
      .map((row) => {
        const name = pick(row, ["name", "ingredient", "item"]);
        if (!name) return null;
        const rawHints = pick(row, ["catalogHints", "catalog_hints", "hints"]);
        const rawExcl = pick(row, ["excludeAllergens", "exclude_allergens"]);
        return {
          ingredientId: pick(row, ["ingredientId", "ingredient_id", "id"]),
          name,
          onHand: Number(pick(row, ["onHand", "on_hand", "quantity", "stock"]) ?? 0),
          unit: pick(row, ["unit"]) ?? "kg",
          parLevel: Number(pick(row, ["parLevel", "par_level", "par"]) ?? 0),
          catalogHints: rawHints ? rawHints.split(/[;|]/).map((s) => s.trim()).filter(Boolean) : [name.toLowerCase()],
          lactoseFreePreferred: /^(1|true|yes)$/i.test(pick(row, ["lactoseFreePreferred", "lactose_free"]) ?? ""),
          excludeAllergens: rawExcl ? rawExcl.split(/[;|]/).map((s) => s.trim()).filter(Boolean) : undefined,
          shelfLifeDays: pick(row, ["shelfLifeDays", "shelf_life_days"]),
          expiresOn: pick(row, ["expiresOn", "expires_on"]),
        };
      })
      .filter((x): x is NonNullable<typeof x> => x !== null);
    const saved = upsertInventory(customerId, items);
    importedRows = saved.length;
  }

  d.prepare(`
    INSERT INTO catalog_csv_imports (kind, source_name, row_count, imported_at)
    VALUES (?, ?, ?, ?)
  `).run(resolvedKind, sourceName, importedRows, now);

  return { kind: resolvedKind, sourceName, importedRows };
}

export function getCatalogDatabaseStats() {
  const d = ensureCatalogSynced();
  const count = (table: string) =>
    (d.prepare(`SELECT COUNT(*) as c FROM ${table}`).get() as { c: number }).c;
  const recentImports = d
    .prepare(
      `SELECT kind, source_name as sourceName, row_count as rowCount, imported_at as importedAt
       FROM catalog_csv_imports ORDER BY import_id DESC LIMIT 10`,
    )
    .all();
  return {
    productsCount: count("catalog_products"),
    reliabilityRowsCount: count("catalog_delivery_reliability"),
    carbonRowsCount: count("catalog_carbon_footprint"),
    availabilitySnapshotsCount: count("catalog_availability_snapshots"),
    ftsEnabled: ftsAvailable,
    recentCsvImports: recentImports,
  };
}

export type CatalogDbQueryFilters = {
  query?: string;
  productIds?: string[];
  lactoseFree?: boolean;
  organic?: boolean;
  vegan?: boolean;
  excludeAllergens?: string[];
  packUnit?: string;
  minPackSize?: number;
  maxPackSize?: number;
  minReliability?: number;
  maxCarbonKgPerKg?: number;
  origin?: string;
  brand?: string;
  category?: string;
  customerId?: string;
  requestedDate?: string;
  onlyAvailable?: boolean;
  sortBy?: "relevance" | "reliability_desc" | "carbon_asc" | "price_asc" | "pack_size_desc";
  limit?: number;
};

type DbProductRow = {
  product_id: string;
  name: string;
  name_fi: string | null;
  brand: string | null;
  category: string | null;
  categories_json: string;
  labels_json: string;
  allergens_json: string;
  may_contain_json: string;
  certifications_json: string;
  claims_json: string;
  substitutes_json: string;
  origin: string | null;
  producer: string | null;
  pack_size: number;
  pack_unit: string;
  pieces_per_pack: number | null;
  sales_unit: string | null;
  lactose_free: number;
  organic: number;
  vegan: number;
  delivery_reliability: number | null;
  carbon_kg_per_kg: number | null;
  available_amount?: number | null;
  availability_unknown?: number | null;
  available_date?: string | null;
  sales_block?: number | null;
  unit_price?: number | null;
  comparison_price?: number | null;
  comparison_unit?: string | null;
  currency?: string | null;
  snapshot_date?: string | null;
  snapshot_source?: string | null;
};

function sanitizeFtsTokens(q: string): string[] {
  return q
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, " ")
    .split(/[\s-]+/)
    .map((t) => t.trim())
    .filter((t) => t.length >= 2);
}

export function queryCatalogDatabase(filters: CatalogDbQueryFilters) {
  const d = ensureCatalogSynced();
  const limit = Math.min(Math.max(filters.limit ?? 25, 1), 100);
  const customerId = filters.customerId || "HOTEL-001";

  const where: string[] = [];
  const params: unknown[] = [];

  let ftsJoin = "";
  let ftsOrderExpr = "0";
  const qText = (filters.query ?? "").trim();

  if (qText) {
    const tokens = sanitizeFtsTokens(qText);
    if (ftsAvailable && tokens.length > 0) {
      const ftsExpr = tokens
        .map((t) => {
          const stem = stemToken(t);
          return stem !== t ? `("${t}"* OR "${stem}"*)` : `"${t}"*`;
        })
        .join(" AND ");
      ftsJoin = `JOIN catalog_products_fts fts ON fts.product_id = p.product_id`;
      where.push(`catalog_products_fts MATCH ?`);
      params.push(ftsExpr);
      ftsOrderExpr = `bm25(catalog_products_fts)`;
    } else if (tokens.length > 0) {
      for (const t of tokens) {
        const stem = stemToken(t);
        where.push(`(LOWER(p.name) LIKE ? OR LOWER(COALESCE(p.name_fi, '')) LIKE ? OR LOWER(COALESCE(p.brand, '')) LIKE ?)`);
        params.push(`%${stem}%`, `%${stem}%`, `%${stem}%`);
      }
    }
  }

  if (filters.productIds && filters.productIds.length > 0) {
    where.push(`p.product_id IN (${filters.productIds.map(() => "?").join(",")})`);
    params.push(...filters.productIds);
  }
  if (filters.lactoseFree === true) {
    where.push(`p.lactose_free = 1`);
  } else if (filters.lactoseFree === false) {
    where.push(`p.lactose_free = 0`);
  }
  if (filters.organic === true) {
    where.push(`p.organic = 1`);
  }
  if (filters.vegan === true) {
    where.push(`p.vegan = 1`);
  }
  if (filters.packUnit) {
    where.push(`UPPER(p.pack_unit) = ?`);
    params.push(filters.packUnit.trim().toUpperCase());
  }
  if (filters.minPackSize !== undefined) {
    where.push(`p.pack_size >= ?`);
    params.push(filters.minPackSize);
  }
  if (filters.maxPackSize !== undefined) {
    where.push(`p.pack_size <= ?`);
    params.push(filters.maxPackSize);
  }
  if (filters.minReliability !== undefined) {
    where.push(`p.delivery_reliability IS NOT NULL AND p.delivery_reliability >= ?`);
    params.push(filters.minReliability);
  }
  if (filters.maxCarbonKgPerKg !== undefined) {
    where.push(`p.carbon_kg_per_kg IS NOT NULL AND p.carbon_kg_per_kg <= ?`);
    params.push(filters.maxCarbonKgPerKg);
  }
  if (filters.origin) {
    where.push(`UPPER(COALESCE(p.origin, '')) = ?`);
    params.push(filters.origin.trim().toUpperCase());
  }
  if (filters.brand) {
    where.push(`LOWER(COALESCE(p.brand, '')) LIKE ?`);
    params.push(`%${filters.brand.trim().toLowerCase()}%`);
  }
  if (filters.category) {
    where.push(`(LOWER(COALESCE(p.category, '')) LIKE ? OR LOWER(p.categories_json) LIKE ?)`);
    const pat = `%${filters.category.trim().toLowerCase()}%`;
    params.push(pat, pat);
  }

  const snapJoinParams: unknown[] = [customerId];
  let snapDateClause = "";
  if (filters.requestedDate) {
    snapDateClause = `AND s2.requested_date = ?`;
    snapJoinParams.push(filters.requestedDate);
  }

  const snapJoin = `
    LEFT JOIN catalog_availability_snapshots snap
      ON snap.customer_id = ?
     AND snap.product_id = p.product_id
     AND snap.requested_date = (
       SELECT s2.requested_date
       FROM catalog_availability_snapshots s2
       WHERE s2.customer_id = snap.customer_id
         AND s2.product_id = p.product_id
         ${snapDateClause}
       ORDER BY s2.updated_at DESC, s2.requested_date DESC
       LIMIT 1
     )
  `;

  if (filters.onlyAvailable) {
    where.push(
      `snap.product_id IS NOT NULL AND snap.sales_block = 0 AND (snap.available_amount > 0 OR snap.availability_unknown = 1)`,
    );
  }

  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";

  let orderSql = `ORDER BY COALESCE(p.delivery_reliability, 0) DESC, p.product_id ASC`;
  const sortBy = filters.sortBy ?? (qText ? "relevance" : "reliability_desc");
  if (sortBy === "relevance" && qText && ftsJoin) {
    orderSql = `ORDER BY ${ftsOrderExpr} ASC, COALESCE(p.delivery_reliability, 0) DESC`;
  } else if (sortBy === "reliability_desc") {
    orderSql = `ORDER BY COALESCE(p.delivery_reliability, -1) DESC, p.product_id ASC`;
  } else if (sortBy === "carbon_asc") {
    orderSql = `ORDER BY CASE WHEN p.carbon_kg_per_kg IS NULL THEN 1 ELSE 0 END ASC, p.carbon_kg_per_kg ASC`;
  } else if (sortBy === "price_asc") {
    orderSql = `ORDER BY CASE WHEN snap.unit_price IS NULL THEN 1 ELSE 0 END ASC, snap.unit_price ASC`;
  } else if (sortBy === "pack_size_desc") {
    orderSql = `ORDER BY p.pack_size DESC, p.product_id ASC`;
  }

  // Over-fetch when allergen post-filtering or relevance re-scoring is active
  const fetchCap = filters.excludeAllergens?.length || qText ? Math.min(limit * 4, 300) : limit;
  const sql = `
    SELECT
      p.*,
      snap.available_amount,
      snap.availability_unknown,
      snap.available_date,
      snap.sales_block,
      snap.unit_price,
      snap.comparison_price,
      snap.comparison_unit,
      snap.currency,
      snap.requested_date as snapshot_date,
      snap.source as snapshot_source
    FROM catalog_products p
    ${ftsJoin}
    ${snapJoin}
    ${whereSql}
    ${orderSql}
    LIMIT ?
  `;

  let rows = d.prepare(sql).all(...snapJoinParams, ...params, fetchCap) as DbProductRow[];

  if (filters.excludeAllergens && filters.excludeAllergens.length > 0) {
    rows = rows.filter((r) => {
      const contains = JSON.parse(r.allergens_json) as string[];
      const mayContain = JSON.parse(r.may_contain_json) as string[];
      return allergenConflicts({ contains, mayContain }, filters.excludeAllergens!).length === 0;
    });
  }

  // Boost products whose primary word matches query tokens so "banana" ranks raw bananas above banana yoghurts
  if (qText && sortBy === "relevance") {
    const qTokens = sanitizeFtsTokens(qText);
    const hardwareRe = /\b(?:cutter|slicer|peeler|holder|dispenser|napkins?|gloves)\b/i;
    const askingHardware = hardwareRe.test(qText);
    rows = rows
      .map((r, idx) => {
        const words = `${r.name} ${r.name_fi ?? ""}`
          .toLowerCase()
          .split(/[^\p{L}\p{N}]+/u)
          .filter(Boolean);
        let boost = 0;
        for (const t of qTokens) {
          const stem = stemToken(t);
          const pos = words.findIndex(
            (w) => w === t || w === stem || w === `${stem}s` || w === `${stem}es`,
          );
          if (pos === 0) boost += 20;
          else if (pos > 0) boost += 10;
        }
        if (!askingHardware && hardwareRe.test(r.name)) boost -= 15;
        return { r, score: boost - idx * 0.05 };
      })
      .sort((a, b) => b.score - a.score)
      .map((x) => x.r);
  }

  const totalMatched = rows.length;
  const sliced = rows.slice(0, limit).map(formatDbProductRow);

  return {
    totalMatched,
    returnedCount: sliced.length,
    products: sliced,
  };
}

function formatDbProductRow(r: DbProductRow) {
  return {
    productId: r.product_id,
    name: r.name,
    nameFi: r.name_fi,
    brand: r.brand,
    category: r.category,
    packSize: r.pack_size,
    packUnit: r.pack_unit,
    piecesPerPack: r.pieces_per_pack,
    salesUnit: r.sales_unit,
    origin: r.origin,
    producer: r.producer,
    lactoseFree: Boolean(r.lactose_free),
    organic: Boolean(r.organic),
    vegan: Boolean(r.vegan),
    allergens: JSON.parse(r.allergens_json) as string[],
    mayContain: JSON.parse(r.may_contain_json) as string[],
    certifications: JSON.parse(r.certifications_json) as string[],
    deliveryReliability: r.delivery_reliability,
    carbonKgPerKg: r.carbon_kg_per_kg,
    cachedSnapshot:
      r.snapshot_date != null
        ? {
            requestedDate: r.snapshot_date,
            availableAmount: r.available_amount ?? null,
            availabilityUnknown: Boolean(r.availability_unknown),
            availableDate: r.available_date ?? null,
            salesBlock: Boolean(r.sales_block),
            unitPrice: r.unit_price ?? null,
            comparisonPrice: r.comparison_price ?? null,
            comparisonUnit: r.comparison_unit ?? null,
            currency: r.currency ?? null,
            source: r.snapshot_source ?? null,
          }
        : null,
  };
}

function defaultInspectionDate(): string {
  const d = new Date();
  d.setDate(d.getDate() + 2);
  return d.toISOString().slice(0, 10);
}

export type InspectProductParams = {
  productId?: string;
  productQuery?: string;
  customerId: string;
  requestedDate?: string;
  fetchLive?: boolean;
  /** Strictly true ONLY for buyer / planner; MUST be false for sourcing / valio-account agents. */
  includeKitchenStock: boolean;
};

export async function inspectProductInventoryAvailability(params: InspectProductParams) {
  const d = ensureCatalogSynced();
  const requestedDate = params.requestedDate || defaultInspectionDate();
  const fetchLive = params.fetchLive ?? true;

  let targetProduct: Product | undefined;
  let alternateMatches: Array<{ productId: string; name: string; packSize: number; packUnit: string }> = [];

  if (params.productId) {
    targetProduct = getProduct(params.productId.trim());
  }
  if (!targetProduct && params.productQuery) {
    const candidates = searchProducts({ q: params.productQuery, limit: 6 });
    targetProduct = candidates[0];
    alternateMatches = candidates.slice(1, 6).map((c) => ({
      productId: c.productId,
      name: c.name,
      packSize: c.packSize,
      packUnit: c.packUnit,
    }));
  }

  if (!targetProduct) {
    return {
      found: false,
      error: params.productId
        ? `Product ID "${params.productId}" was not found in the SQLite catalog.`
        : `No product matched "${params.productQuery ?? ""}" in the SQLite catalog.`,
    };
  }

  const pid = targetProduct.productId;

  // Optionally pull fresh Valio live price & availability (which also persists into catalog_availability_snapshots)
  let liveSupplierAvailability: {
    requestedDate: string;
    availableAmount: number | null;
    availabilityUnknown: boolean;
    availableDate: string | null;
    salesUnit: string | null;
    salesBlock: boolean;
    logisticModel: string | null;
    closingAt: string | null;
    unitPrice: number | null;
    comparisonPrice: number | null;
    comparisonUnit: string | null;
    currency: string | null;
    priceClaimId: string | null;
    availabilityClaimId: string | null;
    liveError?: string;
  } | null = null;

  if (fetchLive) {
    try {
      const [prices, avails] = await Promise.all([
        getPrices(params.customerId, requestedDate, [pid]),
        getAvailability(params.customerId, requestedDate, [pid]),
      ]);
      const pr = prices[0];
      const av = avails[0];
      if (pr || av) {
        liveSupplierAvailability = {
          requestedDate,
          availableAmount: av?.availableAmount ?? null,
          availabilityUnknown: av?.availabilityUnknown ?? false,
          availableDate: av?.availableDate ?? null,
          salesUnit: av?.salesUnit ?? null,
          salesBlock: av?.salesBlock ?? false,
          logisticModel: av?.logisticModel ?? null,
          closingAt: av?.closingAt ?? null,
          unitPrice: pr?.unitPrice ?? null,
          comparisonPrice: pr?.comparisonPrice ?? null,
          comparisonUnit: pr?.comparisonUnit ?? null,
          currency: pr?.currency ?? null,
          priceClaimId: pr?.claim.claimId ?? null,
          availabilityClaimId: av?.claim.claimId ?? null,
        };
      }
    } catch (err) {
      liveSupplierAvailability = {
        requestedDate,
        availableAmount: null,
        availabilityUnknown: true,
        availableDate: null,
        salesUnit: null,
        salesBlock: false,
        logisticModel: null,
        closingAt: null,
        unitPrice: null,
        comparisonPrice: null,
        comparisonUnit: null,
        currency: null,
        priceClaimId: null,
        availabilityClaimId: null,
        liveError: (err as Error).message,
      };
    }
  }

  // Query SQLite CSV tables for this product
  const prodRow = d
    .prepare(`SELECT * FROM catalog_products WHERE product_id = ?`)
    .get(pid) as DbProductRow | undefined;
  const relRow = d
    .prepare(
      `SELECT delivery_reliability as value, source_csv as sourceCsv, updated_at as updatedAt
       FROM catalog_delivery_reliability WHERE product_id = ?`,
    )
    .get(pid) as { value: number; sourceCsv: string; updatedAt: string } | undefined;
  const carbonRow = d
    .prepare(
      `SELECT carbon_kg_per_kg as value, source_csv as sourceCsv, updated_at as updatedAt
       FROM catalog_carbon_footprint WHERE product_id = ?`,
    )
    .get(pid) as { value: number; sourceCsv: string; updatedAt: string } | undefined;

  // Query all stored availability & price snapshots in SQLite for this product
  const snapshots = d
    .prepare(
      `SELECT
         requested_date as requestedDate,
         available_amount as availableAmount,
         availability_unknown as availabilityUnknown,
         available_date as availableDate,
         sales_unit as salesUnit,
         sales_block as salesBlock,
         logistic_model as logisticModel,
         closing_at as closingAt,
         unit_price as unitPrice,
         comparison_price as comparisonPrice,
         comparison_unit as comparisonUnit,
         currency,
         source,
         updated_at as updatedAt
       FROM catalog_availability_snapshots
       WHERE customer_id = ? AND product_id = ?
       ORDER BY requested_date DESC, updated_at DESC`,
    )
    .all(params.customerId, pid)
    .map((s) => {
      const rec = s as Record<string, unknown>;
      return {
        ...rec,
        availabilityUnknown: Boolean(rec.availabilityUnknown),
        salesBlock: Boolean(rec.salesBlock),
      };
    });

  // Resolve Valio-declared substitutes from SQLite
  const subIds = getValioSubstitutes(pid);
  const substitutes = subIds
    .map((subId) => {
      const subRow = d
        .prepare(
          `SELECT p.product_id, p.name, p.pack_size, p.pack_unit, p.lactose_free, p.organic,
                  p.delivery_reliability, p.carbon_kg_per_kg,
                  s.available_amount, s.available_date, s.sales_block, s.unit_price, s.requested_date
           FROM catalog_products p
           LEFT JOIN catalog_availability_snapshots s
             ON s.customer_id = ? AND s.product_id = p.product_id
            AND s.requested_date = (
              SELECT s2.requested_date FROM catalog_availability_snapshots s2
              WHERE s2.customer_id = ? AND s2.product_id = p.product_id
              ORDER BY s2.updated_at DESC LIMIT 1
            )
           WHERE p.product_id = ?`,
        )
        .get(params.customerId, params.customerId, subId) as Record<string, unknown> | undefined;
      if (!subRow) return null;
      return {
        productId: String(subRow.product_id),
        name: String(subRow.name),
        packSize: Number(subRow.pack_size),
        packUnit: String(subRow.pack_unit),
        lactoseFree: Boolean(subRow.lactose_free),
        organic: Boolean(subRow.organic),
        deliveryReliability: (subRow.delivery_reliability as number | null) ?? null,
        carbonKgPerKg: (subRow.carbon_kg_per_kg as number | null) ?? null,
        latestSnapshot:
          subRow.requested_date != null
            ? {
                requestedDate: String(subRow.requested_date),
                availableAmount: (subRow.available_amount as number | null) ?? null,
                availableDate: (subRow.available_date as string | null) ?? null,
                salesBlock: Boolean(subRow.sales_block),
                unitPrice: (subRow.unit_price as number | null) ?? null,
              }
            : null,
      };
    })
    .filter((x): x is NonNullable<typeof x> => x !== null);

  const result: Record<string, unknown> = {
    found: true,
    product: prodRow
      ? formatDbProductRow(prodRow)
      : {
          productId: targetProduct.productId,
          name: targetProduct.name,
          packSize: targetProduct.packSize,
          packUnit: targetProduct.packUnit,
        },
    csvMetrics: {
      deliveryReliability: relRow?.value ?? null,
      reliabilitySourceCsv: relRow?.sourceCsv ?? null,
      carbonKgPerKg: carbonRow?.value ?? null,
      carbonSourceCsv: carbonRow?.sourceCsv ?? null,
    },
    liveSupplierAvailability,
    availabilitySnapshots: snapshots,
    substitutes,
    alternateMatches,
  };

  // Strict least-privilege gate: ONLY attach buyer kitchen stock when includeKitchenStock === true
  if (params.includeKitchenStock) {
    const inv = getInventory(params.customerId);
    const kitchen = getKitchen(params.customerId);
    if (inv && kitchen) {
      const prodLower = `${targetProduct.name} ${targetProduct.nameFi ?? ""}`.toLowerCase();
      const matchingIngredients = inv.inventory.filter((item) => {
        return item.catalogHints.some((hint) => {
          const words = hint
            .toLowerCase()
            .split(/[\s-]+/)
            .filter((w) => w.length >= 3 && w !== "lactose" && w !== "free");
          return words.length > 0 && words.every((w) => prodLower.includes(stemToken(w)) || prodLower.includes(w));
        });
      });
      const matchedIds = new Set(matchingIngredients.map((i) => i.ingredientId));
      const relatedOrders = kitchen.orderHistory
        .filter((o) =>
          o.lines.some(
            (l) =>
              (l.ingredientId && matchedIds.has(l.ingredientId)) ||
              l.productName.toLowerCase().includes(targetProduct!.name.toLowerCase()),
          ),
        )
        .slice(0, 5);
      const relatedRecipes = kitchen.recipes
        .filter((r) => r.ingredients.some((ri) => matchedIds.has(ri.ingredientId)))
        .map((r) => ({
          recipeId: r.recipeId,
          name: r.name,
          batchesPerWeek: r.batchesPerWeek,
          ingredients: r.ingredients.filter((ri) => matchedIds.has(ri.ingredientId)),
        }));

      result.kitchenInventory = {
        hotelName: inv.hotelName,
        matchingPantryItems: matchingIngredients,
        relatedOrders,
        relatedRecipes,
      };
    }
  }

  return result;
}
