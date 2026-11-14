// Shared display formatting for the Approval Desk: one style for money, quantities and dates.

/** "€1,010.00" — grouped thousands, always 2 decimals (override with `digits`). */
export function money(n: number | null | undefined, digits = 2): string {
  if (n == null || Number.isNaN(n)) return "–";
  return `€${n.toLocaleString("en-GB", { minimumFractionDigits: digits, maximumFractionDigits: digits })}`;
}

const UNIT_LABEL: Record<string, string> = {
  litre: "L",
  litres: "L",
  liter: "L",
  liters: "L",
  ltr: "L",
  l: "L",
  kg: "kg",
  kgm: "kg",
  kilogram: "kg",
  kilograms: "kg",
  g: "g",
  grm: "g",
  each: "pcs",
  piece: "pcs",
  pieces: "pcs",
  pce: "pcs",
  pcs: "pcs",
  pack: "packs",
  packs: "packs",
};

/** "L", "kg", "pcs"… one spelling for every unit. */
export function unitLabel(unit: string | null | undefined): string {
  if (!unit) return "";
  return UNIT_LABEL[unit.toLowerCase()] ?? unit;
}

/** "74 L", "47 kg", "1 pack", "4 packs" — number, space, canonical unit. */
export function qty(n: number | null | undefined, unit?: string | null): string {
  if (n == null || Number.isNaN(n)) return "–";
  const num = n.toLocaleString("en-GB", { maximumFractionDigits: 2 });
  if (!unit) return num;
  if (Math.abs(n) === 1 && /^packs?$/i.test(unit)) return `${num} pack`;
  return `${num} ${unitLabel(unit)}`;
}

/** Normalise backend strings like "74litre" / "47KG" / "1pack" to "74 L" / "47 kg" / "1 pack". */
export function qtyText(s: string | null | undefined): string {
  if (!s) return "";
  const m = /^\s*([\d.,]+)\s*([A-Za-z]+)\s*$/.exec(s);
  if (!m) return s;
  const parsed = Number(m[1].replace(/,/g, ""));
  if (Math.abs(parsed) === 1 && /^packs?$/i.test(m[2])) return `${m[1]} pack`;
  return `${m[1]} ${unitLabel(m[2])}`;
}

/** "Fri 27 Nov" for ISO dates (YYYY-MM-DD) and timestamps. ISO stays only in technical views. */
export function day(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso.length === 10 ? `${iso}T12:00:00` : iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" });
}

const REGION_DISPLAY =
  typeof Intl !== "undefined" && typeof Intl.DisplayNames === "function"
    ? new Intl.DisplayNames(["en"], { type: "region" })
    : null;

/** "FI" → "Finland", "NL" → "Netherlands", "SE" → "Sweden". */
export function originLabel(code: string | null | undefined): string | null {
  if (!code) return null;
  const trimmed = code.trim();
  if (!trimmed) return null;
  if (/^[A-Za-z]{2}$/.test(trimmed) && REGION_DISPLAY) {
    try {
      return REGION_DISPLAY.of(trimmed.toUpperCase()) ?? trimmed;
    } catch {
      return trimmed;
    }
  }
  return trimmed;
}

/**
 * Tidy free text from the gateway:
 * - Full ISO timestamps ("2026-11-14T18:17:20.880Z") and ISO dates ("2026-11-14") → "Sat 14 Nov"
 * - Units ("62litre" → "62 L", "1 pack"/"1 packs" → "1 pack", "4pack" → "4 packs", "43kg" → "43 kg", "60each" → "60 pcs")
 */
export function tidy(text: string | null | undefined): string {
  if (!text) return "";
  return text
    .replace(
      /(?<![\d-])(\d{4}-\d{2}-\d{2})(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?(?![\d-])/g,
      (_m, d: string) => day(d),
    )
    .replace(
      /(\d+(?:[.,]\d+)?)\s?(litres?|liters?|ltr|each|pieces?|pcs|packs?|kg|L|l)(?![A-Za-z])/gi,
      (_m, n: string, u: string) => {
        const parsed = Number(n.replace(/,/g, ""));
        if (Math.abs(parsed) === 1 && /^packs?$/i.test(u)) return `${n} pack`;
        return `${n} ${unitLabel(u)}`;
      },
    );
}

/** Add the ingredient unit to "Last ordered 20 on …" / "Order qty rising (9 → 15 recently)" trend lines. */
export function trend(text: string | null | undefined, unit: string): string {
  return tidy(text)
    .replace(/^(Last ordered [\d.]+)(?= on )/, `$1 ${unitLabel(unit)}`)
    .replace(/→ ([\d.]+) recently\)/, `→ $1 ${unitLabel(unit)} recently)`);
}

/** Truncate with an ellipsis (never mid-word silently); pair with a title tooltip for the full text. */
export function clip(s: string | null | undefined, n: number): string {
  if (!s) return "";
  return s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s;
}
