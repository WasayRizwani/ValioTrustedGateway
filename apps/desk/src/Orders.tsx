import { useCallback, useEffect, useMemo, useState } from "react";
import { api } from "./api";
import { money, qty, day, tidy, clip } from "./format";
import { ProductFacts } from "./ProductFacts";
import { ResetNotice, type LastReset } from "./ResetNotice";

type Stage = "approval" | "awaiting_delivery" | "delivered" | "closed";
type Row = {
  intentId: string;
  orderId: string | null;
  runId: string;
  stage: Stage;
  statusLabel: string;
  note: string | null;
  source: string;
  createdAt: string;
  placedAt: string | null;
  neededBy: string;
  deliveredAt: string | null;
  overdue: boolean;
  total: number;
  items: Array<{
    productId?: string;
    name: string;
    quantity: number;
    unit: string;
    price: number;
    isSubstitution: boolean;
    facts: { origin: string | null; producer: string | null; allergens: string[]; mayContain: string[]; certifications: string[]; labels: string[] };
  }>;
  need: string;
  rationale: string[];
  alternatives: Array<{ productName: string; deltaEur: number; note: string }>;
  decidedBy: "agent" | "human" | null;
};
type Activity = { id: number; at: string; actor: "agent" | "human" | "system" | "valio"; kind: string; text: string };

const STAGES: Array<{ id: Stage; label: string }> = [
  { id: "approval", label: "Waiting for approval" },
  { id: "awaiting_delivery", label: "Ordered · awaiting delivery" },
  { id: "delivered", label: "Delivered" },
  { id: "closed", label: "Cancelled / closed" },
];
const PAGE_SIZE = 10;
type SortBy = "status" | "newest" | "oldest" | "needed" | "largest";

const STAGE_ORDER: Record<Stage, number> = { approval: 0, awaiting_delivery: 1, delivered: 2, closed: 3 };

const time = (iso: string) =>
  new Date(iso).toLocaleString(undefined, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });

export function Orders(props: { onNavigate: (v: string, id?: string) => void; onChanged?: () => void }) {
  const [rows, setRows] = useState<Row[]>([]);
  const [counts, setCounts] = useState<Record<Stage, number>>({ approval: 0, awaiting_delivery: 0, delivered: 0, closed: 0 });
  const [stage, setStage] = useState<Stage | "all">("all");
  const [source, setSource] = useState("all");
  const [q, setQ] = useState("");
  const [sortBy, setSortBy] = useState<SortBy>("status");
  const [page, setPage] = useState(0);
  const [open, setOpen] = useState<string | null>(null);
  const [timeline, setTimeline] = useState<Activity[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [lastReset, setLastReset] = useState<LastReset | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const r = await api<{ orders: Row[]; counts: Record<Stage, number>; lastReset?: LastReset | null }>("/v1/orders-overview");
      setRows(r.orders);
      setCounts(r.counts);
      setLastReset(r.lastReset ?? null);
      setErr(null);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setLoaded(true);
    }
  }, []);

  useEffect(() => {
    void load();
    const t = setInterval(() => {
      if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
      void load();
    }, 8000);
    return () => clearInterval(t);
  }, [load]);

  async function toggle(r: Row) {
    if (open === r.intentId) return setOpen(null);
    setOpen(r.intentId);
    setTimeline([]);
    try {
      setTimeline((await api<{ events: Activity[] }>(`/v1/activity?runId=${r.runId}`)).events);
    } catch {
      /* timeline is optional */
    }
  }

  async function markDelivered(r: Row) {
    try {
      await api("/v1/kitchen/deliveries", { method: "POST", body: JSON.stringify({ orderId: r.orderId }) });
      setMsg(`${r.orderId} marked delivered — kitchen stock updated`);
      props.onChanged?.();
      void load();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  }

  const sources = useMemo(() => [...new Set(rows.map((r) => r.source))], [rows]);
  const filtered = rows.filter(
    (r) =>
      (stage === "all" || r.stage === stage) &&
      (source === "all" || r.source === source) &&
      (!q.trim() || `${r.need} ${r.orderId} ${r.items.map((i) => i.name).join(" ")}`.toLowerCase().includes(q.trim().toLowerCase())),
  );
  const sorted = [...filtered].sort((a, b) => {
    if (sortBy === "status" && STAGE_ORDER[a.stage] !== STAGE_ORDER[b.stage]) return STAGE_ORDER[a.stage] - STAGE_ORDER[b.stage];
    if (sortBy === "newest") return b.createdAt.localeCompare(a.createdAt) || a.intentId.localeCompare(b.intentId);
    if (sortBy === "oldest") return a.createdAt.localeCompare(b.createdAt) || a.intentId.localeCompare(b.intentId);
    if (sortBy === "needed") return a.neededBy.localeCompare(b.neededBy) || b.createdAt.localeCompare(a.createdAt);
    if (sortBy === "largest") return b.total - a.total || b.createdAt.localeCompare(a.createdAt);
    return b.createdAt.localeCompare(a.createdAt) || a.intentId.localeCompare(b.intentId);
  });
  const pageCount = Math.ceil(sorted.length / PAGE_SIZE);
  const safePage = Math.min(page, Math.max(0, pageCount - 1));
  const visible = sorted.slice(safePage * PAGE_SIZE, (safePage + 1) * PAGE_SIZE);
  const spend = rows.filter((r) => r.stage === "awaiting_delivery" || r.stage === "delivered").reduce((s, r) => s + r.total, 0);

  const hasActiveFilter = stage !== "all" || source !== "all" || Boolean(q.trim());

  return (
    <div className="home">
      {err && <div className="banner error">{err}</div>}
      {msg && <div className="banner ok">{msg}</div>}
      <ResetNotice reset={lastReset} hasOrders={rows.length > 0} />

      <div className="kpis">
        {STAGES.map((s) => (
          <button
            key={s.id}
            type="button"
            aria-pressed={stage === s.id}
            className={`kpi ${stage === s.id ? "selected" : ""} ${s.id === "approval" && counts.approval ? "alert" : ""}`}
            onClick={() => { setStage(stage === s.id ? "all" : s.id); setPage(0); }}
          >
            <span className="kpi-n">{counts[s.id]}</span>
            <span className="kpi-l">{s.label}</span>
            <span className="kpi-s">{stage === s.id ? "Filtered · click for all" : "Click to filter"}</span>
          </button>
        ))}
        <div className="kpi">
          <span className="kpi-n">{money(spend, 0)}</span>
          <span className="kpi-l">Ordered in total</span>
          <span className="kpi-s">placed + delivered</span>
        </div>
      </div>

      <section className="panel">
        <div className="row-between" style={{ gap: "0.6rem", flexWrap: "wrap" }}>
          <div>
            <h2>Order history</h2>
            <p className="tiny muted" style={{ margin: 0 }}>
              Demo order ledger: approvals and commits are recorded here. This prototype does not submit orders to Valio’s production web shop.
            </p>
          </div>
          <div className="actions orders-controls">
            <input aria-label="Search orders" placeholder="Search item or order ID" value={q} onChange={(e) => { setQ(e.target.value); setPage(0); }} />
            <select aria-label="Filter by source" value={source} onChange={(e) => { setSource(e.target.value); setPage(0); }}>
              <option value="all">All sources</option>
              {sources.map((s) => (
                <option key={s}>{s}</option>
              ))}
            </select>
            <select aria-label="Sort orders" value={sortBy} onChange={(e) => { setSortBy(e.target.value as SortBy); setPage(0); }}>
              <option value="status">Needs attention first</option>
              <option value="newest">Newest first</option>
              <option value="oldest">Oldest first</option>
              <option value="needed">Needed soonest</option>
              <option value="largest">Largest order</option>
            </select>
            {hasActiveFilter && (
              <button
                type="button"
                className="btn"
                onClick={() => {
                  setStage("all");
                  setSource("all");
                  setQ("");
                  setPage(0);
                }}
              >
                Clear filters
              </button>
            )}
          </div>
        </div>

        {!loaded ? (
          <p className="empty">Loading…</p>
        ) : sorted.length === 0 ? (
          <p className="empty">
            {rows.length === 0 ? "No orders yet. Ask the agent to restock, or set up a recurring order." : "No orders match these filters."}
          </p>
        ) : (
          <>
          <p className="orders-count tiny muted" aria-live="polite">Showing {safePage * PAGE_SIZE + 1}–{Math.min(sorted.length, (safePage + 1) * PAGE_SIZE)} of {sorted.length} orders</p>
          <ul className="orders">
            {visible.map((r) => (
              <li key={r.intentId}>
                <button type="button" className="orow" onClick={() => void toggle(r)}>
                  <span className={`stagebadge ${r.stage} ${r.overdue ? "overdue" : ""}`}>{r.statusLabel}</span>
                  <span className="otitle">
                    <strong>{tidy(r.need)}</strong>
                    <span className="tiny muted">
                      {r.orderId ?? "not placed"} · {r.source}
                      {r.decidedBy ? ` · ${r.decidedBy === "agent" ? "bought autonomously" : "approved by you"}` : ""}
                    </span>
                  </span>
                  <span className="odates tiny">
                    <span>Created {time(r.createdAt)}</span>
                    <span>{r.stage === "delivered" && r.deliveredAt ? `Delivered ${time(r.deliveredAt)}` : `Needed by ${day(r.neededBy)}`}</span>
                  </span>
                  <span className="oprice">{money(r.total)}</span>
                </button>

                {open === r.intentId && (
                  <div className="odetail">
                    <div className="stepper">
                      <div className="step done">Created</div>
                      <div className={r.stage === "approval" ? "step current" : "step done"}>
                        {r.decidedBy === "human" ? "Approved" : r.stage === "approval" ? "Awaiting approval" : "Cleared by mandate"}
                      </div>
                      <div className={r.orderId ? "step done" : "step"}>Ordered</div>
                      <div className={r.stage === "delivered" ? "step done" : r.stage === "awaiting_delivery" ? "step current" : "step"}>
                        Delivered
                      </div>
                    </div>
                    {r.note && (
                      <p className="tiny" style={{ color: "var(--warn)" }}>
                        {r.note}
                      </p>
                    )}
                    <table className="otable">
                      <tbody>
                        {r.items.map((i, k) => (
                          <tr key={k}>
                            <td>
                              {i.name}
                              {i.isSubstitution && <span className="tag"> substitute</span>}
                              <ProductFacts f={{ ...i.facts, signed: true }} compact />
                            </td>
                            <td>
                              {qty(i.quantity, i.unit)}
                            </td>
                            <td>{money(i.price)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                    {r.rationale.length > 0 && (
                      <>
                        <h3>Why the agent chose this</h3>
                        <ul className="rationale">
                          {r.rationale.map((x, k) => (
                            <li key={k}>{x}</li>
                          ))}
                        </ul>
                        {r.alternatives.length > 0 && (
                          <p className="tiny muted">
                            Also considered:{" "}
                            {r.alternatives.map((a) => `${clip(a.productName, 34)} (${a.deltaEur >= 0 ? "+" : "−"}${money(Math.abs(a.deltaEur))}, ${a.note})`).join(" · ")}
                          </p>
                        )}
                      </>
                    )}
                    <h3>What happened</h3>
                    <ol className="mini-timeline">
                      {timeline.map((e) => (
                        <li key={e.id} className={e.kind}>
                          <span className="tiny muted">{time(e.at)}</span> {tidy(e.text)}
                        </li>
                      ))}
                    </ol>
                    <div className="actions">
                      {r.stage === "approval" && (
                        <button type="button" className="btn primary" onClick={() => props.onNavigate("approval", r.intentId)}>
                          Review & approve
                        </button>
                      )}
                      {r.stage === "awaiting_delivery" && (
                        <button type="button" className="btn primary" onClick={() => void markDelivered(r)}>
                          Mark as delivered
                        </button>
                      )}
                      <button type="button" className="btn" onClick={() => props.onNavigate("trust", r.runId)}>
                        Full audit trail
                      </button>
                    </div>
                  </div>
                )}
              </li>
            ))}
          </ul>
          {pageCount > 1 && (
            <nav className="orders-pagination" aria-label="Order history pages">
              <span className="tiny muted">Page {safePage + 1} of {pageCount}</span>
              <div className="actions">
                <button type="button" className="btn" disabled={safePage === 0} onClick={() => setPage(safePage - 1)}>Previous</button>
                <button type="button" className="btn" disabled={safePage + 1 >= pageCount} onClick={() => setPage(safePage + 1)}>Next</button>
              </div>
            </nav>
          )}
          </>
        )}
      </section>
    </div>
  );
}
