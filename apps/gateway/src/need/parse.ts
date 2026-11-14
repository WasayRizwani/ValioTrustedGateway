import type { ComplexNeedResult, Need } from "@tta/shared";

/** Deterministic NL → single Need parser (returns primary item; delegates to complex parser). */
export function parseNeedFromText(
  text: string,
  neededByHint?: string,
): Need | { clarificationRequired: string } {
  const res = parseComplexNeedFromText(text, neededByHint);
  if ("clarificationRequired" in res) return res;
  return res.needs[0];
}

/**
 * Deterministic NL → multi-item & multi-constraint Need parser.
 * Handles compound orders ("1,000 litres of lactose-free milk and 10 bananas by Monday morning"),
 * countable whole-item nouns ("10 bananas", "60 eggs", "12 croissants"), sub-units ("500g", "250ml", "5dl"),
 * shared vs per-item delivery dates, and dietary/allergen/sustainability/price constraints.
 */
export function parseComplexNeedFromText(
  text: string,
  neededByHint?: string,
): ComplexNeedResult | { clarificationRequired: string } {
  const requestText = latestCorrection(text);
  const normalized = requestText.trim();
  const fullLower = normalized.toLowerCase();

  // Global validation checks for ambiguous allergen exclusions or malformed price limits
  const globalExcludedAllergens = extractExcludedAllergens(fullLower);
  if (
    /\b(?:excluding|exclude|without|free from|avoid|avoiding)\b/.test(fullLower) &&
    globalExcludedAllergens.length === 0 &&
    !isDietaryFreeFromPhrase(fullLower)
  ) {
    return {
      clarificationRequired:
        "I couldn't safely identify the allergen exclusion in your request. Please name the allergen explicitly (for example, peanuts or sesame).",
    };
  }

  if (
    hasPriceCapTrigger(fullLower) &&
    extractMaxPricePerUnit(fullLower) === undefined &&
    extractMaxCarbon(fullLower) === undefined
  ) {
    return {
      clarificationRequired:
        "I couldn't safely interpret the price limit. Please give it as a per-unit amount (for example, max €5/kg).",
    };
  }

  const clauses = splitMultiItemClauses(normalized);

  // Shared dates: leading date before first clause or trailing date on final clause
  const firstClause = clauses[0] ?? normalized;
  const firstQty = findQuantityMatch(firstClause.toLowerCase());
  const leadingPrefix = firstQty ? firstClause.slice(0, firstQty.start).toLowerCase() : "";
  const sharedLeadingDate = extractDate(leadingPrefix);
  const sharedTrailingDate = extractDate((clauses[clauses.length - 1] ?? "").toLowerCase());

  // Global dietary / allergen modifiers written at request level (e.g. trailing ", nut-free, vegan")
  const trailingSharedScope = extractTrailingSharedConstraintScope(fullLower);
  const sharedAllergens = extractExcludedAllergens(trailingSharedScope);
  const sharedVegan = /\b(?:vegan|vegaaninen|plant[-\s]?based)\b/i.test(trailingSharedScope);

  const parsedNeeds: Need[] = [];
  for (const rawClause of clauses) {
    const single = parseSingleClause(rawClause, {
      neededByHint,
      sharedDate: sharedTrailingDate ?? sharedLeadingDate,
      sharedAllergens: clauses.length > 1 ? sharedAllergens : globalExcludedAllergens,
      sharedVegan,
      wasCorrected: requestText !== text.trim(),
    });
    if (!("productIntent" in single)) {
      if (clauses.length === 1) return single;
      if (looksLikeIncompleteItemClause(rawClause)) {
        const cleanItem = rawClause
          .replace(/\b(?:by|before|on)\s+(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday|tomorrow|\d{4}-\d{2}-\d{2})(?:\s+(?:morning|afternoon|evening))?\b/gi, "")
          .replace(/\b(?:tomorrow|today|next\s+week|this\s+week)\b/gi, "")
          .trim();
        return {
          clarificationRequired: `Please specify both quantity and unit for "${cleanItem || rawClause.trim()}" so every item in your request can be matched accurately (for example, "10 ${cleanItem.replace(/^\d+\s*/, "") || "pcs"}" or "5 kg").`,
        };
      }
      continue;
    }
    parsedNeeds.push(single);
  }

  if (parsedNeeds.length === 0) {
    return {
      clarificationRequired:
        requestText !== text.trim()
          ? "Your corrected request replaces any earlier quantity or unit. Specify the quantity and unit in the corrected request (e.g. 20 litres or 20 packs)."
          : "Specify quantity and unit (e.g. 1000 litres). Customer, date, and allergens will not be invented.",
    };
  }

  return {
    needs: parsedNeeds,
    isMultiItem: parsedNeeds.length > 1,
  };
}

function isDietaryFreeFromPhrase(t: string): boolean {
  return /\b(?:free from lactose|without lactose|lactose[-\s]?free)\b/i.test(t);
}

function hasPriceCapTrigger(t: string): boolean {
  // Don't mistake "under par" or "max 1.2 kg co2" for a malformed price limit
  const cleaned = t.replace(
    /\b(?:max(?:imum)?|under|below)\s*\d+(?:[.,]\d+)?\s*(?:kg\s*)?(?:co2e?|carbon)\b/gi,
    "",
  );
  return /\b(?:strict(?:ly)?\s+)?(?:max(?:imum)?|at most|no more than|under|below)\b/.test(cleaned);
}

function extractTrailingSharedConstraintScope(fullLower: string): string {
  // Capture trailing global constraints after a comma/semicolon or "for all items"
  const parts = fullLower.split(/[,;]/);
  if (parts.length <= 1) return "";
  const tail = parts.slice(1).filter((p) => findQuantityMatch(p) === null);
  return tail.join(" , ");
}

function looksLikeIncompleteItemClause(rawClause: string): boolean {
  const cleaned = rawClause
    .replace(/^[-*•\s]+/, "")
    .replace(
      /\b(?:by|before|on)\s+(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday|tomorrow|\d{4}-\d{2}-\d{2})(?:\s+(?:morning|afternoon|evening))?\b/gi,
      "",
    )
    .replace(/\b(?:tomorrow|today|next\s+week|this\s+week)\b/gi, "")
    .trim();
  if (!cleaned) return false;
  // Number followed by a bulk/liquid food noun without unit (e.g. "20 butter", "50 lactose-free milk")
  if (/^\d+(?:[.,]\d+)?\s+/i.test(cleaned) && BULK_LIQUID_HEAD_RE.test(cleaned)) {
    return true;
  }
  // Standalone countable or bulk/liquid item without quantity (e.g. "and bananas", "and butter", "and whipping cream")
  const words = cleaned.split(/\s+/);
  if (words.length <= 3 && (COUNTABLE_ITEM_RE.test(cleaned) || BULK_LIQUID_HEAD_RE.test(cleaned))) {
    return true;
  }
  return false;
}

function splitMultiItemClauses(text: string): string[] {
  // Mask price-cap and carbon expressions so numbers inside "max €5/kg" never look like a new item quantity
  const masked = text
    .replace(
      /\b(?:strict(?:ly)?\s+)?(?:max(?:imum)?|at most|no more than|under|below)\s*(?:€|eur\s*)?\d+(?:[.,]\d+)?\s*(?:€|eur)?\s*(?:\/\s*[a-z]+|per\s+[a-z]+|(?:kg\s*)?(?:co2e?|carbon))/gi,
      (m) => " ".repeat(m.length),
    )
    .replace(/\b\d{4}-\d{2}-\d{2}\b/g, (m) => " ".repeat(m.length));

  // Candidate conjunctions/delimiters between items (newlines, bullets, Oxford ", and ", commas outside numbers, ;, +, &)
  const sepRe =
    /(?:\r?\n)+(?:\s*[-*•]\s*)?|[,;]?\s+(?:and|plus|also|as well as|along with)\s+|(?<!\d),(?!\d)|;|\s+\+\s+|\s+&\s+/gi;

  const splitPoints: Array<{ sepStart: number; sepEnd: number }> = [];
  let m: RegExpExecArray | null;
  while ((m = sepRe.exec(masked))) {
    splitPoints.push({ sepStart: m.index, sepEnd: m.index + m[0].length });
  }
  if (splitPoints.length === 0) return [text.replace(/^[-*•\s]+/, "")];

  const clauses: string[] = [];
  let cursor = 0;

  for (let i = 0; i < splitPoints.length; i++) {
    const { sepStart, sepEnd } = splitPoints[i];
    const leftMasked = masked.slice(cursor, sepStart);
    const nextSepStart = splitPoints[i + 1]?.sepStart ?? masked.length;
    const rightSegmentMasked = masked.slice(sepEnd, nextSepStart);

    const leftHasQty = findQuantityMatch(leftMasked.toLowerCase()) !== null;
    const rightHasQty =
      findQuantityMatch(rightSegmentMasked.toLowerCase()) !== null ||
      looksLikeIncompleteItemClause(rightSegmentMasked);

    // Prevent splitting inside "excluding X and Y" when Y is not a new quantified item
    const leftEndsWithExclusion =
      /\b(?:excluding|exclude|without|free from|avoid|avoiding)\s+[^,;]*$/i.test(
        text.slice(cursor, sepStart),
      ) && findQuantityMatch(rightSegmentMasked.toLowerCase()) === null;

    if (leftHasQty && rightHasQty && !leftEndsWithExclusion) {
      clauses.push(text.slice(cursor, sepStart).replace(/^[-*•\s]+/, "").trim());
      cursor = sepEnd;
    }
  }

  const tail = text.slice(cursor).replace(/^[-*•\s]+/, "").trim();
  if (tail) clauses.push(tail);
  return clauses.length > 0 ? clauses : [text];
}

function parseSingleClause(
  rawClause: string,
  ctx: {
    neededByHint?: string;
    sharedDate?: string;
    sharedAllergens: string[];
    sharedVegan: boolean;
    wasCorrected: boolean;
  },
): Need | { clarificationRequired: string } {
  const t = rawClause.toLowerCase();
  const matchedQuantity = findQuantityMatch(t);
  if (!matchedQuantity) {
    return {
      clarificationRequired: ctx.wasCorrected
        ? "Your corrected request replaces any earlier quantity or unit. Specify the quantity and unit in the corrected request (e.g. 20 litres or 20 packs)."
        : "Specify quantity and unit (e.g. 1000 litres). Customer, date, and allergens will not be invented.",
    };
  }

  const { quantity, unit } = matchedQuantity;
  const clauseDate = extractDate(t);
  const neededBy = ctx.neededByHint ?? clauseDate ?? ctx.sharedDate ?? nextWeekday(1);

  const lactoseFree =
    t.includes("lactose-free") ||
    t.includes("lactose free") ||
    t.includes("lactosefree") ||
    t.includes("laktoositon") ||
    t.includes("laktosfri");

  const organic = /\b(?:organic|luomu|ekologinen)\b/i.test(t);
  const vegan = ctx.sharedVegan || /\b(?:vegan|vegaaninen|plant[-\s]?based)\b/i.test(t);
  const origin = extractOrigin(t);
  const minReliability = extractMinReliability(t);
  const maxCarbonKgPerKg = extractMaxCarbon(t);
  const maxPricePerUnit = extractMaxPricePerUnit(t);

  const clauseAllergens = extractExcludedAllergens(t);
  const excludeAllergens = [...new Set([...clauseAllergens, ...ctx.sharedAllergens])];

  let productIntent = t
    .slice(matchedQuantity.end)
    .replace(/^\s*(?:of|for)\s+/i, "")
    .split(
      /\b(?:by|needed by|for delivery|deliver(?:ed)?\s+(?:by|on)|before\s+(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday|tomorrow|\d{4}-\d{2}-\d{2})|on\s+(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday)|tomorrow(?:\s+(?:morning|afternoon|evening))?|(?:next|this)\s+(?:week|monday|tuesday|wednesday|thursday|friday|saturday|sunday)|excluding|exclude|without|free from|avoid|avoiding|strict|max(?:imum)?|at most|no more than|under|below|min(?:imum)?\s+\d+\s*%\s*reliability|high\s+reliability|low[-\s]?carbon|do not order|don't order|dont order)\b|[,;.!]/i,
    )[0]
    .trim();

  // Strip trailing standalone weekday/time phrases (e.g. "10 bananas monday morning")
  productIntent = productIntent
    .replace(
      /\s+(?:next\s+|this\s+)?(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday)(?:\s+(?:morning|afternoon|evening|noon))?$/i,
      "",
    )
    .replace(/\s+(?:morning|afternoon|evening|tonight)$/i, "")
    .replace(/^(?:of|for)\s+/i, "")
    .replace(/^(?:please\s+)?(?:find|show|compare|source|order|get|need|want)\s+/i, "")
    .replace(
      /\b(?:nut-free|peanut-free|gluten-free|egg-free|soy-free|sesame-free|dairy-free|finnish|kotimainen|domestic)\b/gi,
      " ",
    )
    .replace(/\s+/g, " ")
    .trim();

  if (!productIntent) productIntent = "product";

  if (lactoseFree && !productIntent.includes("lactose") && !productIntent.includes("laktoositon")) {
    productIntent = `lactose-free ${productIntent.replace(/^lactose-free\s*/i, "")}`.trim();
  }

  return {
    productIntent,
    quantity,
    unit,
    ...(matchedQuantity.isImplicitEach
      ? { ingredientQuantity: quantity, ingredientUnit: "each" as const }
      : {}),
    neededBy,
    constraints: {
      lactoseFree: lactoseFree || undefined,
      organic: organic || undefined,
      vegan: vegan || undefined,
      origin,
      minReliability,
      maxCarbonKgPerKg,
      excludeAllergens: excludeAllergens.length ? excludeAllergens : undefined,
      maxPricePerUnit,
      keywords: productIntent.split(/\s+/).filter(Boolean),
    },
  };
}

const ALLERGENS: ReadonlyArray<readonly [string, string]> = [
  ["tree nuts", "tree nuts"],
  ["peanuts", "peanut"],
  ["peanut", "peanut"],
  ["milk", "milk"],
  ["dairy", "milk"],
  ["eggs", "egg"],
  ["egg", "egg"],
  ["soy", "soy"],
  ["soya", "soy"],
  ["gluten", "gluten"],
  ["wheat", "wheat"],
  ["shellfish", "shellfish"],
  ["fish", "fish"],
  ["sesame", "sesame"],
  ["mustard", "mustard"],
  ["celery", "celery"],
  ["lupin", "lupin"],
  ["sulphites", "sulphites"],
];

const HYPHEN_FREE_ALLERGENS: ReadonlyArray<readonly [RegExp, string[]]> = [
  [/\btree[-\s]?nut[-\s]?free\b/i, ["tree nuts"]],
  [/(?<!tree[-\s])\bnut[-\s]?free\b/i, ["nuts"]],
  [/\bpeanut[-\s]?free\b/i, ["peanut"]],
  [/\bgluten[-\s]?free\b|\bgluteeniton\b/i, ["gluten"]],
  [/\bdairy[-\s]?free\b|\bmaidoton\b/i, ["milk"]],
  [/\begg[-\s]?free\b|\bmunaton\b/i, ["egg"]],
  [/\bsoy[-\s]?free\b|\bsoya[-\s]?free\b/i, ["soy"]],
  [/\bsesame[-\s]?free\b/i, ["sesame"]],
];

function extractExcludedAllergens(text: string): string[] {
  const found: string[] = [];
  const clauses: string[] = [];
  for (const m of text.matchAll(
    /\b(?:exclude|excluding|without|free from|avoid|avoiding|no)\s+(.+?)(?=\b(?:exclude|excluding|without|free from|avoid|avoiding|strict|max(?:imum)?|under|below|by|for delivery|deliver|and (?:do not|don't|dont)|do not order|don't order|dont order)\b|[,.;]|$)/gi,
  )) {
    clauses.push(m[1]);
  }
  if (clauses.length) {
    const joined = clauses.join(" ");
    for (const [word, canonical] of ALLERGENS) {
      if (new RegExp(`\\b${word}\\b`, "i").test(joined)) found.push(canonical);
    }
    if (/(?<!tree\s)\bnuts?\b/i.test(joined) && !found.includes("tree nuts")) {
      found.push("nuts");
    }
  }
  for (const [re, canonicals] of HYPHEN_FREE_ALLERGENS) {
    if (re.test(text)) found.push(...canonicals);
  }
  return [...new Set(found)];
}

function extractMaxPricePerUnit(text: string): number | undefined {
  const m = text.match(
    /\b(?:strict(?:ly)?\s+)?(?:max(?:imum)?|at most|no more than|under|below)\s*(?:€|eur\s*)?(\d+(?:[.,]\d+)?)\s*(?:€|eur)?\s*(?:\/\s*(?:litre|liter|l|kg|each|piece|pcs|pack)|per\s+(?:litre|liter|l|kg|each|piece|pcs|pack))\b/i,
  );
  return m ? Number(m[1].replace(",", ".")) : undefined;
}

function extractOrigin(text: string): string | undefined {
  if (/\b(?:finnish|kotimainen|domestic|from finland|origin\s+fi)\b/i.test(text)) return "FI";
  const m = text.match(/\borigin\s+([a-z]{2})\b/i);
  return m ? m[1].toUpperCase() : undefined;
}

function extractMinReliability(text: string): number | undefined {
  const m = text.match(/\b(?:min(?:imum)?|at least|>=?)\s*(\d{2,3})\s*%\s*(?:delivery\s+)?reliability\b/i) ??
    text.match(/\breliability\s*(?:>=?|at least|min(?:imum)?)\s*(\d{2,3})\s*%/i);
  if (m) {
    const pct = Number(m[1]);
    if (pct > 0 && pct <= 100) return pct / 100;
  }
  if (/\bhigh\s+(?:delivery\s+)?reliability\b/i.test(text)) return 0.95;
  return undefined;
}

function extractMaxCarbon(text: string): number | undefined {
  const m = text.match(
    /\b(?:max(?:imum)?|under|below|<=?)\s*(\d+(?:[.,]\d+)?)\s*(?:kg\s*)?(?:co2e?|carbon)\b/i,
  );
  if (m) return Number(m[1].replace(",", "."));
  if (/\blow[-\s]?carbon\b/i.test(text)) return 1.5;
  return undefined;
}

/** Ignore a superseded clause when the buyer explicitly corrects themselves. */
function latestCorrection(text: string): string {
  const re =
    /(?<!\b(?:that\s+is|which\s+is|it\s+is|is)\s+)\b(?:actually|rather|correction|i mean|make that)\b|\bno,\s*(?:i|we)\b/gi;
  let match: RegExpExecArray | null;
  let start = -1;
  while ((match = re.exec(text))) start = match.index + match[0].length;
  return start >= 0 ? text.slice(start).trim() : text;
}

function localDate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function nextWeekday(target: number): string {
  // 0=Sun ... 1=Mon
  const d = new Date();
  const day = d.getDay();
  let delta = (target - day + 7) % 7;
  if (delta === 0) delta = 7;
  d.setDate(d.getDate() + delta);
  return localDate(d);
}

const UNIT_WORDS: Array<[RegExp, Need["unit"], number]> = [
  [/^(l|lt|ltr|litres?|liters?)$/, "litre", 1],
  [/^(dl|decilitres?|deciliters?)$/, "litre", 0.1],
  [/^(cl|centilitres?|centiliters?)$/, "litre", 0.01],
  [/^(ml|millilitres?|milliliters?)$/, "litre", 0.001],
  [/^(kg|kgs|kilos?|kilograms?)$/, "kg", 1],
  [/^(g|gr|grm|grams?|grammes?)$/, "kg", 0.001],
  [/^(packs?|packages?|cases?|boxes|box|crates?|trays?|cartons?|bags?|tubs?|bottles?|cans?|jars?)$/, "pack", 1],
  [/^(pcs?|pieces?|each|units?|kpl|dozens?)$/, "each", 1],
];

/**
 * Whole countable food items commonly ordered by count ("10 bananas", "60 eggs", "12 croissants")
 * without an explicit unit word. Uncountable bulk goods ("20 lactose-free milk", "10 flour") are
 * intentionally excluded so ambiguous requests still trigger clarificationRequired.
 */
const COUNTABLE_ITEM_RE =
  /\b(?:bananas?|banaan[a-z]*|eggs?|kananmun[a-z]*|apples?|omen[a-z]*|oranges?|appelsiin[a-z]*|lemons?|sitruun[a-z]*|limes?|limet[a-z]*|avocados?|avokad[a-z]*|cucumbers?|kurkk[a-z]*|tomatoes|tomato|tomaat[a-z]*|onions?|sipul[a-z]*|potatoes|potato|perun[a-z]*|carrots?|porkkan[a-z]*|peppers?|paprik[a-z]*|pears?|pääryn[a-z]*|peaches|peach|kiwis?|mangoes|mangos|mango|pineapples?|ananas|melons?|watermelons?|cauliflowers?|cabbages?|lettuces?|salaatt[a-z]*|broccolis?|parsakaal[a-z]*|zucchinis?|courgettes?|kesäkurpits[a-z]*|eggplants?|aubergines?|munakois[a-z]*|grapefruits?|verigreipp[a-z]*|plums?|luum[a-z]*|coconuts?|croissants?|bagels?|muffins?|donuts?|doughnuts?|buns?|rolls?|sämpyl[a-z]*|baguettes?|patonk[a-z]*|loaves|loaf|pastries|pastry|viiner[a-z]*|pies?|piirak[a-z]*|sausages?|makkar[a-z]*|burgers?|patties|patty|pihv[a-z]*|tortillas?|wraps?)\b/i;

const BULK_LIQUID_HEAD_RE =
  /\b(?:milk|maito|cream|kerma|yogurt|yoghurt|jogurtti|juice|mehu|puree|purée|sauce|soup|flour|jauho|sugar|sokeri|butter|cheese|juusto|oil|öljy|powder|jauhe|granola|oats|rice)\b/i;

/**
 * Parses "1,000 litres", "1 000 L", "2,5 kg", "500 g", "250 ml", "10 bananas", "60 eggs",
 * while still returning null for ambiguous unitless bulk requests like "20 lactose-free milk".
 */
export function extractQuantity(text: string): { quantity: number; unit: Need["unit"] } | null {
  const hit = findQuantityMatch(text);
  return hit ? { quantity: hit.quantity, unit: hit.unit } : null;
}

type QuantityMatch = {
  quantity: number;
  unit: Need["unit"];
  start: number;
  end: number;
  isImplicitEach?: boolean;
};

function parseLocalizedNumber(rawNum: string): number | null {
  let num = rawNum.replace(/[ \u00a0]/g, "");
  if (/^\d{1,3}(,\d{3})+(\.\d+)?$/.test(num)) num = num.replace(/,/g, "");
  else num = num.replace(",", ".");
  const value = Number(num);
  return Number.isFinite(value) && value > 0 ? value : null;
}

function findQuantityMatch(text: string): QuantityMatch | null {
  const numPattern = /(\d{1,3}(?:[ ,\u00a0]\d{3})+(?:\.\d+)?|\d+(?:[.,]\d+)?)/g;
  let m: RegExpExecArray | null;

  while ((m = numPattern.exec(text))) {
    const numStart = m.index;
    const numEnd = numStart + m[0].length;

    // Ignore numbers attached to currency/percent/dates/product-codes or preceded by price-cap words
    const before = text.slice(Math.max(0, numStart - 20), numStart);
    const after = text.slice(numEnd);
    if (/(?:€|eur\s*)$/i.test(before) || /^\s*(?:%|€|eur\b)/i.test(after)) continue;
    if (/^\s*-\d{2}-\d{2}\b/.test(after) || /\d{4}-$/.test(before)) continue;

    const rawQty = parseLocalizedNumber(m[1]);
    if (rawQty === null) continue;

    // 1) Check if an explicit unit word immediately follows the number
    const unitFollow = after.match(/^\s*([a-zA-Z]+)\b/);
    if (unitFollow) {
      const word = unitFollow[1].toLowerCase();
      const hit = UNIT_WORDS.find(([r]) => r.test(word));
      if (hit) {
        const [, unit, factor] = hit;
        const mult = /^dozens?$/.test(word) ? 12 : factor;
        const quantity = Math.round(rawQty * mult * 10000) / 10000;
        return {
          quantity,
          unit,
          start: numStart,
          end: numEnd + unitFollow[0].length,
        };
      }
    }

    // 2) Otherwise check if the immediate noun phrase (up to 4 words before stop words) is a countable whole item
    const nounWindow = after
      .split(/\b(?:by|needed|excluding|exclude|without|free|avoid|max|under|below|and|plus)\b|[,;.!]/i)[0]
      .trim()
      .split(/\s+/)
      .slice(0, 4)
      .join(" ");

    if (
      nounWindow &&
      COUNTABLE_ITEM_RE.test(nounWindow) &&
      !BULK_LIQUID_HEAD_RE.test(nounWindow)
    ) {
      return {
        quantity: rawQty,
        unit: "each",
        start: numStart,
        end: numEnd,
        isImplicitEach: true,
      };
    }
  }

  return null;
}

const WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];

/** "by 2026-11-20", "by Friday", "by Monday morning", "tomorrow", "in 3 days" → ISO date (local), else undefined. */
export function extractDate(text: string): string | undefined {
  const t = text.toLowerCase();
  const iso = t.match(/\b(\d{4}-\d{2}-\d{2})\b/);
  if (iso) return iso[1];
  if (/\bday after tomorrow\b/.test(t)) {
    const d = new Date();
    d.setDate(d.getDate() + 2);
    return localDate(d);
  }
  if (/\btomorrow\b/.test(t)) {
    const d = new Date();
    d.setDate(d.getDate() + 1);
    return localDate(d);
  }
  if (/\btoday\b/.test(t)) {
    return localDate(new Date());
  }
  const inDays = t.match(/\bin\s+(\d{1,2})\s+days?\b/);
  if (inDays) {
    const d = new Date();
    d.setDate(d.getDate() + Number(inDays[1]));
    return localDate(d);
  }
  const wd = WEEKDAYS.findIndex((w) => new RegExp(`\\b${w}\\b`).test(t));
  if (wd >= 0) return nextWeekday(wd);
  if (/\bnext week\b|\bthis week\b/.test(t)) return nextWeekday(1);
  return undefined;
}
