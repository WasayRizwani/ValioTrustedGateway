import { z } from "zod";

export const NeedSchema = z.object({
  productIntent: z.string().min(1),
  quantity: z.number().positive(),
  unit: z.enum(["litre", "kg", "each", "pack"]),
  neededBy: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  constraints: z
    .object({
      lactoseFree: z.boolean().optional(),
      organic: z.boolean().optional(),
      keywords: z.array(z.string()).optional(),
      excludeAllergens: z.array(z.string()).optional(),
      maxPricePerUnit: z.number().optional(),
    })
    .default({}),
  clarificationRequired: z.string().optional(),
  /** Buyer-side ingredient this purchase restocks (links orders to kitchen stock). */
  ingredientId: z.string().optional(),
  /** Quantity in the ingredient's own unit when the catalog need is converted (e.g. eggs → kg). */
  ingredientQuantity: z.number().optional(),
  ingredientUnit: z.enum(["litre", "kg", "each", "pack"]).optional(),
});
export type Need = z.infer<typeof NeedSchema>;

export const MandateSchema = z.object({
  mandateId: z.string(),
  customerId: z.string(),
  allowedCategories: z.array(z.string()),
  maxOrderValueEur: z.number(),
  /** Cumulative caps (EUR, UTC calendar windows). Optional so older stored mandates still parse. */
  maxDailySpendEur: z.number().optional(),
  maxWeeklySpendEur: z.number().optional(),
  maxMonthlySpendEur: z.number().optional(),
  maxOrdersPerDay: z.number().optional(),
  maxQuantity: z.object({
    unit: z.enum(["litre", "kg", "each", "pack"]),
    value: z.number(),
  }),
  /** Per-unit order quantity caps; falls back to maxQuantity for its own unit. */
  maxQuantities: z
    .record(z.enum(["litre", "kg", "each", "pack"]), z.number())
    .optional(),
  allowedBrands: z.array(z.string()).default(["*"]),
  allowedSubstitutions: z.boolean().default(false),
  /** Max tolerated price rise (%) between intent and commit before re-approval/refusal. Default 2. */
  priceDriftTolerancePct: z.number().min(0).optional(),
  allergenRestrictions: z.array(z.string()).default([]),
  autoPurchaseIf: z.object({
    deliveryOnOrBeforeNeededBy: z.boolean().default(true),
    withinMaxOrderValue: z.boolean().default(true),
    reliabilityUnknownOk: z.boolean().default(false),
  }),
  requireApprovalFor: z.array(z.string()).default([
    "over_spend",
    "unknown_reliability",
    "price_change_on_revalidate",
    "late_delivery",
    "substitution",
    "partial_fulfil",
    "category_not_allowed",
    "brand_not_allowed",
    "over_unit_price",
    "over_daily_spend",
    "over_weekly_spend",
    "over_monthly_spend",
    "over_order_velocity",
    "order_splitting_suspected",
  ]),
  expiresAt: z.string(),
});
export type Mandate = z.infer<typeof MandateSchema>;

/** What Valio attests about the product itself (signed, so an agent can rely on it without a manual check). */
export const ProductAttestationSchema = z.object({
  origin: z.string().nullable(),
  producer: z.string().nullable(),
  allergens: z.array(z.string()),
  mayContain: z.array(z.string()),
  certifications: z.array(z.string()),
  lactoseFree: z.boolean(),
});
export type ProductAttestation = z.infer<typeof ProductAttestationSchema>;

export const ClaimPayloadSchema = z.object({
  customerId: z.string(),
  productId: z.string(),
  unitPrice: z.number().nullable(),
  currency: z.string(),
  availableQuantity: z.number().nullable(),
  /** True when the upstream reports its unknown-stock sentinel instead of a real quantity. */
  availabilityUnknown: z.boolean().optional(),
  salesUnit: z.string().nullable(),
  availableDate: z.string().nullable().optional(),
  comparisonPrice: z.number().nullable().optional(),
  comparisonUnit: z.string().nullable().optional(),
  validUntil: z.string(),
  claimType: z.enum(["price", "availability", "combined"]),
  attestation: ProductAttestationSchema.optional(),
});
export type ClaimPayload = z.infer<typeof ClaimPayloadSchema>;

/** Optional binding of a claim to a downstream object (quote / order intent). Covered by the signature. */
export const ClaimSubjectSchema = z.object({
  quoteId: z.string().optional(),
  intentId: z.string().optional(),
});
export type ClaimSubject = z.infer<typeof ClaimSubjectSchema>;

/**
 * Envelope v2: the signature covers { version, claimId, issuer, keyId, asOf, subject, claim }.
 * Envelopes without `version` parse as 1 (legacy: signature covered only `claim`) and are rejected by verifyClaim.
 */
export const SignedClaimSchema = z.object({
  version: z.number().int().default(1),
  claimId: z.string().optional(),
  claim: ClaimPayloadSchema,
  issuer: z.string(),
  keyId: z.string(),
  asOf: z.string(),
  subject: ClaimSubjectSchema.optional(),
  signature: z.string(),
});
export type SignedClaim = z.infer<typeof SignedClaimSchema>;

export const OrderStatusSchema = z.enum([
  "intent_created",
  "policy_evaluated",
  "pending_approval",
  "approved",
  "revalidating",
  "committed",
  "rejected",
  "expired",
  "stale_invalidated",
  "blocked",
  "auto_eligible",
  "superseded",
]);
export type OrderStatus = z.infer<typeof OrderStatusSchema>;

export const BasketLineSchema = z.object({
  productId: z.string(),
  productName: z.string(),
  packs: z.number(),
  packSize: z.number(),
  packUnit: z.string(),
  totalQuantity: z.number(),
  quantityUnit: z.string(),
  unitPrice: z.number(),
  totalPrice: z.number(),
  comparisonPrice: z.number().nullable(),
  comparisonUnit: z.string().nullable(),
  availableQuantity: z.number().nullable(),
  /** Upstream reports stock as unknown; this offer is not quantity-capped by that sentinel. */
  availabilityUnknown: z.boolean().optional(),
  availableDate: z.string().nullable(),
  deliveryReliability: z.number().nullable(),
  claimIds: z.array(z.string()).default([]),
  isSubstitution: z.boolean().default(false),
  substitutionLabel: z.enum(["good", "better", "best"]).optional(),
  labels: z.array(z.string()).default([]),
  allergens: z.array(z.string()).default([]),
  mayContain: z.array(z.string()).default([]),
  certifications: z.array(z.string()).default([]),
  origin: z.string().nullable().default(null),
  producer: z.string().nullable().default(null),
});
export type BasketLine = z.infer<typeof BasketLineSchema>;

export const PolicyVerdictSchema = z.object({
  decision: z.enum(["auto_commit", "pending_approval", "blocked"]),
  reasons: z.array(z.string()),
  failingRules: z.array(z.string()),
});
export type PolicyVerdict = z.infer<typeof PolicyVerdictSchema>;

export const OfferCriteriaSchema = z.object({
  price: z.number(),
  deliveryDate: z.string().nullable(),
  reliability: z.number().nullable(),
  carbonKgPerKg: z.number().nullable(),
  certifications: z.array(z.string()),
});
export type OfferCriteria = z.infer<typeof OfferCriteriaSchema>;

/** Normalised 0..1 per criterion, 1 = best. Unknown values score 0.5 (neutral). */
export const CriteriaScoresSchema = z.object({
  price: z.number(),
  delivery: z.number(),
  reliability: z.number(),
  carbon: z.number(),
});
export type CriteriaScores = z.infer<typeof CriteriaScoresSchema>;

/** Caller weights; non-negative, normalised server-side. */
export const PreferencesSchema = z
  .object({
    price: z.number().min(0).optional(),
    reliability: z.number().min(0).optional(),
    carbon: z.number().min(0).optional(),
    delivery: z.number().min(0).optional(),
  })
  .partial();
export type Preferences = z.infer<typeof PreferencesSchema>;

export const OfferSchema = z.object({
  productId: z.string(),
  productName: z.string(),
  brand: z.string().nullable(),
  category: z.string().nullable(),
  packSize: z.number(),
  packUnit: z.string(),
  requiredPacks: z.number(),
  totalQuantity: z.number(),
  quantityUnit: z.string(),
  unitPrice: z.number(),
  totalPrice: z.number(),
  comparisonPrice: z.number().nullable(),
  comparisonUnit: z.string().nullable(),
  availableQuantity: z.number().nullable(),
  /** True when the supplier reports the unknown-stock sentinel (999999). */
  availabilityUnknown: z.boolean().optional(),
  availableDate: z.string().nullable(),
  canFulfil: z.boolean(),
  shortfall: z.number().nullable(),
  deliveryReliability: z.number().nullable(),
  carbonKgPerKg: z.number().nullable(),
  score: z.number(),
  scoreReasons: z.array(z.string()),
  /** Order cut-off for the needed-by date (ISO), from Valio closingTime; best effort. */
  orderByAt: z.string().nullable().optional(),
  /** True when the cut-off has passed or is within 2h. */
  cutoffRisk: z.boolean().optional(),
  criteria: OfferCriteriaSchema.optional(),
  criteriaScores: CriteriaScoresSchema.optional(),
  /** Not dominated by another fulfilable offer on price/reliability/carbon/delivery. */
  paretoOptimal: z.boolean().optional(),
  labels: z.array(z.string()).default([]),
  isSubstitution: z.boolean().default(false),
  substitutionLabel: z.enum(["good", "better", "best"]).optional(),
  allergens: z.array(z.string()).default([]),
  mayContain: z.array(z.string()).default([]),
  certifications: z.array(z.string()).default([]),
  origin: z.string().nullable().default(null),
  producer: z.string().nullable().default(null),
  claims: z.array(z.string()).default([]),
  /** Where a substitution came from: Valio's own catalog list or our ranking. */
  substitutionSource: z.enum(["valio_catalog", "ranking"]).optional(),
  substituteFor: z.string().optional(),
  priceClaim: SignedClaimSchema.optional(),
  availabilityClaim: SignedClaimSchema.optional(),
});
export type Offer = z.infer<typeof OfferSchema>;

export const QuoteStatusSchema = z.enum(["open", "used", "expired", "withdrawn"]);
export type QuoteStatus = z.infer<typeof QuoteStatusSchema>;

/**
 * A firm-price quote: the move from inquiry to commitment. Prices are fixed until `validUntil`
 * (not negotiated). Availability is re-checked at commit time and is NOT held by the quote.
 */
export const QuoteSchema = z.object({
  quoteId: z.string(),
  customerId: z.string(),
  need: NeedSchema,
  /** Priced options for the need (one per shortlisted SKU); the first is the primary line. */
  lines: z.array(BasketLineSchema),
  /** Total of the primary (first) line. */
  totalPrice: z.number(),
  currency: z.string(),
  issuedAt: z.string(),
  /** End of the firm price guarantee window. */
  validUntil: z.string(),
  /** Signed combined price/availability claims bound to this quote (subject.quoteId). */
  claims: z.array(SignedClaimSchema),
  status: QuoteStatusSchema,
  availabilityHeld: z.literal(false),
  availabilityNote: z.string(),
  intentId: z.string().nullable().optional(),
  runId: z.string().optional(),
});
export type Quote = z.infer<typeof QuoteSchema>;
