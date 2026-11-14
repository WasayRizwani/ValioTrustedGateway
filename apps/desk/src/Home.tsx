import { useCallback, useEffect, useRef, useState } from "react";
import { ResetNotice } from "./ResetNotice";
import { api, getApiKey, nextMonday, ruleLabel, type Intent, type Offer } from "./api";
import { money, qty, day, tidy, clip } from "./format";
import { whoLabel } from "./agents";

type ApprovalItem = { id: string; title: string; product: string; total: number; chips: string[]; createdAt: string; neededBy: string };
type Delivery = {
  orderId: string;
  summary: string;
  items?: Array<{ productName: string; quantity: number; unit: string }>;
  neededBy: string | null;
  overdue: boolean;
  total: number | null;
};
type Drift = { name: string; suggested: number; usual: number | null; unit: string; pct: number | null };
type StockRow = { name: string; onHand: number; onOrder: number; par: number; unit: string; urgency: string; suggested: number; drift: boolean; target?: number };
type Overview = {
  lastReset?: { id: number; at: string; removedIntents: number; source: string | null } | null;
  hotelName: string;
  mandate: { maxOrderValueEur: number; allowedSubstitutions: boolean; expiresAt: string } | null;
  stats: { pending: number; committed: number; autoCommitted: number; humanApproved: number; spendToday: number; onOrderEur: number };
  approvals: ApprovalItem[];
  deliveries: Delivery[];
  drift: Drift[];
  stock: StockRow[];
  automation: { policy: { enabled: boolean }; lastRun: { ranAt: string; summary: string; committedCount: number; pendingApprovalCount: number } | null };
};
type Activity = { id: number; agent?: string; at: string; runId: string; actor: "agent" | "human" | "system" | "valio"; kind: "info" | "good" | "warn" | "bad"; text: string };

function ago(iso: string): string {
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return `${Math.floor(s)}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

type RosterAgent = {
  id: string;
  name: string;
  short: string;
  side: "buyer" | "valio";
  job: string;
  cannot: string[];
  actions24h: number;
  last: { text: string; at: string; runId: string } | null;
};
type Suggestion = {
  id: string;
  kind: string;
  title: string;
  body: string;
  status: string;
  deltaEur: number;
  suggestedProductName?: string;
  need?: { quantity: number; unit: string; productIntent: string };
};

type DemoOutcome = {
  tone: "good" | "warn" | "info";
  title: string;
  subtitle: string;
  steps: string[];
  primaryAction?: { label: string; view: string; id?: string };
  secondaryAction?: { label: string; view: string; id?: string };
};

const AGENT_CARD_SUMMARY: Record<string, { role: string; boundary: string }> = {
  sourcing: { role: "Finds & ranks shortlisted Valio offers", boundary: "Cannot place orders" },
  planner: { role: "Computes recipe & event demand", boundary: "Cannot spend or order" },
  procurement: { role: "Quotes & commits inside mandate", boundary: "Cannot approve overrides" },
  "valio-account": { role: "Flags stock-outs & price savings", boundary: "No private kitchen data" },
};

const TODO_PAGE_SIZE = 5;

function PageControls(props: { page: number; count: number; pageSize: number; label: string; onChange: (page: number) => void }) {
  const pages = Math.ceil(props.count / props.pageSize);
  if (pages < 2) return null;
  const first = props.page * props.pageSize + 1;
  const last = Math.min(props.count, first + props.pageSize - 1);
  return (
    <nav className="todo-pagination" aria-label={`${props.label} pages`}>
      <span className="tiny muted">Showing {first}–{last} of {props.count}</span>
      <div className="actions">
        <button type="button" className="btn" disabled={props.page === 0} onClick={() => props.onChange(props.page - 1)} aria-label={`Previous ${props.label.toLowerCase()} page`}>Previous</button>
        <span className="tiny muted" aria-live="polite">Page {props.page + 1} of {pages}</span>
        <button type="button" className="btn" disabled={props.page + 1 >= pages} onClick={() => props.onChange(props.page + 1)} aria-label={`Next ${props.label.toLowerCase()} page`}>Next</button>
      </div>
    </nav>
  );
}

export function Home(props: { onNavigate: (view: string, runId?: string) => void; onChanged?: () => void }) {
  const { onNavigate, onChanged } = props;
  const [overview, setOverview] = useState<Overview | null>(null);
  const [activity, setActivity] = useState<Activity[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [roster, setRoster] = useState<RosterAgent[]>([]);
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [suggestionPage, setSuggestionPage] = useState(0);
  const [deliveryPage, setDeliveryPage] = useState(0);
  const [demoBusy, setDemoBusy] = useState<string | null>(null);
  const [demoOutcome, setDemoOutcome] = useState<DemoOutcome | null>(null);
  const alive = useRef(true);

  const refresh = useCallback(async () => {
    try {
      const [o, a, r, sg] = await Promise.all([
        api<Overview>("/v1/overview"),
        api<{ events: Activity[] }>("/v1/activity?limit=18"),
        api<{ agents: RosterAgent[] }>("/v1/agents"),
        api<{ suggestions: Suggestion[] }>("/v1/suggestions"),
      ]);
      if (!alive.current) return;
      setOverview(o);
      setActivity(a.events);
      setRoster(r.agents);
      setSuggestions(sg.suggestions.filter((x) => x.status === "new"));
      setErr(null);
    } catch (e) {
      if (alive.current) setErr(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    alive.current = true;
    void refresh();
    const t = setInterval(() => {
      if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
      void refresh();
    }, 10000);
    return () => {
      alive.current = false;
      clearInterval(t);
    };
  }, [refresh]);

  async function resolveExternalAgentKey(): Promise<string> {
    try {
      const conn = await api<{ identities: Array<{ id: string; apiKey: string }> }>("/v1/connect");
      const fullAgent = conn.identities.find((i) => i.id === "full-agent" && i.apiKey && !i.apiKey.startsWith("<"));
      if (fullAgent) return fullAgent.apiKey;
      const proc = conn.identities.find((i) => i.id === "procurement" && i.apiKey && !i.apiKey.startsWith("<"));
      if (proc) return proc.apiKey;
    } catch {
      // Already using an agent key
    }
    const cur = getApiKey();
    if (cur.includes("school")) return "school_demo_key_001";
    return "hotel_demo_key_001";
  }

  async function callWithKey<T>(key: string, path: string, method = "POST", body?: unknown): Promise<{ status: number; data: T }> {
    const res = await fetch(path, {
      method,
      headers: {
        "Content-Type": "application/json",
        "X-API-Key": key,
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const json = (await res.json().catch(() => ({}))) as T;
    if (!res.ok && res.status !== 403 && res.status !== 401) {
      const msg = (json as { error?: string; message?: string })?.error ?? (json as { message?: string })?.message ?? `HTTP ${res.status}`;
      throw new Error(msg);
    }
    return { status: res.status, data: json };
  }

  async function runScenarioOrder(litres: 100 | 3000) {
    const tag = litres === 100 ? "a" : "b";
    setDemoBusy(tag);
    setErr(null);
    try {
      const agentKey = await resolveExternalAgentKey();
      const neededBy = nextMonday();
      const need = {
        productIntent: "lactose-free milk",
        quantity: litres,
        unit: "litre",
        neededBy,
        constraints: { lactoseFree: true, keywords: ["lactose-free", "milk"] },
      };

      const rankedRes = await callWithKey<{ offers: Offer[] }>(agentKey, "/v1/offers/rank", "POST", { need });
      const best = rankedRes.data.offers?.find((o) => o.canFulfil) ?? rankedRes.data.offers?.[0];
      if (!best) throw new Error("No matching offers returned from gateway.");

      const quoteRes = await callWithKey<{ quoteId: string; totalPrice: number; validUntil: string }>(
        agentKey,
        "/v1/quotes",
        "POST",
        { need, productIds: [best.productId] },
      );

      const intentRes = await callWithKey<{ intent: Intent }>(
        agentKey,
        "/v1/orders/intent",
        "POST",
        { quoteId: quoteRes.data.quoteId },
      );
      const intent = intentRes.data.intent;

      if (intent.status === "auto_eligible") {
        const commitRes = await callWithKey<{ confirmation: { orderId: string; runId: string } }>(
          agentKey,
          `/v1/orders/${intent.id}/commit`,
          "POST",
          { idempotencyKey: `demo-${tag}-${intent.id}-${Date.now()}` },
        );
        setDemoOutcome({
          tone: "good",
          title: `Autonomous Order Committed (${commitRes.data.confirmation.orderId})`,
          subtitle: `100 L lactose-free milk (${money(intent.totalPrice)}) passed the €${overview?.mandate?.maxOrderValueEur ?? 500} mandate and was committed without human intervention.`,
          steps: [
            `Shortlisted & Ranked: ${best.productName} (${best.requiredPacks} packs · ${money(best.totalPrice)}) with Ed25519 signed claim.`,
            `Firm Quote Issued: ${quoteRes.data.quoteId.slice(0, 12)}… → Mandate Verdict: auto_eligible.`,
            `Two-Phase Commit: Revalidated live price & stock → Order ${commitRes.data.confirmation.orderId}.`,
          ],
          primaryAction: { label: "Inspect Hash-Chained Audit Proof →", view: "trust", id: intent.runId },
          secondaryAction: { label: "View in Orders →", view: "orders" },
        });
      } else {
        const rules = (intent.policy.failingRules ?? []).map(ruleLabel).join(", ") || "Mandate policy";
        setDemoOutcome({
          tone: "warn",
          title: `Halted by Mandate · Queued for Human Approval (${money(intent.totalPrice)})`,
          subtitle: `3,000 L lactose-free milk breached [${rules}]. The external agent cannot self-approve or override the mandate.`,
          steps: [
            `Firm Quote Issued: ${best.productName} · ${money(intent.totalPrice)} (Quote ${quoteRes.data.quoteId.slice(0, 12)}…).`,
            `Policy Gate: Flagged ${(intent.policy.failingRules ?? []).join(", ")} → status pending_approval.`,
            `Snapshot Bound: Basket locked to ${intent.snapshotHash.slice(0, 12)}… awaiting buyer sign-off.`,
          ],
          primaryAction: { label: `Review & Approve ${money(intent.totalPrice)} Order →`, view: "approval", id: intent.id },
          secondaryAction: { label: "Inspect Audit Trail →", view: "trust", id: intent.runId },
        });
      }

      onChanged?.();
      await refresh();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setDemoBusy(null);
    }
  }

  async function runScenarioForbidden() {
    setDemoBusy("c");
    setErr(null);
    try {
      const agentKey = await resolveExternalAgentKey();
      const res = await callWithKey<{ error?: string; message?: string }>(
        agentKey,
        "/v1/orders/demo-escalation-check/approve",
        "POST",
        { snapshotHash: "forged-hash", authorizeMandateOverride: true },
      );
      onChanged?.();
      await refresh();
      const runs = await api<{ runs: Array<{ runId: string }> }>("/v1/audit-runs").catch(() => ({ runs: [] }));
      const latestRunId = runs.runs[0]?.runId;
      setDemoOutcome({
        tone: "good",
        title: `Guardrail Enforced · HTTP ${res.status} Forbidden`,
        subtitle: "The external agent tried to call POST /v1/orders/:id/approve with an override flag and was deterministically blocked.",
        steps: [
          `Attempt: POST /v1/orders/:id/approve with agent key (${agentKey.slice(0, 10)}…).`,
          `Gateway Verdict: HTTP ${res.status} — "${res.data.message ?? "Agent credentials cannot approve an order."}"`,
          `Audit Log: Appended forbidden_action to the tamper-evident SHA-256 chain.`,
        ],
        primaryAction: { label: "View Blocked Attempt in Audit Trail →", view: "trust", id: latestRunId },
        secondaryAction: { label: "Open Scope & Tamper Lab →", view: "connect" },
      });
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setDemoBusy(null);
    }
  }

  async function runScenarioStockout() {
    setDemoBusy("d");
    setErr(null);
    try {
      const o = await api<{ orders: Array<{ stage: string; items: Array<{ productId?: string; name: string }> }> }>("/v1/orders-overview");
      let pid = o.orders.find((x) => x.stage === "awaiting_delivery" || x.stage === "delivered")?.items[0]?.productId;
      if (!pid) {
        const agentKey = await resolveExternalAgentKey();
        const need = {
          productIntent: "lactose-free milk",
          quantity: 100,
          unit: "litre",
          neededBy: nextMonday(),
          constraints: { lactoseFree: true },
        };
        const intentRes = await callWithKey<{ intent: Intent }>(agentKey, "/v1/orders/intent", "POST", { need });
        if (intentRes.data.intent.status === "auto_eligible") {
          await callWithKey(agentKey, `/v1/orders/${intentRes.data.intent.id}/commit`, "POST", {
            idempotencyKey: `stockout-seed-${Date.now()}`,
          });
        }
        pid = intentRes.data.intent.basket[0]?.productId;
      }
      if (!pid) throw new Error("Could not find a product to simulate stock-out.");
      await api("/v1/admin/simulate-stockout", { method: "POST", body: JSON.stringify({ productId: pid }) });
      const r = await api<{ checked: number; created: Array<{ title: string; body: string }> }>("/v1/valio-agent/run", {
        method: "POST",
        body: "{}",
      });
      onChanged?.();
      await refresh();
      setDemoOutcome({
        tone: "warn",
        title: `Supplier Stock-out Flagged by Valio Account Agent`,
        subtitle: `Product ${pid} was marked out-of-stock. Valio's agent proposed a compatible substitute in your Decision Queue below.`,
        steps: [
          `Stock-out Simulated: SKU ${pid} marked unavailable on the mock Valio backend.`,
          `Privacy Boundary: Valio's agent checked ${r.checked} usual product(s) without access to kitchen inventory or recipes.`,
          `Substitute Queued: Requires human sign-off under your mandate before any order is placed.`,
        ],
        primaryAction: { label: "Inspect Cross-Company Scopes →", view: "connect" },
      });
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setDemoBusy(null);
    }
  }

  async function actOnSuggestion(id: string, accept: boolean) {
    try {
      await api(`/v1/suggestions/${id}/${accept ? "accept" : "dismiss"}`, { method: "POST", body: "{}" });
      onChanged?.();
      await refresh();
      if (accept) onNavigate("approval");
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  }

  const [receiving, setReceiving] = useState<string | null>(null);
  async function receive(orderId: string) {
    setReceiving(orderId);
    try {
      await api("/v1/kitchen/deliveries", { method: "POST", body: JSON.stringify({ orderId }) });
      onChanged?.();
      await refresh();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setReceiving(null);
    }
  }

  const todoCount = (overview?.approvals.length ?? 0) + (overview?.deliveries.length ?? 0) + suggestions.length;
  const deliveryCount = overview?.deliveries.length ?? 0;
  const deliveryPages = Math.ceil(deliveryCount / TODO_PAGE_SIZE);
  const safeDeliveryPage = Math.min(deliveryPage, Math.max(0, deliveryPages - 1));
  const visibleDeliveries = (overview?.deliveries ?? []).slice(safeDeliveryPage * TODO_PAGE_SIZE, (safeDeliveryPage + 1) * TODO_PAGE_SIZE);
  const suggestionPages = Math.ceil(suggestions.length / TODO_PAGE_SIZE);
  const safeSuggestionPage = Math.min(suggestionPage, Math.max(0, suggestionPages - 1));
  const visibleSuggestions = suggestions.slice(safeSuggestionPage * TODO_PAGE_SIZE, (safeSuggestionPage + 1) * TODO_PAGE_SIZE);
  const rateLimitEvents = activity.filter((e) => e.actor === "system" && e.text.startsWith("Rate limit hit:"));
  const latestRateLimit = rateLimitEvents[0];
  const retryDelay = latestRateLimit?.text.match(/retry in ([^)]+)/)?.[1];
  const displayActivity = activity.flatMap((e) => {
    if (e.actor !== "system" || !e.text.startsWith("Rate limit hit:")) return [e];
    if (e.id !== latestRateLimit?.id) return [];
    return [{ ...e, text: `API rate limit paused requests (${rateLimitEvents.length} events${retryDelay ? `; latest retry in ${retryDelay}` : ""})` }];
  });
  const st = overview?.stats;
  const autoPct = st && st.committed ? Math.round((st.autoCommitted / st.committed) * 100) : null;

  return (
    <div className="home">
      {err && <div className="banner error">{err}</div>}
      <ResetNotice reset={overview?.lastReset} hasOrders={(overview?.stats.pending ?? 0) + (overview?.stats.committed ?? 0) > 0} />

      {/* ── Row 1: 4 High-Signal KPIs (including Active Mandate Cap) ── */}
      <div className="kpis">
        <button type="button" className={`kpi ${st?.pending ? "alert" : ""}`} onClick={() => onNavigate("approval")}>
          <span className="kpi-n">{st?.pending ?? "–"}</span>
          <span className="kpi-l">Waiting for your approval</span>
          {st?.pending ? <span className="kpi-s">Review &amp; authorize override →</span> : <span className="kpi-s">All caught up</span>}
        </button>
        <button type="button" className="kpi" onClick={() => onNavigate("orders")}>
          <span className="kpi-n">{st?.committed ?? "–"}</span>
          <span className="kpi-l">Orders committed</span>
          <span className="kpi-s">{st ? `${money(st.onOrderEur)} total · View history →` : "–"}</span>
        </button>
        <div className="kpi">
          <span className="kpi-n">{autoPct == null ? "–" : `${autoPct}%`}</span>
          <span className="kpi-l">Handled autonomously</span>
          <span className="kpi-s">
            {st ? `${st.autoCommitted} auto · ${st.humanApproved} human-approved` : ""}
          </span>
        </div>
        <button type="button" className="kpi" onClick={() => onNavigate("mandates")}>
          <span className="kpi-n">{overview?.mandate ? money(overview.mandate.maxOrderValueEur, 0) : "€500"}</span>
          <span className="kpi-l">Mandate per-order limit</span>
          <span className="kpi-s">
            {overview?.mandate?.allowedSubstitutions ? "Substitutions auto-allowed" : "Substitutions need sign-off"} · Edit →
          </span>
        </button>
      </div>

      {/* ── Row 2: Compact 1-Row Demo Scenario Launcher ── */}
      <section className="panel demo-bar">
        <div className="demo-bar-head">
          <div>
            <span className="eyebrow">Interactive Demo Walkthrough</span>
            <h2 style={{ margin: 0 }}>Simulate External Agent Calls</h2>
          </div>
          <div className="demo-pills">
            <button
              type="button"
              className="demo-pill ok"
              disabled={demoBusy !== null}
              onClick={() => void runScenarioOrder(100)}
            >
              <strong>{demoBusy === "a" ? "Running 100 L…" : "▶ 1. Autonomous Order (100 L)"}</strong>
              <span>Within €{overview?.mandate?.maxOrderValueEur ?? 500} → Auto-commit</span>
            </button>

            <button
              type="button"
              className="demo-pill warn"
              disabled={demoBusy !== null}
              onClick={() => void runScenarioOrder(3000)}
            >
              <strong>{demoBusy === "b" ? "Running 3,000 L…" : "▶ 2. Over-Mandate Order (3,000 L)"}</strong>
              <span>Exceeds cap → Halts for Approval</span>
            </button>

            <button
              type="button"
              className="demo-pill shield"
              disabled={demoBusy !== null}
              onClick={() => void runScenarioForbidden()}
            >
              <strong>{demoBusy === "c" ? "Probing 403…" : "▶ 3. Agent Self-Approve Probe"}</strong>
              <span>Blocked with HTTP 403 &amp; audited</span>
            </button>

            <button
              type="button"
              className="demo-pill valio"
              disabled={demoBusy !== null}
              onClick={() => void runScenarioStockout()}
            >
              <strong>{demoBusy === "d" ? "Simulating…" : "▶ 4. Supplier Stock-out Alert"}</strong>
              <span>Valio agent proposes substitute</span>
            </button>
          </div>
        </div>

        {demoOutcome && (
          <div className={`demo-outcome ${demoOutcome.tone}`} role="status" aria-live="polite">
            <div className="row-between" style={{ alignItems: "flex-start" }}>
              <div>
                <strong>{demoOutcome.title}</strong>
                <p className="tiny" style={{ margin: "0.15rem 0 0.45rem" }}>{demoOutcome.subtitle}</p>
              </div>
              <button type="button" className="link tiny" onClick={() => setDemoOutcome(null)}>
                Dismiss
              </button>
            </div>
            <ul className="demo-steps">
              {demoOutcome.steps.map((s, idx) => (
                <li key={idx}>{s}</li>
              ))}
            </ul>
            <div className="actions" style={{ marginTop: "0.55rem" }}>
              {demoOutcome.primaryAction && (
                <button
                  type="button"
                  className="btn primary"
                  onClick={() => onNavigate(demoOutcome.primaryAction!.view, demoOutcome.primaryAction!.id)}
                >
                  {demoOutcome.primaryAction.label}
                </button>
              )}
              {demoOutcome.secondaryAction && (
                <button
                  type="button"
                  className="btn"
                  onClick={() => onNavigate(demoOutcome.secondaryAction!.view, demoOutcome.secondaryAction!.id)}
                >
                  {demoOutcome.secondaryAction.label}
                </button>
              )}
            </div>
          </div>
        )}
      </section>

      {/* ── Row 3: Main 2-Column Workspace (Decision Queue + Live Audit Stream) ── */}
      <div className="home-grid">
        <section className="panel todo">
          <div className="row-between">
            <h2>
              Action Queue {todoCount > 0 && <span className="count">{todoCount}</span>}
            </h2>
            {(overview?.approvals.length ?? 0) > 0 && (
              <button type="button" className="link tiny" onClick={() => onNavigate("approval")}>
                Open Approval Desk →
              </button>
            )}
          </div>

          {!overview && <p className="empty">Loading…</p>}
          {overview && todoCount === 0 && (
            <div className="allclear">
              <span>✓</span>
              <div>
                <strong>Nothing waiting for human sign-off</strong>
                <div className="tiny muted">
                  Click <strong>▶ 2. Over-Mandate Order (3,000 L)</strong> or <strong>▶ 4. Supplier Stock-out Alert</strong> above to trigger an escalation.
                </div>
              </div>
            </div>
          )}

          {(overview?.approvals.length ?? 0) > 0 && (
            <div className="todo-group">
              <h3>Halted by purchasing mandate</h3>
              {overview!.approvals.map((a) => (
                <div key={a.id} className="decision-row">
                  <div className="dr-main">
                    <strong>{tidy(a.title)}</strong>
                    <div className="tiny muted" title={a.product}>{tidy(clip(a.product, 58))}</div>
                    <div className="chips-inline">
                      {a.chips.map((c) => (
                        <span key={c} className="fact warn">
                          {c}
                        </span>
                      ))}
                    </div>
                  </div>
                  <div className="dr-side">
                    <strong className="mono">{money(a.total)}</strong>
                    <button type="button" className="btn primary" onClick={() => onNavigate("approval", a.id)}>
                      Review &amp; Approve
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}

          {suggestions.length > 0 && (
            <div className="todo-group">
              <h3>From Valio's account agent</h3>
              {visibleSuggestions.map((x) => (
                <div key={x.id} className="decision-row valio-row">
                  <div className="dr-main">
                    <strong>{tidy(x.title)}</strong>
                    <div className="suggestion-product">
                      {x.need && <span className="quantity-chip">{qty(x.need.quantity, x.need.unit)}</span>}
                      <strong title={x.suggestedProductName}>{tidy(x.suggestedProductName) || "Suggested alternative"}</strong>
                    </div>
                    <div className="tiny muted">{tidy(x.body)}</div>
                  </div>
                  <div className="dr-side">
                    <button type="button" className="btn" onClick={() => void actOnSuggestion(x.id, false)}>
                      Dismiss
                    </button>
                    <button type="button" className="btn primary" onClick={() => void actOnSuggestion(x.id, true)}>
                      {x.kind === "stockout_alert" ? "Use substitute" : "Switch"}
                    </button>
                  </div>
                </div>
              ))}
              <PageControls page={safeSuggestionPage} count={suggestions.length} pageSize={TODO_PAGE_SIZE} label="Suggestions" onChange={setSuggestionPage} />
            </div>
          )}

          {(overview?.deliveries.length ?? 0) > 0 && (
            <div className="todo-group">
              <h3>Deliveries on the way</h3>
              {visibleDeliveries.map((d) => (
                <div key={d.orderId} className="delivery-row">
                  <div className="dr-main">
                    {d.items?.length ? (
                      <div className="delivery-items">
                        {d.items.map((item, index) => (
                          <div key={`${item.productName}-${index}`} className="delivery-item">
                            <span className="quantity-chip">{qty(item.quantity, item.unit)}</span>
                            <strong title={item.productName}>{tidy(item.productName)}</strong>
                          </div>
                        ))}
                      </div>
                    ) : <strong>{tidy(d.summary)}</strong>}
                    <div className={`tiny ${d.overdue ? "overdue-text" : "muted"}`}>
                      {d.orderId}
                      {d.neededBy ? ` · due ${day(d.neededBy)}` : ""}
                      {d.overdue ? " · overdue" : ""}
                    </div>
                  </div>
                  <button type="button" className="btn" disabled={receiving === d.orderId} onClick={() => void receive(d.orderId)}>
                    {receiving === d.orderId ? "Saving…" : "Mark received"}
                  </button>
                </div>
              ))}
              <PageControls page={safeDeliveryPage} count={deliveryCount} pageSize={TODO_PAGE_SIZE} label="Deliveries" onChange={setDeliveryPage} />
            </div>
          )}
        </section>

        <section className="panel">
          <div className="row-between">
            <div>
              <h2>Live Multi-Agent Audit Feed</h2>
              <p className="tiny muted" style={{ margin: 0 }}>SHA-256 hash-chained quotes, commits, approvals &amp; 403 refusals</p>
            </div>
            <span className="live">
              <i /> live
            </span>
          </div>
          {!overview ? (
            <p className="empty">Loading…</p>
          ) : activity.length === 0 ? (
            <p className="empty">No activity yet. Click any demo scenario above to start.</p>
          ) : (
            <ul className="feed">
              {displayActivity.map((e) => (
                <li key={e.id} className={/^Blocked:/.test(e.text) ? "good" : e.kind}>
                  <span className={`who ${e.actor}`}>{whoLabel(e.actor, e.agent)}</span>
                  <div>
                    {tidy(e.text)}
                    <div className="tiny muted">
                      {ago(e.at)} ·{" "}
                      <button type="button" className="link" onClick={() => onNavigate("trust", e.runId)}>
                        audit proof →
                      </button>
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>

      {/* ── Row 4: Compact 4-Agent Least-Privilege Roster ── */}
      <section className="panel team">
        <div className="row-between" style={{ flexWrap: "wrap", gap: "0.6rem" }}>
          <div>
            <h2>Least-Privilege Agent Roster</h2>
            <p className="tiny muted" style={{ margin: 0 }}>
              Four scoped credentials enforced by gateway middleware on every REST &amp; MCP request.
            </p>
          </div>
          <button type="button" className="btn" onClick={() => onNavigate("connect")}>
            Test keys &amp; 403 boundary probes →
          </button>
        </div>
        <div className="team-grid">
          {roster.map((a) => (
            <div key={a.id} className={`agent-card ${a.side}`}>
              <div className="agent-head">
                <span className={`who ${a.side === "valio" ? "valio" : "agent"}`}>{a.short}</span>
                <span className="side">{a.side === "valio" ? "Valio side" : "Buyer side"}</span>
              </div>
              <div className="agent-role">{AGENT_CARD_SUMMARY[a.id]?.role ?? a.job}</div>
              <span className="agent-boundary">✗ {AGENT_CARD_SUMMARY[a.id]?.boundary ?? "Limited access"}</span>
              <div className="agent-last tiny" title={a.last?.text}>
                {a.last ? (
                  <>
                    <strong>{ago(a.last.at)}</strong>
                    <span className="agent-activity-text">{tidy(clip(a.last.text, 70))}</span>
                  </>
                ) : (
                  <span className="muted">No activity yet</span>
                )}
              </div>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}
