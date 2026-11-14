import { useCallback, useEffect, useState } from "react";
import { api } from "./api";
import { money, qty, unitLabel, day, tidy } from "./format";

export type EventLine = {
  ingredientId: string;
  name: string;
  unit: string;
  required: number;
  usualUse?: number;
  onHand: number;
  onOrder: number;
  shortfall: number;
  status: string;
  explanation: string;
  chosen?: { productName: string; totalPrice: number; availableDate: string | null; isSubstitution: boolean };
  substitutes: Array<{ label: string; productName: string; totalPrice: number; tradeOff: string }>;
};
export type EventView = {
  id: string;
  name: string;
  date: string;
  guests: number;
  bufferPct: number;
  autoOrder: boolean;
  leadDays: number;
  prepDays: number;
  notes: string;
  status: string;
  recipes: Array<{ recipeId: string; servings?: number }>;
  extras: Array<{ ingredientId: string; qty: number }>;
  deliverBy: string;
  orderBy: string;
  daysAway: number;
  daysToOrderBy: number;
  orderDue: boolean;
  readiness: "unplanned" | "covered" | "ready_to_order" | "at_risk" | "ordered" | "past";
  headline: string;
  plan: { lines: EventLine[]; flags: string[]; estTotal: number; canMeetDate: boolean; at: string } | null;
  orders: Array<{ ingredient: string; intentId: string; status: string; total: number }> | null;
  voice?: { eventId: string; delivery: string; approval: string; attempts: number; updatedAt: string; errorCode?: string; approvalUrl?: string; retryAfterAt?: string } | null;
};
type Recipe = { recipeId: string; name: string; servingsPerBatch: number };
type Ing = { ingredientId: string; name: string; unit: string };

export const READINESS: Record<string, { label: string; cls: string }> = {
  covered: { label: "Covered", cls: "ok" },
  ready_to_order: { label: "To order", cls: "info" },
  at_risk: { label: "At risk", cls: "bad" },
  ordered: { label: "Ordered", cls: "ok" },
  unplanned: { label: "Not checked", cls: "muted" },
  past: { label: "Past", cls: "muted" },
};

const inDays = (n: number) => (n === 0 ? "today" : n === 1 ? "tomorrow" : n < 0 ? `${-n} days ago` : `in ${n} days`);
const plusDays = (n: number) => {
  const d = new Date();
  d.setDate(d.getDate() + n);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

type Draft = {
  id?: string;
  name: string;
  date: string;
  guests: number;
  bufferPct: number;
  autoOrder: boolean;
  recipes: Record<string, { on: boolean; servings: number | "" }>;
  extras: Array<{ ingredientId: string; qty: number }>;
};

export function Events(props: { onNavigate: (v: string) => void; onChanged: () => void; onMessage: (m: string | null) => void; onError: (m: string | null) => void }) {
  const { onNavigate, onChanged, onMessage, onError } = props;
  const [events, setEvents] = useState<EventView[]>([]);
  const [recipes, setRecipes] = useState<Recipe[]>([]);
  const [ings, setIngs] = useState<Ing[]>([]);
  const [open, setOpen] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [voiceSetup, setVoiceSetup] = useState<{ mode: string; ready: boolean; phoneNumber: string; missing: string[] } | null>(null);

  const load = useCallback(async () => {
    try {
      const [e, r, i] = await Promise.all([
        api<{ events: EventView[] }>("/v1/events"),
        api<{ recipes: Recipe[] }>("/v1/kitchen/recipes"),
        api<{ inventory: Ing[] }>("/v1/kitchen/inventory"),
      ]);
      setEvents(e.events);
      setRecipes(r.recipes);
      setIngs(i.inventory);
      const readiness = await api<{ mode: string; ready: boolean; phoneNumber: string; missing: string[] }>("/v1/voice/readiness").catch(() => null);
      setVoiceSetup(readiness);
    } catch (err) {
      onError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoaded(true);
    }
  }, [onError]);
  useEffect(() => {
    void load();
  }, [load]);

  const blank = (): Draft => ({
    name: "",
    date: plusDays(14),
    guests: 100,
    bufferPct: 10,
    autoOrder: true,
    recipes: Object.fromEntries(recipes.map((r) => [r.recipeId, { on: false, servings: "" as const }])),
    extras: [],
  });
  const fromEvent = (e: EventView): Draft => ({
    id: e.id,
    name: e.name,
    date: e.date,
    guests: e.guests,
    bufferPct: e.bufferPct,
    autoOrder: e.autoOrder,
    recipes: Object.fromEntries(recipes.map((r) => {
      const hit = e.recipes.find((x) => x.recipeId === r.recipeId);
      return [r.recipeId, { on: Boolean(hit), servings: hit && hit.servings !== e.guests ? (hit.servings ?? "") : "" }];
    })),
    extras: e.extras,
  });

  async function save() {
    if (!draft) return;
    const picked = Object.entries(draft.recipes).filter(([, v]) => v.on);
    if (!draft.name.trim()) return onError("Give the event a name");
    if (!picked.length && !draft.extras.length) return onError("Pick at least one recipe or add an extra item");
    setBusy("save");
    onError(null);
    try {
      const body = {
        name: draft.name,
        date: draft.date,
        guests: draft.guests,
        bufferPct: draft.bufferPct,
        autoOrder: draft.autoOrder,
        recipes: picked.map(([recipeId, v]) => ({ recipeId, servings: v.servings === "" ? draft.guests : Number(v.servings) })),
        extras: draft.extras.filter((x) => x.ingredientId && x.qty > 0),
      };
      const r = await api<{ event: EventView }>(draft.id ? `/v1/events/${draft.id}` : "/v1/events", { method: draft.id ? "PUT" : "POST", body: JSON.stringify(body) });
      setDraft(null);
      setOpen(r.event.id);
      onMessage(`${r.event.name}: ${r.event.headline}`);
      onChanged();
      await load();
    } catch (e) {
      onError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }

  async function run(id: string, what: "order" | "replan" | "cancel") {
    if (what === "cancel" && !window.confirm("Cancel this event? Orders already placed stay as they are.")) return;
    setBusy(`${what}:${id}`);
    onError(null);
    try {
      const r = await api<{ event?: EventView }>(what === "cancel" ? `/v1/events/${id}` : `/v1/events/${id}/${what}`, { method: what === "cancel" ? "DELETE" : "POST", body: "{}" });
      if (r.event) onMessage(`${r.event.name}: ${r.event.headline}`);
      onChanged();
      await load();
    } catch (e) {
      onError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }

  async function retryEmail(id: string) {
    setBusy(`email:${id}`);
    onError(null);
    try {
      await api(`/v1/events/${id}/voice-email/retry`, { method: "POST", body: "{}" });
      onMessage("Approval email sent. The buyer can review the current plan from the link.");
      await load();
    } catch (e) { onError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(null); }
  }

  return (
    <div className="home">
      <section className="panel">
        <div className="row-between" style={{ flexWrap: "wrap", gap: "0.7rem" }}>
          <div>
            <h2>Events &amp; busy days</h2>
            <p className="muted" style={{ margin: 0 }}>
              Tell us about a wedding, banquet or school party. The Planner works out the <strong>extra</strong> food needed on top of your normal usage, checks Valio can deliver it in time, and orders at the right moment.
            </p>
          </div>
          <button type="button" className="btn primary big" onClick={() => setDraft(blank())} disabled={!!draft}>
            + Add an event
          </button>
        </div>
      </section>

      {draft && (
        <section className="panel event-form">
          <h2>{draft.id ? "Edit event" : "New event"}</h2>
          <div className="form-grid">
            <label className="full">
              Name
              <input value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} placeholder="e.g. Saturday wedding brunch" />
            </label>
            <label>
              Event day
              <input type="date" value={draft.date} onChange={(e) => setDraft({ ...draft, date: e.target.value })} />
            </label>
            <label>
              Guests
              <input type="number" min={1} value={draft.guests} onChange={(e) => setDraft({ ...draft, guests: Number(e.target.value) })} />
            </label>
            <label>
              Safety margin (%)
              <input type="number" min={0} max={50} value={draft.bufferPct} onChange={(e) => setDraft({ ...draft, bufferPct: Number(e.target.value) })} />
            </label>
            <label className="check-row" style={{ alignSelf: "end" }}>
              <input type="checkbox" checked={draft.autoOrder} onChange={(e) => setDraft({ ...draft, autoOrder: e.target.checked })} />
              <span>Order automatically at the right time</span>
            </label>
          </div>

          <h3>What will be served?</h3>
          <p className="tiny muted" style={{ margin: "0 0 0.4rem" }}>
            Tick the dishes and (optionally) how many portions — default is every guest.
          </p>
          <ul className="list">
            {recipes.map((r) => {
              const v = draft.recipes[r.recipeId] ?? { on: false, servings: "" as const };
              return (
                <li key={r.recipeId}>
                  <label style={{ display: "flex", gap: "0.6rem", alignItems: "center" }}>
                    <input type="checkbox" checked={v.on} onChange={(e) => setDraft({ ...draft, recipes: { ...draft.recipes, [r.recipeId]: { ...v, on: e.target.checked } } })} />
                    <span style={{ flex: 1 }}>{r.name}</span>
                    {v.on && (
                      <>
                        <input
                          type="number"
                          min={1}
                          style={{ width: "5.5rem" }}
                          placeholder={String(draft.guests)}
                          value={v.servings}
                          onChange={(e) => setDraft({ ...draft, recipes: { ...draft.recipes, [r.recipeId]: { ...v, servings: e.target.value === "" ? "" : Number(e.target.value) } } })}
                        />
                        <span className="tiny muted">portions</span>
                      </>
                    )}
                  </label>
                </li>
              );
            })}
          </ul>

          <h3>Anything extra? (drinks, add-ons)</h3>
          {draft.extras.map((x, i) => (
            <div key={i} className="row-between" style={{ gap: "0.5rem", marginBottom: "0.3rem" }}>
              <select value={x.ingredientId} onChange={(e) => setDraft({ ...draft, extras: draft.extras.map((y, k) => (k === i ? { ...y, ingredientId: e.target.value } : y)) })}>
                <option value="">Select ingredient…</option>
                {ings.map((g) => (
                  <option key={g.ingredientId} value={g.ingredientId}>
                    {g.name} ({unitLabel(g.unit)})
                  </option>
                ))}
              </select>
              <input type="number" min={0} style={{ width: "6rem" }} value={x.qty} onChange={(e) => setDraft({ ...draft, extras: draft.extras.map((y, k) => (k === i ? { ...y, qty: Number(e.target.value) } : y)) })} />
              <button type="button" className="btn" onClick={() => setDraft({ ...draft, extras: draft.extras.filter((_, k) => k !== i) })}>
                ✕
              </button>
            </div>
          ))}
          <button type="button" className="btn" onClick={() => setDraft({ ...draft, extras: [...draft.extras, { ingredientId: "", qty: 10 }] })}>
            + Add extra item
          </button>

          <div className="actions decide">
            <button type="button" className="btn" onClick={() => setDraft(null)}>
              Cancel
            </button>
            <button type="button" className="btn primary big" disabled={busy === "save"} onClick={() => void save()}>
              {busy === "save" ? "Planner is checking Valio…" : draft.id ? "Save & re-check" : "Plan this event"}
            </button>
          </div>
        </section>
      )}

      {!loaded ? (
        <p className="empty">Loading…</p>
      ) : events.length === 0 && !draft ? (
        <section className="panel">
          <p className="empty">No events yet. Add one and the agents will make sure the kitchen is ready — and warn you early if Valio can't deliver in time.</p>
        </section>
      ) : (
        events.map((e) => {
          const r = READINESS[e.readiness];
          const expanded = open === e.id;
          const toOrder = e.plan?.lines.filter((l) => l.shortfall > 0) ?? [];
          const canOrderNow = !e.voice || e.voice.approval === "approved";
          const priceLabel = toOrder.some((line) => !line.chosen)
            ? toOrder.some((line) => line.chosen) ? `At least ${money(e.plan?.estTotal ?? 0, 0)} · incomplete` : "Estimate unavailable"
            : `≈ ${money(e.plan?.estTotal ?? 0, 0)}`;
          return (
            <section key={e.id} className={`panel evt ${e.readiness}`}>
              <button type="button" className="evt-head" onClick={() => setOpen(expanded ? null : e.id)}>
                <div>
                  <h2>{e.name}</h2>
                  <div className="tiny muted">
                    {day(e.date)} · {inDays(e.daysAway)} · {e.guests} guest{e.guests === 1 ? "" : "s"}
                  </div>
                </div>
                <div className="evt-side">
                  {e.plan && toOrder.length > 0 && e.readiness !== "ordered" && <strong className="mono">{priceLabel}</strong>}
                  <span className={`rchip ${r.cls}`}>{r.label}</span>
                </div>
              </button>

              <div className="evt-timeline">
                <div className={e.daysToOrderBy <= 0 ? "done" : ""}>
                  <b>Order by</b>
                  <span>{day(e.orderBy)}</span>
                </div>
                <i />
                <div>
                  <b>On site by</b>
                  <span>{day(e.deliverBy)}</span>
                </div>
                <i />
                <div>
                  <b>Event</b>
                  <span>{day(e.date)}</span>
                </div>
              </div>
              <p className={`evt-headline ${e.readiness}`}>{tidy(e.headline)}</p>

              {e.voice && (
                <div className="phone-plan-status" aria-live="polite">
                  <strong>Phone plan</strong>
                  <span> {e.voice.delivery === "mocked" ? "Mock only · email not sent" : e.voice.delivery === "sent" ? "Email sent" : e.voice.delivery === "queued" || e.voice.delivery === "sending" ? "Email sending" : e.voice.delivery === "unknown" ? "Email delivery unknown" : "Email not sent"} · {e.voice.approval === "approved" ? "plan approved" : e.voice.approval === "stale" ? "approval link expired or plan changed" : e.voice.delivery === "mocked" ? "local preview ready" : "awaiting buyer approval"}</span>
                  {e.voice.approvalUrl && <a className="btn" href={e.voice.approvalUrl} target="_blank" rel="noreferrer">Preview mock approval</a>}
                  {e.voice.delivery === "failed" && e.voice.attempts < 3 && (
                    <button type="button" className="btn" disabled={busy !== null || Boolean(e.voice.retryAfterAt && Date.parse(e.voice.retryAfterAt) > Date.now())} onClick={() => void retryEmail(e.id)}>
                      {busy === `email:${e.id}` ? "Sending…" : "Resend approval email"}
                    </button>
                  )}
                  {e.voice.delivery === "failed" && e.voice.retryAfterAt && Date.parse(e.voice.retryAfterAt) > Date.now() && <p className="tiny">Resend is available after {new Date(e.voice.retryAfterAt).toLocaleTimeString()}.</p>}
                  {e.voice.delivery === "unknown" && <p className="tiny">The provider did not confirm delivery. Check Resend before retrying to avoid duplicate email.</p>}
                  {e.voice.delivery === "failed" && e.voice.approval !== "stale" && <p className="tiny">No order was placed. Email failed: {e.voice.errorCode ?? "provider error"}.</p>}
                </div>
              )}

              {e.plan && e.plan.flags.length > 0 && e.readiness !== "ordered" && (
                <div className="evt-risk">
                  <strong>Needs attention</strong>
                  <ul>
                    {e.plan.flags.map((f) => (
                      <li key={f}>{f}</li>
                    ))}
                  </ul>
                </div>
              )}

              <div className="actions">
                {(e.readiness === "ready_to_order" || e.readiness === "at_risk") && canOrderNow && (
                  <button type="button" className="btn primary" disabled={busy !== null} onClick={() => void run(e.id, "order")}>
                    {busy === `order:${e.id}` ? "Ordering…" : `Order now${e.plan && toOrder.length ? ` · ${priceLabel}` : ""}`}
                  </button>
                )}
                {e.orders?.some((o) => o.status === "pending_approval") && (
                  <button type="button" className="btn primary" onClick={() => onNavigate("approval")}>
                    Review orders waiting for you
                  </button>
                )}
                {e.readiness !== "past" && (
                  <button type="button" className="btn" disabled={busy !== null} onClick={() => void run(e.id, "replan")}>
                    {busy === `replan:${e.id}` ? "Checking Valio…" : "Re-check"}
                  </button>
                )}
                <button type="button" className="btn" onClick={() => setOpen(expanded ? null : e.id)}>
                  {expanded ? "Hide details" : "Show details"}
                </button>
                {e.readiness !== "past" && (
                  <button type="button" className="btn" onClick={() => setDraft(fromEvent(e))}>
                    Edit
                  </button>
                )}
                <button type="button" className="link" onClick={() => void run(e.id, "cancel")}>
                  Cancel event
                </button>
              </div>

              {expanded && e.plan && (
                <div className="evt-plan">
                  <div className="ktable">
                    <div className="kt-head evt-cols">
                      <span>Ingredient</span>
                      <span>Needed for event</span>
                      <span>Your usual use</span>
                      <span>Have + on order</span>
                      <span>To order</span>
                      <span>Valio offer</span>
                    </div>
                    {e.plan.lines.map((l) => (
                      <div key={l.ingredientId} className="kt-row evt-cols">
                        <strong>{l.name}</strong>
                        <span>
                          {qty(l.required, l.unit)}
                        </span>
                        <span className="muted">
                          {qty(l.usualUse ?? 0, l.unit)}
                        </span>
                        <span>
                          {l.onHand}
                          {l.onOrder ? ` + ${l.onOrder}` : ""} {unitLabel(l.unit)}
                        </span>
                        <span>
                          <strong>{l.shortfall > 0 ? qty(l.shortfall, l.unit) : "—"}</strong>
                        </span>
                        <span className="tiny">
                          {l.shortfall <= 0 ? <span className="muted">covered</span> : l.chosen ? (
                            <>
                              {l.chosen.isSubstitution ? "Substitute: " : ""}
                              {l.chosen.productName.slice(0, 40)} · <strong>{money(l.chosen.totalPrice)}</strong>
                              {l.status !== "sourced" && <span className="fact warn"> {l.status.replace("_", " ")}</span>}
                            </>
                          ) : (
                            <span className="fact warn">{l.status.replace("_", " ")}</span>
                          )}
                        </span>
                      </div>
                    ))}
                  </div>
                  <p className="tiny muted">
                    "Needed for event" includes a {e.bufferPct}% safety margin. "Your usual use" is what the kitchen normally consumes until the event day — only stock beyond that counts toward it. Checked {new Date(e.plan.at).toLocaleString()}.
                  </p>
                </div>
              )}

              {expanded && e.orders && e.orders.length > 0 && (
                <div className="evt-plan">
                  <h3>Orders for this event</h3>
                  <ul className="list">
                    {e.orders.map((o) => (
                      <li key={o.intentId}>
                        <div className="row-between">
                          <span>{o.ingredient}</span>
                          <span>
                            <span className={`rchip ${o.status === "committed" ? "ok" : "info"}`}>{o.status === "committed" ? "Placed" : o.status === "pending_approval" ? "Needs approval" : o.status.replace("_", " ")}</span> · {money(o.total)}
                          </span>
                        </div>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </section>
          );
        })
      )}

      {voiceSetup && (
        <section className="panel voice-call-card" aria-live="polite">
          <div className="row-between" style={{ flexWrap: "wrap", gap: "0.7rem" }}>
            <div>
              <span className={`pill ${voiceSetup.ready ? "ok" : "warn"}`}><i />{voiceSetup.ready ? "Voice agent active" : "Optional: Voice event planner"}</span>
              <h3 style={{ margin: "0.45rem 0 0.15rem" }}>Plan an event by phone</h3>
              <p className="muted tiny" style={{ margin: 0 }}>
                Callers describe the date, guest count, and saved dishes. The voice assistant creates a non-ordering proposal and emails a single-use approval link to the buyer.
              </p>
            </div>
            {voiceSetup.phoneNumber ? (
              <div className="voice-call-action">
                <strong className="voice-phone">{voiceSetup.phoneNumber}</strong>
                {voiceSetup.ready ? (
                  <a className="btn primary" href={`tel:${voiceSetup.phoneNumber.replace(/[^+\d]/g, "")}`}>Call the agent</a>
                ) : (
                  <span className="tiny muted">Calling not enabled</span>
                )}
              </div>
            ) : (
              <span className="tiny muted">Local mock / Vapi webhook</span>
            )}
          </div>
          {!voiceSetup.ready && (
            <details className="tiny voice-setup">
              <summary>Voice setup &amp; how it works</summary>
              <div className="voice-call-steps" style={{ marginTop: "0.5rem" }}>
                <div><strong>1. Call &amp; describe</strong><span>“Plan lunch for 80 people on 20 June with the saved salmon and potato dishes.”</span></div>
                <div><strong>2. Spoken confirmation</strong><span>Agent reads back date, guests &amp; dishes before saving a proposal.</span></div>
                <div><strong>3. Buyer email gate</strong><span>No order is placed during the call; buyer approves from the emailed link.</span></div>
              </div>
            </details>
          )}
        </section>
      )}
    </div>
  );
}
