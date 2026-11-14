import { useCallback, useEffect, useState } from "react";
import {
  api,
  timeAgoShort,
  type InventorySyncStatus,
  type Mandate,
  type RestockAutomationBundle,
  type RestockAutomationPolicy,
  type RestockRunResult,
  type StockHealthSnapshot,
} from "./api";
import { money, qty, tidy } from "./format";

type SyncRunResponse = {
  syncStatus: InventorySyncStatus;
  stockHealth: StockHealthSnapshot | null;
  restockResult: RestockRunResult | null;
  policy: RestockAutomationPolicy;
};

export function InventorySyncGuardCard(props: {
  variant: "compact" | "full";
  customerId?: string;
  mandate?: Mandate | null;
  onChanged?: () => Promise<void> | void;
  onMessage?: (msg: string, tone?: "success" | "warn" | "info") => void;
  onGoApprove?: (intentId?: string) => void;
  onGoHistory?: () => void;
  onOpenSettings?: () => void;
}) {
  const [bundle, setBundle] = useState<RestockAutomationBundle | null>(null);
  const [loading, setLoading] = useState(true);
  const [busyAction, setBusyAction] = useState<
    null | "sync_order" | "service_rush" | "policy"
  >(null);
  const [showSettings, setShowSettings] = useState(false);
  const [showReceiptLines, setShowReceiptLines] = useState(false);
  const [latestReceipt, setLatestReceipt] = useState<{
    syncStatus?: InventorySyncStatus;
    run: RestockRunResult | null;
  } | null>(null);

  const loadState = useCallback(async () => {
    try {
      const res = await api<RestockAutomationBundle>("/v1/kitchen/restock/automation");
      setBundle(res);
    } catch {
      // Non-fatal if caller is switching keys
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadState();
  }, [loadState, props.customerId]);

  async function updatePolicy(patch: Partial<RestockAutomationPolicy>, toastText?: string) {
    setBusyAction("policy");
    try {
      const res = await api<RestockAutomationBundle>("/v1/kitchen/restock/automation", {
        method: "PUT",
        body: JSON.stringify(patch),
      });
      setBundle(res);
      if (toastText) props.onMessage?.(toastText, "info");
      await props.onChanged?.();
    } catch (e) {
      props.onMessage?.(e instanceof Error ? e.message : String(e), "warn");
    } finally {
      setBusyAction(null);
    }
  }

  async function runSyncFlow(mode: "pos_sync" | "service_rush", autoOrder: boolean) {
    setBusyAction(mode === "service_rush" ? "service_rush" : "sync_order");
    try {
      const res = await api<SyncRunResponse>("/v1/kitchen/restock/sync", {
        method: "POST",
        body: JSON.stringify({ mode, autoOrder }),
      });
      setBundle({
        policy: res.policy,
        lastRun: res.restockResult ?? bundle?.lastRun ?? null,
        syncStatus: res.syncStatus,
        stockHealth: res.stockHealth,
      });
      setLatestReceipt({
        syncStatus: res.syncStatus,
        run: res.restockResult,
      });
      if (props.variant === "full" && (res.restockResult?.lines.length ?? 0) > 0) {
        setShowReceiptLines(true);
      }
      await props.onChanged?.();

      if (res.restockResult) {
        const tone = res.restockResult.pendingApprovalCount > 0 ? "info" : "success";
        props.onMessage?.(tidy(res.restockResult.summary), tone);
      } else {
        props.onMessage?.(tidy(res.syncStatus.lastSyncSummary), "info");
      }
    } catch (e) {
      props.onMessage?.(e instanceof Error ? e.message : String(e), "warn");
    } finally {
      setBusyAction(null);
    }
  }

  if (loading && !bundle) {
    return (
      <div
        className="card"
        aria-busy="true"
        style={{
          marginBottom: props.variant === "compact" ? 18 : 0,
          padding: props.variant === "compact" ? "11px 18px" : "16px 20px",
          borderRadius: 16,
        }}
      >
        <div style={{ fontSize: 13.5, color: "var(--text-muted)", fontWeight: 600 }}>
          Checking kitchen stock…
        </div>
      </div>
    );
  }

  if (!bundle) return null;

  const { policy, syncStatus, stockHealth } = bundle;
  const activeRun = latestReceipt?.run ?? bundle.lastRun;
  const activeDeductions = latestReceipt?.syncStatus?.deductions ?? syncStatus?.deductions;

  const criticalCount = stockHealth?.criticalCount ?? 0;
  const lowCount = stockHealth?.lowCount ?? 0;
  const okCount = stockHealth?.okCount ?? 0;
  const atRiskItems = (stockHealth?.items ?? []).filter(
    (i) => i.urgency === "critical" || i.urgency === "low",
  );
  const actionableCount = stockHealth?.actionableCount ?? atRiskItems.length;
  const includesLow = policy.urgencies.includes("low");
  const autoLimitEur = props.mandate?.maxOrderValueEur ?? 500;
  const mandatePaused = props.mandate?.autoPurchaseIf?.withinMaxOrderValue === false;
  const effectivelyActive = policy.enabled && !mandatePaused;

  const firstPendingIntentId = activeRun?.lines?.find(
    (l) => l.status === "pending_approval" && l.intentId,
  )?.intentId;

  /* ────────────────────── COMPACT BAR (Home / New Order View) ────────────────────── */
  if (props.variant === "compact") {
    const shortNames = atRiskItems
      .slice(0, 2)
      .map((i) => i.name)
      .join(", ");
    const extraCount = Math.max(0, atRiskItems.length - 2);

    return (
      <div
        className="card"
        aria-live="polite"
        style={{
          marginBottom: 18,
          padding: "11px 18px",
          borderRadius: 16,
          border:
            criticalCount > 0
              ? "1.5px solid var(--amber-border)"
              : effectivelyActive
                ? "1.5px solid var(--green-border)"
                : "1px solid var(--border-light)",
          background:
            criticalCount > 0
              ? "linear-gradient(90deg, #fffdf5 0%, #ffffff 65%)"
              : effectivelyActive
                ? "linear-gradient(90deg, #f3fcf8 0%, #ffffff 65%)"
                : "#ffffff",
        }}
      >
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            gap: 12,
            flexWrap: "wrap",
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
            <span className={`pill ${effectivelyActive ? "green" : "amber"}`}>
              {effectivelyActive ? "● Auto-Restock ON" : "⏸ Auto-Restock Paused"}
            </span>

            <span style={{ fontSize: 13.5, color: "var(--text-main)" }}>
              {atRiskItems.length > 0 ? (
                <>
                  <strong style={{ color: criticalCount > 0 ? "var(--red-text)" : "var(--amber-text)" }}>
                    {atRiskItems.length} low in pantry:
                  </strong>{" "}
                  {shortNames}
                  {extraCount > 0 ? ` +${extraCount} more` : ""}
                </>
              ) : (
                <>
                  <strong style={{ color: "var(--green-text)" }}>
                    All {okCount} pantry items stocked
                  </strong>
                </>
              )}
              <span style={{ color: "var(--text-soft)", marginLeft: 8, fontSize: 12.5 }}>
                · Synced {timeAgoShort(syncStatus?.lastSyncedAt)}
              </span>
            </span>
          </div>

          <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
            <button
              type="button"
              className={`btn ${actionableCount > 0 ? "primary" : "secondary"}`}
              style={{ minHeight: 38, padding: "7px 14px", fontSize: 13 }}
              disabled={busyAction !== null}
              onClick={() => void runSyncFlow("pos_sync", true)}
            >
              {busyAction === "sync_order"
                ? "Ordering…"
                : actionableCount > 0
                  ? `⚡ Auto-Order Low (${actionableCount})`
                  : "🔄 Sync Stock"}
            </button>

            {props.onOpenSettings && (
              <button
                type="button"
                className="link-quiet"
                style={{ fontSize: 13, fontWeight: 700 }}
                onClick={props.onOpenSettings}
              >
                Stock &amp; Rules →
              </button>
            )}
          </div>
        </div>

        {latestReceipt?.run && (
          <div
            style={{
              marginTop: 10,
              paddingTop: 10,
              borderTop: "1px solid var(--border-light)",
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
              gap: 10,
              flexWrap: "wrap",
              fontSize: 13,
            }}
          >
            <span style={{ fontWeight: 700, color: "var(--text-main)" }}>
              ✓ {tidy(latestReceipt.run.summary)}
            </span>
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              {latestReceipt.run.pendingApprovalCount > 0 && props.onGoApprove && (
                <button
                  type="button"
                  className="link-quiet"
                  style={{ fontWeight: 800, color: "var(--brand-blue)" }}
                  onClick={() => props.onGoApprove?.(firstPendingIntentId)}
                >
                  Review {latestReceipt.run.pendingApprovalCount} in Needs Your OK →
                </button>
              )}
              <button
                type="button"
                className="link-quiet"
                onClick={() => setLatestReceipt(null)}
              >
                Dismiss
              </button>
            </div>
          </div>
        )}
      </div>
    );
  }

  /* ────────────────────── FULL CONTROL BAR (Stock & Kitchen View) ────────────────────── */
  const syncSelectValue = policy.autoSyncInventory ? String(policy.syncIntervalMinutes) : "off";

  return (
    <div
      className="card"
      aria-live="polite"
      style={{
        padding: "18px 22px",
        border:
          criticalCount > 0
            ? "1.5px solid var(--amber-border)"
            : effectivelyActive
              ? "1.5px solid var(--green-border)"
              : "1px solid var(--border-light)",
        background:
          criticalCount > 0
            ? "linear-gradient(180deg, #fffdf7 0%, #ffffff 70%)"
            : effectivelyActive
              ? "linear-gradient(180deg, #f4fdf9 0%, #ffffff 70%)"
              : "#ffffff",
      }}
    >
      {/* Single Scannable Top Row */}
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          gap: 14,
          flexWrap: "wrap",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
          <span className={`pill ${effectivelyActive ? "green" : "amber"}`}>
            {effectivelyActive
              ? "● Auto-Order ON"
              : mandatePaused
                ? "⏸ Paused in My Rules"
                : "⏸ Auto-Order Paused"}
          </span>

          <span className={`pill ${criticalCount > 0 ? "red" : "gray"}`}>
            🔴 {criticalCount} Very Low
          </span>
          <span className={`pill ${lowCount > 0 ? "amber" : "gray"}`}>
            🟠 {lowCount} Low
          </span>
          <span className="pill green">🟢 {okCount} Healthy</span>

          <span style={{ fontSize: 13, color: "var(--text-muted)", fontWeight: 600, marginLeft: 4 }}>
            Synced {timeAgoShort(syncStatus?.lastSyncedAt)} · Auto ≤ {money(autoLimitEur, 0)}
          </span>
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
          <button
            type="button"
            className="btn primary"
            style={{ minHeight: 42, padding: "8px 16px", fontSize: 13.5 }}
            disabled={busyAction !== null}
            onClick={() => void runSyncFlow("pos_sync", true)}
          >
            {busyAction === "sync_order"
              ? "Syncing & Ordering…"
              : actionableCount > 0
                ? `⚡ Sync & Order Low (${actionableCount})`
                : "🔄 Sync Stock Now"}
          </button>

          <button
            type="button"
            className="btn secondary"
            style={{ minHeight: 42, padding: "8px 14px", fontSize: 13.5 }}
            disabled={busyAction !== null}
            onClick={() => void runSyncFlow("service_rush", true)}
            title="Simulate busy kitchen POS sales and auto-order items pushed low"
          >
            {busyAction === "service_rush" ? "Simulating…" : "🍽️ Simulate Rush"}
          </button>

          <button
            type="button"
            className="btn secondary"
            style={{ minHeight: 42, padding: "8px 13px", fontSize: 13.5 }}
            disabled={busyAction !== null}
            onClick={() =>
              void updatePolicy(
                { enabled: !policy.enabled },
                !policy.enabled ? "Auto-restock resumed." : "Auto-restock paused.",
              )
            }
          >
            {policy.enabled ? "Pause" : "Resume"}
          </button>

          <button
            type="button"
            data-testid="restock-rules-toggle"
            className="chip-btn"
            style={{
              minHeight: 42,
              padding: "8px 13px",
              fontSize: 13.5,
              fontWeight: 700,
              borderColor: showSettings ? "var(--brand-blue)" : "var(--border-light)",
              background: showSettings ? "var(--bg-blue-soft)" : "#ffffff",
              color: showSettings ? "var(--brand-blue)" : "var(--text-muted)",
            }}
            onClick={() => setShowSettings((v) => !v)}
          >
            ⚙ Rules {showSettings ? "▴" : "▾"}
          </button>
        </div>
      </div>

      {/* Progressive Disclosure: Compact Rules Drawer (Closed by Default) */}
      {showSettings && (
        <div
          style={{
            marginTop: 14,
            paddingTop: 14,
            borderTop: "1px solid var(--border-light)",
            display: "flex",
            flexDirection: "column",
            gap: 12,
          }}
        >
          <div
            style={{
              display: "flex",
              alignItems: "flex-end",
              gap: 14,
              flexWrap: "wrap",
            }}
          >
            <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
              <span style={{ fontSize: 12, fontWeight: 700, color: "var(--text-muted)" }}>
                Order Trigger
              </span>
              <div style={{ display: "flex", gap: 6 }}>
                <button
                  type="button"
                  className="chip-btn"
                  disabled={busyAction !== null}
                  onClick={() =>
                    void updatePolicy(
                      { urgencies: ["critical", "low"] },
                      "Auto-ordering Very Low & Low items.",
                    )
                  }
                  style={{
                    fontWeight: 700,
                    borderColor: includesLow ? "var(--brand-blue)" : "var(--border-light)",
                    background: includesLow ? "var(--bg-blue-soft)" : "#ffffff",
                    color: includesLow ? "var(--brand-blue)" : "var(--text-muted)",
                  }}
                >
                  Very Low &amp; Low
                </button>
                <button
                  type="button"
                  className="chip-btn"
                  disabled={busyAction !== null}
                  onClick={() =>
                    void updatePolicy(
                      { urgencies: ["critical"] },
                      "Auto-ordering Very Low items only.",
                    )
                  }
                  style={{
                    fontWeight: 700,
                    borderColor: !includesLow ? "var(--brand-blue)" : "var(--border-light)",
                    background: !includesLow ? "var(--bg-blue-soft)" : "#ffffff",
                    color: !includesLow ? "var(--brand-blue)" : "var(--text-muted)",
                  }}
                >
                  Very Low Only
                </button>
              </div>
            </div>

            <label style={{ display: "flex", flexDirection: "column", gap: 5, fontSize: 12, fontWeight: 700, color: "var(--text-muted)" }}>
              Stock Cover
              <select
                className="field-select"
                style={{ minHeight: 38, padding: "4px 10px", fontSize: 13, width: 140 }}
                value={policy.daysCover}
                disabled={busyAction !== null}
                onChange={(e) =>
                  void updatePolicy(
                    { daysCover: Number(e.target.value) },
                    `Stock cover set to ${e.target.value} days.`,
                  )
                }
              >
                <option value={3}>3 days</option>
                <option value={5}>5 days</option>
                <option value={7}>7 days (Weekly)</option>
                <option value={14}>14 days</option>
              </select>
            </label>

            <label style={{ display: "flex", flexDirection: "column", gap: 5, fontSize: 12, fontWeight: 700, color: "var(--text-muted)" }}>
              POS Auto-Sync
              <select
                className="field-select"
                style={{ minHeight: 38, padding: "4px 10px", fontSize: 13, width: 155 }}
                value={syncSelectValue}
                disabled={busyAction !== null}
                onChange={(e) => {
                  const v = e.target.value;
                  if (v === "off") {
                    void updatePolicy({ autoSyncInventory: false }, "POS auto-sync paused.");
                  } else {
                    void updatePolicy(
                      { autoSyncInventory: true, syncIntervalMinutes: Number(v) },
                      `POS auto-sync set to every ${v} min.`,
                    );
                  }
                }}
              >
                <option value="5">Every 5 min</option>
                <option value="15">Every 15 min</option>
                <option value="30">Every 30 min</option>
                <option value="60">Every 60 min</option>
                <option value="off">Paused</option>
              </select>
            </label>
          </div>

          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
              gap: 12,
              flexWrap: "wrap",
              fontSize: 13,
            }}
          >
            <div style={{ display: "flex", gap: 18, flexWrap: "wrap" }}>
              <label style={{ display: "inline-flex", alignItems: "center", gap: 7, fontWeight: 600, cursor: "pointer" }}>
                <input
                  type="checkbox"
                  checked={policy.smartQuantities}
                  disabled={busyAction !== null}
                  onChange={(e) =>
                    void updatePolicy({ smartQuantities: e.target.checked })
                  }
                />
                <span>Best-value pack size</span>
              </label>

              <label style={{ display: "inline-flex", alignItems: "center", gap: 7, fontWeight: 600, cursor: "pointer" }}>
                <input
                  type="checkbox"
                  checked={policy.pauseOnStandingOrderDrift}
                  disabled={busyAction !== null}
                  onChange={(e) =>
                    void updatePolicy({ pauseOnStandingOrderDrift: e.target.checked })
                  }
                />
                <span>Ask OK on +50% spikes</span>
              </label>
            </div>

            <span style={{ fontSize: 12.5, color: "var(--green-text)", fontWeight: 700 }}>
              ✓ Connected: Kitchen POS · Valio Deliveries · Fridge Par
            </span>
          </div>
        </div>
      )}

      {/* Compact 1-Line Latest Receipt Strip (Expandable on Click) */}
      {activeRun && (activeRun.lines.length > 0 || latestReceipt !== null) && (
        <div
          style={{
            marginTop: 12,
            padding: "10px 14px",
            borderRadius: 12,
            background:
              activeRun.pendingApprovalCount > 0 ? "var(--bg-amber-soft)" : "var(--bg-green-soft)",
            border: `1px solid ${
              activeRun.pendingApprovalCount > 0 ? "var(--amber-border)" : "var(--green-border)"
            }`,
          }}
        >
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
              gap: 10,
              flexWrap: "wrap",
            }}
          >
            <div style={{ fontSize: 13.5, color: "var(--text-main)" }}>
              <strong>🧾 Last restock ({timeAgoShort(activeRun.ranAt)}):</strong>{" "}
              {tidy(activeRun.summary)}
            </div>

            <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
              {activeRun.pendingApprovalCount > 0 && props.onGoApprove && (
                <button
                  type="button"
                  className="btn primary"
                  style={{ minHeight: 34, padding: "5px 12px", fontSize: 12.5 }}
                  onClick={() => props.onGoApprove?.(firstPendingIntentId)}
                >
                  Review {activeRun.pendingApprovalCount} in Needs Your OK →
                </button>
              )}
              {activeRun.committedCount > 0 && activeRun.pendingApprovalCount === 0 && props.onGoHistory && (
                <button
                  type="button"
                  className="link-quiet"
                  style={{ fontSize: 12.5, fontWeight: 700 }}
                  onClick={() => props.onGoHistory?.()}
                >
                  Past Orders →
                </button>
              )}
              {activeRun.lines.length > 0 && (
                <button
                  type="button"
                  className="link-quiet"
                  style={{ fontSize: 12.5, fontWeight: 700 }}
                  onClick={() => setShowReceiptLines((v) => !v)}
                >
                  {showReceiptLines
                    ? "Hide items ▴"
                    : `Items (${activeRun.lines.length}) ▾`}
                </button>
              )}
            </div>
          </div>

          {showReceiptLines && (
            <div style={{ marginTop: 10 }}>
              {activeDeductions && activeDeductions.length > 0 && (
                <div style={{ fontSize: 12, color: "var(--text-muted)", marginBottom: 8 }}>
                  POS deducted:{" "}
                  {activeDeductions
                    .map((d) => `−${qty(d.used, d.unit)} ${d.name}`)
                    .join(" · ")}
                </div>
              )}

              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "repeat(auto-fill, minmax(230px, 1fr))",
                  gap: 8,
                }}
              >
                {activeRun.lines.map((line, idx) => {
                  const isCommitted = Boolean(line.committed);
                  const isPending = line.status === "pending_approval";
                  return (
                    <div
                      key={`${line.ingredient}-${idx}`}
                      style={{
                        background: "rgba(255,255,255,0.94)",
                        borderRadius: 10,
                        padding: "8px 11px",
                        border: "1px solid var(--border-light)",
                        fontSize: 12.5,
                      }}
                    >
                      <div style={{ display: "flex", justifyContent: "space-between", gap: 6 }}>
                        <strong>
                          {isCommitted ? "✓ " : isPending ? "⏳ " : "ℹ "}
                          {line.ingredient}
                        </strong>
                        {line.totalPrice != null && (
                          <strong style={{ color: "var(--brand-navy)" }}>
                            {money(line.totalPrice)}
                          </strong>
                        )}
                      </div>
                      <div
                        style={{
                          marginTop: 2,
                          fontWeight: 600,
                          color: isCommitted
                            ? "var(--green-text)"
                            : isPending
                              ? "var(--amber-text)"
                              : "var(--text-muted)",
                        }}
                      >
                        {line.quantity ? `${qty(line.quantity, line.unit)} · ` : ""}
                        {isCommitted ? "Ordered" : isPending ? "Needs OK" : tidy(line.outcome)}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
