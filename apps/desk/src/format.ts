// Shared display formatting for the Approval Desk: one style for money, quantities and dates.

/** "€1,010.00" — grouped thousands, always 2 decimals (override with `digits`). */
export function money(n: number | null | undefined, digits = 2): string {
  if (n == null || Number.isNaN(n)) return "–";
  return `€${n.toLocaleString("en-GB", { minimumFractionDigits: digits, maximumFractionDigits: digits })}`;
}

const UNIT_LABEL: Record<string, string> = { litre: "L", litres: "L", liter: "L", liters: "L", l: "L", kg: "kg", g: "g", each: "pcs", pcs: "pcs", pack: "packs", packs: "packs" };

/** "L", "kg", "pcs"… one spelling for every unit. */
export function unitLabel(unit: string | null | undefined): string {
  if (!unit) return "";
  return UNIT_LABEL[unit.toLowerCase()] ?? unit;
}

/** "74 L", "47 kg" — number, space, canonical unit. */
export function qty(n: number | null | undefined, unit?: string | null): string {
  if (n == null || Number.isNaN(n)) return "–";
  const num = n.toLocaleString("en-GB", { maximumFractionDigits: 2 });
  return unit ? `${num} ${unitLabel(unit)}` : num;
}

/** Normalise backend strings like "74litre" / "47KG" to "74 L" / "47 kg". */
export function qtyText(s: string | null | undefined): string {
  if (!s) return "";
  const m = /^\s*([\d.,]+)\s*([A-Za-z]+)\s*$/.exec(s);
  return m ? `${m[1]} ${unitLabel(m[2])}` : s;
}

/** "Fri 27 Nov" for ISO dates (YYYY-MM-DD) and timestamps. ISO stays only in technical views. */
export function day(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso.length === 10 ? `${iso}T12:00:00` : iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" });
}

/** Tidy free text from the gateway: "62litre" → "62 L", "14 litre" → "14 L", "20 l" → "20 L", "43kg" → "43 kg", "60each" → "60 pcs". */
export function tidy(text: string | null | undefined): string {
  if (!text) return "";
  return text
    .replace(/(\d)\s?(litres?|liters?|each|pcs|kg|L|l)(?![A-Za-z])/gi, (_m, n: string, u: string) => `${n} ${unitLabel(u)}`)
    .replace(/\b(\d{4}-\d{2}-\d{2})\b/g, (m) => day(m));
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
