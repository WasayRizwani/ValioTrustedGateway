import { useMemo, useState } from "react";
import { api, localDate, type Intent, type Offer } from "./api";
import { money, qtyText, unitLabel, day as fmtDay, clip } from "./format";
import { ProductFacts } from "./ProductFacts";

/** Default "needed by": one week out, so a 1000-litre request isn't due tomorrow. */
function defaultNeededBy(): string {
  const d = new Date();
  d.setDate(d.getDate() + 7);
  return localDate(d);
}

const ALLERGENS = ["gluten", "milk", "egg", "nuts", "peanut", "soy", "fish", "sesame", "mustard", "celery"];
type Unit = "litre" | "kg" | "each" | "pack";

const PRESETS: Array<{ label: string; query: string; qty: number; unit: Unit; lf: boolean }> = [
  { label: "100 L Lactose-free milk (In mandate)", query: "lactose-free milk", qty: 100, unit: "litre", lf: true },
  { label: "3,000 L Lactose-free milk (Over mandate)", query: "lactose-free milk", qty: 3000, unit: "litre", lf: true },
  { label: "40 L Oat drink", query: "oat drink", qty: 40, unit: "litre", lf: true },
  { label: "50 kg Rolled oats", query: "rolled oats", qty: 50, unit: "kg", lf: false },
];

export function Find(props: {
  onNavigate: (v: string, id?: string) => void;
  onChanged: () => void;
  onMessage: (m: string) => void;
  onPickOffer?: (o: Offer | null) => void;
}) {
  const [query, setQuery] = useState("lactose-free milk");
  const [qty, setQty] = useState(100);
  const [unit, setUnit] = useState<Unit>("litre");
  const [neededBy, setNeededBy] = useState(defaultNeededBy());
  const [lactoseFree, setLactoseFree] = useState(true);
  const [organic, setOrganic] = useState(false);
  const [exclude, setExclude] = useState<string[]>([]);
  const [offers, setOffers] = useState<Offer[] | null>(null);
  const [picked, setPicked] = useState<string | null>(null);
  const [quote, setQuote] = useState<{ quoteId: string; totalPrice: number; validUntil: string } | null>(null);
  const [verdict, setVerdict] = useState<Intent | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const buildNeed = (override?: { query: string; qty: number; unit: Unit; lf: boolean }) => {
    const q = (override?.query ?? query).trim();
    const lf = override ? override.lf : lactoseFree;
    return {
      productIntent: q,
      quantity: override?.qty ?? qty,
      unit: override?.unit ?? unit,
      neededBy,
      constraints: {
        lactoseFree: lf || undefined,
        organic: organic || undefined,
        excludeAllergens: exclude.length ? exclude : undefined,
        keywords: q.split(/\s+/).filter(Boolean),
      },
    };
  };

  async function search(override?: { query: string; qty: number; unit: Unit; lf: boolean }) {
    if (override) {
      setQuery(override.query);
      setQty(override.qty);
      setUnit(override.unit);
      setLactoseFree(override.lf);
    }
    setBusy(true);
    setErr(null);
    setQuote(null);
    setVerdict(null);
    try {
      const r = await api<{ offers: Offer[] }>("/v1/offers/rank", { method: "POST", body: JSON.stringify({ need: buildNeed(override) }) });
      setOffers(r.offers);
      const best = r.offers.find((o) => o.canFulfil) ?? r.offers[0] ?? null;
      setPicked(best?.productId ?? null);
      props.onPickOffer?.(best);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function propose(id: string | null = picked) {
    if (!id) return;
    setPicked(id);
    props.onPickOffer?.(offers?.find((o) => o.productId === id) ?? null);
    setBusy(true);
    setErr(null);
    try {
      const needPayload = buildNeed();
      // Step 1: Lock a firm signed Quote
      const q = await api<{ quoteId: string; totalPrice: number; validUntil: string }>("/v1/quotes", {
        method: "POST",
        body: JSON.stringify({ need: needPayload, productIds: [id] }),
      });
      setQuote(q);
      // Step 2: Build order intent from the signed Quote and evaluate deterministic mandate
      const r = await api<{ intent: Intent }>("/v1/orders/intent", {
        method: "POST",
        body: JSON.stringify({ quoteId: q.quoteId }),
      });
      setVerdict(r.intent);
      props.onChanged();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  function selectOffer(id: string) {
    setPicked(id);
    setQuote(null);
    setVerdict(null);
    props.onPickOffer?.(offers?.find((o) => o.productId === id) ?? null);
  }

  async function orderNow(i: Intent) {
    setBusy(true);
    try {
      const c = await api<{ confirmation: { orderId: string } }>(`/v1/orders/${i.id}/commit`, {
        method: "POST",
        body: JSON.stringify({ idempotencyKey: `find-${i.id}` }),
      });
      props.onChanged();
      props.onMessage(`Ordered — ${c.confirmation.orderId}`);
      props.onNavigate("orders");
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  const badges = useMemo(() => {
    const b = new Map<string, string[]>();
    const add = (id: string | undefined, t: string) => id && b.set(id, [...(b.get(id) ?? []), t]);
    const ok = (offers ?? []).filter((o) => o.canFulfil);
    add(ok.slice().sort((a, c) => a.totalPrice - c.totalPrice)[0]?.productId, "Cheapest");
    add(ok.filter((o) => o.availableDate).sort((a, c) => (a.availableDate! < c.availableDate! ? -1 : 1))[0]?.productId, "Earliest");
    add(ok.filter((o) => o.deliveryReliability != null).sort((a, c) => c.deliveryReliability! - a.deliveryReliability!)[0]?.productId, "Most reliable");
    add(ok.filter((o) => o.carbonKgPerKg != null).sort((a, c) => a.carbonKgPerKg! - c.carbonKgPerKg!)[0]?.productId, "Lowest carbon");
    return b;
  }, [offers]);

  const chosen = offers?.find((o) => o.productId === picked) ?? null;

  return (
    <div className="home">
      {err && <div className="banner error">{err}</div>}
      <section className="panel">
        <span className="eyebrow">Shortlist Lookup → Firm Quote → Mandate Evaluation</span>
        <h2>Compare Live Valio Offers</h2>
        <p className="muted" style={{ margin: "0 0 0.6rem" }}>
          Query live Valio prices, delivery dates, carbon footprint, and Ed25519-signed product facts for a shortlisted set of SKUs.
        </p>

        <div className="chips" style={{ marginTop: 0, marginBottom: "0.6rem" }}>
          <span className="tiny muted">Quick presets:</span>
          {PRESETS.map((p) => (
            <button
              key={p.label}
              type="button"
              className="chip"
              disabled={busy}
              onClick={() => void search(p)}
            >
              {p.label}
            </button>
          ))}
        </div>

        <div className="find-form">
          <label className="grow">
            Product
            <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="e.g. lactose-free milk, rolled oats, tomatoes" />
          </label>
          <label>
            Quantity
            <input type="number" min={1} value={qty} onChange={(e) => setQty(Number(e.target.value))} />
          </label>
          <label>
            Unit
            <select value={unit} onChange={(e) => setUnit(e.target.value as Unit)}>
              <option value="litre">L</option>
              <option value="kg">kg</option>
              <option value="each">pcs</option>
              <option value="pack">packs</option>
            </select>
          </label>
          <label>
            Needed by
            <input type="date" value={neededBy} onChange={(e) => setNeededBy(e.target.value)} />
          </label>
        </div>
        <div className="chips">
          <button type="button" className={`chip ${lactoseFree ? "on" : ""}`} onClick={() => setLactoseFree(!lactoseFree)}>
            Lactose-free
          </button>
          <button type="button" className={`chip ${organic ? "on" : ""}`} onClick={() => setOrganic(!organic)}>
            Organic
          </button>
          <span className="tiny muted" style={{ marginLeft: "0.6rem" }}>
            Must not contain / may contain:
          </span>
          {ALLERGENS.map((a) => (
            <button
              key={a}
              type="button"
              className={`chip ${exclude.includes(a) ? "on warn" : ""}`}
              onClick={() => setExclude(exclude.includes(a) ? exclude.filter((x) => x !== a) : [...exclude, a])}
            >
              {a}
            </button>
          ))}
        </div>
        <div className="actions" style={{ marginTop: "0.8rem" }}>
          <button type="button" className="btn primary" disabled={busy || !query.trim() || qty <= 0} onClick={() => void search()}>
            {busy && !offers ? "Comparing…" : "Compare live offers"}
          </button>
        </div>
      </section>

      {offers && (
        <section className="panel">
          <div className="row-between">
            <h2>{offers.length ? `${offers.length} ranked offers` : "No matching offers"}</h2>
            <span className="tiny muted">Ranked by full quantity, on-time arrival, delivery reliability, then price</span>
          </div>
          {offers.length === 0 && (
            <p className="empty">Nothing matches all your constraints. Try removing an allergen filter or changing the product words.</p>
          )}
          <ul className="offers" role="radiogroup" aria-label="Ranked product offers">
            {offers.map((o) => {
              const late = Boolean(o.canFulfil && o.availableDate && o.availableDate > neededBy);
              const selected = o.productId === picked;
              const detail = [
                o.deliveryReliability != null ? `${Math.round(o.deliveryReliability * 100)}% on time` : "No delivery history",
                o.carbonKgPerKg != null ? `${o.carbonKgPerKg.toFixed(1)} kg CO₂e/kg` : null,
              ].filter(Boolean);
              return (
                <li key={o.productId} className={selected ? "picked" : ""}>
                  <div
                    className="offer-card"
                    role="radio"
                    aria-checked={selected}
                    tabIndex={selected ? 0 : -1}
                    onClick={() => selectOffer(o.productId)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        selectOffer(o.productId);
                      } else if (e.key === "ArrowDown" || e.key === "ArrowRight" || e.key === "ArrowUp" || e.key === "ArrowLeft") {
                        e.preventDefault();
                        const radios = Array.from(
                          e.currentTarget.closest("[role='radiogroup']")?.querySelectorAll<HTMLElement>("[role='radio']") ?? [],
                        );
                        const current = radios.indexOf(e.currentTarget);
                        const forward = e.key === "ArrowDown" || e.key === "ArrowRight";
                        const next = (current + (forward ? 1 : radios.length - 1)) % radios.length;
                        radios[next]?.focus();
                        radios[next]?.click();
                      }
                    }}
                  >
                    <div className="row-between">
                      <strong>{o.productName}</strong>
                      <strong className="mono">{money(o.totalPrice)}</strong>
                    </div>
                    <div className="tiny muted">
                      {o.brand ? `${o.brand} · ` : ""}
                      {o.requiredPacks} × {qtyText(`${o.packSize}${o.packUnit}`)} = {qtyText(`${o.totalQuantity}${o.quantityUnit}`)} · {money(o.totalPrice / Math.max(1, qty))} per {unitLabel(unit)}
                    </div>
                    <div className="meta">
                      {(badges.get(o.productId) ?? []).map((t) => (
                        <span key={t} className="tag best">
                          {t}
                        </span>
                      ))}
                      <span className={!o.canFulfil || late ? "tag warn" : "tag"}>
                        {o.availabilityUnknown
                          ? "Availability unknown · quantity not capped"
                          : o.canFulfil
                            ? `Arrives ${fmtDay(o.availableDate)}${late ? " (after needed-by)" : ""}`
                            : `Only partly available (short ${o.shortfall ?? "?"})`}
                      </span>
                    </div>
                    <div className="tiny muted">{detail.join(" · ")}</div>
                    <ProductFacts f={{ ...o, signed: Boolean(o.priceClaim) }} compact showAllergens={exclude} />
                  </div>
                </li>
              );
            })}
          </ul>

          {chosen && !verdict && (
            <div className="sticky-bar">
              <div>
                <strong title={chosen.productName}>{clip(chosen.productName, 60)}</strong>
                <div className="tiny muted">{money(chosen.totalPrice)} · arrives {fmtDay(chosen.availableDate)}</div>
              </div>
              <button type="button" className="btn primary" disabled={busy} onClick={() => void propose()}>
                {busy ? "Issuing firm quote & checking mandate…" : "Lock firm quote & check mandate"}
              </button>
            </div>
          )}

          {verdict && (
            <div className={`verdict ${verdict.status === "auto_eligible" ? "ok" : "warn"}`}>
              {verdict.status === "auto_eligible" ? (
                <>
                  <div>
                    <strong>✓ Within your mandate (auto_eligible)</strong> — Firm quote{" "}
                    {quote ? <code>{quote.quoteId.slice(0, 10)}…</code> : null} locked at {money(verdict.totalPrice)}. An external agent can commit this order autonomously.
                  </div>
                  <button type="button" className="btn primary" disabled={busy} onClick={() => void orderNow(verdict)}>
                    Commit order · {money(verdict.totalPrice)}
                  </button>
                </>
              ) : verdict.status === "pending_approval" ? (
                <>
                  <div>
                    <strong>⚠ Escalated to Human Approval (pending_approval)</strong> — Firm quote{" "}
                    {quote ? <code>{quote.quoteId.slice(0, 10)}…</code> : null} locked, but policy flagged:{" "}
                    {verdict.policy.reasons.join("; ")}
                  </div>
                  <button type="button" className="btn primary" onClick={() => props.onNavigate("approval", verdict.id)}>
                    Review &amp; Approve Override →
                  </button>
                </>
              ) : (
                <div>
                  <strong>Blocked by your mandate</strong> — {verdict.policy.reasons.join("; ")}
                </div>
              )}
            </div>
          )}
        </section>
      )}
    </div>
  );
}
