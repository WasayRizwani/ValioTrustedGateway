import { useCallback, useEffect, useState } from "react";
import { api } from "./api";
import { day } from "./format";

type Standing = {
  id: string;
  ingredientId: string;
  ingredientName: string;
  quantity: number;
  unit: string;
  weekday: number;
  leadTimeDays: number;
  enabled: boolean;
  nextDelivery: string;
  nextOrderOn: string;
  lastRun: { deliveryDate: string; status: string; detail: string; intentId: string | null } | null;
};
type Suggestion = {
  ingredientId: string;
  name: string;
  quantity: number;
  unit: string;
  weekday: number;
  leadTimeDays: number;
  orders: number;
  avgIntervalDays: number;
  reason: string;
};
type RunResult = { ingredient: string; deliveryDate: string; outcome: string; detail: string };

const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const fmt = day;
const OUTCOME_TAG: Record<string, string> = {
  committed: "tag best",
  pending_approval: "tag warn",
  blocked: "tag warn",
  failed: "tag warn",
};

export function Recurring(props: { onNavigate: (v: string) => void; onChanged?: () => void }) {
  const [items, setItems] = useState<Standing[]>([]);
  const [sugg, setSugg] = useState<Suggestion[]>([]);
  const [ings, setIngs] = useState<Array<{ ingredientId: string; name: string; unit: string }>>([]);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [form, setForm] = useState({ ingredientId: "", quantity: 20, weekday: 1, leadTimeDays: 2 });

  const load = useCallback(async () => {
    try {
      const [s, i] = await Promise.all([
        api<{ standingOrders: Standing[]; suggestions: Suggestion[] }>("/v1/standing-orders"),
        api<{ inventory: Array<{ ingredientId: string; name: string; unit: string }> }>("/v1/kitchen/inventory"),
      ]);
      setItems(s.standingOrders);
      setSugg(s.suggestions);
      setIngs(i.inventory);
      setForm((f) => (f.ingredientId ? f : { ...f, ingredientId: i.inventory[0]?.ingredientId ?? "" }));
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  async function act(fn: () => Promise<unknown>, ok?: string) {
    setBusy(true);
    setErr(null);
    try {
      await fn();
      if (ok) setMsg(ok);
      props.onChanged?.();
      await load();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  const create = (b: object, ok: string) =>
    act(() => api("/v1/standing-orders", { method: "POST", body: JSON.stringify(b) }), ok);

  async function runNow(id?: string) {
    await act(async () => {
      const r = await api<{ results: RunResult[] }>("/v1/standing-orders/run", {
        method: "POST",
        body: JSON.stringify({ standingId: id, force: Boolean(id) }),
      });
      const acted = r.results.filter((x) => x.outcome !== "skipped");
      setMsg(
        acted.length
          ? acted.map((a) => `${a.ingredient} (${fmt(a.deliveryDate)}): ${a.outcome.replace("_", " ")}`).join(" · ")
          : "Nothing was due yet — orders are placed automatically at the right time before each delivery.",
      );
    });
  }

  return (
    <div className="home">
      {err && <div className="banner error">{err}</div>}
      {msg && <div className="banner ok">{msg}</div>}

      <section className="panel">
        <div className="row-between">
          <div>
            <h2>Set it once, never order it again</h2>
            <p className="muted">
              Pick what you need every week and which day it must arrive. The agent places the order automatically{" "}
              <strong>lead-time days before</strong> delivery (e.g. Monday delivery, 2-day lead → ordered Saturday). Anything over your
              mandate still waits for your approval — nothing is bought silently.
            </p>
          </div>
          <button type="button" className="btn" disabled={busy} onClick={() => void runNow()}>
            Check what's due now
          </button>
        </div>
      </section>

      {sugg.length > 0 && (
        <section className="panel">
          <h2>Spotted in your order history</h2>
          <p className="muted">These items are already ordered on a steady rhythm. Automate them in one click.</p>
          <ul className="attn">
            {sugg.map((s) => (
              <li key={s.ingredientId} className="low">
                <div className="sugg">
                  <div>
                    <strong>
                      {s.quantity}
                      {s.unit} {s.name}
                    </strong>{" "}
                    every {DAYS[s.weekday]}
                    <div className="tiny muted">
                      {s.reason} Would be ordered {s.leadTimeDays} days ahead.
                    </div>
                  </div>
                  <button
                    type="button"
                    className="btn primary"
                    disabled={busy}
                    onClick={() =>
                      void create(
                        { ingredientId: s.ingredientId, quantity: s.quantity, weekday: s.weekday, leadTimeDays: s.leadTimeDays },
                        `${s.name} is now automated`,
                      )
                    }
                  >
                    Automate
                  </button>
                </div>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="panel">
        <h2>Your recurring orders</h2>
        {items.length === 0 ? (
          <p className="empty">No recurring orders yet. Add one below or automate a suggestion above.</p>
        ) : (
          <ul className="list">
            {items.map((s) => (
              <li key={s.id} style={{ opacity: s.enabled ? 1 : 0.55 }}>
                <div className="row-between" style={{ gap: "1rem", alignItems: "flex-start" }}>
                  <div>
                    <strong>
                      {s.quantity}
                      {s.unit} {s.ingredientName}
                    </strong>{" "}
                    <span className="tag">every {DAYS[s.weekday]}</span>
                    <div className="tiny">
                      Next delivery <strong>{fmt(s.nextDelivery)}</strong> · agent orders on <strong>{fmt(s.nextOrderOn)}</strong> (
                      {s.leadTimeDays} day{s.leadTimeDays === 1 ? "" : "s"} ahead)
                    </div>
                    {s.lastRun && (
                      <div className="tiny muted">
                        <span className={OUTCOME_TAG[s.lastRun.status] ?? "tag"}>{s.lastRun.status.replace("_", " ")}</span> for{" "}
                        {fmt(s.lastRun.deliveryDate)} — {s.lastRun.detail}
                      </div>
                    )}
                  </div>
                  <div className="actions" style={{ flexWrap: "wrap", justifyContent: "flex-end" }}>
                    <label className="tiny">
                      Qty{" "}
                      <input
                        type="number"
                        style={{ width: "5rem" }}
                        defaultValue={s.quantity}
                        key={`${s.id}-${s.quantity}`}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") e.currentTarget.blur();
                        }}
                        onBlur={(e) => {
                          const v = Number(e.target.value);
                          if (v > 0 && v !== s.quantity)
                            void act(() => api(`/v1/standing-orders/${s.id}`, { method: "PUT", body: JSON.stringify({ quantity: v }) }), "Quantity updated");
                        }}
                      />
                    </label>
                    <label className="tiny">
                      Lead{" "}
                      <input
                        type="number"
                        min={0}
                        max={14}
                        style={{ width: "3.5rem" }}
                        defaultValue={s.leadTimeDays}
                        key={`${s.id}-l${s.leadTimeDays}`}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") e.currentTarget.blur();
                        }}
                        onBlur={(e) => {
                          const v = Number(e.target.value);
                          if (v !== s.leadTimeDays)
                            void act(() => api(`/v1/standing-orders/${s.id}`, { method: "PUT", body: JSON.stringify({ leadTimeDays: v }) }), "Lead time updated");
                        }}
                      />{" "}
                      d
                    </label>
                    <button
                      type="button"
                      className="btn"
                      disabled={busy}
                      onClick={() =>
                        void act(() => api(`/v1/standing-orders/${s.id}`, { method: "PUT", body: JSON.stringify({ enabled: !s.enabled }) }), s.enabled ? "Paused" : "Resumed")
                      }
                    >
                      {s.enabled ? "Pause" : "Resume"}
                    </button>
                    <button type="button" className="btn" disabled={busy} onClick={() => void runNow(s.id)}>
                      Order next delivery now
                    </button>
                    <button
                      type="button"
                      className="btn"
                      disabled={busy}
                      onClick={() => void act(() => api(`/v1/standing-orders/${s.id}`, { method: "DELETE" }), "Removed")}
                    >
                      Remove
                    </button>
                  </div>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="panel">
        <h2>Add a recurring order</h2>
        <div className="form-grid">
          <label>
            Ingredient
            <select value={form.ingredientId} onChange={(e) => setForm({ ...form, ingredientId: e.target.value })}>
              {ings.map((i) => (
                <option key={i.ingredientId} value={i.ingredientId}>
                  {i.name} ({i.unit})
                </option>
              ))}
            </select>
          </label>
          <label>
            Quantity per delivery
            <input type="number" value={form.quantity} onChange={(e) => setForm({ ...form, quantity: Number(e.target.value) })} />
          </label>
          <label>
            Must arrive every
            <select value={form.weekday} onChange={(e) => setForm({ ...form, weekday: Number(e.target.value) })}>
              {[1, 2, 3, 4, 5, 6, 0].map((d) => (
                <option key={d} value={d}>
                  {DAYS[d]}
                </option>
              ))}
            </select>
          </label>
          <label>
            Order this many days ahead
            <input type="number" min={0} max={14} value={form.leadTimeDays} onChange={(e) => setForm({ ...form, leadTimeDays: Number(e.target.value) })} />
          </label>
        </div>
        <button
          type="button"
          className="btn primary"
          style={{ marginTop: "0.7rem" }}
          disabled={busy || !form.ingredientId}
          onClick={() => void create(form, "Recurring order created")}
        >
          Create recurring order
        </button>
      </section>
    </div>
  );
}
