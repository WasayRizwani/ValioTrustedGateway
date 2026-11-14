import { useEffect, useRef, useState } from "react";
import { api } from "./api";

/** Demo identities. Real deployments would sign in with the hotel's own account; keys are static in this prototype. */
const ACCOUNTS: Array<{ key: string; label: string; hint: string }> = [
  { key: "hotel_buyer_key_001", label: "Hotel ABC — buyer", hint: "Can approve orders and change the mandate" },
  { key: "school_buyer_key_001", label: "School canteen — buyer", hint: "Can approve orders and change the mandate" },
  { key: "hotel_demo_key_001", label: "Hotel ABC — agent key", hint: "Can order inside the mandate, cannot approve" },
];

type Check = { id: string; label: string; ok: boolean; ms?: number; detail: string };
type Status = { checks: Check[]; allOk: boolean };
type SelfTest = { ok: boolean; steps: Check[]; ms: number };

export function ConnectMenu(props: {
  customerId: string;
  role: string;
  hotelName?: string | null;
  maxOrderValueEur?: number | null;
  onKeyChange: (key: string) => void;
  onRefresh: () => void;
  onNavigate: (view: string) => void;
  onMessage: (m: string | null) => void;
  onError: (m: string | null) => void;
}) {
  const { customerId, role, hotelName, maxOrderValueEur, onKeyChange, onRefresh, onNavigate, onMessage, onError } = props;
  const [open, setOpen] = useState(false);
  const [custom, setCustom] = useState(false);
  const [customKey, setCustomKey] = useState("");
  const [resetting, setResetting] = useState(false);
  const [status, setStatus] = useState<Status | null>(null);
  const [test, setTest] = useState<SelfTest | null>(null);
  const [testing, setTesting] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const current = (() => {
    try {
      return typeof localStorage !== "undefined" ? (localStorage.getItem("tta_api_key") ?? ACCOUNTS[0].key) : ACCOUNTS[0].key;
    } catch {
      return ACCOUNTS[0].key;
    }
  })();
  const known = ACCOUNTS.find((a) => a.key === current);
  const hotel = hotelName ?? null;
  const maxOrder = maxOrderValueEur ?? null;
  const isBuyer = role === "buyer";

  // The chip only names the connected hotel; its colour is the system health.
  useEffect(() => {
    let alive = true;
    const load = () => {
      api<Status>("/v1/system/status")
        .then((st) => alive && setStatus(st))
        .catch(() => alive && setStatus({ allOk: false, checks: [{ id: "gw", label: "Agent Gateway", ok: false, detail: "Cannot reach the gateway" }] }));
    };
    load();
    const t = setInterval(() => {
      if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
      load();
    }, 30000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [current]);

  async function runTest() {
    setTesting(true);
    setTest(null);
    try {
      setTest(await api<SelfTest>("/v1/system/selftest", { method: "POST" }));
    } catch (e) {
      onError(e instanceof Error ? e.message : String(e));
    } finally {
      setTesting(false);
    }
  }

  async function handleDemoReset() {
    if (!window.confirm("Reset demo state (orders, intents, mandate, and kitchen stock) back to the clean seed? The tamper-evident audit log is preserved.")) {
      return;
    }
    setResetting(true);
    onError(null);
    try {
      await api("/v1/admin/demo-reset", {
        method: "POST",
        headers: {
          "X-Demo-Reset": "confirm",
          "X-Reset-Source": "Top bar reset",
        },
      });
      onMessage("Demo state reset to clean seed — ready for your walkthrough.");
      setOpen(false);
      onRefresh();
    } catch (e) {
      onError(e instanceof Error ? e.message : String(e));
    } finally {
      setResetting(false);
    }
  }

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (box.current && !box.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div className="topbar-controls">
      {isBuyer && (
        <button
          type="button"
          className="btn reset-demo-btn"
          disabled={resetting}
          onClick={() => void handleDemoReset()}
          title="Reset orders, mandate, and kitchen back to the clean demo seed"
        >
          {resetting ? "Resetting…" : "↺ Reset demo"}
        </button>
      )}

      <div className="connect-menu" ref={box}>
        <button type="button" className={`connect-btn ${open ? "open" : ""}`} aria-expanded={open} onClick={() => setOpen(!open)}>
          <i className={`cdot ${status ? (status.allOk ? (isBuyer ? "ok" : "warn") : "bad") : ""}`} />
          <span className="connect-who">{hotel ?? (customerId || "Connecting…")}</span>
          <span className={`role-tag ${isBuyer ? "buyer" : "agent"}`}>
            {isBuyer ? "Buyer" : role === "agent" ? "Agent key" : "…"}
          </span>
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <path d="M6 9l6 6 6-6" />
          </svg>
        </button>

        {open && (
          <div className="connect-pop" role="dialog" aria-label="Account and system status">
            <div className="cp-sec">
              <div className="cp-label">Active credential</div>
              <div className="cp-id">
                <strong>{known?.label ?? customerId}</strong>
                <span className={`pill ${isBuyer ? "ok" : "bad"}`}>
                  <i /> {isBuyer ? "Can approve" : role === "agent" ? "Cannot approve" : "…"}
                </span>
              </div>
              <select
                value={custom ? "__custom" : (known?.key ?? "__custom")}
                onChange={(e) => {
                  if (e.target.value === "__custom") return setCustom(true);
                  setCustom(false);
                  onKeyChange(e.target.value);
                }}
                aria-label="Switch account"
              >
                {ACCOUNTS.map((a) => (
                  <option key={a.key} value={a.key}>
                    {a.label}
                  </option>
                ))}
                <option value="__custom">Use another key…</option>
              </select>
              <div className="tiny muted">{known?.hint ?? "Custom credential"}</div>
              {(custom || !known) && (
                <div className="cp-row">
                  <input type="password" autoComplete="off" placeholder="Paste an API key" value={customKey} onChange={(e) => setCustomKey(e.target.value)} />
                  <button type="button" className="btn" disabled={!customKey.trim()} onClick={() => { onKeyChange(customKey.trim()); setCustomKey(""); setCustom(false); }}>
                    Use
                  </button>
                </div>
              )}
            </div>

            <div className="cp-sec">
              <div className="cp-label">Gateway &amp; system health</div>
              <div className="cp-health">
                <strong>{status ? (status.allOk ? "All systems operational" : "Something needs attention") : "Checking…"}</strong>
                {maxOrder != null && <span className="tiny muted">Mandate auto-commits up to €{maxOrder}/order; larger orders escalate to human approval.</span>}
              </div>
              <div className="pills">
                {(status?.checks ?? []).map((c) => (
                  <span key={c.id} className={`pill ${c.ok ? "ok" : "bad"}`} title={c.detail}>
                    <i /> {c.label}
                    {c.ms != null ? <em>{c.ms} ms</em> : null}
                  </span>
                ))}
              </div>
              {status?.checks.filter((c) => !c.ok).map((c) => (
                <p key={c.id} className="tiny" style={{ color: "var(--danger)", margin: 0 }}>
                  {c.label}: {c.detail}
                </p>
              ))}
              <button type="button" className="btn" disabled={testing} onClick={() => void runTest()}>
                {testing ? "Running agent test…" : "▶ Run end-to-end self-test"}
              </button>
              {(testing || test) && (
                <div className="selftest compact">
                  <div className="tiny">
                    <strong>{testing ? "Running the real purchase path (no order is placed)…" : test?.ok ? `Verified — ${test.steps.length} checks passed in ${test.ms} ms` : "The test found problems"}</strong>
                  </div>
                  <ol>
                    {(test?.steps ?? []).map((st) => (
                      <li key={st.id} className={st.ok ? "ok" : "bad"}>
                        <span className="mark">{st.ok ? "✓" : "✗"}</span>
                        <span className="tiny">{st.label}{st.ms != null ? ` · ${st.ms} ms` : ""}</span>
                      </li>
                    ))}
                  </ol>
                </div>
              )}
            </div>

            <div className="cp-sec">
              <button type="button" className="cp-item" onClick={() => { setOpen(false); onNavigate("connect"); }}>
                <span className="cp-ic">✦</span>
                <span>
                  <strong>Connect an external agent (MCP / REST)</strong>
                  <span className="tiny muted">Scoped keys, 403 boundary probes &amp; Ed25519 claim verification</span>
                </span>
              </button>
            </div>

            <div className="cp-foot" style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <button type="button" className="link" onClick={() => { onRefresh(); setOpen(false); }}>
                Refresh data
              </button>
              {isBuyer && (
                <button type="button" className="link" style={{ color: "var(--danger)" }} disabled={resetting} onClick={() => void handleDemoReset()}>
                  Reset demo seed
                </button>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
