import { useCallback, useEffect, useState } from "react";
import { api, nextMonday, ruleLabel, type Intent } from "./api";
import { money, qtyText, day, clip } from "./format";
import { ProductFacts } from "./ProductFacts";

const RULE_TEXT: Record<string, (i: Intent) => string> = {
  over_spend: (i) => `${money(i.totalPrice)} is over your per-order limit — the agent may not spend this on its own.`,
  over_quantity: () => "The quantity is above what the agent may buy on its own.",
  late_delivery: () => "Delivery would arrive after the date you need it.",
  substitution: () => "This is a substitute, not the exact product requested.",
  partial_fulfil: () => "Valio can't supply the full quantity.",
  allergen_restrictions: () => "Allergen or lactose rules aren't fully met by this product.",
  unknown_reliability: () => "There is no delivery-reliability history for this product.",
  mandate_expired: () => "Your standing mandate has expired and must be renewed or overridden.",
  category_not_allowed: () => "This product category is outside the categories allowed by your mandate.",
  brand_not_allowed: () => "This brand is not on your mandate's allowed brands list.",
  over_unit_price: () => "The unit price exceeds the maximum unit price set in your mandate.",
  over_daily_spend: () => "This order would push today's cumulative spend over your daily limit.",
  over_weekly_spend: () => "This order would push this week's cumulative spend over your weekly limit.",
  over_monthly_spend: () => "This order would push this month's cumulative spend over your monthly limit.",
  over_order_velocity: () => "The number of orders placed today has reached your daily order velocity limit.",
  order_splitting_suspected: () => "Recent orders for the same product suggest a larger purchase may have been split across multiple orders.",
  price_change_on_revalidate: () => "The live price drifted beyond your mandate's tolerance when revalidated before commit.",
};

const ago = (iso: string) => {
  const m = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60000));
  return m < 1 ? "just now" : m < 60 ? `${m} min ago` : `${Math.round(m / 60)} h ago`;
};
const left = (iso: string) => Math.max(0, Math.round((new Date(iso).getTime() - Date.now()) / 60000));

export function Approval(props: {
  initialIntentId?: string | null;
  onNavigate?: (view: string, id?: string) => void;
  onDone: (msg: string) => void;
  onChanged: () => void;
  onError: (m: string | null) => void;
}) {
  const { initialIntentId, onNavigate, onDone, onChanged, onError } = props;
  const [items, setItems] = useState<Intent[]>([]);
  const [sel, setSel] = useState<string | null>(initialIntentId ?? null);
  const [override, setOverride] = useState(false);
  const [busy, setBusy] = useState(false);
  const [loaded, setLoaded] = useState(false);

  const load = useCallback(async () => {
    try {
      const r = await api<{ intents: Intent[] }>("/v1/orders/pending");
      setItems(r.intents);
      setSel((cur) => {
        if (cur && r.intents.some((i) => i.id === cur)) return cur;
        if (initialIntentId && r.intents.some((i) => i.id === initialIntentId)) return initialIntentId;
        return r.intents[0]?.id ?? null;
      });
    } catch (e) {
      onError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoaded(true);
    }
  }, [initialIntentId, onError]);

  useEffect(() => {
    if (initialIntentId && items.some((i) => i.id === initialIntentId)) {
      setSel(initialIntentId);
    }
  }, [initialIntentId, items]);

  useEffect(() => {
    void load();
    const t = setInterval(() => {
      if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
      void load();
    }, 10000);
    return () => clearInterval(t);
  }, [load]);
  useEffect(() => setOverride(false), [sel]);

  const intent = items.find((i) => i.id === sel) ?? null;

  async function triggerDemoBreach() {
    setBusy(true);
    onError(null);
    try {
      const need = {
        productIntent: "lactose-free milk",
        quantity: 3000,
        unit: "litre",
        neededBy: nextMonday(),
        constraints: { lactoseFree: true, keywords: ["lactose-free", "milk"] },
      };
      const r = await api<{ intent: Intent }>("/v1/orders/intent", {
        method: "POST",
        body: JSON.stringify({ need }),
      });
      onChanged();
      await load();
      setSel(r.intent.id);
    } catch (e) {
      onError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function approve(i: Intent) {
    setBusy(true);
    onError(null);
    try {
      const failing = i.policy.failingRules ?? [];
      await api(`/v1/orders/${i.id}/approve`, {
        method: "POST",
        body: JSON.stringify({
          snapshotHash: i.snapshotHash,
          ...(failing.length ? { authorizeMandateOverride: true, acknowledgedRules: failing } : {}),
        }),
      });
      const c = await api<{ confirmation: { orderId: string } }>(`/v1/orders/${i.id}/commit`, {
        method: "POST",
        body: JSON.stringify({ idempotencyKey: `desk-${i.id}` }),
      });
      onChanged();
      onDone(`Approved and ordered — ${c.confirmation.orderId}`);
      await load();
    } catch (e) {
      onError(e instanceof Error ? e.message : String(e));
      await load();
    } finally {
      setBusy(false);
    }
  }

  async function reject(i: Intent) {
    setBusy(true);
    try {
      await api(`/v1/orders/${i.id}/reject`, {
        method: "POST",
        body: JSON.stringify({ snapshotHash: i.snapshotHash, reason: "Rejected by buyer" }),
      });
      onChanged();
      onDone("Order rejected. Nothing was bought.");
      await load();
    } catch (e) {
      onError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function chooseInstead(i: Intent, productId: string) {
    setBusy(true);
    try {
      const r = await api<{ intent: Intent }>("/v1/orders/intent", {
        method: "POST",
        body: JSON.stringify({ need: i.need, offerProductId: productId }),
      });
      await load();
      setSel(r.intent.id);
      onChanged();
    } catch (e) {
      onError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  if (!loaded) return <p className="empty">Loading…</p>;
  if (!items.length || !intent)
    return (
      <section className="panel">
        <div className="allclear" style={{ marginTop: 0 }}>
          <span>✓</span>
          <div>
            <strong>Nothing is waiting for human approval</strong>
            <div className="tiny muted">
              Every order so far was either within the agent's mandate or already decided. Want to demo a policy breach?
            </div>
          </div>
        </div>
        <div className="actions" style={{ marginTop: "0.85rem" }}>
          <button type="button" className="btn primary" disabled={busy} onClick={() => void triggerDemoBreach()}>
            {busy ? "Creating 3,000 L order intent…" : "▶ Trigger 3,000 L Over-Mandate Demo Case"}
          </button>
          {onNavigate && (
            <button type="button" className="btn" onClick={() => onNavigate("mandates")}>
              Edit Purchasing Mandate Limits →
            </button>
          )}
        </div>
      </section>
    );

  const failing = intent.policy.failingRules ?? [];
  const needsOverride = failing.length > 0;
  const alts = intent.meta?.alternatives ?? [];
  const isExpired = left(intent.expiresAt) <= 0;

  return (
    <div className="approval">
      {items.length > 1 && (
        <aside className="queue">
          <div className="tiny muted">{items.length} waiting for review</div>
          {items.map((i) => (
            <button key={i.id} type="button" className={i.id === sel ? "active" : ""} onClick={() => setSel(i.id)}>
              <strong>
                {qtyText(`${i.need.quantity} ${i.need.unit}`)} {i.need.productIntent}
              </strong>
              <span>{money(i.totalPrice)}</span>
            </button>
          ))}
        </aside>
      )}

      <section className="panel decision">
        <div className="row-between" style={{ alignItems: "flex-start", flexWrap: "wrap" }}>
          <div>
            <span className="eyebrow">Human-in-the-Loop Gate</span>
            <h2>
              Approve {money(intent.totalPrice)} for {qtyText(`${intent.need.quantity} ${intent.need.unit}`)} {intent.need.productIntent}?
            </h2>
            <p className="muted" style={{ margin: "0.2rem 0 0" }}>
              Proposed {ago(intent.createdAt)} · needed by {day(intent.neededBy)} ·{" "}
              {isExpired ? <span style={{ color: "var(--danger)" }}>expired</span> : `expires in ${left(intent.expiresAt)} min`} ·{" "}
              <code className="tiny">snapshot {intent.snapshotHash.slice(0, 12)}…</code>
            </p>
          </div>
          {onNavigate && (
            <button type="button" className="btn" onClick={() => onNavigate("trust", intent.runId)}>
              Inspect Audit Chain →
            </button>
          )}
        </div>

        <div className="mandate-box" style={{ marginTop: "0.75rem" }}>
          <div>
            <div className="k">Proposed order total</div>
            <div className={`v ${failing.includes("over_spend") ? "over" : ""}`}>{money(intent.totalPrice)}</div>
          </div>
          <div>
            <div className="k">Requested quantity</div>
            <div className={`v ${failing.includes("over_quantity") ? "over" : ""}`}>
              {qtyText(`${intent.need.quantity} ${intent.need.unit}`)}
            </div>
          </div>
          <div>
            <div className="k">Snapshot hash binding</div>
            <div className="v">{intent.snapshotHash.slice(0, 12)}…</div>
          </div>
        </div>

        <div className="why-you">
          <strong>Why the gateway halted the agent</strong>
          <ul>
            {(needsOverride ? failing : ["policy"]).map((r) => (
              <li key={r}>
                <strong>{ruleLabel(r)}:</strong> {RULE_TEXT[r]?.(intent) ?? (r === "policy" ? intent.policy.reasons.join(" ") : ruleLabel(r))}
              </li>
            ))}
          </ul>
        </div>

        <h3>The agent's pick{intent.basket.length > 1 ? ` (${intent.basket.length} items)` : ""}</h3>
        {intent.basket.length === 0 ? (
          <p className="empty">No items in basket.</p>
        ) : (
          intent.basket.map((line, idx) => (
            <div key={line.productId || idx} className="pick" style={idx > 0 ? { marginTop: "0.6rem" } : undefined}>
              <div className="row-between">
                <strong>{line.productName}</strong>
                <strong className="mono">{money(line.totalPrice)}</strong>
              </div>
              <div className="tiny muted">
                {line.packs} × {qtyText(`${line.packSize}${line.packUnit}`)} = {qtyText(`${line.totalQuantity}${line.quantityUnit}`)} · {money(line.unitPrice)} per pack · delivery {day(line.availableDate)}
                {line.deliveryReliability != null ? ` · ${Math.round(line.deliveryReliability * 100)}% on-time history` : ""}
              </div>
              <ProductFacts f={{ ...line, signed: (line.claimIds?.length ?? 0) > 0 }} />
              {idx === 0 && (intent.meta?.rationale ?? []).length > 0 && (
                <ul className="rationale">
                  {intent.meta!.rationale.map((r, k) => (
                    <li key={k}>{r}</li>
                  ))}
                </ul>
              )}
            </div>
          ))
        )}

        {alts.length > 0 && (
          <>
            <h3>Other options the agent considered</h3>
            <ul className="alts">
              {alts.map((a) => (
                <li key={a.productId}>
                  <div>
                    <strong title={a.productName}>{clip(a.productName, 64)}</strong>
                    <div className="tiny muted">
                      {a.note}
                      {a.availableDate ? ` · arrives ${day(a.availableDate)}` : ""}
                      {a.deliveryReliability != null ? ` · ${Math.round(a.deliveryReliability * 100)}% on time` : ""}
                      {a.certifications.length ? ` · ${a.certifications[0]}` : ""}
                    </div>
                  </div>
                  <span className={`mono ${a.deltaEur < 0 ? "good" : ""}`}>
                    {a.deltaEur >= 0 ? "+" : "−"}{money(Math.abs(a.deltaEur))}
                  </span>
                  <button type="button" className="btn" disabled={busy} onClick={() => void chooseInstead(intent, a.productId)}>
                    Choose this instead
                  </button>
                </li>
              ))}
            </ul>
          </>
        )}

        {needsOverride && (
          <label className="override">
            <input type="checkbox" checked={override} onChange={(e) => setOverride(e.target.checked)} />
            <span>
              I authorise this <strong>one-time</strong> mandate override ({failing.map(ruleLabel).join(", ")}). It does not change the agent's standing mandate.
            </span>
          </label>
        )}

        <div className="actions decide">
          <button type="button" className="btn danger" disabled={busy} onClick={() => void reject(intent)}>
            Reject order
          </button>
          <button
            type="button"
            className="btn primary big"
            disabled={busy || isExpired || (needsOverride && !override)}
            onClick={() => void approve(intent)}
          >
            {busy ? "Revalidating & committing…" : isExpired ? "Order expired" : `Approve & commit order · ${money(intent.totalPrice)}`}
          </button>
        </div>
        <p className="tiny muted">
          Cryptographically bound to this exact basket (snapshot <code>{intent.snapshotHash.slice(0, 10)}…</code>). Commit revalidates live Valio price and availability; if price drifted beyond tolerance or stock dropped, commit is stopped automatically.
        </p>
      </section>
    </div>
  );
}
