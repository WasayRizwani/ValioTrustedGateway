import { useEffect, useRef, useState } from "react";
import { api } from "./api";
import { AGENT_SHORT, type AgentId } from "./agents";
import { ChatMarkdown } from "./ChatMarkdown";

export type ChatBubble = {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  tools?: Array<{ agent?: string; name: string; ok: boolean; resultSummary: string }>;
  provider?: string;
};

type Props = {
  onNavigate?: (view: string) => void;
  onChanged?: () => void;
};

type NextAction = { label: string; view: string; tone: "good" | "warn" };

const DEMO_PROMPTS = [
  {
    label: "Run autonomous order · 100 L",
    prompt: "I need 100 litres of lactose-free milk by next Monday. Find the best available option and place the order automatically if it is within my mandate. If it needs approval, stop and tell me why.",
  },
  {
    label: "Run approval case · 3,000 L",
    prompt: "I need 3,000 litres of lactose-free milk by next Monday. Find the best available option and create an order intent. Do not override my mandate; send it for human approval if required.",
  },
];

function prettyResult(summary: string): string {
  try {
    return JSON.stringify(JSON.parse(summary), null, 2);
  } catch {
    return summary;
  }
}

export function AgentChat({ onNavigate, onChanged }: Props) {
  const [nextActions, setNextActions] = useState<NextAction[]>([]);
  const [bubbles, setBubbles] = useState<ChatBubble[]>([
    {
      id: "welcome",
      role: "assistant",
      content:
        "Describe what the kitchen needs. I'll use recipes, inventory, catalog, and mandate tools to propose or place orders — and stop for Approval when policy requires it.",
    },
  ]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [llm, setLlm] = useState<{
    configured: boolean;
    provider: string | null;
    model: string | null;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [statusLine, setStatusLine] = useState<string | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    void api<{
      configured: boolean;
      provider: string | null;
      model: string | null;
    }>("/v1/agent/status")
      .then(setLlm)
      .catch(() =>
        setLlm({ configured: false, provider: null, model: null }),
      );
  }, []);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [bubbles, busy, statusLine]);

  async function send(text: string) {
    const message = text.trim();
    if (!message || busy) return;
    setBusy(true);
    setError(null);
    setStatusLine("Calling agent…");
    setInput("");
    setBubbles((b) => [
      ...b,
      { id: `u-${Date.now()}`, role: "user", content: message },
    ]);

    try {
      const history = bubbles
        .filter((b) => b.role === "user" || b.role === "assistant")
        .filter((b) => b.id !== "welcome")
        .slice(-12)
        .map((b) => ({ role: b.role, content: b.content }));

      const res = await api<{
        reply: string;
        toolTrace: Array<{ agent?: string; name: string; ok: boolean; resultSummary: string }>;
        provider: string;
        model: string;
      }>("/v1/agent/chat", {
        method: "POST",
        body: JSON.stringify({ message, history }),
      });

      setBubbles((b) => [
        ...b,
        {
          id: `a-${Date.now()}`,
          role: "assistant",
          content: res.reply,
          tools: res.toolTrace,
          provider: `${res.provider}/${res.model}`,
        },
      ]);

      const okCount = res.toolTrace.filter((t) => t.ok).length;
      setStatusLine(
        res.toolTrace.length
          ? `Done · ${okCount}/${res.toolTrace.length} tools ok`
          : "Done · no tools used",
      );

      // Decide from what the tools actually did — not from words in the reply.
      const acts: NextAction[] = [];
      const placed = res.toolTrace.filter((t) => t.name === "commit_order" && t.ok && /"status":\s*"committed"|"orderId"/.test(t.resultSummary));
      const waiting = res.toolTrace.filter((t) => t.name === "create_order_intent" && t.ok && /"status":\s*"pending_approval"/.test(t.resultSummary));
      if (placed.length) acts.push({ label: `Order placed — view in Orders`, view: "orders", tone: "good" });
      if (waiting.length) acts.push({ label: "Waiting for your approval — review", view: "approval", tone: "warn" });
      setNextActions(acts);
      if (acts.length) onChanged?.();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setStatusLine(null);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="agent-shell">
      <div className="agent-toolbar">
        <div className="agent-toolbar-meta">
          <span className="pill-meta">
            {llm?.configured
              ? `${llm.provider} · ${llm.model}`
              : "Deterministic tools"}
          </span>
          {statusLine ? (
            <span className="pill-meta status">{statusLine}</span>
          ) : null}
          {nextActions.map((a) => (
            <button key={a.view} type="button" className={`btn ${a.tone === "warn" ? "primary" : ""}`} onClick={() => onNavigate?.(a.view)}>
              {a.label} →
            </button>
          ))}
        </div>
      </div>

      <div className="chat-log">
        {bubbles.length === 1 && (
          <div className="demo-prompts" role="group" aria-label="Try a demo scenario">
            <p className="tiny muted">Try the two challenge paths:</p>
            <div className="actions">
              {DEMO_PROMPTS.map((demo) => (
                <button
                  key={demo.label}
                  type="button"
                  className="btn"
                  disabled={busy}
                  onClick={() => void send(demo.prompt)}
                >
                  {demo.label}
                </button>
              ))}
              <button
                type="button"
                className="btn"
                onClick={() => onNavigate?.("connect")}
              >
                Connect an external agent
              </button>
            </div>
          </div>
        )}
        {bubbles.map((b) => (
          <div key={b.id} className={`bubble ${b.role}`}>
            <div className="bubble-meta">
              {b.role === "user" ? "You" : "Agent"}
              {b.provider ? ` · ${b.provider}` : ""}
            </div>
            <div className={`bubble-body${b.role === "user" ? " plain" : ""}`}>
              {b.role === "assistant" ? <ChatMarkdown text={b.content} /> : b.content}
            </div>
            {b.tools && b.tools.length > 0 && (
              <div className="tool-trace">
                <div className="tool-trace-label">
                  What ran ({b.tools.length})
                </div>
                {b.tools.map((t, i) => (
                  <details key={`${b.id}-${i}`}>
                    <summary>
                      <span className={t.ok ? "ok" : "fail"}>
                        {t.ok ? "ok" : "fail"}
                      </span>
                      {t.agent && <span className={`who ${t.agent === "valio-account" ? "valio" : "agent"}`}>{AGENT_SHORT[t.agent as AgentId] ?? t.agent}</span>}
                      <span className="tool-name">{t.name}</span>
                      <span className="tool-toggle">result</span>
                    </summary>
                    <pre>{prettyResult(t.resultSummary)}</pre>
                  </details>
                ))}
              </div>
            )}
          </div>
        ))}
        {busy && (
          <div className="bubble assistant">
            <div className="bubble-meta">Agent</div>
            <div className="bubble-body typing" role="status" aria-live="polite">
              <span className="typing-dots" aria-hidden="true"><i /><i /><i /></span>
              Thinking — checking kitchen data and gateway tools…
            </div>
          </div>
        )}
        <div ref={bottomRef} />
      </div>

      <div className="chat-footer">
        {error && <div className="banner error">{error}</div>}
        <form
          className="chat-compose"
          onSubmit={(e) => {
            e.preventDefault();
            void send(input);
          }}
        >
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="e.g. Restock for next week, or order 100 L lactose-free milk by Monday"
            disabled={busy}
          />
          <button
            type="submit"
            className="btn primary"
            disabled={busy || !input.trim()}
          >
            Send
          </button>
        </form>
      </div>
    </section>
  );
}
