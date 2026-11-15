const API_KEY_STORAGE = "tta_api_key";

const inFlightGets = new Map<string, Promise<unknown>>();
const getCache = new Map<string, { data: unknown; at: number }>();
let cacheEpoch = 0;
const FRESH_GET_TTL_MS = 400;
const FALLBACK_GET_TTL_MS = 60_000;

export function clearApiCache(): void {
  cacheEpoch += 1;
  inFlightGets.clear();
  getCache.clear();
}

export function getApiKey(): string {
  try {
    return localStorage.getItem(API_KEY_STORAGE) ?? "hotel_buyer_key_001";
  } catch {
    return "hotel_buyer_key_001";
  }
}

export function setApiKey(key: string) {
  clearApiCache();
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
    inFlightGets.clear();
    cacheEpoch += 1;
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

  const requestEpoch = cacheEpoch;

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
    if (method === "GET" && requestEpoch === cacheEpoch) {
      getCache.set(cacheKey, { data: json, at: Date.now() });
    }
    return json as T;
  })();

  if (method === "GET") {
    inFlightGets.set(cacheKey, run);
    try {
      return await run;
    } finally {
      if (inFlightGets.get(cacheKey) === run) {
        inFlightGets.delete(cacheKey);
      }
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
    substitutionLabel?: "good" | "better" | "best";
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
    quoteId?: string;
    quoteValidUntil?: string;
    humanSignatureProof?: {
      verified: boolean;
      mode: string;
      credentialId: string;
      signerLabel: string;
      signaturePrefix: string;
      verifiedAt: string;
    } | null;
    authorizedFallback?: {
      productId: string;
      productName?: string;
      maxTotalPrice?: number;
    } | null;
    cascadeExecuted?: {
      droppedProductId: string;
      droppedProductName?: string;
      backupProductId: string;
      backupProductName: string;
      newTotalPrice: number;
      at: string;
    } | null;
    itemNeeds?: Array<{
      productIntent: string;
      quantity: number;
      unit: string;
      neededBy: string;
      constraints?: Record<string, unknown>;
    }>;
    isMultiItemBasket?: boolean;
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
  category?: string | null;
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
  orderByAt?: string | null;
  cutoffRisk?: boolean;
  paretoOptimal?: boolean;
  criteria?: {
    price: number;
    deliveryDate: string | null;
    reliability: number | null;
    carbonKgPerKg: number | null;
    certifications: string[];
  };
  criteriaScores?: {
    price: number;
    delivery: number;
    reliability: number;
    carbon: number;
  };
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

export type VoiceReadiness = {
  mode: "mock" | "live" | string;
  ready: boolean;
  phoneNumber: string;
  missing: string[];
};

export type VoiceTranscriptLine = {
  speaker: string;
  role?: "caller" | "assistant" | string;
  text: string;
  at?: string;
};

export type VoiceSimulateResponse = {
  ok?: boolean;
  callId?: string;
  preset?: string;
  callerPhone?: string;
  callerLabel?: string;
  phoneNumber?: string;
  transcript?: VoiceTranscriptLine[];
  turns?: VoiceTranscriptLine[];
  eventId?: string;
  status?: string;
  message?: string;
  approvalToken?: string | null;
  approvalUrl?: string | null;
  mockApprovalUrl?: string | null;
  safetyNote?: string;
  event?: {
    id: string;
    name: string;
    date: string;
    guests: number;
    status?: string;
    orderBy?: string;
    deliverBy?: string;
    autoOrder?: boolean;
    plan?: {
      estTotal: number;
      flags?: string[];
      lines?: Array<{
        ingredientId?: string;
        name: string;
        shortfall: number;
        unit: string;
        chosen?: {
          productId: string;
          productName: string;
          totalPrice: number;
        } | null;
      }>;
    };
  };
  voice?: {
    eventId: string;
    delivery: string;
    approval: string;
    approvalUrl?: string;
    errorCode?: string;
  } | null;
};

export type MandateSimulationResult = {
  totalOrders?: number;
  evaluatedCount?: number;
  autoCount: number;
  approvalCount: number;
  blockedCount: number;
  autoPct?: number;
  estimatedMinutesSaved?: number;
  currentAutoCount?: number;
  deltaAutoCount?: number;
  summary?: string;
  samples?: Array<{
    id?: string;
    orderId?: string;
    productName: string;
    totalPrice: number;
    quantity?: number;
    unit?: string;
    currentDecision?: string;
    simulatedDecision: string;
    failingRules?: string[];
    reasons?: string[];
  }>;
};

export type ArenaRunResult = {
  scenario?: string;
  title?: string;
  description?: string;
  prompt?: string;
  attackPrompt?: string;
  verdict?: string;
  passed?: boolean;
  blocked?: boolean;
  defenseLayer?: string;
  layersTriggered?: string[];
  summary?: string;
  explanation?: string;
  details?: unknown;
  auditRunId?: string;
  ranAt?: string;
  results?: Array<{
    id?: string;
    scenario?: string;
    title: string;
    attack?: string;
    passed: boolean;
    defenseLayer?: string;
    outcome: string;
    detail?: string;
  }>;
};

export type ValioSuggestion = {
  id: string;
  customerId: string;
  kind: "stockout_alert" | "better_price";
  title: string;
  body: string;
  status: "new" | "accepted" | "dismissed";
  createdAt: string;
  originalProductId: string;
  suggestedProductId: string;
  suggestedProductName: string;
  deltaEur: number;
  source: "valio_catalog" | "price_comparison";
  need: {
    productIntent: string;
    quantity: number;
    unit: string;
    neededBy: string;
  };
  intentId?: string;
};

export type RestockAutomationPolicy = {
  enabled: boolean;
  autoSyncInventory: boolean;
  syncIntervalMinutes: number;
  daysCover: number;
  maxItems: number;
  urgencies: Array<"critical" | "low">;
  pauseOnStandingOrderDrift: boolean;
  smartQuantities: boolean;
  intervalMinutes: number;
  dailyDigestEnabled?: boolean;
  dailyDigestTime?: string;
};

export type DailyRestockDigestStatus = {
  enabled: boolean;
  cadence: "1 email/day" | string;
  sendAtLocalTime: string;
  recipient: string;
  lastSentAt: string;
  nextScheduledAt: string;
  inboundDeliveriesCount: number;
  plannedRestockCount: number;
  recentRestockHistoryCount: number;
  summary: string;
};

export type RestockRunLine = {
  ingredientId?: string;
  ingredient: string;
  urgency: string;
  outcome: string;
  productName?: string;
  quantity?: number;
  unit?: string;
  orderId?: string;
  intentId?: string;
  status?: string;
  totalPrice?: number;
  committed?: boolean;
  savedEur?: number;
};

export type RestockRunResult = {
  customerId?: string;
  ranAt: string;
  trigger?: "manual" | "pos_sync" | "service_rush" | "scheduled";
  summary: string;
  skippedReason?: string;
  lines: RestockRunLine[];
  pendingApprovalCount: number;
  committedCount: number;
};

export type InventorySyncStatus = {
  autoSyncEnabled: boolean;
  syncIntervalMinutes: number;
  lastSyncedAt: string;
  lastSyncSource: "pos_sync" | "service_rush" | "delivery_receipt" | "scheduled";
  lastSyncSummary: string;
  deductions?: Array<{
    ingredientId: string;
    name: string;
    used: number;
    onHandAfter: number;
    unit: string;
  }>;
  connectedSources: Array<{
    id: string;
    label: string;
    detail: string;
    connected: boolean;
  }>;
};

export type StockHealthItem = {
  ingredientId: string;
  name: string;
  onHand: number;
  onOrder: number;
  parLevel: number;
  targetQty: number;
  suggestedOrderQty: number;
  unit: string;
  urgency: "critical" | "low" | "ok";
  standingOrderDrift?: boolean;
  daysToExpiry?: number;
};

export type StockHealthSnapshot = {
  daysCover: number;
  criticalCount: number;
  lowCount: number;
  okCount: number;
  actionableCount: number;
  items: StockHealthItem[];
};

export type RestockAutomationBundle = {
  policy: RestockAutomationPolicy;
  lastRun: RestockRunResult | null;
  syncStatus?: InventorySyncStatus;
  stockHealth?: StockHealthSnapshot | null;
  dailyDigest?: DailyRestockDigestStatus;
};

export function timeAgoShort(iso?: string | null): string {
  if (!iso) return "just now";
  const sec = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
  if (sec < 45) return "just now";
  if (sec < 3600) return `${Math.floor(sec / 60)} min ago`;
  if (sec < 86400) return `${Math.floor(sec / 3600)} h ago`;
  return `${Math.floor(sec / 86400)} d ago`;
}

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

export function isLabModeEnabled(): boolean {
  if (import.meta.env.VITE_SHOW_LAB_TOOLS === "true") return true;
  if (typeof window === "undefined") return false;
  return new URLSearchParams(window.location.search).get("lab") === "1";
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
