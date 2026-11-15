import type { Need, Offer, Mandate, Preferences } from "@tta/shared";
import {
  computePacks,
  getCarbon,
  getProduct,
  getReliability,
  getValioSubstitutes,
  allergenConflicts,
  extractMandateExcludedAllergens,
  expandExcludedAllergens,
  isLactoseFree,
  searchFromNeed,
  type Product,
} from "./index.js";
import {
  getAvailability,
  getPrices,
  type AvailabilityResult,
  type PriceResult,
} from "../valio/client.js";
import { getMandate } from "../auth/customers.js";
import { isDairyText } from "../policy/engine.js";
import { isDeterministicallyCompatible } from "./substituteJudge.js";

function dateOnly(d: string): string {
  return d.slice(0, 10);
}

/** Cut-off within this window counts as "at risk" (order may not make it into the picking run). */
export const CUTOFF_RISK_WINDOW_MS = 2 * 3600_000;

/**
 * Order cut-off assumptions: Valio's availability `closingTime` is the last moment to order for the requested
 * (needed-by) delivery date. Passed cut-off => the offer cannot be delivered on time. Within 2h => cutoffRisk.
 * Products without closingTime (e.g. non-terminal / no schedule) are assumed to have no known cut-off.
 */
export function cutoffInfo(
  closingAt: string | null | undefined,
  nowMs: number,
): { orderByAt: string | null; passed: boolean; risk: boolean } {
  if (!closingAt) return { orderByAt: null, passed: false, risk: false };
  const t = Date.parse(closingAt);
  if (Number.isNaN(t)) return { orderByAt: null, passed: false, risk: false };
  return { orderByAt: new Date(t).toISOString(), passed: t <= nowMs, risk: t - nowMs <= CUTOFF_RISK_WINDOW_MS };
}

/** Delivered on/before neededBy AND order cut-off not passed. */
export function isOnTime(o: Offer, neededBy: string, nowMs: number): boolean {
  if (o.orderByAt && Date.parse(o.orderByAt) <= nowMs) return false;
  return !o.availableDate || o.availableDate <= neededBy;
}

const WEIGHT_KEYS = ["price", "reliability", "carbon", "delivery"] as const;

/** Validates (non-negative, finite) and normalises weights to sum 1. Returns null when absent / all zero. */
export function normalizePreferences(p?: Preferences | null): Record<(typeof WEIGHT_KEYS)[number], number> | null {
  if (!p) return null;
  let sum = 0;
  for (const k of WEIGHT_KEYS) {
    const v = p[k];
    if (v == null) continue;
    if (typeof v !== "number" || !Number.isFinite(v) || v < 0) throw new Error(`preferences.${k} must be a non-negative number`);
    sum += v;
  }
  if (sum === 0) return null;
  const out = {} as Record<(typeof WEIGHT_KEYS)[number], number>;
  for (const k of WEIGHT_KEYS) out[k] = (p[k] ?? 0) / sum;
  return out;
}

const dayNum = (d: string) => Date.parse(d.slice(0, 10)) / 86400_000;

/** Fills criteria + normalised 0..1 criteriaScores (1 = best, unknown = 0.5). Mutates offers. */
export function computeCriteria(offers: Offer[], need: Need, nowMs: number): void {
  const eff = (o: Offer) => dayNum(o.availableDate ?? need.neededBy);
  const dates = offers.map(eff);
  const dMin = Math.min(...dates), dMax = Math.max(...dates);
  const carbons = offers.map((o) => o.carbonKgPerKg).filter((c): c is number => c != null);
  const cMin = Math.min(...carbons), cMax = Math.max(...carbons);
  const validPrices = offers.map((o) => o.totalPrice).filter((p) => p > 0);
  const cheapestOverall = validPrices.length ? Math.min(...validPrices) : null;
  for (const o of offers) {
    o.criteria = {
      price: o.totalPrice,
      deliveryDate: o.availableDate,
      reliability: o.deliveryReliability,
      carbonKgPerKg: o.carbonKgPerKg,
      certifications: o.certifications,
    };
    const price = cheapestOverall && o.totalPrice > 0 ? cheapestOverall / o.totalPrice : 0.5;
    const earliness = dMax === dMin ? 1 : 1 - (eff(o) - dMin) / (dMax - dMin);
    const delivery = isOnTime(o, need.neededBy, nowMs) ? earliness : earliness * 0.3;
    const carbon =
      o.carbonKgPerKg == null ? 0.5 : cMax === cMin ? 1 : 1 - (o.carbonKgPerKg - cMin) / (cMax - cMin);
    o.criteriaScores = {
      price,
      delivery,
      reliability: o.deliveryReliability ?? 0.5,
      carbon,
    };
  }
}

/**
 * Pareto flag over offers that can be fulfilled (and on time, when any are): price lower, reliability higher,
 * carbon lower, delivery earlier. Unknown reliability/carbon count as worst. Others get false.
 */
export function markPareto(offers: Offer[], need: Need, nowMs: number): void {
  const fulfil = offers.filter((o) => o.canFulfil);
  const onTimeSet = fulfil.filter((o) => isOnTime(o, need.neededBy, nowMs));
  const pool = onTimeSet.length ? onTimeSet : fulfil;
  // vector where lower is better on every axis
  const vec = (o: Offer) => [
    o.totalPrice,
    o.deliveryReliability == null ? Infinity : -o.deliveryReliability,
    o.carbonKgPerKg ?? Infinity,
    dayNum(o.availableDate ?? need.neededBy),
  ];
  const vs = new Map(pool.map((o) => [o, vec(o)]));
  for (const o of offers) {
    if (!vs.has(o)) {
      o.paretoOptimal = false;
      continue;
    }
    const a = vs.get(o)!;
    o.paretoOptimal = !pool.some((p) => {
      if (p === o) return false;
      const b = vs.get(p)!;
      return b.every((x, i) => x <= a[i]) && b.some((x, i) => x < a[i]);
    });
  }
}

export async function buildOffers(
  customerId: string,
  need: Need,
  options?: {
    productIds?: string[];
    includeSubstitutions?: boolean;
    /** Optional criterion weights; when absent the default ranking is unchanged. */
    preferences?: Preferences;
    /** Optional mandate so offer ranking prefers allergen-safe products under Kitchen Rules. */
    mandate?: Mandate | null;
    /** Injectable clock (tests). */
    now?: Date;
    /** Pre-fetched Valio maps from buildOffersBatch to avoid duplicate upstream requests. */
    preloaded?: {
      prices: Map<string, PriceResult>;
      avails: Map<string, AvailabilityResult>;
    };
    /** Secondary search hints (e.g. ingredient synonym phrases like "oat flakes" for "rolled oats"). */
    extraSearchHints?: string[];
  },
): Promise<Offer[]> {
  const nowMs = (options?.now ?? new Date()).getTime();
  const prefs = normalizePreferences(options?.preferences);
  const soft = new WeakMap<Offer, number>(); // default-score part that preferences replace
  let candidates: Product[];
  if (options?.productIds?.length) {
    candidates = options.productIds
      .map((id) => getProduct(id))
      .filter((p): p is Product => !!p);
  } else {
    candidates = searchFromNeed(need, 20, options?.extraSearchHints);
  }

  // Hard constraints come from the catalog's own facts, not from product-name guesses.
  if (need.constraints.lactoseFree) candidates = candidates.filter((p) => isLactoseFree(p));
  if (need.constraints.excludeAllergens?.length) {
    const excl = expandExcludedAllergens(need.constraints.excludeAllergens);
    candidates = candidates.filter(
      (p) =>
        allergenConflicts(
          { contains: p.allergens ?? [], mayContain: p.mayContain ?? [] },
          excl,
        ).length === 0,
    );
  }

  // Prefer allergen-safe candidates when mandate rules are active (without dropping explicit test productIds
  // unless `options.mandate` was explicitly supplied).
  const effectiveMandate =
    options?.mandate !== undefined
      ? options.mandate
      : !options?.productIds?.length
        ? await getMandate(customerId)
        : null;
  const mandateExcluded = extractMandateExcludedAllergens(effectiveMandate?.allergenRestrictions);
  const mandateMustLf = Boolean(effectiveMandate?.allergenRestrictions?.includes("must_be_lactose_free"));
  const candidateSafeForMandate = (p: Product): boolean => {
    if (
      mandateExcluded.length > 0 &&
      allergenConflicts({ contains: p.allergens ?? [], mayContain: p.mayContain ?? [] }, mandateExcluded).length > 0
    ) {
      return false;
    }
    if (mandateMustLf && (need.constraints.lactoseFree || isDairyText(`${need.productIntent} ${p.name}`)) && !isLactoseFree(p)) {
      return false;
    }
    return true;
  };
  if (effectiveMandate && !options?.productIds?.length && (mandateExcluded.length > 0 || mandateMustLf)) {
    const safeOnly = candidates.filter(candidateSafeForMandate);
    if (safeOnly.length > 0) candidates = safeOnly;
  }
  const searched = candidates;

  if (candidates.length === 0) return [];

  const ids = candidates.map((c) => c.productId);
  let priceMap: Map<string, PriceResult>;
  let availMap: Map<string, AvailabilityResult>;
  if (
    options?.preloaded &&
    ids.every((id) => options.preloaded!.prices.has(id) && options.preloaded!.avails.has(id))
  ) {
    priceMap = options.preloaded.prices;
    availMap = options.preloaded.avails;
  } else {
    const [prices, avails] = await Promise.all([
      getPrices(customerId, need.neededBy, ids),
      getAvailability(customerId, need.neededBy, ids),
    ]);
    priceMap = new Map(prices.map((p) => [p.productId, p]));
    availMap = new Map(avails.map((a) => [a.productId, a]));
  }

  const offers: Offer[] = [];
  for (const product of candidates) {
    const pack = computePacks(need.quantity, need.unit, product);
    if (!pack.compatible) continue;
    const price = priceMap.get(product.productId);
    const avail = availMap.get(product.productId);
    if (!price || price.error || price.unitPrice == null) continue;
    if (!avail || avail.salesBlock) continue;

    const availableQuantity = avail.availableAmount;
    const availabilityUnknown = avail.availabilityUnknown;
    const canFulfil = availabilityUnknown || (
      availableQuantity != null &&
      availableQuantity > 0 &&
      availableQuantity >= pack.requiredPacks
    );

    const shortfall = canFulfil
      ? null
      : availableQuantity == null
        ? pack.requiredPacks
        : Math.max(0, pack.requiredPacks - availableQuantity);

    const totalPrice = price.unitPrice * pack.requiredPacks;
    const comparisonPrice =
      price.comparisonPrice ??
      (pack.quantityUnit === "L" || pack.quantityUnit === "KG"
        ? totalPrice / pack.totalQuantity
        : null);

    const deliveryReliability = getReliability(product.productId);
    const carbonKgPerKg = getCarbon(product.productId);
    const availableDate = avail.availableDate
      ? dateOnly(avail.availableDate)
      : null;
    const cut = cutoffInfo(avail.closingAt, nowMs);
    const onTime =
      (!availableDate || availableDate <= need.neededBy) && !cut.passed;

    const scoreReasons: string[] = [];
    let score = 0;
    let softParts = 0;
    if (canFulfil) {
      score += 40;
      scoreReasons.push(availabilityUnknown
        ? "Valio availability is unknown; this terminal product is not quantity-capped"
        : "Can fulfil requested quantity");
    } else {
      scoreReasons.push("Cannot fully fulfil quantity");
    }
    if (onTime) {
      score += 25;
      scoreReasons.push(`Delivery on/before ${need.neededBy}`);
    } else if (cut.passed) {
      scoreReasons.push(`Order cut-off passed (${cut.orderByAt}) — cannot arrive by ${need.neededBy}`);
    } else {
      scoreReasons.push(`Earliest delivery ${availableDate}`);
    }
    if (!cut.passed && cut.risk) {
      score -= 5;
      scoreReasons.push(`Order cut-off imminent (order by ${cut.orderByAt})`);
    }
    if (deliveryReliability != null) {
      score += deliveryReliability * 12;
      softParts += deliveryReliability * 12;
      scoreReasons.push(`Delivery reliability ${(deliveryReliability * 100).toFixed(0)}%`);
    } else {
      scoreReasons.push("Delivery reliability unknown");
    }
    if (carbonKgPerKg != null) {
      // Lower carbon is better — small sustainability tilt
      score += Math.max(0, 5 - carbonKgPerKg);
      softParts += Math.max(0, 5 - carbonKgPerKg);
      scoreReasons.push(`Carbon ~${carbonKgPerKg.toFixed(2)} kg/kg`);
    }
    if (effectiveMandate && !candidateSafeForMandate(product)) {
      score -= 60;
      scoreReasons.push("Conflicts with mandate allergen / lactose rule");
    }
    const offer: Offer = {
      productId: product.productId,
      productName: product.name,
      brand: product.brand ?? null,
      category: product.category ?? null,
      packSize: product.packSize,
      packUnit: product.packUnit,
      requiredPacks: pack.requiredPacks,
      totalQuantity: pack.totalQuantity,
      quantityUnit: pack.quantityUnit,
      unitPrice: price.unitPrice,
      totalPrice,
      comparisonPrice,
      comparisonUnit: price.comparisonUnit ?? pack.quantityUnit,
      availableQuantity,
      availabilityUnknown,
      availableDate,
      canFulfil,
      shortfall,
      deliveryReliability,
      carbonKgPerKg,
      score,
      scoreReasons,
      labels: product.labels ?? [],
      allergens: product.allergens ?? [],
      mayContain: product.mayContain ?? [],
      certifications: product.certifications ?? [],
      origin: product.origin ? product.origin.toUpperCase() : null,
      producer: product.producer ?? null,
      claims: product.claims ?? [],
      isSubstitution: false,
      priceClaim: price.claim,
      availabilityClaim: avail.claim,
      orderByAt: cut.orderByAt,
      cutoffRisk: cut.risk,
    };
    soft.set(offer, softParts);
    offers.push(offer);
  }

  // Price is the primary differentiator: cost per requested unit (what you actually pay, pack rounding included)
  // relative to the cheapest offer that can really be delivered in time.
  const deliverable = offers.filter((o) => o.canFulfil && isOnTime(o, need.neededBy, nowMs));
  const catCount = new Map<string, number>();
  for (const o of deliverable) catCount.set(o.category ?? "", (catCount.get(o.category ?? "") ?? 0) + 1);
  const mainCat = [...catCount.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
  const pool = deliverable.filter((o) => (o.category ?? "") === mainCat);
  const cheapest = pool.length ? Math.min(...pool.map((o) => o.totalPrice)) : null;
  for (const o of offers) {
    if (cheapest != null && o.totalPrice > 0 && (o.category ?? "") === mainCat) {
      const ratio = cheapest / o.totalPrice;
      o.score += 45 * ratio;
      soft.set(o, (soft.get(o) ?? 0) + 45 * ratio);
      o.scoreReasons.unshift(
        ratio >= 0.9995
          ? `Cheapest deliverable offer (€${o.totalPrice.toFixed(2)})`
          : `${Math.round((1 / ratio - 1) * 100)}% more expensive than the cheapest deliverable offer (€${cheapest.toFixed(2)})`,
      );
    }
    if (o.requiredPacks > 150) o.score -= Math.min(6, o.requiredPacks / 200); // tie-break: hundreds of tiny packs are a handling burden
  }

  computeCriteria(offers, need, nowMs);
  markPareto(offers, need, nowMs);

  if (prefs) {
    // Replace the default soft part (price 45 + reliability 12 + carbon ~5 = ~62) with the caller's weighting,
    // keeping fulfilment / on-time / cut-off hard parts untouched.
    const label = WEIGHT_KEYS.filter((k) => prefs[k] > 0)
      .map((k) => `${k} ${Math.round(prefs[k] * 100)}%`)
      .join(", ");
    for (const o of offers) {
      const cs = o.criteriaScores!;
      const weighted = prefs.price * cs.price + prefs.reliability * cs.reliability + prefs.carbon * cs.carbon + prefs.delivery * cs.delivery;
      o.score = o.score - (soft.get(o) ?? 0) + 62 * weighted;
      o.scoreReasons.unshift(`Preference-weighted (${label}): ${(weighted * 100).toFixed(0)}/100`);
    }
  }

  // Fulfilable first, then score
  offers.sort((a, b) => Number(b.canFulfil) - Number(a.canFulfil) || b.score - a.score);

  if (options?.includeSubstitutions && offers.length > 0) {
    const labels: Array<"best" | "better" | "good"> = ["best", "better", "good"];
    const anchorCat = offers[0]?.category ?? null;
    const isSubCompatible = (o: Offer) =>
      Boolean(options?.productIds?.length) ||
      isDeterministicallyCompatible({
        queryText: need.productIntent,
        anchorCategory: anchorCat,
        candidate: {
          productId: o.productId,
          name: o.productName,
          category: o.category,
          isValioDeclaredSub: o.substitutionSource === "valio_catalog",
        },
        veganRequested: need.constraints.vegan,
      }).ok;

    const anyFull = offers.some((o) => o.canFulfil && isSubCompatible(o));
    if (!anyFull) {
      // Partial-availability path: label top 3 compatible partial options as GBB alternatives
      offers
        .filter(isSubCompatible)
        .slice(0, 3)
        .forEach((o, i) => {
          o.isSubstitution = true;
          o.substitutionLabel = labels[i];
          o.scoreReasons = [
            `Partial availability · substitution (${labels[i]})`,
            ...o.scoreReasons,
          ];
        });
    } else if (!offers[0].canFulfil) {
      // Primary ranked can't fulfil — mark fulfilable compatible alternatives as GBB
      const fulfilable = offers.filter((o) => o.canFulfil && isSubCompatible(o)).slice(0, 3);
      fulfilable.forEach((o, i) => {
        o.isSubstitution = true;
        o.substitutionLabel = labels[i];
        o.scoreReasons = [`Substitution (${labels[i]})`, ...o.scoreReasons];
      });
    } else if (offers.length >= 2) {
      // Still surface next-best fulfilable compatible options as GBB for explainability
      offers
        .filter((o) => o.canFulfil && isSubCompatible(o))
        .slice(0, 3)
        .forEach((o, i) => {
          o.substitutionLabel = labels[i];
          if (i > 0) {
            o.scoreReasons = [`Alternative (${labels[i]})`, ...o.scoreReasons];
          }
        });
    }
  }

  // Nothing fulfilable on time? Ask the catalog what Valio itself declares as a substitute — then
  // re-check constraints, price and stock for those, instead of guessing a swap.
  const onTime = (o: Offer) => isOnTime(o, need.neededBy, nowMs);
  if (
    options?.includeSubstitutions &&
    !options.productIds?.length &&
    !offers.some((o) => o.canFulfil && onTime(o))
  ) {
    const origin = new Map<string, string>();
    for (const c of searched.slice(0, 8))
      for (const id of getValioSubstitutes(c.productId))
        if (!candidates.some((x) => x.productId === id) && !origin.has(id)) origin.set(id, c.name);
    if (origin.size) {
      const extra = await buildOffers(customerId, need, {
        productIds: [...origin.keys()].slice(0, 12),
        includeSubstitutions: false,
        preferences: options.preferences,
        now: options.now,
      });
      for (const e of extra) {
        e.isSubstitution = true;
        e.substitutionSource = "valio_catalog";
        e.substituteFor = origin.get(e.productId);
        e.scoreReasons = [`Valio-declared substitute for "${e.substituteFor}"`, ...e.scoreReasons];
      }
      offers.push(...extra);
      offers.sort((a, b) => Number(b.canFulfil) - Number(a.canFulfil) || b.score - a.score);
    }
  }

  return offers;
}

export function explainOffers(offers: Offer[], need: Need, mandate?: Mandate | null): string {
  if (offers.length === 0) {
    return `No offers matched "${need.productIntent}" for ${need.quantity} ${need.unit} by ${need.neededBy}.`;
  }
  const top = offers[0];
  const lines = [
    `Top offer: ${top.productName} (${top.productId}).`,
    `Need ${need.quantity} ${need.unit} → ${top.requiredPacks} packs × ${top.packSize}${top.packUnit} = ${top.totalQuantity}${top.quantityUnit}.`,
    `Unit price €${top.unitPrice.toFixed(2)}, total €${top.totalPrice.toFixed(2)}.`,
    top.canFulfil
      ? "Quantity can be fulfilled."
      : `Partial availability: shortfall of ${top.shortfall} packs (avail ${top.availableQuantity ?? 0}).`,
    ...top.scoreReasons.slice(0, 4),
  ];
  const gbb = offers.filter((o) => o.substitutionLabel);
  if (gbb.length) {
    lines.push(
      `Good/better/best: ${gbb
        .map(
          (o) =>
            `${o.substitutionLabel}=${o.productId}${o.canFulfil ? "" : " (partial)"}`,
        )
        .join(", ")}.`,
    );
  }
  if (mandate) {
    lines.push(
      `Mandate ${mandate.mandateId} max order €${mandate.maxOrderValueEur}; this offer is €${top.totalPrice.toFixed(2)}.`,
    );
  }
  return lines.join(" ");
}

export type BatchOfferItem = {
  need: Need;
  offers: Offer[];
  explanation: string;
};

/**
 * Rank offers for multiple Needs in one coordinated batch.
 * Groups shortlisted SKUs by neededBy date so Valio price/availability APIs are called once per date.
 */
export async function buildOffersBatch(
  customerId: string,
  needs: Need[],
  options?: {
    includeSubstitutions?: boolean;
    preferences?: Preferences;
    mandate?: Mandate | null;
    now?: Date;
  },
): Promise<{ items: BatchOfferItem[]; combinedExplanation: string }> {
  if (needs.length === 0) return { items: [], combinedExplanation: "No items requested." };
  if (needs.length === 1) {
    const offers = await buildOffers(customerId, needs[0], {
      includeSubstitutions: options?.includeSubstitutions ?? true,
      preferences: options?.preferences,
      mandate: options?.mandate,
      now: options?.now,
    });
    const explanation = explainOffers(offers, needs[0], options?.mandate);
    return {
      items: [{ need: needs[0], offers, explanation }],
      combinedExplanation: explanation,
    };
  }

  // Shortlist per need; keep each date-bucket <= 25 unique SKUs to stay light on upstream Valio APIs
  const perNeedCap = Math.max(4, Math.min(12, Math.floor(24 / needs.length)));
  const shortlistedByIdx: Product[][] = needs.map((need) => {
    let cands = searchFromNeed(need, perNeedCap);
    if (need.constraints.lactoseFree) cands = cands.filter((p) => isLactoseFree(p));
    if (need.constraints.excludeAllergens?.length) {
      cands = cands.filter(
        (p) =>
          allergenConflicts(
            { contains: p.allergens ?? [], mayContain: p.mayContain ?? [] },
            need.constraints.excludeAllergens ?? [],
          ).length === 0,
      );
    }
    return cands.slice(0, perNeedCap);
  });

  const idsByDate = new Map<string, Set<string>>();
  needs.forEach((need, idx) => {
    const set = idsByDate.get(need.neededBy) ?? new Set<string>();
    for (const c of shortlistedByIdx[idx]) set.add(c.productId);
    idsByDate.set(need.neededBy, set);
  });

  const preloadedByDate = new Map<
    string,
    { prices: Map<string, PriceResult>; avails: Map<string, AvailabilityResult> }
  >();

  for (const [date, idSet] of idsByDate.entries()) {
    const ids = [...idSet];
    if (!ids.length) continue;
    const [prices, avails] = await Promise.all([
      getPrices(customerId, date, ids),
      getAvailability(customerId, date, ids),
    ]);
    preloadedByDate.set(date, {
      prices: new Map(prices.map((p) => [p.productId, p])),
      avails: new Map(avails.map((a) => [a.productId, a])),
    });
  }

  const items: BatchOfferItem[] = [];
  for (let i = 0; i < needs.length; i++) {
    const need = needs[i];
    const cands = shortlistedByIdx[i];
    const preloaded = preloadedByDate.get(need.neededBy);
    const offers = cands.length
      ? await buildOffers(customerId, need, {
          productIds: cands.map((c) => c.productId),
          includeSubstitutions: options?.includeSubstitutions ?? true,
          preferences: options?.preferences,
          mandate: options?.mandate,
          now: options?.now,
          preloaded,
        })
      : [];
    items.push({
      need,
      offers,
      explanation: explainOffers(offers, need, options?.mandate),
    });
  }

  const combinedTotal = items.reduce((s, it) => s + (it.offers[0]?.totalPrice ?? 0), 0);
  const summaryParts = items.map((it, idx) => {
    const top = it.offers[0];
    return top
      ? `Item ${idx + 1} (${it.need.quantity} ${it.need.unit} ${it.need.productIntent}): ${top.productName} €${top.totalPrice.toFixed(2)}`
      : `Item ${idx + 1} (${it.need.quantity} ${it.need.unit} ${it.need.productIntent}): no matching offer`;
  });
  const combinedExplanation = `${summaryParts.join(" · ")}. Combined top total: €${combinedTotal.toFixed(2)}.`;

  return { items, combinedExplanation };
}
