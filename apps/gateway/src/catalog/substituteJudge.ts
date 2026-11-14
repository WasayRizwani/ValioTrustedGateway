/**
 * Two-stage substitute & candidate compatibility engine:
 *   Stage 1 (0 ms, deterministic): Valio 5-digit catalog category locking + non-food exclusion +
 *     culinary form-factor / plain-vs-flavoured guardrails. Works offline and in every search path.
 *   Stage 2 (1 batched LLM call per plan, cached): Culinary LLM-as-a-judge over Stage-1 survivors
 *     with full recipe context (e.g. smoothies, pancakes, salmon sauce). Strictly subtractive so an
 *     LLM can never introduce an unverified SKU or bypass allergen/lactose mandate rules.
 */
import { createHash } from "node:crypto";
import { config } from "../config.js";

/** Valio 2-digit category prefixes that represent non-food items (utensils, packaging, office, gas). */
const NON_FOOD_CATEGORY_PREFIXES = new Set(["20", "30", "32", "63", "64", "67", "77", "90"]);

const HARDWARE_QUERY_RE =
  /\b(?:cutter|slicer|peeler|holder|dispenser|scoop|spreader|dish|tumbler|glass|napkins?|gloves|candle|foil|film|bag|toilet|soap|detergent)\b/i;

export function isNonFoodCategory(category?: string | null): boolean {
  if (!category) return false;
  const trimmed = category.trim();
  if (trimmed.length < 2 || !/^\d+$/.test(trimmed)) return false;
  return NON_FOOD_CATEGORY_PREFIXES.has(trimmed.slice(0, 2));
}

export function isHardwareQuery(queryText: string): boolean {
  return HARDWARE_QUERY_RE.test(queryText);
}

/**
 * Composite / derivative food forms that mention a base ingredient in their name
 * ("butter brioche", "strawberry-banana soya product", "egg noodles", "peach puree"),
 * but are NOT a culinary substitute for that base ingredient unless the query asked for that form.
 */
const COMPOSITE_DERIVATIVE_GROUPS: ReadonlyArray<{
  label: string;
  queryAllowsRe: RegExp;
  productMatchesRe: RegExp;
}> = [
  {
    label: "bakery/pastry item",
    queryAllowsRe:
      /\b(?:brioche|croissants?|buns?|butterbun|rolls?|sämpyl|pastry|pastries|viiner|donuts?|doughnuts?|munkki|cakes?|cookies?|biscuits?|wafers?|bread|limppu|paahto|toast|muffins?|bagels?|flourmix|bakery\s+mix|dough|pizza)\b/i,
    productMatchesRe:
      /\b(?:brioche|croissants?|buns?|butterbun|pastry|pastries|viiner\w*|donuts?|doughnuts?|cakes?|cookies?|biscuits?|wafers?|bread|limppu|paahto|toast|muffins?|bagels?|flourmix|bakery\s+mix|pizza\s+dough)\b/i,
  },
  {
    label: "confectionery/candy",
    queryAllowsRe: /\b(?:lollipops?|tikkari|candy|sweets?|truffles?|countline|mignon|chocolate\s+bar|chocolate\s+egg|licorice)\b/i,
    productMatchesRe:
      /\b(?:lollipops?|tikkari|truffles?|countline|mignon|chocolate\s+bar|chocolate\s+tablet|chocolate\s+egg|in\s+a\s+real\s+eggshell|licorice)\b/i,
  },
  {
    label: "pasta/noodles/dumplings",
    queryAllowsRe: /\b(?:pasta|noodles?|nuudeli|tagliatelle|spaghetti|macaroni|fusilli|lasagne|ravioli|gnocchi)\b/i,
    productMatchesRe: /\b(?:pasta|noodles?|nuudeli\w*|tagliatelle|spaghetti|macaroni|fusilli|lasagne|ravioli|gnocchi)\b/i,
  },
  {
    label: "plant-based fermented snack/pudding",
    queryAllowsRe: /\b(?:soya?|soija\w*|alpro|oatgurt|plantgurt|gurt|pudding|dessert|vegan|vegaan\w*|plant[-\s]?based)\b/i,
    productMatchesRe:
      /\b(?:fermented\s+soya|soya\s+product|soy\s+product|soijavalmiste|oatgurt|plantgurt|pudding|dessert\s+soya)\b/i,
  },
  {
    label: "puree/baby-food/jam/filling",
    queryAllowsRe: /\b(?:puree|purée|sose|piltti|baby|jam|hillo|marmalade|filling|täyte)\b/i,
    productMatchesRe: /\b(?:puree|purée|hedelmäsose|piltti|vanilla-yogurt\s+filling|bakery\s+filling|\bjam\b)\b/i,
  },
  {
    label: "savory sauce/soup/salad/mayo",
    queryAllowsRe: /\b(?:sauce|kastike|paste|pyree|soup|keitto|salad|salaatti|mayo|mayonnaise|majoneesi|dressing)\b/i,
    productMatchesRe: /\b(?:tomato\s+sauce|tomato\s+paste|potato\s+salad|mayo-max|mayonnaise)\b/i,
  },
  {
    label: "powder/dried industrial mix",
    queryAllowsRe: /\b(?:powder|jauhe|albumen|dried|dehydrated)\b/i,
    productMatchesRe: /\b(?:milk\s+powder|cream\s+powder|maitojauhe|albumen\s+powder|egg\s+powder)\b/i,
  },
  {
    label: "coconut/condensed culinary milk",
    queryAllowsRe: /\b(?:coconut|kookos\w*|condensed|condensated|evaporated|kondensoitu)\b/i,
    productMatchesRe: /\b(?:coconut\s+milk|kookosmaito|condensed\s+milk|condensated\s+milk|evaporated\s+milk|kondensoitu)\b/i,
  },
  {
    label: "inedible leaves/wrappers",
    queryAllowsRe: /\b(?:leaves|leaf|bananaleaves?|bananaleave|lehti|wrappers?|cups?)\b/i,
    productMatchesRe: /\b(?:bananaleaves?|bananaleave|banaaninlehti|bananblad\w*)\b/i,
  },
  {
    label: "cooking plantain (not sweet banana)",
    queryAllowsRe: /\b(?:plantains?|keittobanaani|matbanan)\b/i,
    productMatchesRe: /\b(?:plantains?|keittobanaani|matbanan)\b/i,
  },
  {
    label: "eggplant/aubergine (not eggs)",
    queryAllowsRe: /\b(?:eggplants?|aubergines?|munakoiso\w*)\b/i,
    productMatchesRe: /\b(?:eggplants?|aubergines?|munakoiso\w*)\b/i,
  },
  {
    label: "shallot/onion (not banana)",
    queryAllowsRe: /\b(?:shallots?|shalots?|onions?|sipuli\w*|banaanisipuli)\b/i,
    productMatchesRe: /\b(?:shallots?|shalots?|shalottibanaanisipuli|banaanisipuli)\b/i,
  },
  {
    label: "quail eggs (not chicken eggs)",
    queryAllowsRe: /\b(?:quail|viiriäis\w*)\b/i,
    productMatchesRe: /\b(?:quail|viiriäis\w*)\b/i,
  },
  {
    label: "ice cream / gelato",
    queryAllowsRe: /\b(?:ice\s*cream|jäätelö|gelato|sorbet)\b/i,
    productMatchesRe: /\b(?:ice\s*cream|jäätelö\w*|gelatolab|gelato)\b/i,
  },
  {
    label: "cream cheese",
    queryAllowsRe: /\b(?:cream\s*cheese|tuorejuusto|viola)\b/i,
    productMatchesRe: /\b(?:cream\s*cheese|tuorejuusto)\b/i,
  },
  {
    label: "fermented/sour milk (piimä/kefir, not regular milk)",
    queryAllowsRe: /\b(?:fermented|sour\s+milk|buttermilk|piimä\w*|kefir\w*)\b/i,
    productMatchesRe: /\b(?:fermented\s+milk|sour\s+milk|buttermilk|piimä\w*|kefir\w*)\b/i,
  },
];

const PLAIN_STAPLE_QUERY_RE =
  /\b(?:yogurts?|yoghurts?|jogurtti\w*|milk|maito|cream|kerma|oats?|oat\s+flakes?|kaurahiutale\w*|butter|voi)\b/i;

const FLAVOR_OR_ADDIN_RE =
  /\b(?:strawberry|mansikka|banana|banaani|peach|persikka|pear|päärynä|mango|passionfruit|passion|papaya|pineapple|ananas|berry|berries|marja\w*|blueberry|mustikka|bilberry|raspberry|vadelma|cherry|kirsikka|plum|luumu|rhubarb|raparperi|lingonberry|puolukka|blackcurrant|mustaherukka|apple|omena|baked\s+apple|lemon|sitruuna|cinnamon|kaneli|vanilla|vanilja|chocolate|suklaa|cocoa|kaakao|caramel|kinuski|tropic|forest\s+fruit|fruit\s+mix|fruity|hedelmä\w*|granola|muesli|mysli|oat\s+hoops|layered|lassi|yoghurtsmoothie|drink\s+yoghurt|drinkable|benecol|profeel|flavoured|flavored|smoked\s+cheese|three\s+cheeses|three\s+onions|pepper\s+cheese|pippuripekka|kippari|cream\s+in\s+spray|japan|bali|sicily)\b/i;

const OAT_QUERY_RE = /\b(?:oats?|oat\s+flakes?|rolled\s+oats?|kaurahiutale\w*)\b/i;
const OTHER_GRAIN_QUERY_ALLOW_RE = /\b(?:barley|ohra|rye|ruis|wheat|vehnä|buckwheat|tattari|spelt|4\s*cereal|multigrain|bran|lese)\b/i;
const OTHER_GRAIN_PRODUCT_RE =
  /\b(?:barley|ohra\w*|rye|ruis\w*|wheatflake\w*|wheat\s+bran|vehnälese\w*|rolled\s+buckwheat|buckwheat|tattari\w*|4\s*cereal|spelt)\b|(?:^|\s)oat\s+bran\b/i;

/**
 * Checks whether a candidate product's culinary form factor matches the query intent
 * (e.g., plain yogurt ≠ peach Benecol yogurt, banana ≠ Alpro soya cup or plantain, butter ≠ butter brioche).
 */
export function checkCulinaryFormFactor(
  queryText: string,
  product: { name: string; nameFi?: string },
): { ok: boolean; reason?: string } {
  const q = queryText.toLowerCase();
  const hay = `${product.name} ${product.nameFi ?? ""}`.toLowerCase();

  for (const group of COMPOSITE_DERIVATIVE_GROUPS) {
    if (!group.queryAllowsRe.test(q) && group.productMatchesRe.test(hay)) {
      return { ok: false, reason: `derivative form (${group.label})` };
    }
  }

  // Plain staple protection: don't swap fruit/flavoured/granola/drinkable variants into plain yogurt/milk/cream/oats
  if (PLAIN_STAPLE_QUERY_RE.test(q) && !FLAVOR_OR_ADDIN_RE.test(q) && FLAVOR_OR_ADDIN_RE.test(hay)) {
    // Allow when the staple IS banana itself (PLAIN_STAPLE_QUERY_RE doesn't match "banana", only dairy/oats)
    return { ok: false, reason: "flavoured or sweetened variant for plain staple" };
  }

  // Oat queries should not drift to barley, rye, buckwheat, or pure oat bran unless asked
  if (OAT_QUERY_RE.test(q) && !OTHER_GRAIN_QUERY_ALLOW_RE.test(q) && OTHER_GRAIN_PRODUCT_RE.test(hay)) {
    return { ok: false, reason: "different grain species or bran" };
  }

  // Cooking / whipping cream should not swap to low-fat coffee creamer; bulk milk should not swap to 2cl coffee portions
  if (/\b(?:cooking|whipping|food\s+service)\s+cream\b/i.test(q) && !/\bcoffee\b/i.test(q)) {
    if (/\b(?:coffee\s+cream|kahvikerma)\b/i.test(hay)) {
      return { ok: false, reason: "coffee cream is unsuitable for cooking/whipping cream" };
    }
  }
  if (/\bmilk\b/i.test(q) && !/\b(?:coffee|portion)\b/i.test(q)) {
    if (/\b(?:portion\s+milk|\d+\s*x\s*2\s*cl|coffee\s+milk|kahvimaito)\b/i.test(hay)) {
      return { ok: false, reason: "coffee/portion creamer instead of standard milk" };
    }
  }
  if (/\bmilk\b/i.test(q) && !/\b(?:cream|kerma|vegetable\s+mix|kasvirasva\w*)\b/i.test(q)) {
    if (/\b(?:based\s+on\s+milk\s+vegetable\s+mix|kasvirasvasekoite|cooking\s+cream|whipping\s+cream|ruokakerma|kuohukerma)\b/i.test(hay)) {
      return { ok: false, reason: "cooking cream or fat blend instead of liquid milk" };
    }
  }

  return { ok: true };
}

const ANCHOR_RANK_WEIGHTS = [10, 7, 5, 4, 3, 2];

/**
 * Infers the canonical Valio 5-digit category for a query from lexical-relevance-ordered candidates,
 * skipping non-food kitchenware and composite derivatives and taking a rank-weighted consensus over the
 * top matches so a lone lexical tie never overrides the dominant product category.
 */
export function inferAnchorCategory<
  T extends { name: string; nameFi?: string; category?: string | null },
>(candidates: T[], queryText: string): string | null {
  const askingHardware = isHardwareQuery(queryText);
  const clean = candidates.filter((c) => {
    if (!askingHardware && isNonFoodCategory(c.category)) return false;
    return checkCulinaryFormFactor(queryText, c).ok;
  });
  const pool = clean.length > 0 ? clean : candidates.filter((c) => askingHardware || !isNonFoodCategory(c.category));
  const scores = new Map<string, number>();
  for (let i = 0; i < Math.min(pool.length, ANCHOR_RANK_WEIGHTS.length); i++) {
    const cat = pool[i]?.category?.trim();
    if (!cat) continue;
    scores.set(cat, (scores.get(cat) ?? 0) + ANCHOR_RANK_WEIGHTS[i]);
  }
  let bestCat: string | null = null;
  let bestScore = -1;
  for (const [cat, sc] of scores) {
    if (sc > bestScore) {
      bestCat = cat;
      bestScore = sc;
    }
  }
  return bestCat ?? candidates[0]?.category?.trim() ?? null;
}

export function isDeterministicallyCompatible(params: {
  queryText: string;
  anchorCategory: string | null;
  candidate: {
    productId: string;
    name: string;
    nameFi?: string;
    category?: string | null;
    isValioDeclaredSub?: boolean;
  };
  veganRequested?: boolean;
}): { ok: boolean; reason: string } {
  const { queryText, anchorCategory, candidate, veganRequested } = params;

  // Valio's own catalog substitution table is an explicit equivalence statement
  if (candidate.isValioDeclaredSub) {
    return { ok: true, reason: "Valio-declared catalog substitute" };
  }

  const askingHardware = isHardwareQuery(queryText);
  if (!askingHardware && isNonFoodCategory(candidate.category)) {
    return { ok: false, reason: `non-food category (${candidate.category})` };
  }

  const candCat = candidate.category?.trim() || null;
  if (anchorCategory && candCat && candCat !== anchorCategory) {
    const veganDairyBridge =
      Boolean(veganRequested) &&
      ((anchorCategory === "10412" && candCat === "10413") ||
        (anchorCategory === "10413" && candCat === "10412"));
    if (!veganDairyBridge) {
      return { ok: false, reason: `category mismatch (${candCat} vs ${anchorCategory})` };
    }
  }

  const form = checkCulinaryFormFactor(queryText, candidate);
  if (!form.ok) {
    return { ok: false, reason: form.reason ?? "incompatible culinary form" };
  }

  return { ok: true, reason: "category and culinary form compatible" };
}

/** Filters a candidate product list using Stage-1 deterministic category & culinary rules. */
export function filterCompatibleProducts<
  T extends { productId: string; name: string; nameFi?: string; category?: string | null },
>(
  candidates: T[],
  queryText: string,
  options?: { vegan?: boolean; valioDeclaredSubIds?: Set<string> },
): T[] {
  if (candidates.length === 0) return [];
  const anchorCategory = inferAnchorCategory(candidates, queryText);
  const filtered = candidates.filter(
    (c) =>
      isDeterministicallyCompatible({
        queryText,
        anchorCategory,
        candidate: {
          ...c,
          isValioDeclaredSub: options?.valioDeclaredSubIds?.has(c.productId),
        },
        veganRequested: options?.vegan,
      }).ok,
  );
  return filtered;
}

// ───────────────────────── Stage 2: Batched LLM Culinary Judge ─────────────────────────

export type JudgeCandidateInput = {
  productId: string;
  productName: string;
  category: string | null;
  packSize: number;
  packUnit: string;
  totalPrice: number;
  isValioDeclaredSub?: boolean;
};

export type JudgeIngredientInput = {
  ingredientId: string;
  ingredientName: string;
  unit: string;
  requiredQty: number;
  recipes: string[];
  primary?: { productId: string; productName: string; category: string | null } | null;
  candidates: JudgeCandidateInput[];
};

export type JudgeIngredientVerdict = {
  approvedIds: Set<string>;
  orderedApprovedIds: string[];
  notes: Map<string, string>;
  vetoed: Array<{ productId: string; reason: string }>;
};

export type BatchJudgeResult = {
  source: "llm_judge" | "cache" | "deterministic_fallback";
  model: string | null;
  byIngredient: Map<string, JudgeIngredientVerdict>;
  totalVetoed: number;
};

const JUDGE_CACHE_MAX = 250;
const judgeCache = new Map<string, Omit<BatchJudgeResult, "source">>();

export function clearSubstituteJudgeCache(): void {
  judgeCache.clear();
}

function activeJudgeLlm(): {
  provider: "openai" | "gemini" | "anthropic";
  key: string;
  model: string;
  baseUrl: string;
} | null {
  if (config.geminiApiKey) {
    return {
      provider: "gemini",
      key: config.geminiApiKey,
      model: config.geminiModel,
      baseUrl: config.geminiBaseUrl,
    };
  }
  if (config.openaiApiKey) {
    const isGemini = config.openaiBaseUrl.includes("generativelanguage.googleapis.com");
    return {
      provider: isGemini ? "gemini" : "openai",
      key: config.openaiApiKey,
      model: config.llmModel,
      baseUrl: config.openaiBaseUrl,
    };
  }
  if (config.anthropicApiKey) {
    return {
      provider: "anthropic",
      key: config.anthropicApiKey,
      model: config.anthropicModel,
      baseUrl: "https://api.anthropic.com",
    };
  }
  return null;
}

function buildFallbackResult(items: JudgeIngredientInput[]): BatchJudgeResult {
  const byIngredient = new Map<string, JudgeIngredientVerdict>();
  for (const item of items) {
    const ids = item.candidates.map((c) => c.productId);
    byIngredient.set(item.ingredientId, {
      approvedIds: new Set(ids),
      orderedApprovedIds: ids,
      notes: new Map(),
      vetoed: [],
    });
  }
  return {
    source: "deterministic_fallback",
    model: null,
    byIngredient,
    totalVetoed: 0,
  };
}

function cacheKeyFor(items: JudgeIngredientInput[], model: string): string {
  const canonical = items.map((it) => ({
    id: it.ingredientId,
    name: it.ingredientName,
    unit: it.unit,
    recipes: [...it.recipes].sort(),
    primary: it.primary?.productId ?? null,
    cands: it.candidates.map((c) => c.productId),
  }));
  return createHash("sha256")
    .update(JSON.stringify({ v: 1, model, canonical }))
    .digest("hex");
}

function sanitizeNote(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  const cleaned = raw.replace(/[\r\n\t]+/g, " ").replace(/\s+/g, " ").trim();
  if (!cleaned) return undefined;
  return cleaned.length > 64 ? `${cleaned.slice(0, 63).trimEnd()}…` : cleaned;
}

function extractJsonObject(text: string): Record<string, unknown> | null {
  const stripped = text
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
  try {
    const parsed = JSON.parse(stripped);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    const start = stripped.indexOf("{");
    const end = stripped.lastIndexOf("}");
    if (start >= 0 && end > start) {
      try {
        const sub = JSON.parse(stripped.slice(start, end + 1));
        if (sub && typeof sub === "object" && !Array.isArray(sub)) {
          return sub as Record<string, unknown>;
        }
      } catch {
        return null;
      }
    }
  }
  return null;
}

const JUDGE_SYSTEM_PROMPT = `You are an executive chef and food-safety procurement judge for a commercial kitchen.
Evaluate whether each candidate wholesale SKU is a genuine, recipe-safe culinary substitute for the requested ingredient across ALL listed recipes.

Rules:
1. APPROVE (approved: true) if a professional chef can swap the candidate into every listed recipe without harming dish identity, flavour profile, or culinary function (e.g., different wholesale pack size, organic/Fairtrade grade, barn vs free-range eggs, 2% natural vs Turkish/Greek plain yoghurt for bowls/smoothies, standard salted vs unsalted butter unless laminating-only).
2. REJECT (approved: false) if the candidate is:
   - A completely different food or composite product (e.g., soy dessert or puree for fresh fruit, brioche bun for butter, pasta for eggs).
   - Flavoured/sweetened/topped when the ingredient is plain/unflavoured (e.g., peach/berry yoghurt for plain yoghurt, smoked-cheese cream for plain cooking cream).
   - Wrong culinary form for the recipes (e.g., raw cooking plantains for smoothies, pastry-laminating sheet butter or brown butter when standard cooking/baking butter is needed and normal packs exist, coffee creamer in savoury sauces).
3. Order approved candidates best-culinary-fit first in your decisions array.
4. Keep "note" ultra-concise (3 to 7 words, e.g. "Fresh 4.5 kg banana case", "Organic wholegrain oat flakes", "Plain 10% Turkish yoghurt", or why rejected).

Respond ONLY with valid JSON matching this exact schema:
{
  "ingredients": [
    {
      "ingredientId": "string",
      "decisions": [
        { "productId": "string", "approved": true, "note": "short culinary reason" }
      ]
    }
  ]
}`;

/**
 * Evaluates all shortlisted substitute candidates across a sourcing plan in ONE batched LLM call.
 * Strictly subtractive: can only veto or re-rank among already-policy-safe Stage-1 candidates.
 */
export async function judgeRecipeSubstitutesWithLlm(
  items: JudgeIngredientInput[],
  options?: {
    fetchImpl?: typeof fetch;
    forceEnableInTests?: boolean;
    timeoutMs?: number;
  },
): Promise<BatchJudgeResult> {
  const actionable = items.filter((i) => i.candidates.length > 0);
  if (actionable.length === 0) return buildFallbackResult(items);

  const inNodeTest = Boolean(process.env.NODE_TEST_CONTEXT);
  if (inNodeTest && !options?.fetchImpl && !options?.forceEnableInTests) {
    return buildFallbackResult(items);
  }

  const cfg = activeJudgeLlm();
  if (!cfg && !options?.fetchImpl) {
    return buildFallbackResult(items);
  }
  const effectiveCfg = cfg ?? {
    provider: "openai" as const,
    key: "test-key",
    model: "mock-judge",
    baseUrl: "https://mock.local/v1",
  };

  const key = cacheKeyFor(actionable, effectiveCfg.model);
  const hit = judgeCache.get(key);
  if (hit && !options?.fetchImpl) {
    return { ...hit, source: "cache" };
  }

  const userPayload = {
    ingredients: actionable.map((it) => ({
      ingredientId: it.ingredientId,
      ingredientName: it.ingredientName,
      required: `${it.requiredQty} ${it.unit}`,
      recipes: it.recipes,
      primaryMatch: it.primary
        ? { productId: it.primary.productId, productName: it.primary.productName }
        : null,
      candidates: it.candidates.map((c) => ({
        productId: c.productId,
        productName: c.productName,
        pack: `${c.packSize} ${c.packUnit}`,
        totalPriceEur: Math.round(c.totalPrice * 100) / 100,
        valioDeclaredSubstitute: Boolean(c.isValioDeclaredSub),
      })),
    })),
  };

  const fetchFn = options?.fetchImpl ?? globalThis.fetch;
  const timeoutMs = options?.timeoutMs ?? 18_000;

  try {
    let rawText = "";
    if (effectiveCfg.provider === "anthropic") {
      const res = await fetchFn(`${effectiveCfg.baseUrl.replace(/\/$/, "")}/v1/messages`, {
        method: "POST",
        headers: {
          "x-api-key": effectiveCfg.key,
          "anthropic-version": "2023-06-01",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: effectiveCfg.model,
          max_tokens: 1500,
          temperature: 0,
          system: JUDGE_SYSTEM_PROMPT,
          messages: [{ role: "user", content: JSON.stringify(userPayload) }],
        }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok) return buildFallbackResult(items);
      const data = (await res.json()) as { content?: Array<{ type: string; text?: string }> };
      rawText = (data.content ?? [])
        .filter((c) => c.type === "text" && typeof c.text === "string")
        .map((c) => c.text!)
        .join("\n");
    } else {
      const isGemini =
        effectiveCfg.provider === "gemini" ||
        effectiveCfg.baseUrl.includes("generativelanguage.googleapis.com");
      const body: Record<string, unknown> = {
        model: effectiveCfg.model,
        temperature: 0,
        messages: [
          { role: "system", content: JUDGE_SYSTEM_PROMPT },
          { role: "user", content: JSON.stringify(userPayload) },
        ],
      };
      if (isGemini) {
        body.reasoning_effort = "low";
      } else {
        body.response_format = { type: "json_object" };
      }

      const res = await fetchFn(`${effectiveCfg.baseUrl.replace(/\/$/, "")}/chat/completions`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${effectiveCfg.key}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok) return buildFallbackResult(items);
      const data = (await res.json()) as {
        choices?: Array<{ message?: { content?: string | null } }>;
      };
      rawText = data.choices?.[0]?.message?.content ?? "";
    }

    const parsed = extractJsonObject(rawText);
    if (!parsed || !Array.isArray(parsed.ingredients)) {
      return buildFallbackResult(items);
    }

    const rawByIng = new Map<string, Array<Record<string, unknown>>>();
    for (const entry of parsed.ingredients as Array<Record<string, unknown>>) {
      if (typeof entry?.ingredientId === "string" && Array.isArray(entry.decisions)) {
        rawByIng.set(entry.ingredientId, entry.decisions as Array<Record<string, unknown>>);
      }
    }

    const byIngredient = new Map<string, JudgeIngredientVerdict>();
    let totalVetoed = 0;

    for (const item of items) {
      const allowedCandidateIds = new Set(item.candidates.map((c) => c.productId));
      const decisions = rawByIng.get(item.ingredientId);
      if (!decisions) {
        const ids = item.candidates.map((c) => c.productId);
        byIngredient.set(item.ingredientId, {
          approvedIds: new Set(ids),
          orderedApprovedIds: ids,
          notes: new Map(),
          vetoed: [],
        });
        continue;
      }

      const approvedIds = new Set<string>();
      const orderedApprovedIds: string[] = [];
      const notes = new Map<string, string>();
      const vetoed: Array<{ productId: string; reason: string }> = [];
      const seen = new Set<string>();

      for (const d of decisions) {
        const pid = typeof d?.productId === "string" ? d.productId : "";
        // Strictly ignore any hallucinated SKU not in the Stage-1 candidate set
        if (!allowedCandidateIds.has(pid) || seen.has(pid)) continue;
        seen.add(pid);
        const note = sanitizeNote(d.note);
        if (note) notes.set(pid, note);
        if (d.approved === false) {
          vetoed.push({ productId: pid, reason: note ?? "rejected by culinary judge" });
          totalVetoed++;
        } else {
          approvedIds.add(pid);
          orderedApprovedIds.push(pid);
        }
      }

      // Any candidate omitted by the model defaults to approved (at the end) so partial JSON never drops valid SKUs silently
      for (const c of item.candidates) {
        if (!seen.has(c.productId)) {
          approvedIds.add(c.productId);
          orderedApprovedIds.push(c.productId);
        }
      }

      byIngredient.set(item.ingredientId, {
        approvedIds,
        orderedApprovedIds,
        notes,
        vetoed,
      });
    }

    const core = { model: effectiveCfg.model, byIngredient, totalVetoed };
    if (judgeCache.size >= JUDGE_CACHE_MAX) {
      const oldest = judgeCache.keys().next().value;
      if (oldest) judgeCache.delete(oldest);
    }
    judgeCache.set(key, core);
    return { ...core, source: "llm_judge" };
  } catch {
    return buildFallbackResult(items);
  }
}
