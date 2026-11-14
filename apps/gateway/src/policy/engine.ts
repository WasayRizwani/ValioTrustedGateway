import type { BasketLine, Mandate, Need, Offer, PolicyVerdict } from "@tta/shared";
import { getProduct, allergenConflicts } from "../catalog/index.js";
import type { SpendSummary } from "./spend.js";

const DAIRY_SUBSTRINGS = [
  "milk", "maito", "cream", "kerma", "yogurt", "yoghurt", "jogurtti", "butter",
  "cheese", "juusto", "kefir", "viili", "quark", "rahka", "skyr", "custard",
];
const VOI_RE = /\bvoi(?:ta|n|ssa|lla|sta)?\b/i;

export function isDairyText(text: string): boolean {
  const t = text.toLowerCase();
  return DAIRY_SUBSTRINGS.some((w) => t.includes(w)) || VOI_RE.test(t);
}

function lineRequiresLactoseFree(line: BasketLine, need: Need): boolean {
  if (need.constraints.lactoseFree) return true;
  return isDairyText(`${need.productIntent} ${line.productName}`);
}

function isLactoseFree(line: BasketLine): boolean {
  if (line.labels.includes("lactose-free")) return true; // from the catalog's own nutritional claim
  // Name fallback must not accept "low lactose" — that is not lactose-free.
  return /lactose[\s-]?free|laktoositon|laktosfri/i.test(line.productName);
}

export function evaluatePolicy(
  mandate: Mandate,
  need: Need,
  lines: BasketLine[],
  options?: { isSubstitution?: boolean; partialFulfil?: boolean; spend?: SpendSummary },
): PolicyVerdict {
  const reasons: string[] = [];
  const failingRules: string[] = [];
  const total = lines.reduce((s, l) => s + l.totalPrice, 0);
  const totalQty = lines.reduce((s, l) => s + l.totalQuantity, 0);

  if (new Date(mandate.expiresAt).getTime() < Date.now()) {
    failingRules.push("mandate_expired");
    return {
      decision: "blocked",
      reasons: ["Purchasing mandate has expired"],
      failingRules,
    };
  }

  // Lactose restriction applies to dairy lines (or any line the need marks
  // lactose-free) — not to bananas or eggs. Prefer catalog labels over names.
  if (mandate.allergenRestrictions.includes("must_be_lactose_free")) {
    for (const line of lines) {
      if (!lineRequiresLactoseFree(line, need)) continue;
      if (!isLactoseFree(line)) {
        failingRules.push("allergen_restrictions");
        reasons.push(
          `${line.productName} (${line.productId}) is dairy but not labelled lactose-free`,
        );
      }
    }
  }
  // Explicitly excluded allergens: declared CONTAINS or MAY CONTAIN both fail (school / hospital rules).
  if (need.constraints.excludeAllergens?.length) {
    for (const line of lines) {
      for (const c of allergenConflicts({ contains: line.allergens, mayContain: line.mayContain }, need.constraints.excludeAllergens)) {
        failingRules.push("allergen_restrictions");
        reasons.push(`${line.productName}: ${c.level} ${c.found} (excluded: ${c.excluded})`);
      }
    }
  }

  if (total > mandate.maxOrderValueEur) {
    failingRules.push("over_spend");
    reasons.push(
      `Total €${total.toFixed(2)} exceeds mandate max €${mandate.maxOrderValueEur}`,
    );
  }

  // Category / brand: only judged for products the catalog knows (their category
  // codes are often opaque, so match on name + category tokens). Violations are
  // pending_approval, not blocked: a human may legitimately widen the mandate for
  // a one-off item; blocking is reserved for an expired mandate.
  const cats = mandate.allowedCategories.map((c) => c.toLowerCase());
  const brands = mandate.allowedBrands.map((b) => b.toLowerCase());
  for (const line of lines) {
    const product = getProduct(line.productId);
    if (!product) continue;
    if (cats.length > 0 && !cats.includes("*")) {
      const hay = [product.category, ...(product.categories ?? []), product.name, product.nameFi, line.productName]
        .filter(Boolean).join(" ").toLowerCase();
      if (!cats.some((c) => hay.includes(c))) {
        failingRules.push("category_not_allowed");
        reasons.push(`${line.productName} (${line.productId}) is outside the allowed categories`);
      }
    }
    if (brands.length > 0 && !brands.includes("*") && product.brand) {
      if (!brands.includes(product.brand.toLowerCase())) {
        failingRules.push("brand_not_allowed");
        reasons.push(`${line.productName}: brand ${product.brand} is not in the allowed brands`);
      }
    }
  }

  if (need.constraints.maxPricePerUnit !== undefined) {
    for (const line of lines) {
      const perUnit = line.comparisonPrice ?? (line.totalQuantity > 0 ? line.totalPrice / line.totalQuantity : null);
      if (perUnit !== null && perUnit > need.constraints.maxPricePerUnit) {
        failingRules.push("over_unit_price");
        reasons.push(
          `${line.productName}: €${perUnit.toFixed(2)}/unit exceeds max €${need.constraints.maxPricePerUnit}/unit`,
        );
      }
    }
  }

  const spend = options?.spend;
  if (spend) {
    const checks: Array<[number | undefined, number, string, string]> = [
      [mandate.maxDailySpendEur, spend.day, "over_daily_spend", "daily"],
      [mandate.maxWeeklySpendEur, spend.week, "over_weekly_spend", "weekly"],
      [mandate.maxMonthlySpendEur, spend.month, "over_monthly_spend", "monthly"],
    ];
    for (const [cap, spent, rule, label] of checks) {
      if (cap !== undefined && spent + total > cap) {
        failingRules.push(rule);
        reasons.push(`Committed €${spent.toFixed(2)} + this order €${total.toFixed(2)} exceeds ${label} limit €${cap}`);
      }
    }
    if (mandate.maxOrdersPerDay !== undefined && spend.ordersToday + 1 > mandate.maxOrdersPerDay) {
      failingRules.push("over_order_velocity");
      reasons.push(`${spend.ordersToday + 1} orders today exceeds limit of ${mandate.maxOrdersPerDay}`);
    }
    // Order splitting: many orders just under the per-order cap within 24h.
    const threshold = mandate.maxOrderValueEur * 0.8;
    if (
      total > threshold &&
      total <= mandate.maxOrderValueEur &&
      spend.recent24h.filter((t) => t > threshold && t <= mandate.maxOrderValueEur).length >= 2
    ) {
      failingRules.push("order_splitting_suspected");
      reasons.push("3+ orders in 24h each above 80% of the per-order limit — possible order splitting");
    }
  }

  const qtyCap =
    mandate.maxQuantities?.[need.unit] ??
    (mandate.maxQuantity.unit === need.unit ? mandate.maxQuantity.value : undefined);
  if (qtyCap !== undefined && need.quantity > qtyCap) {
    failingRules.push("over_quantity");
    reasons.push(
      `Requested ${need.quantity} ${need.unit} exceeds mandate max ${qtyCap} ${need.unit}`,
    );
  }

  for (const line of lines) {
    if (line.availableDate && line.availableDate > need.neededBy) {
      failingRules.push("late_delivery");
      reasons.push(
        `${line.productId} available ${line.availableDate} after needed ${need.neededBy}`,
      );
    }
    if (line.deliveryReliability == null) {
      if (!mandate.autoPurchaseIf.reliabilityUnknownOk) {
        failingRules.push("unknown_reliability");
        reasons.push(`${line.productId} has unknown delivery reliability`);
      }
    }
  }

  if (options?.isSubstitution || lines.some((l) => l.isSubstitution)) {
    if (!mandate.allowedSubstitutions) {
      failingRules.push("substitution");
      reasons.push("Substitutions are not allowed by mandate — human sign-off needed");
    } else if (mandate.requireApprovalFor.includes("substitution")) {
      failingRules.push("substitution");
      reasons.push("Substitutions require human approval");
    }
  }

  if (options?.partialFulfil) {
    failingRules.push("partial_fulfil");
    reasons.push("Partial fulfilment requires human approval");
  }

  // Deduplicate failing rules
  const uniqueFailing = [...new Set(failingRules)];

  if (uniqueFailing.includes("mandate_expired")) {
    return { decision: "blocked", reasons, failingRules: uniqueFailing };
  }

  if (uniqueFailing.length === 0) {
    // also check auto flags
    if (
      mandate.autoPurchaseIf.withinMaxOrderValue &&
      mandate.autoPurchaseIf.deliveryOnOrBeforeNeededBy
    ) {
      return {
        decision: "auto_commit",
        reasons: ["All mandate auto-purchase conditions met", ...reasons],
        failingRules: [],
      };
    }
    const autoFailing: string[] = [];
    if (!mandate.autoPurchaseIf.withinMaxOrderValue) autoFailing.push("over_spend");
    if (!mandate.autoPurchaseIf.deliveryOnOrBeforeNeededBy) autoFailing.push("late_delivery");
    return {
      decision: "pending_approval",
      reasons: ["Human approval required by mandate autoPurchaseIf settings", ...reasons],
      failingRules: autoFailing,
    };
  }

  // Any require_approval_for match → pending
  const needsApproval = uniqueFailing.some((r) =>
    mandate.requireApprovalFor.includes(r),
  );
  if (needsApproval || uniqueFailing.length > 0) {
    return {
      decision: "pending_approval",
      reasons: reasons.length ? reasons : ["Human approval required by mandate"],
      failingRules: uniqueFailing,
    };
  }

  return {
    decision: "auto_commit",
    reasons: ["Within purchasing mandate"],
    failingRules: [],
  };
}

export function offerToBasketLine(offer: Offer): BasketLine {
  return {
    productId: offer.productId,
    productName: offer.productName,
    packs: offer.requiredPacks,
    packSize: offer.packSize,
    packUnit: offer.packUnit,
    totalQuantity: offer.totalQuantity,
    quantityUnit: offer.quantityUnit,
    unitPrice: offer.unitPrice,
    totalPrice: offer.totalPrice,
    comparisonPrice: offer.comparisonPrice,
    comparisonUnit: offer.comparisonUnit,
    availableQuantity: offer.availableQuantity,
    availabilityUnknown: offer.availabilityUnknown,
    availableDate: offer.availableDate,
    deliveryReliability: offer.deliveryReliability,
    claimIds: [
      offer.priceClaim?.signature ?? "",
      offer.availabilityClaim?.signature ?? "",
    ].filter(Boolean),
    isSubstitution: offer.isSubstitution,
    substitutionLabel: offer.substitutionLabel,
    labels: offer.labels ?? [],
    allergens: offer.allergens ?? getProduct(offer.productId)?.allergens ?? [],
    mayContain: offer.mayContain ?? [],
    certifications: offer.certifications ?? [],
    origin: offer.origin ?? null,
    producer: offer.producer ?? null,
  };
}
