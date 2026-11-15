import { AsyncLocalStorage } from "node:async_hooks";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import pg from "pg";
import { config } from "../config.js";

// Parse INT8 (BIGINT / COUNT(*)) and NUMERIC as JS numbers to match application expectations.
pg.types.setTypeParser(20, (v: string) => Number(v));
pg.types.setTypeParser(1700, (v: string) => Number(v));

export interface DbClient {
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;
  queryOne<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T | undefined>;
  execute(sql: string, params?: unknown[]): Promise<{ rowCount: number }>;
  exec(sql: string): Promise<void>;
  withTransaction<T>(fn: (tx: DbClient) => Promise<T>): Promise<T>;
}

const SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS audit_events (
    id SERIAL PRIMARY KEY,
    run_id TEXT NOT NULL,
    customer_id TEXT NOT NULL,
    type TEXT NOT NULL,
    payload TEXT NOT NULL,
    prev_hash TEXT NOT NULL,
    hash TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_audit_run_customer ON audit_events(run_id, customer_id, id);

  CREATE TABLE IF NOT EXISTS order_intents (
    id TEXT PRIMARY KEY,
    customer_id TEXT NOT NULL,
    run_id TEXT NOT NULL,
    status TEXT NOT NULL,
    need_json TEXT NOT NULL,
    basket_json TEXT NOT NULL,
    snapshot_hash TEXT NOT NULL,
    policy_json TEXT NOT NULL,
    total_price DOUBLE PRECISION NOT NULL,
    needed_by TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    approval_snapshot_hash TEXT,
    idempotency_key TEXT,
    committed_order_id TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    meta_json TEXT
  );
  CREATE UNIQUE INDEX IF NOT EXISTS idx_idempotency
    ON order_intents(idempotency_key)
    WHERE idempotency_key IS NOT NULL;

  CREATE TABLE IF NOT EXISTS quotes (
    id TEXT PRIMARY KEY,
    customer_id TEXT NOT NULL,
    run_id TEXT NOT NULL,
    status TEXT NOT NULL,
    need_json TEXT NOT NULL,
    lines_json TEXT NOT NULL,
    claims_json TEXT NOT NULL,
    total_price DOUBLE PRECISION NOT NULL,
    currency TEXT NOT NULL,
    issued_at TEXT NOT NULL,
    valid_until TEXT NOT NULL,
    intent_id TEXT,
    meta_json TEXT
  );

  CREATE TABLE IF NOT EXISTS mandates (
    customer_id TEXT PRIMARY KEY,
    json TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS kitchen_profile (
    customer_id TEXT PRIMARY KEY,
    hotel_name TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS kitchen_inventory (
    customer_id TEXT NOT NULL,
    ingredient_id TEXT NOT NULL,
    json TEXT NOT NULL,
    seq SERIAL,
    PRIMARY KEY (customer_id, ingredient_id)
  );

  CREATE TABLE IF NOT EXISTS kitchen_recipes (
    customer_id TEXT NOT NULL,
    recipe_id TEXT NOT NULL,
    json TEXT NOT NULL,
    seq SERIAL,
    PRIMARY KEY (customer_id, recipe_id)
  );

  CREATE TABLE IF NOT EXISTS kitchen_orders (
    order_id TEXT PRIMARY KEY,
    customer_id TEXT NOT NULL,
    ordered_at TEXT NOT NULL,
    status TEXT NOT NULL,
    intent_id TEXT,
    json TEXT NOT NULL,
    seq SERIAL
  );
  CREATE UNIQUE INDEX IF NOT EXISTS idx_kitchen_orders_intent
    ON kitchen_orders(intent_id)
    WHERE intent_id IS NOT NULL;

  CREATE TABLE IF NOT EXISTS events (
    id TEXT PRIMARY KEY,
    customer_id TEXT NOT NULL,
    status TEXT NOT NULL,
    date TEXT NOT NULL,
    json TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS event_order_claims (
    event_id TEXT PRIMARY KEY,
    lease_until TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS standing_orders (
    id TEXT PRIMARY KEY,
    customer_id TEXT NOT NULL,
    ingredient_id TEXT NOT NULL,
    quantity DOUBLE PRECISION NOT NULL,
    weekday INTEGER NOT NULL,
    lead_time_days INTEGER NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS standing_runs (
    standing_id TEXT NOT NULL,
    delivery_date TEXT NOT NULL,
    placed_at TEXT NOT NULL,
    status TEXT NOT NULL,
    intent_id TEXT,
    detail TEXT NOT NULL,
    PRIMARY KEY (standing_id, delivery_date)
  );

  CREATE TABLE IF NOT EXISTS restock_automation_state (
    customer_id TEXT PRIMARY KEY,
    policy_json TEXT NOT NULL,
    last_run_json TEXT,
    sync_json TEXT
  );

  CREATE TABLE IF NOT EXISTS voice_calls (
    call_id TEXT NOT NULL,
    tool_call_id TEXT NOT NULL,
    payload_hash TEXT NOT NULL,
    result_json TEXT,
    status TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (call_id, tool_call_id)
  );

  CREATE TABLE IF NOT EXISTS voice_approvals (
    event_id TEXT PRIMARY KEY,
    customer_id TEXT NOT NULL,
    buyer_email TEXT NOT NULL,
    event_version INTEGER NOT NULL,
    snapshot_hash TEXT NOT NULL,
    token_hash TEXT NOT NULL UNIQUE,
    expires_at TEXT NOT NULL,
    consumed_at TEXT,
    status TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS voice_outbox (
    id TEXT PRIMARY KEY,
    event_id TEXT NOT NULL,
    customer_id TEXT NOT NULL,
    recipient TEXT NOT NULL,
    status TEXT NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0,
    next_attempt_at TEXT,
    provider_id TEXT,
    error_code TEXT,
    mock_approval_url TEXT,
    retry_after_at TEXT,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_voice_outbox_event ON voice_outbox(event_id);

  CREATE TABLE IF NOT EXISTS voice_attempts (
    caller_hash TEXT PRIMARY KEY,
    window_started TEXT NOT NULL,
    attempts INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS valio_suggestions (
    id TEXT PRIMARY KEY,
    customer_id TEXT NOT NULL,
    dedupe_key TEXT NOT NULL,
    status TEXT NOT NULL,
    created_at TEXT NOT NULL,
    json TEXT NOT NULL
  );
  CREATE UNIQUE INDEX IF NOT EXISTS idx_sugg_open
    ON valio_suggestions(customer_id, dedupe_key)
    WHERE status = 'new';

  CREATE TABLE IF NOT EXISTS eval_bench_state (
    customer_id TEXT PRIMARY KEY,
    payload_json TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS catalog_meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS catalog_delivery_reliability (
    product_id TEXT PRIMARY KEY,
    delivery_reliability DOUBLE PRECISION NOT NULL,
    source_csv TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS catalog_carbon_footprint (
    product_id TEXT PRIMARY KEY,
    carbon_kg_per_kg DOUBLE PRECISION NOT NULL,
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
    pack_size DOUBLE PRECISION NOT NULL,
    pack_unit TEXT NOT NULL,
    pieces_per_pack INTEGER,
    sales_unit TEXT,
    lactose_free INTEGER NOT NULL DEFAULT 0,
    organic INTEGER NOT NULL DEFAULT 0,
    vegan INTEGER NOT NULL DEFAULT 0,
    delivery_reliability DOUBLE PRECISION,
    carbon_kg_per_kg DOUBLE PRECISION
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
    available_amount DOUBLE PRECISION,
    availability_unknown INTEGER NOT NULL DEFAULT 0,
    available_date TEXT,
    sales_unit TEXT,
    sales_block INTEGER NOT NULL DEFAULT 0,
    logistic_model TEXT,
    closing_at TEXT,
    unit_price DOUBLE PRECISION,
    comparison_price DOUBLE PRECISION,
    comparison_unit TEXT,
    currency TEXT,
    source TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (customer_id, product_id, requested_date)
  );
  CREATE INDEX IF NOT EXISTS idx_avail_snap_product
    ON catalog_availability_snapshots(product_id, customer_id);

  CREATE TABLE IF NOT EXISTS catalog_csv_imports (
    import_id SERIAL PRIMARY KEY,
    kind TEXT NOT NULL,
    source_name TEXT NOT NULL,
    row_count INTEGER NOT NULL,
    imported_at TEXT NOT NULL
  );
`;

function decodeCaCert(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.includes("-----BEGIN CERTIFICATE-----")) return trimmed;
  return Buffer.from(trimmed, "base64").toString("utf8");
}

function createPgPool(databaseUrl: string, projectCaCert: string): pg.Pool {
  const parsed = new URL(databaseUrl);
  const sslMode = (parsed.searchParams.get("sslmode") ?? process.env.PGSSLMODE ?? "").toLowerCase();
  const useSsl =
    (sslMode !== "" && sslMode !== "disable") ||
    Boolean(projectCaCert.trim()) ||
    parsed.hostname.endsWith(".aivencloud.com");

  let ssl: pg.PoolConfig["ssl"] = undefined;
  if (useSsl) {
    // Strip sslmode from URL so pg-connection-string doesn't override our explicit ssl object.
    parsed.searchParams.delete("sslmode");
    ssl = projectCaCert.trim()
      ? { ca: decodeCaCert(projectCaCert), rejectUnauthorized: true }
      : { rejectUnauthorized: false };
  }

  return new pg.Pool({
    connectionString: parsed.toString(),
    ssl,
    max: Number(process.env.PG_POOL_MAX ?? 15),
  });
}

const txStorage = new AsyncLocalStorage<DbClient>();
let savepointSeq = 0;

let pgPool: pg.Pool | null = null;
let pgliteInstance: PGlite | null = null;
let rootClient: DbClient | null = null;
let schemaReadyPromise: Promise<void> | null = null;

async function runNestedSavepoint<T>(activeTx: DbClient, fn: (tx: DbClient) => Promise<T>): Promise<T> {
  const sp = `sp_${++savepointSeq}`;
  await activeTx.exec(`SAVEPOINT ${sp}`);
  try {
    const result = await fn(activeTx);
    await activeTx.exec(`RELEASE SAVEPOINT ${sp}`);
    return result;
  } catch (err) {
    await activeTx.exec(`ROLLBACK TO SAVEPOINT ${sp}`).catch(() => {});
    throw err;
  }
}

function wrapPgConnection(conn: pg.PoolClient): DbClient {
  const txClient: DbClient = {
    async query<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
      const res = await conn.query(sql, params);
      return res.rows as T[];
    },
    async queryOne<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T | undefined> {
      const res = await conn.query(sql, params);
      return (res.rows[0] as T | undefined) ?? undefined;
    },
    async execute(sql: string, params: unknown[] = []): Promise<{ rowCount: number }> {
      const res = await conn.query(sql, params);
      return { rowCount: res.rowCount ?? 0 };
    },
    async exec(sql: string): Promise<void> {
      await conn.query(sql);
    },
    async withTransaction<T>(fn: (tx: DbClient) => Promise<T>): Promise<T> {
      return runNestedSavepoint(txClient, fn);
    },
  };
  return txClient;
}

function buildBackendClient(): {
  rawExec: (sql: string) => Promise<void>;
  backend: DbClient;
} {
  const databaseUrl = (process.env.DATABASE_URL ?? config.databaseUrl ?? "").trim();
  const projectCaCert = process.env.PROJECT_CA_CERT ?? config.projectCaCert ?? "";

  if (databaseUrl) {
    pgPool = createPgPool(databaseUrl, projectCaCert);
    const pool = pgPool;
    const backend: DbClient = {
      async query<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
        const res = await pool.query(sql, params);
        return res.rows as T[];
      },
      async queryOne<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T | undefined> {
        const res = await pool.query(sql, params);
        return (res.rows[0] as T | undefined) ?? undefined;
      },
      async execute(sql: string, params: unknown[] = []): Promise<{ rowCount: number }> {
        const res = await pool.query(sql, params);
        return { rowCount: res.rowCount ?? 0 };
      },
      async exec(sql: string): Promise<void> {
        await pool.query(sql);
      },
      async withTransaction<T>(fn: (tx: DbClient) => Promise<T>): Promise<T> {
        const conn = await pool.connect();
        const txClient = wrapPgConnection(conn);
        try {
          await conn.query("BEGIN");
          const result = await txStorage.run(txClient, () => fn(txClient));
          await conn.query("COMMIT");
          return result;
        } catch (err) {
          await conn.query("ROLLBACK").catch(() => {});
          throw err;
        } finally {
          conn.release();
        }
      },
    };
    return {
      rawExec: async (sql: string) => {
        await pool.query(sql);
      },
      backend,
    };
  }

  const dataDir = process.env.PGLITE_DATA_DIR ?? config.pgliteDataDir;
  const isLocalDir = Boolean(dataDir && !dataDir.startsWith("memory://") && !dataDir.startsWith("idb://"));
  if (isLocalDir) {
    mkdirSync(dirname(dataDir), { recursive: true });
    // Recover from an interrupted initdb or stale single-process lock files (e.g. tsx watch reload).
    if (existsSync(dataDir) && !existsSync(join(dataDir, "PG_VERSION"))) {
      rmSync(dataDir, { recursive: true, force: true });
    }
    mkdirSync(dataDir, { recursive: true });
    for (const staleLock of ["postmaster.pid", ".s.PGSQL.5432.lock", ".s.PGSQL.5432.lock.out"]) {
      rmSync(join(dataDir, staleLock), { force: true });
    }
  }
  pgliteInstance = new PGlite(dataDir || "memory://");
  let pgl = pgliteInstance;

  const backend: DbClient = {
    async query<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
      const res = await pgl.query<T>(sql, params);
      return res.rows;
    },
    async queryOne<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T | undefined> {
      const res = await pgl.query<T>(sql, params);
      return res.rows[0] ?? undefined;
    },
    async execute(sql: string, params: unknown[] = []): Promise<{ rowCount: number }> {
      const res = await pgl.query(sql, params);
      return { rowCount: res.affectedRows ?? 0 };
    },
    async exec(sql: string): Promise<void> {
      await pgl.exec(sql);
    },
    async withTransaction<T>(fn: (tx: DbClient) => Promise<T>): Promise<T> {
      return pgl.transaction(async (tx) => {
        const txClient: DbClient = {
          async query<R = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<R[]> {
            const res = await tx.query<R>(sql, params);
            return res.rows;
          },
          async queryOne<R = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<R | undefined> {
            const res = await tx.query<R>(sql, params);
            return res.rows[0] ?? undefined;
          },
          async execute(sql: string, params: unknown[] = []): Promise<{ rowCount: number }> {
            const res = await tx.query(sql, params);
            return { rowCount: res.affectedRows ?? 0 };
          },
          async exec(sql: string): Promise<void> {
            await tx.exec(sql);
          },
          async withTransaction<R>(innerFn: (innerTx: DbClient) => Promise<R>): Promise<R> {
            return runNestedSavepoint(txClient, innerFn);
          },
        };
        return txStorage.run(txClient, () => fn(txClient));
      });
    },
  };

  return {
    rawExec: async (sql: string) => {
      try {
        await pgl.waitReady;
        await pgl.exec(sql);
      } catch (err) {
        if (!isLocalDir) throw err;
        console.warn(`[db] Recovering corrupted PGlite directory at ${dataDir}:`, err);
        await pgl.close().catch(() => {});
        rmSync(dataDir, { recursive: true, force: true });
        mkdirSync(dataDir, { recursive: true });
        pgliteInstance = new PGlite(dataDir);
        pgl = pgliteInstance;
        await pgl.waitReady;
        await pgl.exec(sql);
      }
    },
    backend,
  };
}

function ensureInitialized(): Promise<void> {
  if (!schemaReadyPromise) {
    const { rawExec, backend } = buildBackendClient();
    rootClient = {
      async query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]> {
        await ensureInitialized();
        const active = txStorage.getStore() ?? backend;
        return active.query<T>(sql, params);
      },
      async queryOne<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T | undefined> {
        await ensureInitialized();
        const active = txStorage.getStore() ?? backend;
        return active.queryOne<T>(sql, params);
      },
      async execute(sql: string, params?: unknown[]): Promise<{ rowCount: number }> {
        await ensureInitialized();
        const active = txStorage.getStore() ?? backend;
        return active.execute(sql, params);
      },
      async exec(sql: string): Promise<void> {
        await ensureInitialized();
        const active = txStorage.getStore() ?? backend;
        return active.exec(sql);
      },
      async withTransaction<T>(fn: (tx: DbClient) => Promise<T>): Promise<T> {
        await ensureInitialized();
        const active = txStorage.getStore();
        if (active) return runNestedSavepoint(active, fn);
        return backend.withTransaction(fn);
      },
    };
    schemaReadyPromise = rawExec(SCHEMA_SQL);
  }
  return schemaReadyPromise;
}

export async function initDb(): Promise<DbClient> {
  await ensureInitialized();
  return rootClient!;
}

export function getDb(): DbClient {
  if (!rootClient) {
    void ensureInitialized();
  }
  return rootClient!;
}

export function getDbBackendInfo(): { backend: "pg" | "pglite"; connected: boolean } {
  const databaseUrl = (process.env.DATABASE_URL ?? config.databaseUrl ?? "").trim();
  return {
    backend: databaseUrl ? "pg" : "pglite",
    connected: schemaReadyPromise !== null,
  };
}

export async function closeDb(): Promise<void> {
  if (schemaReadyPromise) {
    await schemaReadyPromise.catch(() => {});
  }
  if (pgPool) {
    await pgPool.end();
    pgPool = null;
  }
  if (pgliteInstance) {
    await pgliteInstance.close();
    pgliteInstance = null;
  }
  rootClient = null;
  schemaReadyPromise = null;
}
