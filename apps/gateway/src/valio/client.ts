import type { ClaimPayload, SignedClaim } from "@tta/shared";
import { config } from "../config.js";
import { signClaim } from "../claims/sign.js";
import { attestationFor } from "../catalog/index.js";
import { recordAvailabilitySnapshots, recordPriceSnapshots } from "../catalog/db.js";

export type PriceResult = {
  productId: string;
  unitPrice: number | null;
  priceWithTax: number | null;
  comparisonPrice: number | null;
  comparisonUnit: string | null;
  currency: string;
  validFrom: string | null;
  validTo: string | null;
  error: boolean;
  claim: SignedClaim;
  raw: unknown;
};

export type AvailabilityResult = {
  productId: string;
  salesBlock: boolean;
  logisticModel: string | null;
  availableAmount: number | null;
  availabilityUnknown: boolean;
  availableDate: string | null;
  salesUnit: string | null;
  closingTime: string | null;
  /** closingTime normalised to ISO-8601 UTC (Valio sends offsets like +0200); null if absent/unparseable. */
  closingAt: string | null;
  claim: SignedClaim;
  raw: unknown;
};

function validUntilFrom(hours = 1): string {
  return new Date(Date.now() + hours * 3600_000).toISOString();
}

/** Demo hook: pretend Valio ran out of these products (applied on top of the mock backend's answer). */
export const simulatedStockouts = new Set<string>();

const MIN_REQUEST_GAP_MS = 100; // 10 requests/second maximum, even under parallel callers.
const MAX_AUTO_RETRY_SEC = 5;
let valioQueue: Promise<void> = Promise.resolve();
let nextValioRequestAt = 0;
let valioBlockedUntil = 0;
let hasCustomSleep = false;
let valioNow = () => Date.now();
let valioSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export class ValioRateLimitError extends Error {
  constructor(readonly retryAfterSec: number) {
    super(`Valio API rate limit reached; retry after ${retryAfterSec}s`);
    this.name = "ValioRateLimitError";
  }
}

/** Test hook for deterministic pacing / 429 coverage. */
export function configureValioRequestGateForTest(options?: {
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}) {
  valioQueue = Promise.resolve();
  nextValioRequestAt = 0;
  valioBlockedUntil = 0;
  hasCustomSleep = Boolean(options?.sleep);
  valioNow = options?.now ?? (() => Date.now());
  valioSleep = options?.sleep ?? ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
}

function retryDelayMs(response: Response): number {
  const value = response.headers.get("Retry-After");
  if (value) {
    const seconds = Number(value);
    if (Number.isFinite(seconds) && seconds >= 0) return Math.max(1_000, seconds * 1000);
    const date = Date.parse(value);
    if (Number.isFinite(date)) return Math.max(1_000, date - valioNow());
  }
  return 30_000;
}

function withTimeoutSignal(init?: RequestInit): RequestInit {
  const timeoutSignal = AbortSignal.timeout(15_000);
  const signal = init?.signal
    ? AbortSignal.any([init.signal, timeoutSignal])
    : timeoutSignal;
  return { ...init, signal };
}

/** Serializes mock API calls, paces them below 10/sec, and honors upstream 429 cooldowns. */
export async function valioFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  let release!: () => void;
  const previous = valioQueue;
  valioQueue = new Promise<void>((resolve) => { release = resolve; });
  await previous;
  try {
    const waitMs = Math.max(nextValioRequestAt, valioBlockedUntil) - valioNow();
    if (waitMs > 0) {
      const waitSec = Math.ceil(waitMs / 1000);
      if (waitSec > (hasCustomSleep ? 60 : MAX_AUTO_RETRY_SEC)) {
        throw new ValioRateLimitError(waitSec);
      }
      await valioSleep(waitMs);
    }
    nextValioRequestAt = valioNow() + MIN_REQUEST_GAP_MS;

    let response = await fetch(input, withTimeoutSignal(init));
    if (response.status !== 429) return response;

    const delay = retryDelayMs(response);
    const waitSec = Math.ceil(delay / 1000);
    valioBlockedUntil = Math.max(valioBlockedUntil, valioNow() + delay);
    if (waitSec > (hasCustomSleep ? 60 : MAX_AUTO_RETRY_SEC)) {
      throw new ValioRateLimitError(waitSec);
    }
    await valioSleep(valioBlockedUntil - valioNow());
    nextValioRequestAt = valioNow() + MIN_REQUEST_GAP_MS;
    response = await fetch(input, withTimeoutSignal(init));
    if (response.status === 429) {
      const retryAgain = retryDelayMs(response);
      valioBlockedUntil = Math.max(valioBlockedUntil, valioNow() + retryAgain);
      throw new ValioRateLimitError(Math.ceil(retryAgain / 1000));
    }
    return response;
  } finally {
    release();
  }
}

/** Valio sends "2026-11-12T15:00:00+0200" (no colon in offset). Normalise to an ISO instant, or null. */
export function parseClosingTime(v: unknown): string | null {
  if (typeof v !== "string" || !v) return null;
  const t = Date.parse(v.replace(/([+-]\d{2})(\d{2})$/, "$1:$2"));
  return Number.isNaN(t) ? null : new Date(t).toISOString();
}

export async function pingValio(): Promise<{ ok: boolean; body: string }> {
  const res = await valioFetch(`${config.valioBaseUrl}/api/ping`, {
    headers: { "X-API-Key": config.valioApiKey },
  });
  return { ok: res.ok, body: await res.text() };
}

export async function getPrices(
  customerId: string,
  requestedDate: string,
  productIds: string[],
): Promise<PriceResult[]> {
  if (productIds.length === 0) return [];
  if (productIds.length > 1000) {
    throw new Error("Max 1000 products per price request");
  }
  const res = await valioFetch(`${config.valioBaseUrl}/api/price`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-API-Key": config.valioApiKey,
    },
    body: JSON.stringify({
      customer: customerId,
      requestedDate,
      products: productIds,
    }),
  });
  if (!res.ok) {
    throw new Error(`Valio price API ${res.status}: ${await res.text()}`);
  }
  const data = (await res.json()) as {
    currency?: string;
    products: Array<Record<string, unknown>>;
  };
  const currency = data.currency ?? "EUR";

  const results: PriceResult[] = data.products.map((p) => {
    const productId = String(p.productId);
    const catalogPrice = p.catalogPrice as
      | { value?: number; valueWithTax?: number; validFrom?: string; validTo?: string }
      | null
      | undefined;
    const comparisonPriceObj = p.comparisonPrice as
      | { value?: number }
      | null
      | undefined;
    const unitPrice =
      catalogPrice?.value ??
      (typeof p.listPrice === "object" && p.listPrice
        ? (p.listPrice as { value?: number }).value
        : null) ??
      null;
    const claimPayload: ClaimPayload = {
      customerId,
      productId,
      unitPrice,
      currency,
      availableQuantity: null,
      salesUnit: null,
      comparisonPrice: comparisonPriceObj?.value ?? null,
      comparisonUnit: (p.comparisonUnit as string) ?? null,
      validUntil: catalogPrice?.validTo
        ? new Date(catalogPrice.validTo).toISOString()
        : validUntilFrom(1),
      claimType: "price",
      attestation: attestationFor(productId),
    };
    return {
      productId,
      unitPrice,
      priceWithTax: catalogPrice?.valueWithTax ?? null,
      comparisonPrice: comparisonPriceObj?.value ?? null,
      comparisonUnit: (p.comparisonUnit as string) ?? null,
      currency,
      validFrom: catalogPrice?.validFrom ?? null,
      validTo: catalogPrice?.validTo ?? null,
      error: Boolean(p.error) || unitPrice == null,
      claim: signClaim(claimPayload),
      raw: p,
    };
  });
  try {
    recordPriceSnapshots(customerId, requestedDate, results);
  } catch {
    // non-fatal if DB snapshot write fails
  }
  return results;
}

export async function getAvailability(
  customerId: string,
  requestedDate: string,
  productIds: string[],
): Promise<AvailabilityResult[]> {
  if (productIds.length === 0) return [];
  if (productIds.length > 1000) {
    throw new Error("Max 1000 products per availability request");
  }
  const res = await valioFetch(`${config.valioBaseUrl}/api/availability`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-API-Key": config.valioApiKey,
    },
    body: JSON.stringify({
      customer: customerId,
      requestedDate,
      products: productIds,
    }),
  });
  if (!res.ok) {
    throw new Error(`Valio availability API ${res.status}: ${await res.text()}`);
  }
  const data = (await res.json()) as {
    products: Array<Record<string, unknown>>;
  };

  const results: AvailabilityResult[] = data.products.map((p) => {
    const productId = String(p.productId);
    if (simulatedStockouts.has(productId)) {
      p = { ...p, salesBlock: true, scheduleLines: [] };
    }
    const lines = (p.scheduleLines as Array<Record<string, unknown>>) ?? [];
    const line = lines[0];
    const rawAvailableAmount = line && typeof line.availableAmount === "number" ? line.availableAmount : null;
    const availabilityUnknown = rawAvailableAmount != null && rawAvailableAmount >= 999999;
    const availableAmount = availabilityUnknown
      ? null
      : rawAvailableAmount === 0.01
        ? 1
        : rawAvailableAmount;
    const availableDate =
      line && typeof line.availableDate === "string" ? line.availableDate : null;
    const salesUnit =
      line && typeof line.salesUnit === "string" ? line.availableDate && typeof line.salesUnit === "string" ? line.salesUnit : line.salesUnit : null;
    const claimPayload: ClaimPayload = {
      customerId,
      productId,
      unitPrice: null,
      currency: "EUR",
      availableQuantity: availableAmount,
      availabilityUnknown,
      salesUnit,
      availableDate,
      validUntil: validUntilFrom(1),
      claimType: "availability",
    };
    return {
      productId,
      salesBlock: Boolean(p.salesBlock) || !line,
      logisticModel: (p.logisticModel as string) ?? null,
      availableAmount,
      availabilityUnknown,
      availableDate,
      salesUnit,
      closingTime: (p.closingTime as string) ?? null,
      closingAt: parseClosingTime(p.closingTime),
      claim: signClaim(claimPayload),
      raw: p,
    };
  });
  try {
    recordAvailabilitySnapshots(customerId, requestedDate, results);
  } catch {
    // non-fatal if DB snapshot write fails
  }
  return results;
}
