import { MandateSchema, type Mandate } from "@tta/shared";
import { getDb } from "../audit/chain.js";
import { credentials, type Role } from "../config.js";

export type AuthContext = {
  apiKey: string;
  customerId: string;
  role: Role;
  agentId?: string;
};

const defaultMandates = new Map<string, Mandate>([
  [
    "HOTEL-001",
    {
      mandateId: "MANDATE-HOTEL-001",
      customerId: "HOTEL-001",
      allowedCategories: [
        "dairy",
        "milk",
        "juomat",
        "elintarvikkeet",
        "fruit",
        "produce",
        "banana",
        "egg",
        "bakery",
        "maito",
        "banaani",
        "muna",
        "kananmuna",
        "hedelmät",
      ],
      maxOrderValueEur: 500,
      maxDailySpendEur: 2000,
      maxWeeklySpendEur: 6000,
      maxMonthlySpendEur: 20000,
      maxOrdersPerDay: 25,
      maxQuantity: { unit: "litre", value: 1000 },
      maxQuantities: { litre: 1000, kg: 500, each: 2000, pack: 200 },
      allowedBrands: ["*"],
      allowedSubstitutions: false,
      allergenRestrictions: ["must_be_lactose_free"],
      // Demo: allow auto-commit when reliability CSV misses a SKU (common for milk).
      // Flip to false to force pending_approval on unknown_reliability.
      autoPurchaseIf: {
        deliveryOnOrBeforeNeededBy: true,
        withinMaxOrderValue: true,
        reliabilityUnknownOk: true,
      },
      requireApprovalFor: [
        "over_spend",
        "unknown_reliability",
        "price_change_on_revalidate",
        "late_delivery",
        "substitution",
        "partial_fulfil",
        "over_quantity",
        "category_not_allowed",
        "brand_not_allowed",
        "over_unit_price",
        "over_daily_spend",
        "over_weekly_spend",
        "over_monthly_spend",
        "over_order_velocity",
        "order_splitting_suspected",
      ],
      expiresAt: "2026-12-31T23:59:59Z",
    },
  ],
  [
    "SCHOOL-001",
    {
      mandateId: "MANDATE-SCHOOL-001",
      customerId: "SCHOOL-001",
      allowedCategories: ["dairy", "milk", "juomat", "elintarvikkeet"],
      maxOrderValueEur: 200,
      maxDailySpendEur: 600,
      maxWeeklySpendEur: 2000,
      maxMonthlySpendEur: 6000,
      maxOrdersPerDay: 10,
      maxQuantity: { unit: "litre", value: 200 },
      maxQuantities: { litre: 200, kg: 100, each: 500, pack: 100 },
      allowedBrands: ["*"],
      allowedSubstitutions: true,
      allergenRestrictions: ["must_be_lactose_free"],
      autoPurchaseIf: {
        deliveryOnOrBeforeNeededBy: true,
        withinMaxOrderValue: true,
        reliabilityUnknownOk: true,
      },
      requireApprovalFor: [
        "over_spend",
        "unknown_reliability",
        "price_change_on_revalidate",
        "late_delivery",
        "substitution",
        "partial_fulfil",
        "over_quantity",
        "category_not_allowed",
        "brand_not_allowed",
        "over_unit_price",
        "over_daily_spend",
        "over_weekly_spend",
        "over_monthly_spend",
        "over_order_velocity",
        "order_splitting_suspected",
      ],
      expiresAt: "2026-12-31T23:59:59Z",
    },
  ],
]);

export function authenticate(apiKey: string | undefined): AuthContext | null {
  if (!apiKey) return null;
  const cred = credentials[apiKey];
  if (!cred) return null;
  return { apiKey, customerId: cred.customerId, role: cred.role, agentId: cred.agentId };
}

export class ForbiddenError extends Error {
  constructor(action: string) {
    super(
      `forbidden: "${action}" requires a buyer credential. Agent credentials may search, quote and order within the mandate, but cannot approve, override policy or change authority.`,
    );
  }
}

/** Throws unless the caller holds a buyer (human-side) credential. */
export function assertBuyer(auth: AuthContext, action: string): void {
  if (auth.role !== "buyer") throw new ForbiddenError(action);
}

function mandateTable() {
  const db = getDb();
  db.exec(
    `CREATE TABLE IF NOT EXISTS mandates (
       customer_id TEXT PRIMARY KEY,
       json TEXT NOT NULL,
       updated_at TEXT NOT NULL
     )`,
  );
  return db;
}

/** Mandates are persisted so edits survive a gateway restart. */
export function getMandate(customerId: string): Mandate | null {
  const db = mandateTable();
  const row = db
    .prepare(`SELECT json FROM mandates WHERE customer_id = ?`)
    .get(customerId) as { json: string } | undefined;
  if (row) return MandateSchema.parse(JSON.parse(row.json));
  const seed = defaultMandates.get(customerId);
  if (!seed) return null;
  saveMandate(seed);
  return seed;
}

function saveMandate(m: Mandate) {
  mandateTable()
    .prepare(
      `INSERT INTO mandates (customer_id, json, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(customer_id) DO UPDATE SET json=excluded.json, updated_at=excluded.updated_at`,
    )
    .run(m.customerId, JSON.stringify(m), new Date().toISOString());
}

export function setMandate(mandate: Mandate): Mandate {
  if (!defaultMandates.has(mandate.customerId)) {
    throw new Error("Unknown customer");
  }
  saveMandate(mandate);
  return mandate;
}

export function resetMandate(customerId: string): Mandate | null {
  const seed = defaultMandates.get(customerId);
  if (!seed) return null;
  saveMandate(seed);
  return seed;
}

export function assertCustomerAccess(
  auth: AuthContext,
  requestedCustomerId?: string,
): void {
  if (requestedCustomerId && requestedCustomerId !== auth.customerId) {
    throw new Error(
      "Customer isolation violation: credential is bound to a different customer",
    );
  }
}
