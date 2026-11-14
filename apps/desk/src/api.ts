const API_KEY_STORAGE = "tta_api_key";

const inFlightGets = new Map<string, Promise<unknown>>();
const getCache = new Map<string, { data: unknown; at: number }>();
const FRESH_GET_TTL_MS = 400;
const FALLBACK_GET_TTL_MS = 60_000;

export function getApiKey(): string {
  try {
    return localStorage.getItem(API_KEY_STORAGE) ?? "hotel_buyer_key_001";
  } catch {
    return "hotel_buyer_key_001";
  }
}

export function setApiKey(key: string) {
  inFlightGets.clear();
  getCache.clear();
  try {
    localStorage.setItem(API_KEY_STORAGE, key);
  } catch {
    // Ignore storage errors (e.g. private browsing / quota exceeded)
  }
}

export async function api<T = unknown>(
  path: string,
  init?: RequestInit,
): Promise<T> {
  const method = (init?.method ?? "GET").toUpperCase();
  const apiKey = getApiKey();
  const cacheKey = `${apiKey}:${path}`;

  if (method !== "GET") {
    getCache.clear();
  } else {
    const cached = getCache.get(cacheKey);
    if (cached && Date.now() - cached.at < FRESH_GET_TTL_MS) {
      return cached.data as T;
    }
    const existing = inFlightGets.get(cacheKey);
    if (existing) {
      return existing as Promise<T>;
    }
  }

  const run = (async (): Promise<T> => {
    const res = await fetch(path, {
      ...init,
      headers: {
        "Content-Type": "application/json",
        "X-API-Key": apiKey,
        "X-Desk-UI": "1",
        ...(init?.headers ?? {}),
      },
    });
    const text = await res.text();
    let json: any = null;
    if (text) {
      try {
        json = JSON.parse(text);
      } catch {
        if (!res.ok) {
          throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`);
        }
        return text as unknown as T;
      }
    }
    if (!res.ok) {
      if (res.status === 429 && method === "GET") {
        const fallback = getCache.get(cacheKey);
        if (fallback && Date.now() - fallback.at < FALLBACK_GET_TTL_MS) {
          return fallback.data as T;
        }
      }
      throw new Error(
        res.status === 429
          ? (json?.message ?? "Rate limit reached — please wait a few seconds and try again.")
          : typeof json?.error === "string"
            ? json.error
            : (json?.message ?? (json ? JSON.stringify(json) : `HTTP ${res.status}`)),
      );
    }
    if (method === "GET") {
      getCache.set(cacheKey, { data: json, at: Date.now() });
    }
    return json as T;
  })();

  if (method === "GET") {
    inFlightGets.set(cacheKey, run);
    try {
      return await run;
    } finally {
      inFlightGets.delete(cacheKey);
    }
  }

  return run;
}

export type Intent = {
  id: string;
  customerId: string;
  runId: string;
  status: string;
  need: {
    productIntent: string;
    quantity: number;
    unit: string;
    neededBy: string;
  };
  basket: Array<{
    productId: string;
    productName: string;
    packs: number;
    packSize: number;
    packUnit: string;
    totalQuantity: number;
    quantityUnit: string;
    unitPrice: number;
    totalPrice: number;
    comparisonPrice: number | null;
    comparisonUnit: string | null;
    availableQuantity: number | null;
    availabilityUnknown?: boolean;
    availableDate: string | null;
    deliveryReliability: number | null;
    claimIds?: string[];
    isSubstitution: boolean;
    labels?: string[];
    allergens?: string[];
    mayContain?: string[];
    certifications?: string[];
    origin?: string | null;
    producer?: string | null;
  }>;
  snapshotHash: string;
  meta?: {
    rationale: string[];
    consideredOffers: number;
    alternatives: Array<{
      productId: string;
      productName: string;
      totalPrice: number;
      deltaEur: number;
      availableDate: string | null;
      deliveryReliability: number | null;
      canFulfil: boolean;
      isSubstitution: boolean;
      certifications: string[];
      origin: string | null;
      note: string;
    }>;
  };
  policy: {
    decision: string;
    reasons: string[];
    failingRules: string[];
  };
  totalPrice: number;
  neededBy: string;
  expiresAt: string;
  committedOrderId: string | null;
  createdAt: string;
  updatedAt: string;
};

export type Mandate = {
  mandateId: string;
  customerId: string;
  maxOrderValueEur: number;
  maxQuantity: { unit: string; value: number };
  maxQuantities?: Record<string, number>;
  allowedSubstitutions: boolean;
  autoPurchaseIf: {
    reliabilityUnknownOk: boolean;
    withinMaxOrderValue: boolean;
    deliveryOnOrBeforeNeededBy: boolean;
  };
  requireApprovalFor: string[];
  expiresAt: string;
  allergenRestrictions: string[];
  allowedCategories: string[];
  allowedBrands?: string[];
  maxDailySpendEur?: number;
  maxWeeklySpendEur?: number;
  maxMonthlySpendEur?: number;
  maxOrdersPerDay?: number;
  priceDriftTolerancePct?: number;
};

export type AuditEvent = {
  id: number;
  type: string;
  payload: unknown;
  prevHash: string;
  hash: string;
  createdAt: string;
};

export type Offer = {
  productId: string;
  productName: string;
  brand: string | null;
  packSize: number;
  packUnit: string;
  requiredPacks: number;
  totalQuantity: number;
  quantityUnit: string;
  unitPrice: number;
  totalPrice: number;
  comparisonPrice: number | null;
  comparisonUnit: string | null;
  availableQuantity: number | null;
  availabilityUnknown?: boolean;
  availableDate: string | null;
  canFulfil: boolean;
  shortfall?: number | null;
  deliveryReliability: number | null;
  carbonKgPerKg: number | null;
  score: number;
  scoreReasons: string[];
  labels: string[];
  allergens?: string[];
  mayContain?: string[];
  certifications?: string[];
  origin?: string | null;
  producer?: string | null;
  substitutionSource?: string;
  substituteFor?: string;
  isSubstitution?: boolean;
  substitutionLabel?: "good" | "better" | "best";
  priceClaim?: { signature: string; claim: unknown; asOf: string };
  availabilityClaim?: { signature: string };
};

export function localDate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

export function nextMonday(): string {
  const d = new Date();
  const day = d.getDay();
  let delta = (1 - day + 7) % 7;
  if (delta === 0) delta = 7;
  d.setDate(d.getDate() + delta);
  return localDate(d);
}

export function ruleLabel(rule: string): string {
  const map: Record<string, string> = {
    over_spend: "Exceeds spending limit",
    over_quantity: "High quantity order",
    unknown_reliability: "Unknown delivery reliability",
    late_delivery: "Delivery after needed-by date",
    substitution: "Substitution outside mandate",
    partial_fulfil: "Partial fulfilment",
    allergen_restrictions: "Allergen restriction",
    mandate_expired: "Mandate expired",
    category_not_allowed: "Category not allowed",
    brand_not_allowed: "Brand not allowed",
    over_unit_price: "Exceeds unit price limit",
    over_daily_spend: "Exceeds daily spend limit",
    over_weekly_spend: "Exceeds weekly spend limit",
    over_monthly_spend: "Exceeds monthly spend limit",
    over_order_velocity: "Exceeds daily order count limit",
    order_splitting_suspected: "Suspected order splitting",
    price_change_on_revalidate: "Price changed on revalidation",
  };
  return map[rule] ?? rule;
}
