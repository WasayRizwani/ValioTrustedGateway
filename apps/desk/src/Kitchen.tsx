import { useCallback, useEffect, useState } from "react";
import { api } from "./api";
import { money, qty, unitLabel, tidy, trend } from "./format";
import { KitchenTools } from "./KitchenTools";
import { Events } from "./Events";

type Unit = "kg" | "litre" | "each" | "pack";
type Rec = {
  ingredientId: string;
  name: string;
  onHand: number;
  parLevel: number;
  targetQty?: number;
  onOrder?: number;
  weeklyRecipeDemand: number;
  suggestedOrderQty: number;
  unit: string;
  urgency: "critical" | "low" | "ok";
  reason: string;
  standingOrderDrift?: boolean;
  standingOrderAvgQty?: number;
  recentOrderTrend?: string;
  expiresOn?: string;
  daysToExpiry?: number;
  atRiskQty?: number;
  daysSinceUse?: number;
};
type QtyOption = {
  productId: string; productName: string; packs: number; packLabel: string; quantity: number; unit: string;
  totalEur: number; effectivePerUnit: number; usedQty: number; surplusQty: number; wasteQty: number; wasteEur: number; why: string;
};
type SmartLine = {
  ingredientId: string; name: string; unit: string; exact: QtyOption | null; smart: QtyOption | null; savingEur: number;
  recommendation: "smart" | "exact"; note: string;
};
type UseFirst = {
  ingredientId: string; name: string; kind: "expiring" | "slow_moving"; headline: string; detail: string; wasteEur?: number | null;
};
type RunLine = { ingredient: string; urgency: string; outcome: string; status?: string; totalPrice?: number; committed?: boolean };
type RunResult = { ranAt: string; summary: string; lines: RunLine[]; pendingApprovalCount: number; committedCount: number };
type Policy = { enabled: boolean; daysCover: number; maxItems: number; intervalMinutes: number; pauseOnStandingOrderDrift: boolean; smartQuantities?: boolean; urgencies: Array<"critical" | "low"> };
type Tab = "stock" | "events" | "recipes" | "automation";

const TABS: Array<[Tab, string]> = [
  ["stock", "Stock & Smart Restock"],
  ["events", "Events & Phone Planner"],
  ["recipes", "Recipes"],
  ["automation", "Auto-restock Rules"],
];

const ago = (iso: string) => {
  const m = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60000));
  return m < 1 ? "just now" : m < 60 ? `${m} min ago` : `${Math.round(m / 60)} h ago`;
};

export function Kitchen(props: {
  initialTab?: Tab;
  onTabChange?: (tab: Tab) => void;
  onNavigate: (v: string, id?: string) => void;
  onChanged: () => void;
  onMessage: (m: string | null) => void;
  onError: (m: string | null) => void;
}) {
  const { onTabChange, onNavigate, onChanged, onMessage, onError } = props;
  const [tab, setTab] = useState<Tab>(props.initialTab ?? "stock");
  useEffect(() => {
    if (props.initialTab) setTab(props.initialTab);
  }, [props.initialTab]);
  const [recs, setRecs] = useState<Rec[]>([]);
  const [hotel, setHotel] = useState("");
  const [policy, setPolicy] = useState<Policy | null>(null);
  const [smart, setSmart] = useState<Record<string, SmartLine>>({});
  const [useFirst, setUseFirst] = useState<UseFirst[]>([]);
  const [lastRun, setLastRun] = useState<RunResult | null>(null);
  const [result, setResult] = useState<RunResult | null>(null);
  const [busy, setBusy] = useState<string | null>(null); // "all" | ingredientId
  const [editing, setEditing] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [draft, setDraft] = useState({ name: "", unit: "kg" as Unit, onHand: 0, parLevel: 0, hint: "", lf: false });

  const load = useCallback(async () => {
    try {
      const [r, a] = await Promise.all([
        api<{ hotelName: string; recommendations: Rec[] }>("/v1/kitchen/restock?daysCover=7"),
        api<{ policy: Policy; lastRun: RunResult | null }>("/v1/kitchen/restock/automation"),
      ]);
      setRecs(r.recommendations);
      setHotel(r.hotelName);
      // Pack-size pricing hits Valio live, so it loads after the table is already on screen.
      void api<{ lines: SmartLine[]; useFirst: UseFirst[] }>("/v1/kitchen/restock/smart?daysCover=7")
        .then((sm) => {
          setSmart(Object.fromEntries(sm.lines.map((l) => [l.ingredientId, l])));
          setUseFirst(sm.useFirst);
        })
        .catch(() => undefined);
      setPolicy(a.policy);
      setLastRun(a.lastRun);
    } catch (e) {
      onError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoaded(true);
    }
  }, [onError]);

  useEffect(() => {
    void load();
  }, [load]);

  const low = recs.filter((r) => r.urgency !== "ok");
  const counts = { critical: recs.filter((r) => r.urgency === "critical").length, low: recs.filter((r) => r.urgency === "low").length, ok: recs.filter((r) => r.urgency === "ok").length };

  async function restock(only?: string, choice?: "exact" | "smart") {
    setBusy(only ?? "all");
    onError(null);
    try {
      const r = await api<{ result: RunResult }>("/v1/kitchen/restock/run", {
        method: "POST",
        body: JSON.stringify(only ? { only: [only], choice } : { all: true, choice }),
      });
      setResult(r.result);
      onChanged();
      await load();
    } catch (e) {
      onError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }

  async function savePolicy(patch: Partial<Policy>) {
    if (!policy) return;
    try {
      const r = await api<{ policy: Policy }>("/v1/kitchen/restock/automation", { method: "PUT", body: JSON.stringify({ ...policy, ...patch }) });
      setPolicy(r.policy);
      onMessage(r.policy.enabled ? `Auto-restock is ON — checks every ${r.policy.intervalMinutes} min and orders within your mandate.` : "Auto-restock is off.");
    } catch (e) {
      onError(e instanceof Error ? e.message : String(e));
    }
  }

  async function act(fn: () => Promise<unknown>, ok?: string) {
    try {
      await fn();
      if (ok) onMessage(ok);
      onChanged();
      await load();
    } catch (e) {
      onError(e instanceof Error ? e.message : String(e));
    }
  }

  return (
    <div className="home">
      <div className="subtabs kitchen-tabs" role="tablist">
        {TABS.map(([id, label]) => (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={tab === id}
            className={tab === id ? "active" : ""}
            onClick={() => {
              setTab(id);
              onTabChange?.(id);
            }}
          >
            {label}
            {id === "stock" && counts.critical + counts.low > 0 ? <span className="dot">{counts.critical + counts.low}</span> : null}
          </button>
        ))}
      </div>

      {tab === "stock" && (
        <>
          <section className="panel">
            <div className="row-between" style={{ flexWrap: "wrap", gap: "0.8rem" }}>
              <div>
                <h2>{hotel || "Kitchen"} · Stock &amp; Pack-Size Optimizer</h2>
                <div className="stock-chips">
                  <span className={`schip critical ${counts.critical ? "" : "zero"}`}>{counts.critical} critical</span>
                  <span className={`schip low ${counts.low ? "" : "zero"}`}>{counts.low} low</span>
                  <span className="schip ok">{counts.ok} ok</span>
                </div>
              </div>
              <div className="actions">
                <button type="button" className="btn" onClick={() => setAdding(!adding)}>
                  {adding ? "Close" : "+ Add ingredient"}
                </button>
                <button type="button" className="btn primary big" disabled={busy !== null || low.length === 0} onClick={() => void restock()}>
                  {busy === "all" ? "Agents are ordering…" : low.length ? `Restock all low items (${low.length})` : "Nothing to restock"}
                </button>
              </div>
            </div>

            {result && (
              <div className="run-result">
                <div className="row-between">
                  <strong>{result.summary}</strong>
                  <button type="button" className="link" onClick={() => setResult(null)}>
                    Dismiss
                  </button>
                </div>
                <ul>
                  {result.lines.map((l, i) => (
                    <li key={i} className={l.committed ? "ok" : l.status === "pending_approval" ? "warn" : l.outcome.startsWith("Skipped") ? "muted" : ""}>
                      <span className="mk">{l.committed ? "✓" : l.status === "pending_approval" ? "!" : "–"}</span>
                      <div>
                        <strong>{l.ingredient}</strong> — {l.committed ? "ordered automatically" : l.status === "pending_approval" ? "needs your approval" : l.outcome}
                        {l.totalPrice != null ? ` · ${money(l.totalPrice)}` : ""}
                      </div>
                    </li>
                  ))}
                </ul>
                {result.pendingApprovalCount > 0 && (
                  <button type="button" className="btn primary" onClick={() => onNavigate("approval")}>
                    Review {result.pendingApprovalCount} order{result.pendingApprovalCount === 1 ? "" : "s"} waiting for you
                  </button>
                )}
              </div>
            )}

            {adding && (
              <div className="add-form">
                <div className="form-grid">
                  <label>
                    Name
                    <input value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} placeholder="e.g. Oat drink" />
                  </label>
                  <label>
                    Unit
                    <select value={draft.unit} onChange={(e) => setDraft({ ...draft, unit: e.target.value as Unit })}>
                      {["kg", "litre", "each", "pack"].map((u) => (
                        <option key={u}>{u}</option>
                      ))}
                    </select>
                  </label>
                  <label>
                    On hand
                    <input type="number" value={draft.onHand} onChange={(e) => setDraft({ ...draft, onHand: Number(e.target.value) })} />
                  </label>
                  <label>
                    Keep at least (par)
                    <input type="number" value={draft.parLevel} onChange={(e) => setDraft({ ...draft, parLevel: Number(e.target.value) })} />
                  </label>
                  <label className="full">
                    What to search at Valio
                    <input value={draft.hint} onChange={(e) => setDraft({ ...draft, hint: e.target.value })} placeholder="e.g. lactose-free oat drink" />
                  </label>
                  <label className="full check-row">
                    <input type="checkbox" checked={draft.lf} onChange={(e) => setDraft({ ...draft, lf: e.target.checked })} />
                    <span>Must be lactose-free</span>
                  </label>
                </div>
                <button
                  type="button"
                  className="btn primary"
                  style={{ marginTop: "0.6rem" }}
                  disabled={!draft.name.trim()}
                  onClick={() =>
                    void act(async () => {
                      await api("/v1/kitchen/inventory", {
                        method: "PUT",
                        body: JSON.stringify({
                          items: [{ name: draft.name.trim(), unit: draft.unit, onHand: draft.onHand, parLevel: draft.parLevel, lactoseFreePreferred: draft.lf, catalogHints: [draft.hint.trim() || draft.name.trim().toLowerCase()] }],
                        }),
                      });
                      setDraft({ name: "", unit: "kg", onHand: 0, parLevel: 0, hint: "", lf: false });
                      setAdding(false);
                    }, "Ingredient added")
                  }
                >
                  Add ingredient
                </button>
              </div>
            )}
          </section>

          {useFirst.length > 0 && (
            <section className="panel usefirst">
              <h2>Use these first (Expiry &amp; Waste Prevention)</h2>
              <p className="muted">Stock you already hold that is about to expire or has not been touched in weeks. Use it before buying more.</p>
              <ul>
                {useFirst.map((u) => (
                  <li key={u.ingredientId} className={u.kind}>
                    <span className={`fact ${u.kind === "expiring" ? "warn" : ""}`}>{u.kind === "expiring" ? "Expiring" : "Slow-moving"}</span>
                    <div>
                      <strong>{tidy(u.headline)}</strong>
                      {u.wasteEur ? <span className="tiny muted"> · about {money(u.wasteEur, 0)} at risk</span> : null}
                      <div className="tiny muted">{u.detail}</div>
                    </div>
                  </li>
                ))}
              </ul>
            </section>
          )}

          <section className="panel">
            {!loaded ? (
              <p className="empty">Loading…</p>
            ) : (
              <div className="ktable">
                <div className="kt-head">
                  <span>Ingredient</span>
                  <span>Stock</span>
                  <span>Uses / week</span>
                  <span>Status</span>
                  <span />
                </div>
                {recs
                  .slice()
                  .sort((a, b) => ({ critical: 0, low: 1, ok: 2 })[a.urgency] - ({ critical: 0, low: 1, ok: 2 })[b.urgency])
                  .map((r) => {
                    const goal = r.targetQty ?? r.parLevel;
                    const max = Math.max(goal, r.onHand + (r.onOrder ?? 0), 1) * 1.1;
                    const covered = r.urgency === "ok" && (r.onOrder ?? 0) > 0 && r.onHand < goal;
                    return (
                      <div key={r.ingredientId} className={`kt-row ${r.urgency}`}>
                        <div className="kt-name">
                          <strong>{r.name}</strong>
                          {r.standingOrderDrift && (
                            <span className="fact warn" title={`Suggested ${qty(r.suggestedOrderQty, r.unit)} vs your usual ~${qty(r.standingOrderAvgQty, r.unit)}. The scheduled auto-restock skips this one; clicking Order or Restock yourself still places it (checked against your mandate).`}>
                              check quantity
                            </span>
                          )}
                          {r.recentOrderTrend && <div className="tiny muted">{trend(r.recentOrderTrend, r.unit)}</div>}
                          {r.expiresOn && r.onHand > 0 && (
                            <span
                              className={`fact ${(r.daysToExpiry ?? 99) <= 3 ? "warn" : ""}`}
                              title={`Earliest expiry ${r.expiresOn}. Click to change.`}
                              style={{ cursor: "pointer" }}
                              onClick={() => {
                                const v = window.prompt(`Earliest expiry date for ${r.name} (YYYY-MM-DD)`, r.expiresOn);
                                if (!v) return;
                                if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) {
                                  onError("Use YYYY-MM-DD format for expiry date");
                                  return;
                                }
                                void act(() => api("/v1/kitchen/inventory/adjust", { method: "POST", body: JSON.stringify({ ingredientId: r.ingredientId, expiresOn: v }) }), "Expiry updated");
                              }}
                            >
                              {(r.daysToExpiry ?? 0) <= 0 ? "expires today" : `expires in ${r.daysToExpiry}d`}
                              {r.atRiskQty ? ` · ${qty(r.atRiskQty, r.unit)} may go unused` : ""}
                            </span>
                          )}
                        </div>
                        <div className="kt-stock">
                          <span className="track">
                            <b className={`have ${r.urgency}`} style={{ width: `${(r.onHand / max) * 100}%` }} />
                            <b className="inbound" style={{ width: `${((r.onOrder ?? 0) / max) * 100}%` }} />
                            <u style={{ left: `${(goal / max) * 100}%` }} title={`target ${goal} = larger of par ${r.parLevel} and a week of recipe use`} />
                          </span>
                          {editing === r.ingredientId ? (
                            <span className="edit-stock">
                              <input
                                type="number"
                                autoFocus
                                defaultValue={r.onHand}
                                onKeyDown={(e) => {
                                  if (e.key === "Escape") setEditing(null);
                                  if (e.key === "Enter") e.currentTarget.blur();
                                }}
                                onBlur={(e) => {
                                  const v = Number(e.target.value);
                                  setEditing(null);
                                  if (v !== r.onHand) void act(() => api("/v1/kitchen/inventory/adjust", { method: "POST", body: JSON.stringify({ ingredientId: r.ingredientId, onHand: v }) }), `${r.name}: stock set to ${qty(v, r.unit)}`);
                                }}
                              />
                              <span className="tiny muted">{unitLabel(r.unit)} on hand</span>
                            </span>
                          ) : (
                            <button type="button" className="num-btn" title="Click to correct the amount on hand (stock-take)" onClick={() => setEditing(r.ingredientId)}>
                              {r.onHand}
                              {r.onOrder ? <span className="muted" title="already ordered, arriving"> +{r.onOrder} ordered</span> : null} / need {qty(goal, r.unit)}
                            </button>
                          )}
                        </div>
                        <div className="tiny">
                          {qty(r.weeklyRecipeDemand, r.unit)} <span className="muted">/ week</span>
                        </div>
                        <div>
                          <span className={`status-text ${r.urgency}`}>{r.urgency === "ok" ? (covered ? "Covered by orders" : "OK") : r.urgency === "critical" ? "Critical" : "Low"}</span>
                        </div>
                        <div className="kt-act">
                          {r.urgency !== "ok" && r.suggestedOrderQty > 0 ? (
                            <button type="button" className={`btn ${r.standingOrderDrift ? "" : "primary"}`} disabled={busy !== null} onClick={() => void restock(r.ingredientId)}>
                              {busy === r.ingredientId ? "Ordering…" : `${r.standingOrderDrift ? "Order anyway" : "Order"} ${qty(r.suggestedOrderQty, r.unit)}`}
                            </button>
                          ) : (
                            <button
                              type="button"
                              className="link"
                              onClick={() => {
                                if (window.confirm(`Remove ${r.name} from your kitchen?`)) void act(() => api(`/v1/kitchen/inventory/${r.ingredientId}`, { method: "DELETE" }), `${r.name} removed`);
                              }}
                            >
                              Remove
                            </button>
                          )}
                        </div>
                        {r.urgency !== "ok" && r.suggestedOrderQty > 0 && smart[r.ingredientId]?.smart && (
                          <div className="smartcard">
                            {(() => {
                              const sl = smart[r.ingredientId];
                              const sm = sl.smart!;
                              return (
                                <div className="smartopt">
                                  <div className="tiny">
                                    <span className="fact ok">Smarter pack size</span>{" "}
                                    <strong>{sm.packs} × {sm.packLabel}</strong> ({sm.quantity}{sm.unit} · {money(sm.totalEur)} · {money(sm.effectivePerUnit)}/{sm.unit} used) —{" "}
                                    <span style={{ color: "var(--success)" }}>{sl.note || tidy(sm.why)}</span>
                                  </div>
                                  <button type="button" className="btn primary" disabled={busy !== null} onClick={() => void restock(r.ingredientId, "smart")}>
                                    Order smart · {money(sm.totalEur)}
                                  </button>
                                </div>
                              );
                            })()}
                          </div>
                        )}
                      </div>
                    );
                  })}
              </div>
            )}
            <p className="tiny muted" style={{ marginTop: "0.6rem" }}>
              Solid bar = on hand · light blue = already ordered · tick = target (the larger of par and a week of recipe use); on hand + ordered is compared against it. Every order is checked against your mandate; anything over it waits for you. Click a stock number to correct it.
            </p>
          </section>

          <KitchenTools section="inbound" onChanged={() => { onChanged(); void load(); }} onError={onError} onMessage={onMessage} />
        </>
      )}

      {tab === "events" && <Events onNavigate={onNavigate} onChanged={onChanged} onMessage={onMessage} onError={onError} />}

      {tab === "recipes" && <KitchenTools section="recipes" onChanged={() => { onChanged(); void load(); }} onError={onError} onMessage={onMessage} />}

      {tab === "automation" && policy && (
        <section className="panel">
          <div className="row-between" style={{ alignItems: "flex-start", gap: "1rem" }}>
            <div>
              <h2>Automatic restocking</h2>
              <p className="muted">
                When on, the agent team checks stock on a schedule and orders what is low — you do nothing. Anything over your mandate still waits for your approval.
              </p>
            </div>
            <label className="switch">
              <input type="checkbox" checked={policy.enabled} onChange={(e) => void savePolicy({ enabled: e.target.checked })} />
              <span className="switch-ui" />
              <span className="switch-label">{policy.enabled ? "On" : "Off"}</span>
            </label>
          </div>

          <div className="how">
            <div>
              <b>1 · Planner</b>
              <span>finds what is running low, using your recipes and stock</span>
            </div>
            <div>
              <b>2 · Sourcing</b>
              <span>compares live Valio offers and picks the best deliverable one</span>
            </div>
            <div>
              <b>3 · Procurement</b>
              <span>orders it if it's inside your mandate — otherwise asks you</span>
            </div>
          </div>

          <div className="form-grid" style={{ marginTop: "1rem" }}>
            <label>
              Plan ahead (days)
              <input type="number" min={1} max={30} defaultValue={policy.daysCover} key={`d${policy.daysCover}`} onKeyDown={(e) => { if (e.key === "Enter") e.currentTarget.blur(); }} onBlur={(e) => Number(e.target.value) !== policy.daysCover && void savePolicy({ daysCover: Number(e.target.value) })} />
            </label>
            <label>
              Max items per scheduled run
              <input type="number" min={1} max={10} defaultValue={policy.maxItems} key={`m${policy.maxItems}`} onKeyDown={(e) => { if (e.key === "Enter") e.currentTarget.blur(); }} onBlur={(e) => Number(e.target.value) !== policy.maxItems && void savePolicy({ maxItems: Number(e.target.value) })} />
            </label>
            <label>
              Check every (minutes)
              <input type="number" min={1} max={1440} defaultValue={policy.intervalMinutes} key={`i${policy.intervalMinutes}`} onKeyDown={(e) => { if (e.key === "Enter") e.currentTarget.blur(); }} onBlur={(e) => Number(e.target.value) !== policy.intervalMinutes && void savePolicy({ intervalMinutes: Number(e.target.value) })} />
            </label>
            <label className="full check-row">
              <input type="checkbox" checked={policy.smartQuantities !== false} onChange={(e) => void savePolicy({ smartQuantities: e.target.checked })} />
              <span>Smart quantities: pick the pack size that costs least per unit I actually use, when it is a modest step up from the exact amount</span>
            </label>
            <label className="full check-row">
              <input type="checkbox" checked={policy.pauseOnStandingOrderDrift} onChange={(e) => void savePolicy({ pauseOnStandingOrderDrift: e.target.checked })} />
              <span>Don't auto-order an item when the suggested quantity is very different from my usual (I'll check it myself)</span>
            </label>
          </div>

          {lastRun && (
            <div className="run-result" style={{ marginTop: "1rem" }}>
              <strong>Last run · {ago(lastRun.ranAt)}</strong> — {lastRun.summary}
            </div>
          )}
          <p className="tiny muted" style={{ marginTop: "0.8rem" }}>
            For items you need on a fixed day every week, use{" "}
            <button type="button" className="link" onClick={() => onNavigate("recurring")}>
              Recurring orders
            </button>
            .
          </p>
        </section>
      )}
    </div>
  );
}
