/** Product facts straight from the Valio catalog: origin, allergens, certifications — and the signed-by-Valio proof. */
type Facts = {
  origin?: string | null;
  producer?: string | null;
  allergens?: string[];
  mayContain?: string[];
  certifications?: string[];
  labels?: string[];
  isSubstitution?: boolean;
  substitutionSource?: string;
  substituteFor?: string;
  signed?: boolean;
};

const REGION = (() => {
  try {
    return new Intl.DisplayNames(["en"], { type: "region" });
  } catch {
    return null;
  }
})();
const country = (c?: string | null) => (c ? (REGION?.of(c.toUpperCase()) ?? c.toUpperCase()) : null);

/** `showAllergens`: when given, only allergens in this list are shown (e.g. the ones the user is avoiding); otherwise all. */
export function ProductFacts({ f, compact = false, showAllergens }: { f: Facts; compact?: boolean; showAllergens?: string[] }) {
  const pick = (l?: string[]) => (showAllergens ? (l ?? []).filter((a) => showAllergens.some((s) => a.toLowerCase().includes(s.toLowerCase()))) : (l ?? []));
  const allergens = pick(f.allergens);
  const mayContain = pick(f.mayContain);
  const hasAny =
    f.origin || f.producer || f.allergens?.length || f.mayContain?.length || f.certifications?.length || f.labels?.length || f.signed;
  if (!hasAny) return null;
  return (
    <div className={`facts ${compact ? "compact" : ""}`}>
      {f.substitutionSource === "valio_catalog" && (
        <span className="fact sub" title="Valio's own catalog lists this as a substitute">
          Valio-approved substitute{f.substituteFor ? ` for ${f.substituteFor}` : ""}
        </span>
      )}
      {f.labels?.includes("lactose-free") && <span className="fact ok">Lactose-free</span>}
      {f.origin && (
        <span className="fact">
          Origin: {country(f.origin)}
          {f.producer ? ` · ${f.producer}` : ""}
        </span>
      )}
      {(f.certifications ?? []).map((c) => (
        <span key={c} className="fact cert">
          ✓ {c}
        </span>
      ))}
      {allergens.length > 0 && <span className="fact warn">Contains: {allergens.join(", ")}</span>}
      {mayContain.length > 0 && <span className="fact">May contain: {mayContain.join(", ")}</span>}
      {f.signed && (
        <span className="fact ok" title="Origin, allergens and certifications are inside the gateway's signed price claim">
          🔏 Signed claim
        </span>
      )}
    </div>
  );
}
