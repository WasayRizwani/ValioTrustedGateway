import { useEffect, useState } from "react";
import { api, getApiKey, setApiKey, type AuditEvent } from "./api";

const ACCOUNTS = [
  {
    key: "hotel_buyer_key_001",
    name: "Hotel Kitchen (HOTEL-001)",
    desc: "Standard €500 auto-order limit · Lactose-free & culinary sourcing",
  },
  {
    key: "school_buyer_key_001",
    name: "School Kitchen (SCHOOL-001)",
    desc: "Strict €200 auto-order limit · Child allergen & dietary safety locks",
  },
];

type SystemCheck = {
  id: string;
  label: string;
  ok: boolean;
  ms?: number;
  detail: string;
};

type SelfTestResult = {
  ok: boolean;
  steps: SystemCheck[];
  ms: number;
  runId: string;
};

export function TechProofModal(props: {
  open: boolean;
  runId?: string;
  onClose: () => void;
  onSwitchedOrReset: (msg: string) => void;
  onOpenArena?: () => void;
}) {
  const [verifying, setVerifying] = useState(false);
  const [verifyMsg, setVerifyMsg] = useState<string | null>(null);
  const [msgTone, setMsgTone] = useState<"success" | "error" | "warn">("success");
  const [resetting, setResetting] = useState(false);

  const [healthChecks, setHealthChecks] = useState<SystemCheck[] | null>(null);
  const [selfTesting, setSelfTesting] = useState(false);
  const [selfTest, setSelfTest] = useState<SelfTestResult | null>(null);

  // Clear stale verification/self-test status whenever modal opens/closes or target runId changes
  useEffect(() => {
    setVerifyMsg(null);
    setMsgTone("success");
    setSelfTest(null);
    if (!props.open) return;

    let cancelled = false;
    api<{ checks: SystemCheck[]; allOk: boolean }>("/v1/system/status")
      .then((res) => {
        if (!cancelled && Array.isArray(res.checks)) {
          setHealthChecks(res.checks);
        }
      })
      .catch(() => {
        if (!cancelled) setHealthChecks(null);
      });

    return () => {
      cancelled = true;
    };
  }, [props.open, props.runId]);

  // Escape key closes modal cleanly
  useEffect(() => {
    if (!props.open) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        props.onClose();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [props.open, props.onClose]);

  if (!props.open) return null;

  const activeKey = getApiKey();

  async function verifyAudit() {
    setVerifying(true);
    setVerifyMsg(null);
    try {
      let targetRun = props.runId;
      if (!targetRun) {
        const runs = await api<{ runs: Array<{ runId: string }> }>("/v1/audit-runs");
        targetRun = runs.runs[0]?.runId;
      }
      if (!targetRun) {
        setMsgTone("warn");
        setVerifyMsg("No order audit runs recorded yet for this kitchen account.");
        return;
      }

      const [trailRes, verifyRes] = await Promise.all([
        api<{
          events: AuditEvent[];
          verification?: { valid: boolean; brokenAt?: number; headHash?: string };
        }>(`/v1/audit/${encodeURIComponent(targetRun)}`),
        api<{ valid: boolean; brokenAt?: number; headHash?: string }>(
          `/v1/audit/${encodeURIComponent(targetRun)}/verify`,
          {
            method: "POST",
            body: "{}",
          },
        ),
      ]);

      const count = Array.isArray(trailRes.events) ? trailRes.events.length : 0;
      const headHash = verifyRes.headHash ?? trailRes.verification?.headHash;

      if (count === 0) {
        setMsgTone("warn");
        setVerifyMsg(`Run ${targetRun.slice(0, 8)}… has 0 recorded events.`);
        return;
      }

      if (verifyRes.valid) {
        setMsgTone("success");
        setVerifyMsg(
          `✓ Verified tamper-evident SHA-256 chain & Ed25519 claims (${count} ${count === 1 ? "event" : "events"} intact${headHash ? ` · head ${headHash.slice(0, 12)}…` : ""}).`,
        );
      } else {
        setMsgTone("error");
        setVerifyMsg(
          `✗ Audit verification detected a hash mismatch${verifyRes.brokenAt != null ? ` at event #${verifyRes.brokenAt}` : ""}.`,
        );
      }
    } catch (e) {
      setMsgTone("error");
      setVerifyMsg(e instanceof Error ? e.message : String(e));
    } finally {
      setVerifying(false);
    }
  }

  async function runEndToEndSelfTest() {
    setSelfTesting(true);
    setVerifyMsg(null);
    try {
      const res = await api<SelfTestResult>("/v1/system/selftest", {
        method: "POST",
        body: "{}",
      });
      setSelfTest(res);
      setMsgTone(res.ok ? "success" : "warn");
      setVerifyMsg(
        res.ok
          ? `✓ End-to-end self-test passed (${res.steps.length} checks in ${res.ms} ms · run ${res.runId.slice(0, 8)}…).`
          : `Self-test completed in ${res.ms} ms — review highlighted checks below.`,
      );
    } catch (e) {
      setMsgTone("error");
      setVerifyMsg(e instanceof Error ? e.message : String(e));
    } finally {
      setSelfTesting(false);
    }
  }

  async function resetDemo() {
    setResetting(true);
    setVerifyMsg(null);
    try {
      await api("/v1/admin/demo-reset", {
        method: "POST",
        headers: { "X-Demo-Reset": "confirm" },
        body: "{}",
      });
      props.onSwitchedOrReset("Demo data reset to fresh starting state.");
      props.onClose();
    } catch (e) {
      setMsgTone("error");
      setVerifyMsg(e instanceof Error ? e.message : String(e));
    } finally {
      setResetting(false);
    }
  }

  return (
    <div className="modal-backdrop" onClick={props.onClose}>
      <div
        className="modal-card"
        role="dialog"
        aria-modal="true"
        aria-labelledby="tech-proof-modal-title"
        style={{ maxWidth: 680 }}
        onClick={(e) => e.stopPropagation()}
      >
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            gap: 12,
            marginBottom: 18,
          }}
        >
          <h2 id="tech-proof-modal-title" style={{ margin: 0, fontSize: 20, fontWeight: 800 }}>
            Kitchen Account &amp; System Verification
          </h2>
          <button
            type="button"
            className="btn secondary"
            style={{ minHeight: 38, padding: "6px 14px" }}
            onClick={props.onClose}
          >
            Close
          </button>
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
          {/* Account Switcher */}
          <div>
            <div style={{ fontWeight: 700, fontSize: 14, marginBottom: 8 }}>
              Switch Active Kitchen Account
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              {ACCOUNTS.map((acc) => {
                const selected = activeKey === acc.key;
                return (
                  <button
                    key={acc.key}
                    type="button"
                    className={`radio-card ${selected ? "selected" : ""}`}
                    onClick={() => {
                      setApiKey(acc.key);
                      props.onSwitchedOrReset(`Switched to ${acc.name}`);
                      props.onClose();
                    }}
                  >
                    <div style={{ fontWeight: 800, fontSize: 14.5 }}>
                      {selected ? "● " : "○ "}
                      {acc.name}
                    </div>
                    <div style={{ fontSize: 13, color: "var(--text-muted)", marginTop: 2 }}>
                      {acc.desc}
                    </div>
                  </button>
                );
              })}
            </div>
          </div>

          {/* Live System Health Pills */}
          {healthChecks && healthChecks.length > 0 && (
            <div className="card-subtle" style={{ padding: "12px 14px" }}>
              <div
                style={{
                  fontSize: 12.5,
                  fontWeight: 800,
                  color: "var(--text-muted)",
                  textTransform: "uppercase",
                  letterSpacing: "0.04em",
                  marginBottom: 8,
                }}
              >
                Live Gateway Health
              </div>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                {healthChecks.map((c) => (
                  <span
                    key={c.id}
                    className={`pill ${c.ok ? "green" : c.id === "llm" ? "amber" : "red"}`}
                    title={c.detail}
                  >
                    {c.ok ? "✓" : "•"} {c.label}
                    {c.ms != null ? ` (${c.ms}ms)` : ""}
                  </span>
                ))}
              </div>
            </div>
          )}

          {/* Judge & IT Verification Controls */}
          <div style={{ borderTop: "1px solid var(--border-light)", paddingTop: 16 }}>
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                gap: 10,
                flexWrap: "wrap",
                marginBottom: 6,
              }}
            >
              <div style={{ fontWeight: 700, fontSize: 14 }}>
                For IT &amp; Hackathon Judges (Kept Out of the Chef UI)
              </div>
              {props.runId && (
                <span className="pill blue mono" style={{ fontSize: 11.5 }}>
                  Run: {props.runId.slice(0, 12)}…
                </span>
              )}
            </div>
            <p style={{ margin: "0 0 12px", fontSize: 13.5, color: "var(--text-muted)" }}>
              External purchasing agents connect via OpenAPI 3.1 or MCP while the deterministic gateway enforces 17 spending &amp; allergen rules, Ed25519 signed price/stock claims, and SHA-256 hash-chained audit logs.
            </p>

            {verifyMsg && (
              <div
                className={`banner ${msgTone}`}
                style={{ marginBottom: 12, fontSize: 13.5, alignItems: "center" }}
              >
                <div style={{ fontWeight: 600 }}>{verifyMsg}</div>
              </div>
            )}

            {selfTest && (
              <div
                className="card-subtle"
                style={{ marginBottom: 14, display: "flex", flexDirection: "column", gap: 6 }}
              >
                <div
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    alignItems: "center",
                    fontSize: 12.5,
                    fontWeight: 700,
                    marginBottom: 4,
                  }}
                >
                  <span>End-to-End Pipeline Self-Test</span>
                  <span className="mono" style={{ color: "var(--text-muted)" }}>
                    {selfTest.ms} ms
                  </span>
                </div>
                {selfTest.steps.map((s) => (
                  <div
                    key={s.id}
                    style={{
                      display: "flex",
                      justifyContent: "space-between",
                      alignItems: "flex-start",
                      gap: 10,
                      fontSize: 12.5,
                      padding: "5px 0",
                      borderTop: "1px solid var(--border-light)",
                    }}
                  >
                    <div>
                      <span
                        style={{
                          fontWeight: 700,
                          color: s.ok ? "var(--green-text)" : "var(--red-text)",
                        }}
                      >
                        {s.ok ? "✓" : "✗"} {s.label}
                      </span>
                      <div style={{ color: "var(--text-muted)", fontSize: 12 }}>{s.detail}</div>
                    </div>
                    {s.ms != null && (
                      <span className="mono" style={{ color: "var(--text-soft)", flexShrink: 0 }}>
                        {s.ms}ms
                      </span>
                    )}
                  </div>
                ))}
              </div>
            )}

            {props.onOpenArena && (
              <button
                type="button"
                className="btn primary full"
                style={{ marginBottom: 10, minHeight: 44 }}
                onClick={() => {
                  props.onClose();
                  props.onOpenArena?.();
                }}
              >
                ⚡ Open Full Judge &amp; Security Lab →
              </button>
            )}

            <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
              <button
                type="button"
                className="btn secondary"
                style={{ minHeight: 42, fontSize: 13.5 }}
                disabled={verifying}
                onClick={() => void verifyAudit()}
              >
                {verifying ? "Verifying…" : "Verify Signed Audit Proof"}
              </button>
              <button
                type="button"
                className="btn secondary"
                style={{ minHeight: 42, fontSize: 13.5 }}
                disabled={selfTesting}
                onClick={() => void runEndToEndSelfTest()}
              >
                {selfTesting ? "Running Self-Test…" : "Run End-to-End System Self-Test"}
              </button>
              <a
                href="/openapi.json"
                target="_blank"
                rel="noreferrer"
                className="btn secondary"
                style={{ minHeight: 42, fontSize: 13.5, textDecoration: "none" }}
              >
                OpenAPI Spec ↗
              </a>
              <a
                href="/.well-known/jwks.json"
                target="_blank"
                rel="noreferrer"
                className="btn secondary"
                style={{ minHeight: 42, fontSize: 13.5, textDecoration: "none" }}
              >
                Ed25519 JWKS ↗
              </a>
              <button
                type="button"
                className="btn danger-outline"
                style={{ minHeight: 42, fontSize: 13.5 }}
                disabled={resetting}
                onClick={() => void resetDemo()}
              >
                {resetting ? "Resetting…" : "Reset Demo Data"}
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
