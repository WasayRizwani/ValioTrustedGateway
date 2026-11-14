import { ConnectMenu } from "./ConnectMenu";
import { Kitchen } from "./Kitchen";
import { Home } from "./Home";
import { Approval } from "./Approval";
import { Find } from "./Find";
import { ConnectAgent } from "./ConnectAgent";
import { AuditLog } from "./AuditLog";
import { Orders } from "./Orders";
import { Recurring } from "./Recurring";
import { money, qty as fmtQty, day } from "./format";
import { Fragment, useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import {
  api,
  getApiKey,
  setApiKey,
  type AuditEvent,
  type Intent,
  type Mandate,
  type Offer,
} from "./api";
import { AgentChat } from "./AgentChat";

type View =
  | "home"
  | "approval"
  | "mandates"
  | "orders"
  | "recurring"
  | "connect"
  | "trust"
  | "kitchen"
  | "events"
  | "discover"
  | "agent"
  | "proposal"
  | "tracking";

function Icon({ d }: { d: string }) {
  return (
    <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d={d} />
    </svg>
  );
}

export function App() {
  // Open on the Command Center & Demo Launcher so judges see the full architecture,
  // 1-click external agent scenarios, active mandate, and decision queue immediately.
  const [view, setView] = useState<View>("home");
  const [apiKey, setApiKeyState] = useState(getApiKey());
  const [customerId, setCustomerId] = useState("");
  const [role, setRole] = useState("");
  const [hotelName, setHotelName] = useState<string | null>(null);
  const [mandate, setMandate] = useState<Mandate | null>(null);
  const [pending, setPending] = useState<Intent[]>([]);
  const [orders, setOrders] = useState<Intent[]>([]);
  const [selectedIntentId, setSelectedIntentId] = useState<string | null>(null);

  const [picked, setPicked] = useState<Offer | null>(null);
  const [showClaimEnvelope, setShowClaimEnvelope] = useState(false);

  const [auditRunId, setAuditRunId] = useState("");
  const auditRunIdRef = useRef("");
  auditRunIdRef.current = auditRunId;
  const [auditEvents, setAuditEvents] = useState<AuditEvent[]>([]);
  const [auditVerify, setAuditVerify] = useState<{
    valid: boolean;
    headHash?: string;
    brokenAt?: number;
  } | null>(null);

  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const [me, p, o] = await Promise.all([
        api<{ customerId: string; role: string; hotelName?: string | null; mandate: Mandate }>("/v1/me"),
        api<{ intents: Intent[] }>("/v1/orders/pending"),
        api<{ orders: Intent[] }>("/v1/orders"),
      ]);
      setCustomerId(me.customerId);
      setRole(me.role);
      setHotelName(me.hotelName ?? null);
      setMandate((prev) => prev ?? me.mandate);
      setPending(p.intents);
      setOrders(o.orders);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    void refresh();
    const t = setInterval(() => {
      if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
      void refresh();
    }, 15000);
    return () => clearInterval(t);
  }, [refresh]);

  // Banners describe the last action — don't let them follow you around the app.
  useEffect(() => {
    setError(null);
  }, [view]);
  useEffect(() => {
    if (!message) return;
    const t = setTimeout(() => setMessage(null), 6000);
    return () => clearTimeout(t);
  }, [message]);

  const loadAudit = useCallback(async (runId: string) => {
    auditRunIdRef.current = runId;
    setAuditRunId(runId);
    try {
      const data = await api<{
        events: AuditEvent[];
        verification: { valid: boolean; headHash?: string; brokenAt?: number };
      }>(`/v1/audit/${runId}`);
      setAuditEvents(data.events);
      setAuditVerify(data.verification);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  const handleSelectRun = useCallback(
    (runId: string) => {
      if (!runId || runId === auditRunIdRef.current) return;
      void loadAudit(runId);
    },
    [loadAudit],
  );
  useEffect(() => {
    if (view !== "trust" || auditRunId || auditEvents.length > 0) return;
    const latest = orders.find((o) => o.runId);
    if (latest) {
      void loadAudit(latest.runId);
    }
  }, [view, orders, auditRunId, auditEvents.length, loadAudit]);

  const fetchDefaultOffer = useCallback(async (): Promise<Offer | null> => {
    const neededBy = new Date(Date.now() + 3 * 86400_000).toISOString().slice(0, 10);
    const res = await api<{ offers: Offer[] }>("/v1/offers/rank", {
      method: "POST",
      body: JSON.stringify({
        need: {
          productIntent: "lactose-free milk",
          quantity: 100,
          unit: "litre",
          neededBy,
          constraints: { lactoseFree: true },
        },
      }),
    });
    const offer = res.offers.find((o) => o.priceClaim) ?? res.offers[0] ?? null;
    if (offer) setPicked(offer);
    return offer;
  }, []);

  const navigateTo = useCallback(
    (next: string, runIdOrIntentId?: string) => {
      const target = next as View;
      if (target === "trust" && runIdOrIntentId) {
        setAuditRunId(runIdOrIntentId);
        void loadAudit(runIdOrIntentId);
      } else if (target === "approval") {
        setSelectedIntentId(runIdOrIntentId ?? null);
      }
      setView(target);
    },
    [loadAudit],
  );

  async function verifyChain() {
    setError(null);
    try {
      let targetRunId = auditRunId;
      if (!targetRunId) {
        const runsRes = await api<{ runs: Array<{ runId: string }> }>("/v1/audit-runs");
        targetRunId = runsRes.runs[0]?.runId ?? orders.find((o) => o.runId)?.runId ?? "";
        if (targetRunId) {
          setAuditRunId(targetRunId);
        }
      }
      if (!targetRunId) {
        setError("No audit runs recorded yet.");
        return;
      }
      const v = await api<{
        valid: boolean;
        headHash?: string;
        brokenAt?: number;
      }>(`/v1/audit/${targetRunId}/verify`, { method: "POST" });
      setAuditVerify(v);
      if (v.valid) {
        setMessage(`Tamper-evident SHA-256 chain verified · head ${v.headHash?.slice(0, 16)}…`);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  async function saveMandate() {
    if (!mandate) return;
    setBusy(true);
    try {
      const updated = await api<Mandate>("/v1/mandate", {
        method: "PUT",
        body: JSON.stringify(mandate),
      });
      setMandate(updated);
      setMessage("Purchasing mandate updated — new limits apply immediately to all external agent requests.");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function verifyTopClaim() {
    setError(null);
    try {
      let offer = picked;
      if (!offer?.priceClaim) {
        offer = await fetchDefaultOffer();
      }
      const claim = offer?.priceClaim;
      if (!claim) {
        setError("No signed claim on selected offer yet.");
        return;
      }
      const v = await api<{ valid: boolean; reason?: string }>(
        "/v1/claims/verify",
        { method: "POST", body: JSON.stringify({ claim }) },
      );
      setShowClaimEnvelope(true);
      setMessage(
        v.valid
          ? "Ed25519 price & allergen claim signature verified against gateway public key (/.well-known/jwks.json)."
          : `Claim invalid: ${v.reason}`,
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  const pageMeta: Record<View, { title: string; subtitle: string }> = {
    home: {
      title: "Command Center",
      subtitle: "Live demo scenarios, active mandate guardrails, agent boundaries & pending decisions",
    },
    approval: {
      title: "Human Approval Desk",
      subtitle: "Orders halted by your purchasing mandate awaiting buyer review & one-time override",
    },
    mandates: {
      title: "Purchasing Mandate",
      subtitle: "Deterministic spending caps, drift tolerance, and substitution rules enforced on every agent",
    },
    orders: {
      title: "Order History",
      subtitle: "Full lifecycle from signed quote & intent to two-phase commit and delivery",
    },
    recurring: {
      title: "Recurring Orders",
      subtitle: "Automated weekly deliveries scheduled ahead of lead time under your mandate",
    },
    connect: {
      title: "Connect Agent & Guardrail Lab",
      subtitle: "OpenAPI, MCP, least-privilege keys, live 403 boundary probes & Ed25519 tamper detection",
    },
    trust: {
      title: "Hash-Chained Audit Trail",
      subtitle: "Tamper-evident SHA-256 decision log and Ed25519 claim verification",
    },
    kitchen: {
      title: "Events & Kitchen",
      subtitle: "Inventory, pack-size optimization, banquet/voice event planning & recipes",
    },
    events: {
      title: "Events & Phone Planner",
      subtitle: "Backward lead-time scheduling for weddings, banquets & voice-submitted proposals",
    },
    discover: {
      title: "Compare Offers & Quote",
      subtitle: "Shortlist Valio SKUs, inspect signed facts, lock a firm quote & test mandate rules",
    },
    proposal: {
      title: "Agent Proposal",
      subtitle: "Ranked offer ready for auto-commit or human approval",
    },
    agent: {
      title: "AI Purchasing Chat",
      subtitle: "Optional conversational orchestrator — mandate & commit stay deterministic",
    },
    tracking: {
      title: "Order Tracking",
      subtitle: "Order status from intent to commit",
    },
  };

  // Five demo-focused top-level destinations
  const navItems: Array<{ id: string; label: string; views: View[]; badge?: number; icon: ReactNode }> = [
    {
      id: "home",
      label: "Command Center",
      views: ["home"],
      icon: <Icon d="M3 11l9-8 9 8M5 10v10h5v-6h4v6h5V10" />,
    },
    {
      id: "approval",
      label: "Approvals & Mandate",
      views: ["approval", "mandates", "orders", "recurring", "tracking"],
      badge: pending.length,
      icon: <Icon d="M9 11l3 3L22 4M21 12v7a2 2 0 01-2 2H5a2 2 0 01-2-2V5a2 2 0 012-2h11" />,
    },
    {
      id: "trust",
      label: "Gateway & Trust",
      views: ["trust", "connect"],
      icon: <Icon d="M12 2l8 3v6c0 5-3.4 9.4-8 11-4.6-1.6-8-6-8-11V5l8-3zM9 12l2 2 4-4" />,
    },
    {
      id: "kitchen",
      label: "Events & Kitchen",
      views: ["kitchen", "events"],
      icon: <Icon d="M6 13.9V20h12v-6.1M4 9a4 4 0 014-4 4 4 0 018 0 4 4 0 014 4 3 3 0 01-3 3H7a3 3 0 01-3-3z" />,
    },
    {
      id: "discover",
      label: "Try Agent",
      views: ["discover", "agent", "proposal"],
      icon: <Icon d="M12 3l1.8 4.7L18.5 9l-4.7 1.8L12 15.5l-1.8-4.7L5.5 9l4.7-1.3L12 3zM18 15l.9 2.1L21 18l-2.1.9L18 21l-.9-2.1L15 18l2.1-.9L18 15z" />,
    },
  ];

  const subTabs: Record<string, Array<{ view: View; label: string; badge?: number }>> = {
    approval: [
      { view: "approval", label: "Needs approval", badge: pending.length },
      { view: "mandates", label: "Purchasing mandate" },
      { view: "orders", label: "Order history" },
      { view: "recurring", label: "Recurring orders" },
    ],
    trust: [
      { view: "trust", label: "Hash-Chained Audit Trail" },
      { view: "connect", label: "Connect Agent & 403 / Tamper Lab" },
    ],
    discover: [
      { view: "discover", label: "Compare Offers & Quote" },
      { view: "agent", label: "AI Purchasing Chat" },
      ...(view === "proposal" ? [{ view: "proposal" as View, label: "Proposal" }] : []),
    ],
  };
  const activeGroup = navItems.find((n) => n.views.includes(view));

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="sidebar-brand">
          <div className="logo-mark">VA</div>
          <div>
            <p className="brand-title">Valio Aimo</p>
            <p className="brand-tag">Agent Gateway</p>
          </div>
        </div>

        <nav className="nav">
          {navItems.map((n) => (
            <button
              key={n.id}
              type="button"
              className={activeGroup?.id === n.id ? "active" : ""}
              onClick={() => setView(n.views[0])}
            >
              <span className="nav-label">
                {n.icon}
                {n.label}
              </span>
              {n.badge ? <span className="dot">{n.badge}</span> : null}
            </button>
          ))}
        </nav>

        <div className="sidebar-foot">
          <div className="sidebar-meta">
            <strong>{hotelName || customerId || "—"}</strong>
            <br />
            Mandate: max {mandate ? money(mandate.maxOrderValueEur, 0) : "—"} / order
            <br />
            <button
              type="button"
              className="sidebar-link"
              onClick={() => setView("mandates")}
            >
              Configure mandate →
            </button>
          </div>
        </div>
      </aside>

      <div className="workspace">
        <header className="topbar">
          <div className="page-heading">
            <h1>{pageMeta[view].title}</h1>
            <p title={pageMeta[view].subtitle}>{pageMeta[view].subtitle}</p>
          </div>
          <ConnectMenu
            customerId={customerId}
            role={role}
            hotelName={hotelName}
            maxOrderValueEur={mandate?.maxOrderValueEur ?? null}
            onKeyChange={(k) => {
              setApiKey(k);
              setApiKeyState(k);
              setMandate(null);
              setPicked(null);
              setAuditRunId("");
              setAuditEvents([]);
              setAuditVerify(null);
              setSelectedIntentId(null);
              setError(null);
              void refresh();
            }}
            onRefresh={() => {
              setMandate(null);
              void refresh();
            }}
            onNavigate={(v) => navigateTo(v)}
            onMessage={setMessage}
            onError={setError}
          />
        </header>

        <main className="content">
          {error && <div className="banner error">{error}</div>}
          {message && <div className="banner ok">{message}</div>}

          {activeGroup && subTabs[activeGroup.id] && (
            <div className="subtabs" role="tablist">
              {subTabs[activeGroup.id].map((t) => (
                <button
                  key={t.view}
                  type="button"
                  role="tab"
                  aria-selected={view === t.view}
                  className={view === t.view ? "active" : ""}
                  onClick={() => setView(t.view)}
                >
                  {t.label}
                  {t.badge ? <span className="dot">{t.badge}</span> : null}
                </button>
              ))}
            </div>
          )}

          <Fragment key={apiKey}>
            {view === "home" && (
              <Home
                onNavigate={(v, id) => navigateTo(v, id)}
                onChanged={() => void refresh()}
              />
            )}

            {view === "approval" && (
              <Approval
                initialIntentId={selectedIntentId}
                onNavigate={(v, id) => navigateTo(v, id)}
                onDone={(m) => {
                  setMessage(m);
                  void refresh();
                }}
                onChanged={() => void refresh()}
                onError={setError}
              />
            )}

            {view === "mandates" && mandate && (
              <div className="home">
                <section className="panel trust-stage">
                  <div className="status-hero">
                    <div className="icon">✓</div>
                    <div>
                      <h2>
                        {customerId} · Standing Purchasing Mandate
                      </h2>
                      <p>
                        Active until {day(mandate.expiresAt)} · autonomous up to {money(mandate.maxOrderValueEur, 0)} / order · max{" "}
                        {fmtQty(mandate.maxQuantity.value, mandate.maxQuantity.unit)} per order
                      </p>
                    </div>
                  </div>
                  <p className="muted tiny" style={{ marginTop: 0 }}>
                    These rules are evaluated deterministically inside the Agent Gateway on every <code>POST /v1/orders/intent</code> and re-checked on <code>POST /v1/orders/:id/commit</code>. External agents cannot edit this mandate (<code>PUT /v1/mandate</code> requires a buyer credential).
                  </p>
                  <div className="form-grid">
                    <label>
                      Max autonomous order (€)
                      <input
                        type="number"
                        value={mandate.maxOrderValueEur}
                        onChange={(e) =>
                          setMandate({
                            ...mandate,
                            maxOrderValueEur: Number(e.target.value),
                          })
                        }
                      />
                    </label>
                    <label>
                      Max quantity ({mandate.maxQuantity.unit})
                      <input
                        type="number"
                        value={mandate.maxQuantity.value}
                        onChange={(e) =>
                          setMandate({
                            ...mandate,
                            maxQuantity: {
                              ...mandate.maxQuantity,
                              value: Number(e.target.value),
                            },
                            maxQuantities: {
                              ...(mandate.maxQuantities ?? {}),
                              [mandate.maxQuantity.unit]: Number(e.target.value),
                            },
                          })
                        }
                      />
                    </label>
                    <label>
                      Daily spend cap (€)
                      <input
                        type="number"
                        placeholder="No daily cap"
                        value={mandate.maxDailySpendEur ?? ""}
                        onChange={(e) =>
                          setMandate({
                            ...mandate,
                            maxDailySpendEur: e.target.value === "" ? undefined : Number(e.target.value),
                          })
                        }
                      />
                    </label>
                    <label>
                      Price drift tolerance on commit (%)
                      <input
                        type="number"
                        min={0}
                        max={50}
                        value={mandate.priceDriftTolerancePct ?? 2}
                        onChange={(e) =>
                          setMandate({
                            ...mandate,
                            priceDriftTolerancePct: Number(e.target.value),
                          })
                        }
                      />
                    </label>
                    <label className="full check-row">
                      <input
                        type="checkbox"
                        checked={mandate.allowedSubstitutions}
                        onChange={(e) =>
                          setMandate({
                            ...mandate,
                            allowedSubstitutions: e.target.checked,
                          })
                        }
                      />
                      <span>Allow product substitutions without human approval</span>
                    </label>
                    <label className="full check-row">
                      <input
                        type="checkbox"
                        checked={mandate.autoPurchaseIf.reliabilityUnknownOk}
                        onChange={(e) =>
                          setMandate({
                            ...mandate,
                            autoPurchaseIf: {
                              ...mandate.autoPurchaseIf,
                              reliabilityUnknownOk: e.target.checked,
                            },
                          })
                        }
                      />
                      <span>Allow autonomous orders when delivery reliability history is unknown</span>
                    </label>
                  </div>
                  <div className="chips-inline" style={{ marginBottom: "0.85rem" }}>
                    {mandate.allowedCategories.map((c) => (
                      <span key={c} className="fact ok">Allowed category: {c}</span>
                    ))}
                    {mandate.allergenRestrictions.map((a) => (
                      <span key={a} className="fact warn">Dietary rule: {a}</span>
                    ))}
                  </div>
                  <div className="actions">
                    <button
                      type="button"
                      className="btn primary"
                      disabled={busy}
                      onClick={() => void saveMandate()}
                    >
                      {busy ? "Saving…" : "Save purchasing mandate"}
                    </button>
                    <button
                      type="button"
                      className="btn"
                      onClick={() => navigateTo("approval")}
                    >
                      Back to Approval Queue ({pending.length})
                    </button>
                  </div>
                </section>
              </div>
            )}

            {(view === "orders" || view === "tracking") && (
              <Orders
                onNavigate={(v, id) => navigateTo(v, id)}
                onChanged={() => void refresh()}
              />
            )}

            {view === "recurring" && (
              <Recurring
                onNavigate={(v) => navigateTo(v)}
                onChanged={() => void refresh()}
              />
            )}

            {view === "connect" && <ConnectAgent />}

            {view === "trust" && (
              <div className="home">
                <section className="panel trust-stage">
                  <div className="row-between" style={{ flexWrap: "wrap", gap: "0.75rem" }}>
                    <div>
                      <span className="eyebrow">Cryptographic Audit &amp; Claim Integrity</span>
                      <h2 style={{ margin: 0 }}>
                        {auditVerify?.valid
                          ? "✓ Tamper-Evident SHA-256 Chain Verified"
                          : "Verify Hash-Chained Audit & Ed25519 Claims"}
                      </h2>
                      <p className="muted tiny" style={{ margin: "0.25rem 0 0" }}>
                        {auditVerify?.valid
                          ? `Chain intact · head hash ${auditVerify.headHash?.slice(0, 16)}… (${auditEvents.length} event${auditEvents.length === 1 ? "" : "s"} in selected run)`
                          : "Every agent decision, quote, commit, and 403 refusal is linked to the previous event's SHA-256 hash."}
                      </p>
                    </div>
                    <div className="actions">
                      <button
                        type="button"
                        className="btn primary"
                        onClick={() => void verifyChain()}
                      >
                        Verify SHA-256 audit chain
                      </button>
                      <button
                        type="button"
                        className="btn"
                        onClick={() => void verifyTopClaim()}
                      >
                        Verify live Ed25519 price claim
                      </button>
                      <button
                        type="button"
                        className="btn"
                        onClick={() => setView("connect")}
                      >
                        Open 403 &amp; Tamper Lab →
                      </button>
                    </div>
                  </div>
                  {showClaimEnvelope && picked?.priceClaim && (
                    <details open style={{ marginTop: "0.75rem" }}>
                      <summary className="tiny" style={{ cursor: "pointer", fontWeight: 600, color: "var(--accent-ink)" }}>
                        Signed Ed25519 Price Claim Envelope ({picked.productName})
                      </summary>
                      <pre className="claim-pre" style={{ marginTop: "0.4rem", maxHeight: "220px" }}>
                        {JSON.stringify(picked.priceClaim, null, 2)}
                      </pre>
                    </details>
                  )}
                </section>

                <AuditLog
                  initialRunId={auditRunId || undefined}
                  selectedRunId={auditRunId || undefined}
                  onSelectRun={handleSelectRun}
                />
              </div>
            )}

            {(view === "kitchen" || view === "events") && (
              <Kitchen
                initialTab={view === "events" ? "events" : undefined}
                onTabChange={(t) => {
                  if (view === "events" && t !== "events") setView("kitchen");
                  else if (view === "kitchen" && t === "events") setView("events");
                }}
                onNavigate={(v, id) => navigateTo(v, id)}
                onChanged={() => {
                  setMandate(null);
                  void refresh();
                }}
                onMessage={(m) => setMessage(m)}
                onError={setError}
              />
            )}

            {(view === "discover" || view === "proposal") && (
              <Find
                onNavigate={(v, id) => navigateTo(v, id)}
                onChanged={() => void refresh()}
                onMessage={(m) => setMessage(m)}
                onPickOffer={setPicked}
              />
            )}

            {view === "agent" && (
              <AgentChat onNavigate={(v) => navigateTo(v)} onChanged={() => void refresh()} />
            )}
          </Fragment>
        </main>
      </div>
    </div>
  );
}
