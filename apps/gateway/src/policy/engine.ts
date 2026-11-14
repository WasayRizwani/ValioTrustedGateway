import type { BasketLine, Mandate, Need, Offer, PolicyVerdict } from "@tta/shared";
import {
  getProduct,
  allergenConflicts,
  extractMandateExcludedAllergens,
  expandExcludedAllergens,
} from "../catalog/index.js";
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

function lineRequiresLactoseFree(line: BasketLine, lineNeed: Need, isMultiLine: boolean): boolean {
  if (lineNeed.constraints.lactoseFree) {
    // In a multi-line order without explicit per-line needs, only dairy lines inherit a summary lactose-free flag.
    return isMultiLine ? isDairyText(`${line.productName}`) || isDairyText(lineNeed.productIntent) : true;
  }
  return isDairyText(`${lineNeed.productIntent} ${line.productName}`);
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
  options?: { isSubstitution?: boolean; partialFulfil?: boolean; spend?: SpendSummary; lineNeeds?: Need[] },
): PolicyVerdict {
  const reasons: string[] = [];
  const failingRules: string[] = [];
  const total = lines.reduce((s, l) => s + l.totalPrice, 0);
  const hasExplicitLineNeeds = Boolean(options?.lineNeeds && options.lineNeeds.length === lines.length);
  const needForLine = (idx: number): Need => options?.lineNeeds?.[idx] ?? need;

  if (new Date(mandate.expiresAt).getTime() < Date.now()) {
    failingRules.push("mandate_expired");
    return {
      decision: "blocked",
      reasons: ["Purchasing mandate has expired"],
      failingRules,
    };
  }

  // Lactose restriction applies to dairy lines (or any line its own need marks
  // lactose-free) — not to bananas or eggs. Prefer catalog labels over names.
  if (mandate.allergenRestrictions.includes("must_be_lactose_free")) {
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const ln = needForLine(i);
      if (!lineRequiresLactoseFree(line, ln, lines.length > 1 && !hasExplicitLineNeeds)) continue;
      if (!isLactoseFree(line)) {
        failingRules.push("allergen_restrictions");
        reasons.push(
          `${line.productName} (${line.productId}) is dairy but not labelled lactose-free`,
        );
      }
    }
  }
  // Explicitly excluded allergens (from both mandate Kitchen Rules and per-need constraints):
  // declared CONTAINS or MAY CONTAIN both fail (school / hospital / hotel safety rules).
  const mandateExcluded = extractMandateExcludedAllergens(mandate.allergenRestrictions);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const ln = needForLine(i);
    const combinedExcluded = [
      ...new Set([
        ...mandateExcluded,
        ...expandExcludedAllergens(ln.constraints.excludeAllergens),
      ]),
    ];
    if (combinedExcluded.length === 0) continue;
    const catProd = getProduct(line.productId);
    const contains = line.allergens?.length ? line.allergens : (catProd?.allergens ?? []);
    const mayContain = line.mayContain?.length ? line.mayContain : (catProd?.mayContain ?? []);
    for (const c of allergenConflicts({ contains, mayContain }, combinedExcluded)) {
      failingRules.push("allergen_restrictions");
      reasons.push(`${line.productName}: ${c.level} ${c.found} (excluded: ${c.excluded})`);
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

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const maxPpu = needForLine(i).constraints.maxPricePerUnit;
    if (maxPpu === undefined) continue;
    const perUnit = line.comparisonPrice ?? (line.totalQuantity > 0 ? line.totalPrice / line.totalQuantity : null);
    if (perUnit !== null && perUnit > maxPpu) {
      failingRules.push("over_unit_price");
      reasons.push(
        `${line.productName}: €${perUnit.toFixed(2)}/unit exceeds max €${maxPpu}/unit`,
      );
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

  // Check quantity caps per unit across all requested needs in this order
  const needsToCheck = options?.lineNeeds?.length ? options.lineNeeds : [need];
  const qtyByUnit = new Map<Need["unit"], number>();
  for (const n of needsToCheck) {
    qtyByUnit.set(n.unit, (qtyByUnit.get(n.unit) ?? 0) + n.quantity);
  }
  for (const [unit, sumQty] of qtyByUnit.entries()) {
    const qtyCap =
      mandate.maxQuantities?.[unit] ??
      (mandate.maxQuantity.unit === unit ? mandate.maxQuantity.value : undefined);
    if (qtyCap !== undefined && sumQty > qtyCap) {
      failingRules.push("over_quantity");
      reasons.push(
        `Requested ${sumQty} ${unit} exceeds mandate max ${qtyCap} ${unit}`,
      );
    }
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineDeadline = needForLine(i).neededBy;
    if (line.availableDate && line.availableDate > lineDeadline) {
      failingRules.push("late_delivery");
      reasons.push(
        `${line.productId} available ${line.availableDate} after needed ${lineDeadline}`,
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
