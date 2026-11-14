import { useCallback, useEffect, useRef, useState } from "react";
import { tidy } from "./format";
import { api } from "./api";
import { whoLabel } from "./agents";

// A blocked attempt is the guardrail working, not a failure.
const isGuardrail = (r: { title: string; outcome: string }) => r.outcome === "Refused" && /^Blocked attempt/i.test(r.title);
const uiTone = (r: Run) => (isGuardrail(r) ? "good" : r.tone);
const uiOutcome = (r: Run) => (isGuardrail(r) ? "Correctly refused" : r.outcome);

type Run = { runId: string; startedAt: string; endedAt: string; title: string; outcome: string; tone: "good" | "warn" | "bad" | "info"; events: number; clearedByReset?: boolean };
type Act = { id: number; agent?: string; at: string; actor: "agent" | "human" | "system" | "valio"; kind: string; text: string };
type Raw = { id: number; type: string; payload: unknown; hash: string; prevHash: string; createdAt: string };

const t = (iso: string) => new Date(iso).toLocaleString(undefined, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", second: "2-digit" });

export function AuditLog(props: {
  initialRunId?: string;
  selectedRunId?: string;
  onSelectRun?: (runId: string) => void;
}) {
  const { initialRunId, selectedRunId, onSelectRun } = props;
  const [runs, setRuns] = useState<Run[]>([]);
  const [sel, setSel] = useState<string | null>(selectedRunId || initialRunId || null);
  const [acts, setActs] = useState<Act[]>([]);
  const [raw, setRaw] = useState<Raw[]>([]);
  const [verify, setVerify] = useState<{ valid: boolean; headHash?: string; brokenAt?: number } | null>(null);
  const [tech, setTech] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const onSelectRunRef = useRef(onSelectRun);
  onSelectRunRef.current = onSelectRun;
  const selRef = useRef(sel);
  selRef.current = sel;

  const loadRuns = useCallback(async () => {
    try {
      const r = await api<{ runs: Run[] }>("/v1/audit-runs");
      setRuns(r.runs);
      setErr(null);
      const cur = selRef.current;
      const next = cur && r.runs.some((x) => x.runId === cur) ? cur : (r.runs[0]?.runId ?? null);
      if (next !== cur) {
        selRef.current = next;
        setSel(next);
      }
      if (next && next !== cur) {
        onSelectRunRef.current?.(next);
      }
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  }, []);
  useEffect(() => {
    void loadRuns();
  }, [loadRuns]);

  useEffect(() => {
    const incoming = selectedRunId || initialRunId;
    if (incoming && incoming !== selRef.current) {
      selRef.current = incoming;
      setSel(incoming);
    }
  }, [selectedRunId, initialRunId]);

  useEffect(() => {
    if (!sel) return;
    let alive = true;
    void (async () => {
      try {
        const [a, r] = await Promise.all([
          api<{ events: Act[] }>(`/v1/activity?runId=${sel}`),
          api<{ events: Raw[]; verification: { valid: boolean; headHash?: string; brokenAt?: number } }>(`/v1/audit/${sel}`),
        ]);
        if (!alive) return;
        setActs(a.events);
        setRaw(r.events);
        setVerify(r.verification);
        setErr(null);
      } catch (e) {
        if (alive) setErr(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => {
      alive = false;
    };
  }, [sel]);

  const run = runs.find((r) => r.runId === sel);
  const rawById = new Map(raw.map((r) => [r.id, r]));

  return (
    <div className="auditlog">
      {err && <div className="banner error">{err}</div>}
      <aside className="runs">
        <div className="tiny muted" style={{ padding: "0 0.3rem 0.4rem" }}>
          Agent runs, newest first
        </div>
        {runs.length === 0 && <p className="empty">No agent activity yet.</p>}
        {runs.map((r) => (
          <button
            key={r.runId}
            type="button"
            className={r.runId === sel ? "active" : ""}
            onClick={() => {
              selRef.current = r.runId;
              setSel(r.runId);
              onSelectRun?.(r.runId);
            }}
          >
            <strong title={r.title}>{tidy(r.title)}</strong>
            <span className={`o ${uiTone(r)}`}>{uiOutcome(r)}</span>
            <em>{t(r.endedAt)}</em>
            {r.clearedByReset && <em title="The demo was reset after this run; the order no longer exists, the audit record is kept.">order cleared by demo reset</em>}
          </button>
        ))}
      </aside>

      <section className="panel">
        {!run ? (
          <p className="empty">Select a run to see what the agent did and why.</p>
        ) : (
          <>
            <div className="row-between" style={{ alignItems: "flex-start" }}>
              <div>
                <h2>{tidy(run.title)}</h2>
                <p className={`o-line ${uiTone(run)}`}>{uiOutcome(run)}</p>
              </div>
              {verify && (
                <span className={`pill ${verify.valid ? "ok" : "bad"}`} title={verify.headHash ? `head ${verify.headHash}` : ""}>
                  <i /> {verify.valid ? "Tamper-evident chain verified" : `Chain broken at event ${verify.brokenAt}`}
                </span>
              )}
            </div>
            <ol className="story">
              {acts.map((e) => (
                <li key={e.id} className={/^Blocked:/.test(e.text) ? "good" : e.kind}>
                  <span className={`who ${e.actor}`}>{whoLabel(e.actor, e.agent)}</span>
                  <div>
                    <div>{tidy(e.text)}</div>
                    <div className="tiny muted">{t(e.at)}</div>
                    {tech && rawById.get(e.id) && (
                      <pre className="tech">
                        {JSON.stringify({ type: rawById.get(e.id)!.type, payload: rawById.get(e.id)!.payload, hash: rawById.get(e.id)!.hash, prev: rawById.get(e.id)!.prevHash }, null, 2)}
                      </pre>
                    )}
                  </div>
                </li>
              ))}
            </ol>
            <label className="tiny" style={{ display: "flex", gap: "0.4rem", alignItems: "center" }}>
              <input type="checkbox" checked={tech} onChange={(e) => setTech(e.target.checked)} />
              Show technical details (payloads and hashes)
            </label>
          </>
        )}
      </section>
    </div>
  );
}
