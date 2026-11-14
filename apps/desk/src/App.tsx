import { useCallback, useEffect, useRef, useState } from "react";
import { AgentArenaView } from "./AgentArenaView";
import {
  api,
  getApiKey,
  setApiKey,
  type Intent,
  type Mandate,
  type RestockAutomationBundle,
} from "./api";
import { ApprovalView } from "./ApprovalView";
import { EventsAndKitchenView } from "./EventsAndKitchenView";
import { NewOrderView } from "./NewOrderView";
import { OrdersHistoryView } from "./OrdersHistoryView";
import { PromptEvalView } from "./PromptEvalView";
import { RulesView } from "./RulesView";
import { TechProofModal } from "./TechProofModal";

export type TabId = "order" | "kitchen" | "approval" | "rules" | "history" | "arena" | "eval";
type KitchenSection = "events" | "pantry" | "recipes" | "recurring";
type ToastTone = "success" | "warn" | "info";

type EventBadgeSummary = {
  id: string;
  readiness?: string;
  orderDue?: boolean;
  voice?: { approval?: string } | null;
};

function getInitialTab(): TabId {
  if (typeof window === "undefined") return "order";
  const params = new URLSearchParams(window.location.search);
  if (params.get("eval") === "1") return "eval";
  const q = params.get("tab");
  if (
    q === "order" ||
    q === "kitchen" ||
    q === "approval" ||
    q === "rules" ||
    q === "history" ||
    q === "arena" ||
    q === "eval"
  ) {
    return q;
  }
  return "order";
}

function getInitialKitchenSection(): KitchenSection {
  if (typeof window === "undefined") return "pantry";
  const s = new URLSearchParams(window.location.search).get("section");
  if (s === "events" || s === "pantry" || s === "recipes" || s === "recurring") {
    return s;
  }
  return "pantry";
}

export function App() {
  const [tab, setTab] = useState<TabId>(getInitialTab);
  const [kitchenSection, setKitchenSection] = useState<KitchenSection>(getInitialKitchenSection);
  const [customerId, setCustomerId] = useState<string>("HOTEL-001");
  const [kitchenName, setKitchenName] = useState<string>("Hotel Kitchen");
  const [mandate, setMandate] = useState<Mandate | null>(null);
  const [pending, setPending] = useState<Intent[]>([]);
  const [eventsBadgeCount, setEventsBadgeCount] = useState<number>(0);
  const [lowStockBadgeCount, setLowStockBadgeCount] = useState<number>(0);
  const [criticalStockCount, setCriticalStockCount] = useState<number>(0);
  const [selectedPendingId, setSelectedPendingId] = useState<string | null>(null);
  const [toast, setToast] = useState<{ text: string; tone: ToastTone } | null>(null);
  const [authIssue, setAuthIssue] = useState<string | null>(null);
  const [sseConnected, setSseConnected] = useState<boolean>(false);
  const [resetNonce, setResetNonce] = useState<number>(0);
  const [techModal, setTechModal] = useState<{ open: boolean; runId?: string }>({
    open: false,
  });

  const lastMandateJsonRef = useRef<string>("");

  const showToast = useCallback((text: string, tone: ToastTone = "success") => {
    setToast({ text, tone });
  }, []);

  const refreshState = useCallback(async () => {
    try {
      const [meRes, pendingRes, eventsRes, autoRes] = await Promise.all([
        api<{
          customerId: string;
          role?: string;
          canApprove?: boolean;
          hotelName?: string | null;
          mandate: Mandate;
        }>("/v1/me"),
        api<{ intents: Intent[] }>("/v1/orders/pending"),
        api<{ events: EventBadgeSummary[] }>("/v1/events").catch(() => ({ events: [] })),
        api<RestockAutomationBundle>("/v1/kitchen/restock/automation").catch(() => null),
      ]);

      setAuthIssue(
        meRes.canApprove === false
          ? "You are currently signed in with a restricted agent credential. Switch back to the Buyer key to approve orders or edit kitchen rules."
          : null,
      );

      setCustomerId(meRes.customerId);
      setKitchenName(
        meRes.hotelName ||
          (meRes.customerId.includes("SCHOOL") ? "School Kitchen" : "Hotel Kitchen"),
      );

      // Bug #6 fix: Only update mandate state when serialized content actually changes
      // so background polling never wipes unsaved slider/chip edits in RulesView.
      const nextJson = JSON.stringify(meRes.mandate);
      if (nextJson !== lastMandateJsonRef.current) {
        lastMandateJsonRef.current = nextJson;
        setMandate(meRes.mandate);
      }

      setPending(pendingRes.intents);

      const actionableEvents = (eventsRes.events ?? []).filter(
        (e) =>
          e.voice?.approval === "pending" ||
          e.readiness === "at_risk" ||
          e.readiness === "ready_to_order" ||
          Boolean(e.orderDue),
      ).length;
      setEventsBadgeCount(actionableEvents);

      const crit = autoRes?.stockHealth?.criticalCount ?? 0;
      const low = autoRes?.stockHealth?.lowCount ?? 0;
      setCriticalStockCount(crit);
      setLowStockBadgeCount(crit + low);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (/unauthorized|401|forbidden|403/i.test(msg)) {
        setAuthIssue(
          "Saved API key was not recognized by the gateway. Restore the default Hotel Kitchen buyer key to continue.",
        );
      }
    }
  }, []);

  useEffect(() => {
    void refreshState();
    const timer = setInterval(() => {
      if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
      void refreshState();
    }, 6000);
    return () => clearInterval(timer);
  }, [refreshState]);

  // Real-time SSE stream (/v1/stream) for zero-lag multi-agent, voice & approval updates
  useEffect(() => {
    if (typeof EventSource === "undefined") return;
    let es: EventSource | null = null;
    let debounceTimer: number | null = null;

    try {
      const key = getApiKey();
      es = new EventSource(`/v1/stream?apiKey=${encodeURIComponent(key)}`);
      es.addEventListener("connected", () => {
        setSseConnected(true);
      });
      es.addEventListener("audit", () => {
        setSseConnected(true);
        if (debounceTimer) window.clearTimeout(debounceTimer);
        debounceTimer = window.setTimeout(() => {
          void refreshState();
        }, 180);
      });
      es.onerror = () => {
        setSseConnected(false);
      };
    } catch {
      setSseConnected(false);
    }

    return () => {
      if (debounceTimer) window.clearTimeout(debounceTimer);
      es?.close();
    };
  }, [customerId, resetNonce, refreshState]);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 5500);
    return () => clearTimeout(t);
  }, [toast]);

  const viewKey = `${customerId}-${resetNonce}`;

  return (
    <div>
      {/* Calm Chef Navigation + Instant Judge Security Lab Access */}
      <header className="top-shell">
        <div className="top-shell-inner">
          <button type="button" className="brand-lockup" onClick={() => setTab("order")}>
            <div className="brand-mark">VA</div>
            <div>
              <div className="brand-title">Valio Aimo®</div>
              <div className="brand-sub">Kitchen Ordering &amp; Voice Assistant</div>
            </div>
          </button>

          <nav className="nav-tabs" aria-label="Main navigation">
            <button
              type="button"
              className={`nav-tab ${tab === "order" ? "active" : ""}`}
              onClick={() => setTab("order")}
            >
              New Order
            </button>
            <button
              type="button"
              className={`nav-tab ${tab === "kitchen" ? "active" : ""}`}
              onClick={() => setTab("kitchen")}
            >
              Stock &amp; Kitchen
              {lowStockBadgeCount + eventsBadgeCount > 0 && (
                <span
                  className="nav-badge"
                  style={{
                    background:
                      criticalStockCount > 0
                        ? "var(--red-main)"
                        : lowStockBadgeCount > 0
                          ? "var(--amber-main)"
                          : "var(--brand-blue)",
                  }}
                  title={`${lowStockBadgeCount} low/very-low pantry item(s) · ${eventsBadgeCount} upcoming event(s)`}
                >
                  {lowStockBadgeCount + eventsBadgeCount}
                </span>
              )}
            </button>
            <button
              type="button"
              className={`nav-tab ${tab === "approval" ? "active" : ""}`}
              onClick={() => setTab("approval")}
            >
              Needs Your OK
              {pending.length > 0 && <span className="nav-badge">{pending.length}</span>}
            </button>
            <button
              type="button"
              className={`nav-tab ${tab === "rules" ? "active" : ""}`}
              onClick={() => setTab("rules")}
            >
              My Rules
            </button>
            <button
              type="button"
              className={`nav-tab ${tab === "history" ? "active" : ""}`}
              onClick={() => setTab("history")}
            >
              Past Orders
            </button>
          </nav>

          <div
            className="top-shell-actions"
            style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}
          >
            <button
              type="button"
              className={`judge-lab-btn ${tab === "eval" ? "active" : ""}`}
              onClick={() => setTab("eval")}
              title="28-case LLM Purchasing Agent Prompt Evaluation & Accuracy Marking Bench"
            >
              <span>🧪 Prompt Eval</span>
            </button>

            <button
              type="button"
              className={`judge-lab-btn ${tab === "arena" ? "active" : ""}`}
              onClick={() => setTab("arena")}
              title="Live Multi-Agent Topology, Red-Team Security Attacks, MCP & Cryptographic Proof"
            >
              <span className={`pulse-dot ${sseConnected ? "" : "amber"}`} />
              <span>⚡ Live Agent Lab</span>
            </button>

            <button
              type="button"
              className="kitchen-pill-btn"
              onClick={() => setTechModal({ open: true })}
              title="Switch kitchen account or open demo tools"
            >
              <span>{kitchenName}</span>
              <span style={{ opacity: 0.6 }}>▾</span>
            </button>
          </div>
        </div>
      </header>

      {/* Recovery Banner if localStorage has an invalid or non-buyer API key */}
      {authIssue && (
        <div style={{ maxWidth: 1120, margin: "18px auto 0", padding: "0 24px" }}>
          <div className="banner warn" style={{ alignItems: "center", flexWrap: "wrap" }}>
            <div style={{ fontWeight: 600 }}>{authIssue}</div>
            <button
              type="button"
              className="btn secondary"
              style={{ minHeight: 38, padding: "6px 14px", fontSize: 13 }}
              onClick={() => {
                setApiKey("hotel_buyer_key_001");
                lastMandateJsonRef.current = "";
                setSelectedPendingId(null);
                setResetNonce((n) => n + 1);
                void refreshState();
                showToast("Restored Hotel Kitchen buyer account.", "info");
              }}
            >
              Restore Hotel Buyer Key
            </button>
          </div>
        </div>
      )}

      {/* Friendly Confirmation / Info Toast */}
      {toast && (
        <div style={{ maxWidth: 1120, margin: "18px auto 0", padding: "0 24px" }}>
          <div className={`banner ${toast.tone}`}>
            <div style={{ fontWeight: 700 }}>
              {toast.tone === "success" ? "✓ " : toast.tone === "warn" ? "⚠ " : "ℹ "}
              {toast.text}
            </div>
            <button type="button" className="link-quiet" onClick={() => setToast(null)}>
              Dismiss
            </button>
          </div>
        </div>
      )}

      {/* Active Tab Content */}
      <main>
        {tab === "order" && (
          <NewOrderView
            key={`order-${viewKey}`}
            customerId={customerId}
            mandate={mandate}
            onChanged={refreshState}
            onGoApprove={(intentId) => {
              if (intentId) setSelectedPendingId(intentId);
              setTab("approval");
            }}
            onMessage={showToast}
            onNavigateTab={(nextTab, subView) => {
              if (
                subView === "events" ||
                subView === "pantry" ||
                subView === "recipes" ||
                subView === "recurring"
              ) {
                setKitchenSection(subView);
              }
              setTab(nextTab);
            }}
            onOrderCreated={(intent, committedOrderId) => {
              void refreshState();
              if (committedOrderId) {
                showToast(`Order placed automatically! Confirmation #${committedOrderId}`, "success");
                setTab("history");
              } else {
                setSelectedPendingId(intent.id);
                setTab("approval");
              }
            }}
          />
        )}

        {tab === "kitchen" && (
          <EventsAndKitchenView
            key={`kitchen-${viewKey}`}
            customerId={customerId}
            mandate={mandate}
            initialSection={kitchenSection}
            onChanged={refreshState}
            onMessage={showToast}
            onGoApprove={(intentId) => {
              if (intentId) setSelectedPendingId(intentId);
              setTab("approval");
            }}
            onGoHistory={() => setTab("history")}
          />
        )}

        {tab === "approval" && (
          <ApprovalView
            key={`approval-${viewKey}`}
            pending={pending}
            mandate={mandate}
            selectedId={selectedPendingId}
            onSelectId={setSelectedPendingId}
            onChanged={refreshState}
            onApproved={(msg, stayInQueue) => {
              showToast(msg, stayInQueue ? "info" : "success");
              if (!stayInQueue) {
                setTab("history");
              }
            }}
          />
        )}

        {tab === "rules" && (
          <RulesView
            key={`rules-${viewKey}`}
            customerId={customerId}
            mandate={mandate}
            onMessage={showToast}
            onOpenInventorySync={() => {
              setKitchenSection("pantry");
              setTab("kitchen");
            }}
            onSaved={(updated) => {
              lastMandateJsonRef.current = JSON.stringify(updated);
              setMandate(updated);
              void refreshState();
            }}
          />
        )}

        {tab === "history" && (
          <OrdersHistoryView
            key={`history-${viewKey}`}
            customerId={customerId}
            onChanged={() => void refreshState()}
            onMessage={showToast}
            onGoApprove={(intentId) => {
              setSelectedPendingId(intentId);
              setTab("approval");
            }}
            onOpenTechModal={(runId) => setTechModal({ open: true, runId })}
          />
        )}

        {tab === "arena" && (
          <AgentArenaView
            key={`arena-${viewKey}`}
            customerId={customerId}
            onChanged={refreshState}
            onMessage={showToast}
            onGoApprove={(intentId) => {
              if (intentId) setSelectedPendingId(intentId);
              setTab("approval");
            }}
          />
        )}

        {tab === "eval" && (
          <PromptEvalView
            key={`eval-${viewKey}`}
            customerId={customerId}
            onChanged={refreshState}
            onMessage={showToast}
          />
        )}
      </main>

      <TechProofModal
        open={techModal.open}
        runId={techModal.runId}
        onClose={() => setTechModal({ open: false })}
        onOpenArena={() => {
          setTechModal({ open: false });
          setTab("arena");
        }}
        onSwitchedOrReset={(msg) => {
          lastMandateJsonRef.current = "";
          setSelectedPendingId(null);
          setResetNonce((n) => n + 1);
          showToast(msg, "info");
          void refreshState();
        }}
      />
    </div>
  );
}
