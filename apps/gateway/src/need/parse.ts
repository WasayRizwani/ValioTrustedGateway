import type { Need } from "@tta/shared";

/** Deterministic NL → Need parser for demo (no LLM required). */
export function parseNeedFromText(
  text: string,
  neededByHint?: string,
): Need | { clarificationRequired: string } {
  const requestText = latestCorrection(text);
  const t = requestText.toLowerCase();

  const q = extractQuantity(t);
  if (!q) {
    return {
      clarificationRequired: requestText !== text.trim()
        ? "Your corrected request replaces any earlier quantity or unit. Specify the quantity and unit in the corrected request (e.g. 20 litres or 20 packs)."
        : "Specify quantity and unit (e.g. 1000 litres). Customer, date, and allergens will not be invented.",
    };
  }
  const { quantity, unit } = q;

  const neededBy = neededByHint ?? extractDate(t) ?? nextWeekday(1);

  const lactoseFree =
    t.includes("lactose-free") ||
    t.includes("lactose free") ||
    t.includes("laktoositon");

  const excludedAllergens = extractExcludedAllergens(t);
  const maxPricePerUnit = extractMaxPricePerUnit(t);
  if (/\b(?:excluding|exclude|without|free from|avoid|avoiding)\b/.test(t) && excludedAllergens.length === 0) {
    return { clarificationRequired: "I couldn't safely identify the allergen exclusion in your request. Please name the allergen explicitly (for example, peanuts or sesame)." };
  }
  if (/\b(?:strict(?:ly)?\s+)?(?:max(?:imum)?|at most|no more than|under|below)\b/.test(t) && maxPricePerUnit === undefined) {
    return { clarificationRequired: "I couldn't safely interpret the price limit. Please give it as a per-unit amount (for example, max €5/kg)." };
  }

  const matchedQuantity = findQuantityMatch(t);
  let productIntent = matchedQuantity
    ? t.slice(matchedQuantity.end).replace(/^\s*(?:of|for)\s+/i, "").split(/\b(?:by|needed by|excluding|exclude|without|free from|avoid|avoiding|strict|max(?:imum)?|at most|no more than|under|below|do not order|don't order|dont order)\b|[,;.!]/i)[0].trim()
    : "product";
  productIntent = productIntent.replace(/^(?:of|for)\s+/i, "").replace(/^(?:please\s+)?(?:find|show|compare|source|order)\s+/i, "").trim();
  if (!productIntent) productIntent = "product";

  if (lactoseFree && !productIntent.includes("lactose")) {
    productIntent = `lactose-free ${productIntent.replace(/^lactose-free\s*/i, "")}`;
  }

  return {
    productIntent,
    quantity,
    unit,
    neededBy,
    constraints: {
      lactoseFree: lactoseFree || undefined,
      excludeAllergens: excludedAllergens.length ? excludedAllergens : undefined,
      maxPricePerUnit,
      keywords: productIntent.split(/\s+/).filter(Boolean),
    },
  };
}

const ALLERGENS = [
  ["tree nuts", "tree nuts"], ["peanuts", "peanut"], ["peanut", "peanut"],
  ["milk", "milk"], ["dairy", "milk"], ["eggs", "egg"], ["egg", "egg"],
  ["soy", "soy"], ["soya", "soy"], ["gluten", "gluten"], ["wheat", "wheat"],
  ["shellfish", "shellfish"], ["fish", "fish"], ["sesame", "sesame"],
  ["mustard", "mustard"], ["celery", "celery"], ["lupin", "lupin"], ["sulphites", "sulphites"],
] as const;

function extractExcludedAllergens(text: string): string[] {
  const clauses: string[] = [];
  for (const m of text.matchAll(/\b(?:exclude|excluding|without|free from|avoid|avoiding|no)\s+(.+?)(?=\b(?:exclude|excluding|without|free from|avoid|avoiding|strict|max(?:imum)?|under|below|by|for delivery|deliver|and (?:do not|don't|dont)|do not order|don't order|dont order)\b|[,.;]|$)/gi)) {
    clauses.push(m[1]);
  }
  if (!clauses.length) return [];
  const joined = clauses.join(" ");
  return [...new Set(ALLERGENS.filter(([word]) => new RegExp(`\\b${word}\\b`, "i").test(joined)).map(([, canonical]) => canonical))];
}

function extractMaxPricePerUnit(text: string): number | undefined {
  const m = text.match(/\b(?:strict(?:ly)?\s+)?(?:max(?:imum)?|at most|no more than|under|below)\s*(?:€|eur\s*)?(\d+(?:[.,]\d+)?)\s*(?:€|eur)?\s*(?:\/\s*(?:litre|liter|l|kg|each|piece|pack)|per\s+(?:litre|liter|l|kg|each|piece|pack))\b/i);
  return m ? Number(m[1].replace(",", ".")) : undefined;
}

/** Ignore a superseded clause when the buyer explicitly corrects themselves. */
function latestCorrection(text: string): string {
  const re = /(?<!\b(?:that\s+is|which\s+is|it\s+is|is)\s+)\b(?:actually|rather|correction|i mean|make that)\b|\bno,\s*(?:i|we)\b/gi;
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

const UNIT_WORDS: Array<[RegExp, Need["unit"]]> = [
  [/^(l|lt|ltr|litres?|liters?)$/, "litre"],
  [/^(kg|kgs|kilos?|kilograms?)$/, "kg"],
  [/^(packs?|packages?|cases?|boxes|box)$/, "pack"],
  [/^(pcs?|pieces?|each|eggs?|units?)$/, "each"],
];

/**
 * Parses "1,000 litres", "1 000 L", "2,5 kg", "0.5 kg", "20 lactose-free milk" (no unit → null).
 * Thousands groups (comma/space + exactly 3 digits) are NOT decimals; a comma followed by 1–2 digits is.
 */
export function extractQuantity(text: string): { quantity: number; unit: Need["unit"] } | null {
  const hit = findQuantityMatch(text);
  return hit ? { quantity: hit.quantity, unit: hit.unit } : null;
}

function findQuantityMatch(text: string): { quantity: number; unit: Need["unit"]; end: number } | null {
  const re = /(\d{1,3}(?:[ ,\u00a0]\d{3})+(?:\.\d+)?|\d+(?:[.,]\d+)?)\s*([a-zA-Z]+)\b/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const word = m[2].toLowerCase();
    const hit = UNIT_WORDS.find(([r]) => r.test(word));
    if (!hit) continue; // e.g. "20 lactose-free" — "lactose" is not a unit
    let num = m[1].replace(/[ \u00a0]/g, "");
    if (/^\d{1,3}(,\d{3})+(\.\d+)?$/.test(num)) num = num.replace(/,/g, "");
    else num = num.replace(",", ".");
    const quantity = Number(num);
    if (!Number.isFinite(quantity) || quantity <= 0) return null;
    return { quantity, unit: hit[1], end: re.lastIndex };
  }
  return null;
}

const WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];

/** "by 2026-11-20", "by Friday", "tomorrow", "next week" → ISO date (local), else undefined. */
export function extractDate(text: string): string | undefined {
  const iso = text.match(/\b(\d{4}-\d{2}-\d{2})\b/);
  if (iso) return iso[1];
  if (/\btomorrow\b/.test(text)) {
    const d = new Date();
    d.setDate(d.getDate() + 1);
    return localDate(d);
  }
  const wd = WEEKDAYS.findIndex((w) => new RegExp(`\\b${w}\\b`).test(text));
  if (wd >= 0) return nextWeekday(wd);
  if (/\bnext week\b|\bthis week\b/.test(text)) return nextWeekday(1);
  return undefined;
}
