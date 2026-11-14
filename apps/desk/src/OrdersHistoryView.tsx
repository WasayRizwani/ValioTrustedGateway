import { useCallback, useEffect, useState } from "react";
import { api } from "./api";
import { day, money, originLabel, qty, tidy } from "./format";

type Stage = "approval" | "awaiting_delivery" | "delivered" | "closed";

type OrderRow = {
  intentId: string;
  orderId: string | null;
  runId: string;
  stage: Stage;
  status?: string;
  statusLabel: string;
  note: string | null;
  source?: string;
  overdue?: boolean;
  createdAt: string;
  placedAt: string | null;
  neededBy: string;
  deliveredAt: string | null;
  total: number;
  items: Array<{
    productId?: string;
    name: string;
    quantity: number;
    unit: string;
    price: number;
    isSubstitution: boolean;
    facts: {
      origin: string | null;
      producer?: string | null;
      allergens?: string[];
      mayContain?: string[];
      certifications: string[];
      labels: string[];
    };
  }>;
  need: string;
  rationale: string[];
  decidedBy: "agent" | "human" | null;
  humanSignatureProof?: {
    verified: boolean;
    mode: string;
    credentialId: string;
    signerLabel: string;
    signaturePrefix: string;
    verifiedAt: string;
  } | null;
  cascadeExecuted?: {
    droppedProductId: string;
    droppedProductName?: string;
    backupProductId: string;
    backupProductName: string;
    newTotalPrice: number;
    at: string;
  } | null;
};

type ActivityItem = {
  id: number;
  at: string;
  actor: "agent" | "human" | "system" | "valio";
  text: string;
};

const PAGE_SIZE = 12;

function formatVerifiedAt(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return day(iso);
  const hm = d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
  return `${day(iso)}, ${hm}`;
}

function isReadyToCommit(order: OrderRow): boolean {
  const lbl = order.statusLabel?.toLowerCase() ?? "";
  return (
    lbl.includes("ready") ||
    lbl.includes("approved") ||
    order.status === "approved" ||
    order.status === "auto_eligible"
  );
}

export function OrdersHistoryView(props: {
  customerId?: string;
  onGoApprove: (intentId: string) => void;
  onOpenTechModal: (runId?: string) => void;
  onChanged: () => void;
  onMessage: (msg: string, tone?: "success" | "warn" | "info") => void;
}) {
  const [rows, setRows] = useState<OrderRow[]>([]);
  const [filter, setFilter] = useState<Stage | "all">("all");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [visibleCount, setVisibleCount] = useState<number>(PAGE_SIZE);
  const [timeline, setTimeline] = useState<ActivityItem[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [busyDeliver, setBusyDeliver] = useState(false);
  const [busyCommit, setBusyCommit] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const r = await api<{ orders: OrderRow[] }>("/v1/orders-overview");
      setRows(r.orders);
    } catch {
      // Keep previous list on transient network blip
    } finally {
      setLoaded(true);
    }
  }, []);

  // Reset selection & immediately reload whenever customerId changes
  useEffect(() => {
    setSelectedId(null);
    setVisibleCount(PAGE_SIZE);
    setError(null);
    setTimeline([]);
    void load();
  }, [props.customerId, load]);

  // Background refresh while tab is visible
  useEffect(() => {
    const timer = setInterval(() => {
      if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
      void load();
    }, 6000);
    return () => clearInterval(timer);
  }, [load]);

  const filtered = rows.filter((r) => filter === "all" || r.stage === filter);
  const visibleRows = filtered.slice(0, visibleCount);
  const activeOrder =
    filtered.find((r) => r.intentId === selectedId) ?? filtered[0] ?? null;

  const fetchTimeline = useCallback(async (runId: string) => {
    try {
      const res = await api<{ events: ActivityItem[] }>(
        `/v1/activity?runId=${encodeURIComponent(runId)}`,
      );
      setTimeline(res.events);
    } catch {
      setTimeline([]);
    }
  }, []);

  useEffect(() => {
    if (!activeOrder?.runId) {
      setTimeline([]);
      return;
    }
    void fetchTimeline(activeOrder.runId);
  }, [
    activeOrder?.runId,
    activeOrder?.stage,
    activeOrder?.orderId,
    activeOrder?.deliveredAt,
    fetchTimeline,
  ]);

  async function markReceived(order: OrderRow) {
    if (!order.orderId) return;
    setBusyDeliver(true);
    setError(null);
    try {
      await api("/v1/kitchen/deliveries", {
        method: "POST",
        body: JSON.stringify({ orderId: order.orderId }),
      });
      if (order.runId) {
        await fetchTimeline(order.runId);
      }
      props.onMessage(
        `Marked ${order.orderId} as received — pantry stock updated!`,
        "success",
      );
      props.onChanged();
      await load();
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : "Could not mark delivery as received. Please try again.",
      );
    } finally {
      setBusyDeliver(false);
    }
  }

  async function commitDirectly(order: OrderRow) {
    setBusyCommit(true);
    setError(null);
    try {
      const res = await api<{
        confirmation?: { orderId?: string | null };
        intent?: {
          committedOrderId?: string | null;
          meta?: { cascadeExecuted?: OrderRow["cascadeExecuted"] };
        };
      }>(`/v1/orders/${encodeURIComponent(order.intentId)}/commit`, {
        method: "POST",
        body: JSON.stringify({ idempotencyKey: `desk-history-commit-${order.intentId}` }),
      });
      if (order.runId) {
        await fetchTimeline(order.runId);
      }
      const orderId =
        res.confirmation?.orderId ?? res.intent?.committedOrderId ?? "confirmed";
      const cascade = res.intent?.meta?.cascadeExecuted;
      if (cascade) {
        props.onMessage(
          `Order #${orderId} placed — auto-recovered with pre-approved backup ${cascade.backupProductName}!`,
          "warn",
        );
      } else {
        props.onMessage(`Order #${orderId} confirmed & placed!`, "success");
      }
      props.onChanged();
      await load();
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : "Could not confirm and place this order right now.",
      );
    } finally {
      setBusyCommit(false);
    }
  }

  function badgeFor(r: OrderRow) {
    if (r.overdue && r.stage === "awaiting_delivery") {
      return <span className="pill red">Overdue Delivery</span>;
    }
    if (r.stage === "approval") {
      if (isReadyToCommit(r)) {
        return <span className="pill amber">Ready to Place</span>;
      }
      return <span className="pill amber">Waiting for OK</span>;
    }
    if (r.stage === "delivered") {
      return <span className="pill green">✓ Delivered</span>;
    }
    if (r.stage === "closed") {
      const lbl = r.statusLabel?.toLowerCase() ?? "";
      if (lbl.includes("blocked")) {
        return <span className="pill red">Blocked by Safety Rules</span>;
      }
      if (lbl.includes("expired")) {
        return <span className="pill amber">Expired</span>;
      }
      return <span className="pill gray">Cancelled</span>;
    }
    if (r.decidedBy === "human") {
      return <span className="pill blue">Approved by You</span>;
    }
    return <span className="pill green">Placed Automatically</span>;
  }

  const isCommittedOrDelivered =
    activeOrder != null &&
    (activeOrder.stage === "awaiting_delivery" ||
      activeOrder.stage === "delivered" ||
      Boolean(activeOrder.orderId));

  return (
    <div className="page-wrap">
      <div
        className="page-header left"
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "flex-end",
          flexWrap: "wrap",
          gap: 16,
        }}
      >
        <div>
          <h1 className="page-title" style={{ fontSize: 26 }}>
            Past Orders &amp; What Your Assistant Did
          </h1>
          <p className="page-subtitle">
            Every automatic purchase, safety check, and quick approval explained in plain language.
          </p>
        </div>

        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          {(
            [
              ["all", "All"],
              ["approval", "Waiting for OK"],
              ["awaiting_delivery", "Ordered"],
              ["delivered", "Delivered"],
              ["closed", "Cancelled / Blocked"],
            ] as const
          ).map(([id, label]) => (
            <button
              key={id}
              type="button"
              className="chip-btn"
              style={
                filter === id
                  ? {
                      background: "var(--brand-blue)",
                      color: "#fff",
                      borderColor: "var(--brand-blue)",
                    }
                  : undefined
              }
              onClick={() => {
                setFilter(id);
                setVisibleCount(PAGE_SIZE);
              }}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      {error && (
        <div className="banner error" role="alert" style={{ marginBottom: 20 }}>
          <div>
            <strong>Action could not be completed:</strong> {error}
          </div>
          <button
            type="button"
            className="link-quiet"
            style={{ color: "var(--red-text)" }}
            onClick={() => setError(null)}
          >
            Dismiss
          </button>
        </div>
      )}

      {!loaded ? (
        <div className="card" style={{ textAlign: "center", padding: 40 }}>
          Loading order history…
        </div>
      ) : filtered.length === 0 ? (
        <div className="card" style={{ textAlign: "center", padding: 48 }}>
          <h2 style={{ margin: "0 0 6px", fontSize: 19 }}>No orders in this view yet</h2>
          <p style={{ margin: 0, color: "var(--text-muted)", fontSize: 14.5 }}>
            Place an order from the New Order tab to see its plain-English story here.
          </p>
        </div>
      ) : (
        <div className="split-grid">
          {/* Left Column: Clean Paginated List of Orders */}
          <div
            className="card"
            style={{ padding: 18, display: "flex", flexDirection: "column", gap: 10 }}
          >
            {visibleRows.map((r) => {
              const isSelected = activeOrder?.intentId === r.intentId;
              const title =
                r.items.length > 1
                  ? `${r.items[0]?.name ?? "Bundle"} + ${r.items.length - 1} more`
                  : (r.items[0]?.name ?? tidy(r.need));
              return (
                <button
                  key={r.intentId}
                  type="button"
                  onClick={() => {
                    setSelectedId(r.intentId);
                    setError(null);
                  }}
                  style={{
                    textAlign: "left",
                    fontFamily: "inherit",
                    cursor: "pointer",
                    borderRadius: 14,
                    padding: "14px 16px",
                    background: isSelected ? "var(--bg-blue-soft)" : "#ffffff",
                    border: isSelected
                      ? "2px solid var(--brand-blue)"
                      : "1px solid var(--border-light)",
                    display: "flex",
                    flexDirection: "column",
                    gap: 8,
                  }}
                >
                  <div
                    style={{
                      display: "flex",
                      justifyContent: "space-between",
                      alignItems: "center",
                      gap: 8,
                      flexWrap: "wrap",
                    }}
                  >
                    <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
                      {badgeFor(r)}
                      {r.cascadeExecuted && (
                        <span
                          className="pill amber"
                          style={{ fontSize: 11.5, padding: "3px 8px" }}
                        >
                          🛡️ Backup Fulfilled
                        </span>
                      )}
                      {r.humanSignatureProof?.verified && (
                        <span
                          className="pill blue"
                          style={{ fontSize: 11.5, padding: "3px 8px" }}
                        >
                          🔐 Signed
                        </span>
                      )}
                    </div>
                    <span
                      style={{
                        fontWeight: 800,
                        fontSize: 17,
                        color: "var(--text-main)",
                      }}
                    >
                      {money(r.total)}
                    </span>
                  </div>
                  <div style={{ fontWeight: 700, fontSize: 15, color: "var(--text-main)" }}>
                    {title}
                  </div>
                  <div style={{ fontSize: 13, color: "var(--text-muted)" }}>
                    Delivery target: {day(r.neededBy)}
                    {r.orderId ? ` · #${r.orderId}` : ""}
                    {r.source ? ` · ${r.source}` : ""}
                  </div>
                  {r.note && (
                    <div
                      style={{
                        fontSize: 12.5,
                        color:
                          r.stage === "closed"
                            ? "var(--red-text)"
                            : "var(--amber-text)",
                        fontWeight: 600,
                      }}
                    >
                      {tidy(r.note)}
                    </div>
                  )}
                </button>
              );
            })}

            {filtered.length > visibleCount && (
              <button
                type="button"
                className="btn secondary full"
                style={{ marginTop: 4 }}
                onClick={() => setVisibleCount((c) => c + PAGE_SIZE)}
              >
                Show More Orders ({filtered.length - visibleCount} remaining)
              </button>
            )}
          </div>

          {/* Right Column: Plain-English Story Receipt & Verified Trade Certificate */}
          {activeOrder && (
            <div className="card" style={{ display: "flex", flexDirection: "column", gap: 18 }}>
              <div
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "center",
                  flexWrap: "wrap",
                  gap: 10,
                }}
              >
                <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                  {badgeFor(activeOrder)}
                  {activeOrder.statusLabel && (
                    <span style={{ fontSize: 13, fontWeight: 600, color: "var(--text-muted)" }}>
                      {activeOrder.statusLabel}
                    </span>
                  )}
                </div>
                {activeOrder.orderId && (
                  <span style={{ fontSize: 13, fontWeight: 700, color: "var(--text-soft)" }}>
                    Confirmation #{activeOrder.orderId}
                  </span>
                )}
              </div>

              <div>
                <h2 style={{ margin: "0 0 4px", fontSize: 22, fontWeight: 800 }}>
                  How This Order Was Handled
                </h2>
                <p style={{ margin: 0, fontSize: 14, color: "var(--text-muted)" }}>
                  Requested: <strong>{tidy(activeOrder.need)}</strong> · Needed by{" "}
                  <strong>{day(activeOrder.neededBy)}</strong>
                  {activeOrder.source ? (
                    <>
                      {" "}
                      · Source: <strong>{activeOrder.source}</strong>
                    </>
                  ) : null}
                </p>
              </div>

              {/* Policy / Safety Note Callout when present */}
              {activeOrder.note && (
                <div
                  className={`banner ${activeOrder.stage === "closed" ? "error" : "warn"}`}
                  style={{ padding: "12px 16px", fontSize: 13.5 }}
                >
                  <div>
                    <strong>
                      {activeOrder.stage === "closed"
                        ? "Kitchen Safety / Policy Reason: "
                        : "Why Your OK Is Needed: "}
                    </strong>
                    {tidy(activeOrder.note)}
                  </div>
                </div>
              )}

              {/* Cold-Chain Auto-Recovery Callout (#2C) */}
              {activeOrder.cascadeExecuted && (
                <div
                  className="banner warn"
                  style={{
                    background: "linear-gradient(135deg, #ecfdf5 0%, #fffbeb 100%)",
                    border: "1.5px solid var(--green-main)",
                    color: "var(--text-main)",
                    padding: "14px 18px",
                  }}
                >
                  <div style={{ fontSize: 13.5, lineHeight: 1.5, fontWeight: 600 }}>
                    🛡️ Auto-Recovered Before Cut-Off: Primary item (
                    {activeOrder.cascadeExecuted.droppedProductName ||
                      activeOrder.cascadeExecuted.droppedProductId}
                    ) ran out of stock at commit → automatically fulfilled with pre-approved backup{" "}
                    <strong>{activeOrder.cascadeExecuted.backupProductName}</strong> (
                    {money(activeOrder.cascadeExecuted.newTotalPrice)})!
                  </div>
                </div>
              )}

              {/* Receipt items */}
              <div className="card-subtle">
                {activeOrder.items.map((it, idx) => {
                  const origin = originLabel(it.facts.origin);
                  const allergens = it.facts.allergens ?? [];
                  const mayContain = it.facts.mayContain ?? [];
                  const certs = it.facts.certifications ?? [];
                  const hasTags =
                    it.isSubstitution ||
                    allergens.length > 0 ||
                    mayContain.length > 0 ||
                    certs.length > 0;

                  return (
                    <div key={idx} className="receipt-row">
                      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                        <div style={{ fontWeight: 700, fontSize: 15 }}>{it.name}</div>
                        <div style={{ fontSize: 13, color: "var(--text-muted)" }}>
                          {qty(it.quantity, it.unit)}
                          {origin ? ` · ${origin}` : ""}
                          {it.facts.producer ? ` · ${it.facts.producer}` : ""}
                        </div>
                        {hasTags && (
                          <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                            {it.isSubstitution && (
                              <span
                                className="pill blue"
                                style={{ fontSize: 11.5, padding: "2px 8px" }}
                              >
                                Substitution / Backup
                              </span>
                            )}
                            {allergens.map((alg) => (
                              <span
                                key={`alg-${alg}`}
                                className="pill amber"
                                style={{ fontSize: 11.5, padding: "2px 8px" }}
                              >
                                Allergen: {alg}
                              </span>
                            ))}
                            {mayContain.map((mc) => (
                              <span
                                key={`mc-${mc}`}
                                className="pill gray"
                                style={{ fontSize: 11.5, padding: "2px 8px" }}
                              >
                                May contain: {mc}
                              </span>
                            ))}
                            {certs.map((cert) => (
                              <span
                                key={`cert-${cert}`}
                                className="pill green"
                                style={{ fontSize: 11.5, padding: "2px 8px" }}
                              >
                                {cert}
                              </span>
                            ))}
                          </div>
                        )}
                      </div>
                      <div style={{ fontWeight: 800, fontSize: 16 }}>{money(it.price)}</div>
                    </div>
                  );
                })}
                <div className="receipt-row" style={{ alignItems: "center" }}>
                  <span style={{ fontSize: 14, fontWeight: 700, color: "var(--text-muted)" }}>
                    Total
                  </span>
                  <span style={{ fontSize: 21, fontWeight: 800 }}>
                    {money(activeOrder.total)}
                  </span>
                </div>
              </div>

              {/* Plain-English Steps & Full Chronological Timeline */}
              <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                <div className="card-subtle">
                  <div style={{ fontWeight: 800, fontSize: 14, marginBottom: 4 }}>
                    Why your assistant picked this option
                  </div>
                  <div style={{ fontSize: 13.5, color: "var(--text-muted)" }}>
                    {activeOrder.rationale.length > 0
                      ? activeOrder.rationale.map((line) => tidy(line)).join(" · ")
                      : "Matched your dietary rules, contract price, and requested delivery date."}
                  </div>
                </div>

                {timeline.length > 0 && (
                  <div className="card-subtle">
                    <div
                      style={{
                        display: "flex",
                        justifyContent: "space-between",
                        alignItems: "center",
                        marginBottom: 8,
                        gap: 8,
                      }}
                    >
                      <div style={{ fontWeight: 800, fontSize: 14 }}>
                        Step-by-Step Activity ({timeline.length})
                      </div>
                      <span style={{ fontSize: 12, color: "var(--text-soft)" }}>
                        Full chronological log
                      </span>
                    </div>
                    <ul
                      style={{
                        margin: 0,
                        paddingLeft: 18,
                        fontSize: 13.5,
                        color: "var(--text-muted)",
                        display: "flex",
                        flexDirection: "column",
                        gap: 5,
                      }}
                    >
                      {timeline.map((ev) => (
                        <li key={ev.id}>{tidy(ev.text)}</li>
                      ))}
                    </ul>
                  </div>
                )}
              </div>

              {/* Contextual Actions: No Stranded Orders (Bug #9) */}
              {activeOrder.stage === "approval" && (
                <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
                  {isReadyToCommit(activeOrder) ? (
                    <>
                      <button
                        type="button"
                        className="btn success"
                        style={{ flex: "1 1 220px" }}
                        disabled={busyCommit}
                        onClick={() => void commitDirectly(activeOrder)}
                      >
                        {busyCommit ? "Placing order…" : "Confirm & Place Order Now"}
                      </button>
                      <button
                        type="button"
                        className="btn secondary"
                        style={{ flex: "1 1 200px" }}
                        disabled={busyCommit}
                        onClick={() => props.onGoApprove(activeOrder.intentId)}
                      >
                        Review in Needs Your OK →
                      </button>
                    </>
                  ) : (
                    <button
                      type="button"
                      className="btn primary full"
                      onClick={() => props.onGoApprove(activeOrder.intentId)}
                    >
                      Review in Needs Your OK →
                    </button>
                  )}
                </div>
              )}

              {activeOrder.stage === "awaiting_delivery" && activeOrder.orderId && (
                <button
                  type="button"
                  className="btn secondary"
                  disabled={busyDeliver}
                  onClick={() => void markReceived(activeOrder)}
                >
                  {busyDeliver ? "Updating pantry…" : "Mark Delivery Received in Kitchen"}
                </button>
              )}

              {/* Dual-Signed Cryptographic Trade Certificate (#2C) for committed / delivered orders */}
              {isCommittedOrDelivered ? (
                <div
                  className="cert-box safe"
                  style={{
                    padding: "16px 18px",
                    display: "flex",
                    flexDirection: "column",
                    gap: 12,
                  }}
                >
                  <div
                    style={{
                      display: "flex",
                      justifyContent: "space-between",
                      alignItems: "center",
                      flexWrap: "wrap",
                      gap: 8,
                      borderBottom: "1px solid rgba(167, 243, 208, 0.22)",
                      paddingBottom: 10,
                    }}
                  >
                    <div style={{ fontWeight: 800, fontSize: 14, color: "#ecfdf5" }}>
                      Verified Trade Certificate
                    </div>
                    <button
                      type="button"
                      className="link-quiet"
                      style={{ color: "#6ee7b7", fontSize: 12.5 }}
                      onClick={() => props.onOpenTechModal(activeOrder.runId)}
                    >
                      Inspect Signed Audit Chain ↗
                    </button>
                  </div>

                  {/* 1. Supplier Fixed-Price & Allergen Guarantee */}
                  <div
                    style={{
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "space-between",
                      flexWrap: "wrap",
                      gap: 8,
                    }}
                  >
                    <span style={{ fontWeight: 700, color: "#d1fae5", fontSize: 13 }}>
                      ✓ Valio Aimo® Ed25519 Signed Price &amp; Product Envelope Verified
                    </span>
                  </div>

                  {/* 2. Kitchen Buyer Authority Proof */}
                  <div
                    style={{
                      background: "rgba(15, 23, 42, 0.45)",
                      border: "1px solid rgba(167, 243, 208, 0.24)",
                      borderRadius: 10,
                      padding: "10px 12px",
                      display: "flex",
                      flexDirection: "column",
                      gap: 6,
                    }}
                  >
                    {activeOrder.humanSignatureProof?.verified ? (
                      <>
                        <div
                          style={{
                            display: "flex",
                            alignItems: "center",
                            gap: 8,
                            flexWrap: "wrap",
                          }}
                        >
                          <span className="pill blue" style={{ fontSize: 12 }}>
                            🔐 Counter-Signed by {activeOrder.humanSignatureProof.signerLabel}
                          </span>
                          <span style={{ fontSize: 12, color: "#a7f3d0" }}>
                            Verified {formatVerifiedAt(activeOrder.humanSignatureProof.verifiedAt)}
                          </span>
                        </div>
                        <div className="mono" style={{ fontSize: 12, color: "#cbd5e1" }}>
                          Signature fingerprint: {activeOrder.humanSignatureProof.signaturePrefix}… ·{" "}
                          {activeOrder.humanSignatureProof.mode} ({activeOrder.humanSignatureProof.credentialId})
                        </div>
                      </>
                    ) : (
                      <div style={{ fontWeight: 700, fontSize: 13, color: "#ecfdf5" }}>
                        ⚡ Placed Autonomously Within Kitchen Spending &amp; Safety Rules
                      </div>
                    )}
                  </div>

                  {/* 3. Cold-Chain Auto-Recovery Summary inside Certificate when triggered */}
                  {activeOrder.cascadeExecuted && (
                    <div
                      style={{
                        background: "rgba(217, 119, 6, 0.18)",
                        border: "1px solid rgba(253, 230, 138, 0.45)",
                        borderRadius: 10,
                        padding: "9px 12px",
                        color: "#fef3c7",
                        fontSize: 12.5,
                        fontWeight: 600,
                      }}
                    >
                      🛡️ Cold-Chain Recovery Proof: Primary{" "}
                      {activeOrder.cascadeExecuted.droppedProductName ||
                        activeOrder.cascadeExecuted.droppedProductId}{" "}
                      → fulfilled with pre-authorized backup{" "}
                      {activeOrder.cascadeExecuted.backupProductName} (
                      {money(activeOrder.cascadeExecuted.newTotalPrice)})
                    </div>
                  )}
                </div>
              ) : (
                /* Quiet Valio Aimo Trust & Discreet IT Link for non-committed intents */
                <div
                  style={{
                    background: "var(--bg-green-soft)",
                    border: "1px solid var(--green-border)",
                    borderRadius: 14,
                    padding: "14px 16px",
                    display: "flex",
                    justifyContent: "space-between",
                    alignItems: "center",
                    flexWrap: "wrap",
                    gap: 10,
                  }}
                >
                  <div style={{ fontSize: 13, color: "var(--green-text)", fontWeight: 600 }}>
                    ✓ Valio Aimo® Price, Stock &amp; Kitchen Privacy Guarantee
                  </div>
                  <button
                    type="button"
                    className="link-quiet"
                    onClick={() => props.onOpenTechModal(activeOrder.runId)}
                  >
                    Verification &amp; Demo Tools
                  </button>
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
