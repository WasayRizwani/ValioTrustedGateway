import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "./api";
import {
  EVAL_PROMPT_CASES,
  FAILURE_REASON_TAGS,
  type EvalCategory,
  type EvalPromptCase,
} from "./evalPrompts";
import { tidy } from "./format";

export type EvalVerdict = "untested" | "accurate" | "partial" | "inaccurate";

export type EvalToolCall = {
  agent?: string;
  name: string;
  args?: unknown;
  resultSummary?: string;
  ok: boolean;
};

export type EvalTurnRecord = {
  userMessage: string;
  reply: string;
  toolTrace: EvalToolCall[];
  provider?: string;
  model?: string;
  latencyMs: number;
  ranAt: string;
  error?: string;
};

export type EvalCaseRecord = {
  caseId: string;
  customPrompt?: string;
  verdict: EvalVerdict;
  tags: string[];
  notes: string;
  turns: EvalTurnRecord[];
  updatedAt: string;
};

type LlmStatus = {
  configured: boolean;
  provider: string | null;
  model: string | null;
  baseUrl: string | null;
};

const STORAGE_KEY = "tta_llm_eval_bench_v1";

const CATEGORIES: EvalCategory[] = [
  "Multi-Item & Quantities",
  "Alternatives & Substitutes",
  "Inventory Caps & Limits",
  "Recipes, Menus & Events",
  "Mandate, Quotes & Security",
  "Ambiguity, Bilingual & Edge Cases",
];

function loadLocalState(): {
  records: Record<string, EvalCaseRecord>;
  customCases: EvalPromptCase[];
} {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { records: {}, customCases: [] };
    const parsed = JSON.parse(raw);
    return {
      records: parsed?.records && typeof parsed.records === "object" ? parsed.records : {},
      customCases: Array.isArray(parsed?.customCases) ? parsed.customCases : [],
    };
  } catch {
    return { records: {}, customCases: [] };
  }
}

export function getSavedInaccurateCount(): number {
  const { records } = loadLocalState();
  return Object.values(records).filter(
    (r) => r.verdict === "inaccurate" || r.verdict === "partial",
  ).length;
}

function renderReplyMarkdown(text: string) {
  const lines = tidy(text).split("\n");
  return lines.map((line, i) => {
    const trimmed = line.trim();
    if (!trimmed) return <div key={i} style={{ height: 6 }} />;
    const parts = line.split(/(\*\*[^*]+\*\*)/g);
    return (
      <div key={i} style={{ marginBottom: 4, lineHeight: 1.55 }}>
        {parts.map((part, j) =>
          part.startsWith("**") && part.endsWith("**") ? (
            <strong key={j}>{part.slice(2, -2)}</strong>
          ) : (
            <span key={j}>{part}</span>
          ),
        )}
      </div>
    );
  });
}

function formatJsonPretty(val: unknown): string {
  if (val === undefined || val === null) return "";
  if (typeof val === "string") {
    try {
      return JSON.stringify(JSON.parse(val), null, 2);
    } catch {
      return val;
    }
  }
  try {
    return JSON.stringify(val, null, 2);
  } catch {
    return String(val);
  }
}

export function PromptEvalView(props: {
  customerId: string;
  onChanged?: () => void;
  onMessage: (msg: string, tone?: "success" | "warn" | "info") => void;
}) {
  const initial = useMemo(() => loadLocalState(), []);
  const [records, setRecords] = useState<Record<string, EvalCaseRecord>>(initial.records);
  const [customCases, setCustomCases] = useState<EvalPromptCase[]>(initial.customCases);
  const [selectedId, setSelectedId] = useState<string>(EVAL_PROMPT_CASES[0]?.id ?? "P01");

  const [verdictFilter, setVerdictFilter] = useState<"all" | EvalVerdict>("all");
  const [categoryFilter, setCategoryFilter] = useState<string>("all");
  const [searchQuery, setSearchQuery] = useState<string>("");

  const [llmStatus, setLlmStatus] = useState<LlmStatus | null>(null);
  const [autoResetSeed, setAutoResetSeed] = useState<boolean>(true);
  const [runningId, setRunningId] = useState<string | null>(null);
  const [batchRunning, setBatchRunning] = useState<boolean>(false);
  const stopBatchRef = useRef<boolean>(false);

  const [followUpText, setFollowUpText] = useState<string>("");
  const [expandedTraces, setExpandedTraces] = useState<Record<string, boolean>>({});
  const [syncState, setSyncState] = useState<"idle" | "synced" | "local-only">("idle");

  // New custom prompt modal state
  const [addingCustom, setAddingCustom] = useState<boolean>(false);
  const [newTitle, setNewTitle] = useState<string>("");
  const [newCategory, setNewCategory] = useState<EvalCategory>("Multi-Item & Quantities");
  const [newPrompt, setNewPrompt] = useState<string>("");
  const [newExpected, setNewExpected] = useState<string>("");

  const allCases = useMemo(
    () => [...EVAL_PROMPT_CASES, ...customCases],
    [customCases],
  );

  // Hydrate from server file if local state is empty
  useEffect(() => {
    api<LlmStatus>("/v1/agent/status")
      .then(setLlmStatus)
      .catch(() => setLlmStatus(null));

    api<{
      updatedAt: string | null;
      records?: Record<string, EvalCaseRecord>;
      customCases?: EvalPromptCase[];
    }>("/v1/eval/results")
      .then((serverData) => {
        if (!serverData?.updatedAt) return;
        setRecords((prev) => {
          if (Object.keys(prev).length > 0) return prev;
          return serverData.records ?? {};
        });
        setCustomCases((prev) => {
          if (prev.length > 0) return prev;
          return serverData.customCases ?? [];
        });
        setSyncState("synced");
      })
      .catch(() => {
        setSyncState("local-only");
      });
  }, []);

  // Persist to localStorage + sync to gateway data/llm-eval-results.json
  const persistTimerRef = useRef<number | null>(null);
  const persistAll = useCallback(
    (nextRecords: Record<string, EvalCaseRecord>, nextCustom: EvalPromptCase[]) => {
      try {
        localStorage.setItem(
          STORAGE_KEY,
          JSON.stringify({ records: nextRecords, customCases: nextCustom }),
        );
      } catch {
        // Ignore storage quota errors
      }
      if (persistTimerRef.current) window.clearTimeout(persistTimerRef.current);
      persistTimerRef.current = window.setTimeout(() => {
        api("/v1/eval/results", {
          method: "POST",
          body: JSON.stringify({ records: nextRecords, customCases: nextCustom }),
        })
          .then(() => setSyncState("synced"))
          .catch(() => setSyncState("local-only"));
      }, 350);
    },
    [],
  );

  const updateCaseRecord = useCallback(
    (caseId: string, updater: (prev: EvalCaseRecord) => EvalCaseRecord) => {
      setRecords((prev) => {
        const existing: EvalCaseRecord = prev[caseId] ?? {
          caseId,
          verdict: "untested",
          tags: [],
          notes: "",
          turns: [],
          updatedAt: new Date().toISOString(),
        };
        const updated = { ...updater(existing), updatedAt: new Date().toISOString() };
        const next = { ...prev, [caseId]: updated };
        persistAll(next, customCases);
        return next;
      });
    },
    [customCases, persistAll],
  );

  const selectedCase = useMemo(
    () => allCases.find((c) => c.id === selectedId) ?? allCases[0]!,
    [allCases, selectedId],
  );

  const selectedRecord: EvalCaseRecord = records[selectedCase.id] ?? {
    caseId: selectedCase.id,
    verdict: "untested",
    tags: [],
    notes: "",
    turns: [],
    updatedAt: "",
  };

  const activePromptText = selectedRecord.customPrompt ?? selectedCase.prompt;

  const filteredCases = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return allCases.filter((c) => {
      const rec = records[c.id];
      const v: EvalVerdict = rec?.verdict ?? "untested";
      if (verdictFilter !== "all" && v !== verdictFilter) return false;
      if (categoryFilter !== "all" && c.category !== categoryFilter) return false;
      if (q) {
        const hay = `${c.id} ${c.title} ${c.category} ${rec?.customPrompt ?? c.prompt} ${rec?.notes ?? ""} ${(rec?.tags ?? []).join(" ")}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }, [allCases, records, verdictFilter, categoryFilter, searchQuery]);

  const stats = useMemo(() => {
    let tested = 0;
    let accurate = 0;
    let partial = 0;
    let inaccurate = 0;
    for (const c of allCases) {
      const rec = records[c.id];
      if ((rec?.turns?.length ?? 0) > 0 || (rec && rec.verdict !== "untested")) {
        tested += 1;
      }
      if (rec?.verdict === "accurate") accurate += 1;
      else if (rec?.verdict === "partial") partial += 1;
      else if (rec?.verdict === "inaccurate") inaccurate += 1;
    }
    const graded = accurate + partial + inaccurate;
    const accuracyPct = graded > 0 ? Math.round((accurate / graded) * 100) : null;
    return { total: allCases.length, tested, accurate, partial, inaccurate, graded, accuracyPct };
  }, [allCases, records]);

  async function resetDemoKitchen(silent = false) {
    try {
      await api("/v1/admin/demo-reset", {
        method: "POST",
        headers: {
          "X-Demo-Reset": "confirm",
          "X-Reset-Source": "llm-eval-bench",
        },
        body: JSON.stringify({}),
      });
      props.onChanged?.();
      if (!silent) {
        props.onMessage("Kitchen inventory, orders & mandate reset to clean seed state.", "info");
      }
    } catch (e) {
      if (!silent) {
        props.onMessage(
          `Demo reset failed (make sure you're on Buyer key): ${e instanceof Error ? e.message : String(e)}`,
          "warn",
        );
      }
    }
  }

  async function executeCaseTurn(
    targetCase: EvalPromptCase,
    options?: { followUp?: string; keepHistory?: boolean },
  ) {
    const rec = records[targetCase.id];
    const isFollowUp = Boolean(options?.followUp && options?.keepHistory);
    const messageToSend = isFollowUp
      ? options!.followUp!.trim()
      : (rec?.customPrompt ?? targetCase.prompt).trim();
    if (!messageToSend) return;

    setRunningId(targetCase.id);
    const started = performance.now();

    try {
      if (!isFollowUp && autoResetSeed && targetCase.seedStateSensitive) {
        await resetDemoKitchen(true);
      }

      const historyPayload = isFollowUp
        ? (rec?.turns ?? []).flatMap((t) => [
            { role: "user" as const, content: t.userMessage },
            { role: "assistant" as const, content: t.reply },
          ])
        : [];

      const res = await api<{
        reply: string;
        toolTrace?: EvalToolCall[];
        provider?: string;
        model?: string;
      }>("/v1/agent/chat", {
        method: "POST",
        body: JSON.stringify({
          message: messageToSend,
          history: historyPayload,
        }),
      });

      const latencyMs = Math.round(performance.now() - started);
      const turn: EvalTurnRecord = {
        userMessage: messageToSend,
        reply: res.reply ?? "",
        toolTrace: res.toolTrace ?? [],
        provider: res.provider,
        model: res.model,
        latencyMs,
        ranAt: new Date().toISOString(),
      };

      updateCaseRecord(targetCase.id, (prev) => ({
        ...prev,
        turns: isFollowUp ? [...prev.turns, turn] : [turn],
      }));
      if (isFollowUp) setFollowUpText("");
      props.onChanged?.();
    } catch (e) {
      const latencyMs = Math.round(performance.now() - started);
      const errMsg = e instanceof Error ? e.message : String(e);
      const turn: EvalTurnRecord = {
        userMessage: messageToSend,
        reply: "",
        toolTrace: [],
        latencyMs,
        ranAt: new Date().toISOString(),
        error: errMsg,
      };
      updateCaseRecord(targetCase.id, (prev) => ({
        ...prev,
        turns: isFollowUp ? [...prev.turns, turn] : [turn],
      }));
    } finally {
      setRunningId(null);
    }
  }

  async function runBatchUntested() {
    const queue = filteredCases.filter((c) => {
      const r = records[c.id];
      return !r || (r.turns.length === 0 && r.verdict === "untested");
    });
    if (queue.length === 0) {
      props.onMessage("All prompts in the current filter have already been run.", "info");
      return;
    }
    stopBatchRef.current = false;
    setBatchRunning(true);
    for (const item of queue) {
      if (stopBatchRef.current) break;
      setSelectedId(item.id);
      await executeCaseTurn(item);
    }
    setBatchRunning(false);
    stopBatchRef.current = false;
    props.onMessage("Batch run finished — review outputs and mark accuracy.", "success");
  }

  function addCustomPromptCase() {
    const promptTrimmed = newPrompt.trim();
    if (!promptTrimmed) return;
    const nextNum = allCases.length + 1;
    const id = `P${String(nextNum).padStart(2, "0")}`;
    const created: EvalPromptCase = {
      id,
      category: newCategory,
      title: newTitle.trim() || `Custom case ${id}`,
      difficulty: "Hard",
      prompt: promptTrimmed,
      expectedBehavior: newExpected
        .split("\n")
        .map((s) => s.trim())
        .filter(Boolean),
    };
    const nextCustom = [...customCases, created];
    setCustomCases(nextCustom);
    persistAll(records, nextCustom);
    setSelectedId(id);
    setAddingCustom(false);
    setNewTitle("");
    setNewPrompt("");
    setNewExpected("");
    props.onMessage(`Added custom test prompt ${id}.`, "success");
  }

  function buildMarkdownFailureReport(): string {
    const flagged = allCases
      .map((c) => ({ c, r: records[c.id] }))
      .filter(({ r }) => r && (r.verdict === "inaccurate" || r.verdict === "partial"));

    const lines: string[] = [
      `# Valio Aimo LLM Purchasing Agent — Evaluation Report`,
      `- **Generated:** ${new Date().toISOString()}`,
      `- **Customer:** ${props.customerId}`,
      `- **Model:** ${llmStatus?.provider ?? "unknown"} / ${llmStatus?.model ?? "heuristic"}`,
      `- **Summary:** ${stats.tested}/${stats.total} run · ✅ ${stats.accurate} accurate · ⚠️ ${stats.partial} partial · ❌ ${stats.inaccurate} inaccurate`,
      ``,
    ];

    if (flagged.length === 0) {
      lines.push(`_No cases marked inaccurate or partial yet._`);
      return lines.join("\n");
    }

    lines.push(`## Flagged Cases (${flagged.length})`, ``);
    for (const { c, r } of flagged) {
      if (!r) continue;
      const lastTurn = r.turns[r.turns.length - 1];
      const toolChain =
        lastTurn?.toolTrace?.map((t) => `${t.name}(${t.ok ? "ok" : "ERR"})`).join(" → ") ||
        "(no tools called)";
      lines.push(
        `### ${c.id}: ${c.title} [${r.verdict.toUpperCase()}]`,
        `- **Category:** ${c.category}`,
        `- **Prompt:** ${r.customPrompt ?? c.prompt}`,
        `- **Issue Tags:** ${r.tags.length ? r.tags.join(", ") : "none"}`,
        `- **Evaluator Notes:** ${r.notes || "(none)"}`,
        `- **Expected:** ${c.expectedBehavior.join(" ")}`,
        `- **Tools Called:** \`${toolChain}\``,
        `- **LLM Reply:**`,
        `> ${(lastTurn?.error ? `ERROR: ${lastTurn.error}` : lastTurn?.reply || "(not run)").replace(/\n/g, "\n> ")}`,
        ``,
      );
    }
    return lines.join("\n");
  }

  async function copyInaccurateReport() {
    const md = buildMarkdownFailureReport();
    try {
      await navigator.clipboard.writeText(md);
      props.onMessage("Copied Markdown report of inaccurate/partial cases to clipboard!", "success");
    } catch {
      props.onMessage("Could not access clipboard — use Export JSON instead.", "warn");
    }
  }

  function downloadJsonReport() {
    const blob = new Blob(
      [
        JSON.stringify(
          {
            exportedAt: new Date().toISOString(),
            customerId: props.customerId,
            llm: llmStatus,
            stats,
            cases: allCases.map((c) => ({
              ...c,
              evaluation: records[c.id] ?? null,
            })),
          },
          null,
          2,
        ),
      ],
      { type: "application/json" },
    );
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `llm-eval-results-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }

  // Automated sanity checks on the latest run of selectedCase
  const sanityWarnings = useMemo(() => {
    const turns = selectedRecord.turns;
    if (!turns.length) return [];
    const warnings: string[] = [];
    const calledTools = new Set(
      turns.flatMap((t) => t.toolTrace.map((tr) => tr.name)),
    );
    const failedTools = turns.flatMap((t) =>
      t.toolTrace.filter((tr) => !tr.ok).map((tr) => tr.name),
    );
    for (const forbidden of selectedCase.forbiddenTools ?? []) {
      if (calledTools.has(forbidden)) {
        warnings.push(
          `Forbidden tool "${forbidden}" was called! (Expected strictly blocked/read-only or unapproved behavior.)`,
        );
      }
    }
    if ((selectedCase.expectedTools?.length ?? 0) > 0 && calledTools.size === 0) {
      warnings.push("LLM replied without calling any gateway tools.");
    }
    for (const expected of selectedCase.expectedTools ?? []) {
      if (!calledTools.has(expected)) {
        warnings.push(`Expected tool "${expected}" was not called in this run.`);
      }
    }
    if (failedTools.length > 0) {
      warnings.push(`Tool execution error(s): ${failedTools.join(", ")}`);
    }
    return warnings;
  }, [selectedCase, selectedRecord.turns]);

  const currentIdx = filteredCases.findIndex((c) => c.id === selectedCase.id);
  const prevCase = currentIdx > 0 ? filteredCases[currentIdx - 1] : null;
  const nextCase =
    currentIdx >= 0 && currentIdx < filteredCases.length - 1
      ? filteredCases[currentIdx + 1]
      : null;

  const verdictBadge = (v: EvalVerdict, hasRun: boolean) => {
    if (v === "accurate")
      return { label: "✅ Accurate", bg: "#ecfdf5", color: "#065f46", border: "#a7f3d0" };
    if (v === "partial")
      return { label: "⚠️ Partial", bg: "#fffbeb", color: "#92400e", border: "#fde68a" };
    if (v === "inaccurate")
      return { label: "❌ Inaccurate", bg: "#fef2f2", color: "#991b1b", border: "#fecaca" };
    if (hasRun)
      return { label: "🔵 Needs Grade", bg: "#eff6ff", color: "#1d4ed8", border: "#bfdbfe" };
    return { label: "⚪ Untested", bg: "#f8fafc", color: "#64748b", border: "#e2e8f0" };
  };

  return (
    <div style={{ maxWidth: 1340, margin: "20px auto 48px", padding: "0 20px" }}>
      {/* Top Header & KPI Bar */}
      <div
        style={{
          background: "var(--bg-card)",
          border: "1px solid var(--border-light)",
          borderRadius: "var(--radius-lg)",
          padding: "18px 22px",
          boxShadow: "var(--shadow-card)",
          marginBottom: 18,
        }}
      >
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "flex-start",
            gap: 16,
            flexWrap: "wrap",
          }}
        >
          <div>
            <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
              <h1 style={{ margin: 0, fontSize: 21, fontWeight: 800 }}>
                🧪 LLM Purchasing Agent — Robustness Eval Bench
              </h1>
              <span
                style={{
                  fontSize: 12,
                  fontWeight: 700,
                  padding: "4px 10px",
                  borderRadius: 999,
                  background: llmStatus?.configured ? "#eff6ff" : "#fffbeb",
                  color: llmStatus?.configured ? "#0052cc" : "#92400e",
                  border: `1px solid ${llmStatus?.configured ? "#bfdbfe" : "#fde68a"}`,
                }}
              >
                {llmStatus?.configured
                  ? `LLM: ${llmStatus.provider} · ${llmStatus.model}`
                  : "Heuristic Fallback (No LLM API key in .env)"}
              </span>
              <span
                style={{
                  fontSize: 12,
                  color: "var(--text-soft)",
                  fontWeight: 600,
                }}
              >
                {syncState === "synced"
                  ? "✓ Auto-saved to data/llm-eval-results.json"
                  : "✓ Auto-saved in browser"}
              </span>
            </div>
            <p style={{ margin: "6px 0 0", fontSize: 14, color: "var(--text-muted)" }}>
              Run complex multi-item, substitute, inventory-cap, recipe, and security prompts against{" "}
              <code>/v1/agent/chat</code>, inspect tool traces, and mark inaccurate cases so we can
              harden the agent.
            </p>
          </div>

          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
            {batchRunning ? (
              <button
                type="button"
                className="btn"
                style={{
                  background: "#dc2626",
                  color: "#fff",
                  minHeight: 38,
                  padding: "7px 14px",
                  fontSize: 13,
                }}
                onClick={() => {
                  stopBatchRef.current = true;
                }}
              >
                ⏹ Stop Batch
              </button>
            ) : (
              <button
                type="button"
                className="btn secondary"
                style={{ minHeight: 38, padding: "7px 14px", fontSize: 13 }}
                disabled={runningId !== null}
                onClick={() => void runBatchUntested()}
                title="Sequentially execute all untested prompts in the current filter"
              >
                ⏩ Run Untested
              </button>
            )}

            <button
              type="button"
              className="btn secondary"
              style={{ minHeight: 38, padding: "7px 14px", fontSize: 13 }}
              disabled={runningId !== null}
              onClick={() => void resetDemoKitchen(false)}
              title="Reset inventory, intents, events & mandate back to clean HOTEL-001 seed data"
            >
              ↺ Reset Kitchen State
            </button>

            <button
              type="button"
              className="btn secondary"
              style={{ minHeight: 38, padding: "7px 14px", fontSize: 13 }}
              onClick={() => setAddingCustom((v) => !v)}
            >
              + Custom Prompt
            </button>

            <button
              type="button"
              className="btn secondary"
              style={{ minHeight: 38, padding: "7px 14px", fontSize: 13 }}
              onClick={() => void copyInaccurateReport()}
            >
              📋 Copy Flagged Report ({stats.inaccurate + stats.partial})
            </button>

            <button
              type="button"
              className="btn secondary"
              style={{ minHeight: 38, padding: "7px 14px", fontSize: 13 }}
              onClick={downloadJsonReport}
            >
              ⬇ JSON
            </button>
          </div>
        </div>

        {/* Scoreboard + Auto-Reset Toggle */}
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            gap: 12,
            flexWrap: "wrap",
            marginTop: 14,
            paddingTop: 14,
            borderTop: "1px solid var(--border-light)",
          }}
        >
          <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
            <span
              style={{
                padding: "5px 12px",
                borderRadius: 999,
                fontSize: 13,
                fontWeight: 700,
                background: "var(--bg-subtle)",
              }}
            >
              Run: {stats.tested} / {stats.total}
            </span>
            <span
              style={{
                padding: "5px 12px",
                borderRadius: 999,
                fontSize: 13,
                fontWeight: 700,
                background: "#ecfdf5",
                color: "#065f46",
                border: "1px solid #a7f3d0",
              }}
            >
              ✅ Accurate: {stats.accurate}
            </span>
            <span
              style={{
                padding: "5px 12px",
                borderRadius: 999,
                fontSize: 13,
                fontWeight: 700,
                background: "#fffbeb",
                color: "#92400e",
                border: "1px solid #fde68a",
              }}
            >
              ⚠️ Partial: {stats.partial}
            </span>
            <span
              style={{
                padding: "5px 12px",
                borderRadius: 999,
                fontSize: 13,
                fontWeight: 700,
                background: "#fef2f2",
                color: "#991b1b",
                border: "1px solid #fecaca",
              }}
            >
              ❌ Inaccurate: {stats.inaccurate}
            </span>
            {stats.accuracyPct !== null && (
              <span
                style={{
                  padding: "5px 12px",
                  borderRadius: 999,
                  fontSize: 13,
                  fontWeight: 800,
                  background: "#eff6ff",
                  color: "#0052cc",
                }}
              >
                Pass Rate: {stats.accuracyPct}%
              </span>
            )}
          </div>

          <label
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 8,
              fontSize: 13,
              color: "var(--text-muted)",
              cursor: "pointer",
              userSelect: "none",
            }}
          >
            <input
              type="checkbox"
              checked={autoResetSeed}
              onChange={(e) => setAutoResetSeed(e.target.checked)}
            />
            Auto-reset seed inventory before <strong>[Seed Stock]</strong> prompts
          </label>
        </div>

        {/* Inline Add Custom Case Drawer */}
        {addingCustom && (
          <div
            style={{
              marginTop: 16,
              padding: 16,
              borderRadius: "var(--radius-md)",
              background: "var(--bg-subtle)",
              border: "1px solid var(--border-strong)",
            }}
          >
            <div style={{ fontWeight: 700, fontSize: 14, marginBottom: 10 }}>
              Add New Custom Test Prompt
            </div>
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "2fr 1fr",
                gap: 10,
                marginBottom: 10,
              }}
            >
              <input
                type="text"
                placeholder="Short case title (e.g. 5-item Friday banquet + nut allergy)"
                value={newTitle}
                onChange={(e) => setNewTitle(e.target.value)}
                style={{
                  padding: "9px 12px",
                  borderRadius: 8,
                  border: "1px solid var(--border-strong)",
                  fontSize: 14,
                }}
              />
              <select
                value={newCategory}
                onChange={(e) => setNewCategory(e.target.value as EvalCategory)}
                style={{
                  padding: "9px 12px",
                  borderRadius: 8,
                  border: "1px solid var(--border-strong)",
                  fontSize: 14,
                  background: "#fff",
                }}
              >
                {CATEGORIES.map((cat) => (
                  <option key={cat} value={cat}>
                    {cat}
                  </option>
                ))}
              </select>
            </div>
            <textarea
              rows={3}
              placeholder="Complex prompt to send to the LLM..."
              value={newPrompt}
              onChange={(e) => setNewPrompt(e.target.value)}
              style={{
                width: "100%",
                padding: "10px 12px",
                borderRadius: 8,
                border: "1px solid var(--border-strong)",
                fontSize: 14,
                fontFamily: "inherit",
                marginBottom: 8,
              }}
            />
            <textarea
              rows={2}
              placeholder="Expected behavior (one bullet per line, optional)..."
              value={newExpected}
              onChange={(e) => setNewExpected(e.target.value)}
              style={{
                width: "100%",
                padding: "8px 12px",
                borderRadius: 8,
                border: "1px solid var(--border-strong)",
                fontSize: 13,
                fontFamily: "inherit",
                marginBottom: 10,
              }}
            />
            <div style={{ display: "flex", gap: 8 }}>
              <button
                type="button"
                className="btn primary"
                style={{ minHeight: 36, padding: "6px 14px", fontSize: 13 }}
                onClick={addCustomPromptCase}
              >
                Add Case
              </button>
              <button
                type="button"
                className="btn secondary"
                style={{ minHeight: 36, padding: "6px 14px", fontSize: 13 }}
                onClick={() => setAddingCustom(false)}
              >
                Cancel
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Main Split Workspace */}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "minmax(310px, 370px) minmax(0, 1fr)",
          gap: 18,
          alignItems: "start",
        }}
      >
        {/* Left Sidebar: Filters + Case List */}
        <aside
          style={{
            background: "var(--bg-card)",
            border: "1px solid var(--border-light)",
            borderRadius: "var(--radius-lg)",
            padding: 14,
            boxShadow: "var(--shadow-card)",
            position: "sticky",
            top: 82,
            maxHeight: "calc(100vh - 104px)",
            display: "flex",
            flexDirection: "column",
            gap: 10,
          }}
        >
          <input
            type="search"
            placeholder="Search ID, prompt, tag, notes..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            style={{
              width: "100%",
              padding: "8px 12px",
              borderRadius: 10,
              border: "1px solid var(--border-strong)",
              fontSize: 13,
            }}
          />

          <select
            value={categoryFilter}
            onChange={(e) => setCategoryFilter(e.target.value)}
            style={{
              width: "100%",
              padding: "8px 10px",
              borderRadius: 10,
              border: "1px solid var(--border-strong)",
              fontSize: 13,
              background: "#fff",
            }}
          >
            <option value="all">All Categories ({allCases.length})</option>
            {CATEGORIES.map((cat) => (
              <option key={cat} value={cat}>
                {cat}
              </option>
            ))}
          </select>

          <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
            {(
              [
                ["all", "All"],
                ["untested", "Untested"],
                ["inaccurate", "❌ Inaccurate"],
                ["partial", "⚠️ Partial"],
                ["accurate", "✅ Accurate"],
              ] as const
            ).map(([id, label]) => (
              <button
                key={id}
                type="button"
                onClick={() => setVerdictFilter(id)}
                style={{
                  padding: "4px 9px",
                  fontSize: 12,
                  fontWeight: 700,
                  borderRadius: 999,
                  border:
                    verdictFilter === id
                      ? "1px solid var(--brand-blue)"
                      : "1px solid var(--border-light)",
                  background: verdictFilter === id ? "#eff6ff" : "var(--bg-subtle)",
                  color: verdictFilter === id ? "var(--brand-blue)" : "var(--text-muted)",
                  cursor: "pointer",
                }}
              >
                {label}
              </button>
            ))}
          </div>

          <div
            style={{
              overflowY: "auto",
              display: "flex",
              flexDirection: "column",
              gap: 7,
              paddingRight: 2,
            }}
          >
            {filteredCases.map((c) => {
              const rec = records[c.id];
              const hasRun = (rec?.turns?.length ?? 0) > 0;
              const badge = verdictBadge(rec?.verdict ?? "untested", hasRun);
              const isSelected = c.id === selectedCase.id;
              const isRunning = runningId === c.id;
              const lastTurn = rec?.turns?.[rec.turns.length - 1];

              return (
                <button
                  key={c.id}
                  type="button"
                  onClick={() => setSelectedId(c.id)}
                  style={{
                    textAlign: "left",
                    padding: "10px 12px",
                    borderRadius: 12,
                    border: isSelected
                      ? "2px solid var(--brand-blue)"
                      : "1px solid var(--border-light)",
                    background: isSelected ? "#eff6ff" : "#fff",
                    cursor: "pointer",
                    fontFamily: "inherit",
                  }}
                >
                  <div
                    style={{
                      display: "flex",
                      justifyContent: "space-between",
                      alignItems: "center",
                      gap: 6,
                      marginBottom: 4,
                    }}
                  >
                    <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                      <span style={{ fontWeight: 800, fontSize: 13, color: "var(--brand-navy)" }}>
                        {c.id}
                      </span>
                      <span
                        style={{
                          fontSize: 11,
                          padding: "1px 6px",
                          borderRadius: 6,
                          background:
                            c.difficulty === "Adversarial"
                              ? "#fef2f2"
                              : c.difficulty === "Hard"
                                ? "#fffbeb"
                                : "#f1f5f9",
                          color:
                            c.difficulty === "Adversarial"
                              ? "#991b1b"
                              : c.difficulty === "Hard"
                                ? "#92400e"
                                : "#475569",
                          fontWeight: 700,
                        }}
                      >
                        {c.difficulty}
                      </span>
                      {c.seedStateSensitive && (
                        <span
                          style={{
                            fontSize: 10,
                            padding: "1px 5px",
                            borderRadius: 5,
                            background: "#f1f5f9",
                            color: "#475569",
                            fontWeight: 600,
                          }}
                          title="Depends on seed inventory/recipe numbers"
                        >
                          Seed Stock
                        </span>
                      )}
                    </div>

                    <span
                      style={{
                        fontSize: 11,
                        fontWeight: 700,
                        padding: "2px 7px",
                        borderRadius: 999,
                        background: badge.bg,
                        color: badge.color,
                        border: `1px solid ${badge.border}`,
                      }}
                    >
                      {isRunning ? "⏳ Running..." : badge.label}
                    </span>
                  </div>

                  <div
                    style={{
                      fontSize: 13,
                      fontWeight: 700,
                      color: "var(--text-main)",
                      lineHeight: 1.35,
                    }}
                  >
                    {c.title}
                  </div>

                  <div
                    style={{
                      display: "flex",
                      justifyContent: "space-between",
                      fontSize: 11,
                      color: "var(--text-soft)",
                      marginTop: 5,
                    }}
                  >
                    <span>{c.category}</span>
                    {lastTurn && (
                      <span>
                        {lastTurn.toolTrace.length} tool{lastTurn.toolTrace.length === 1 ? "" : "s"}{" "}
                        · {(lastTurn.latencyMs / 1000).toFixed(1)}s
                      </span>
                    )}
                  </div>
                </button>
              );
            })}

            {filteredCases.length === 0 && (
              <div
                style={{
                  padding: 20,
                  textAlign: "center",
                  color: "var(--text-soft)",
                  fontSize: 13,
                }}
              >
                No prompts match the current filter.
              </div>
            )}
          </div>
        </aside>

        {/* Right Workspace: Selected Case Details, Execution, Trace & Grading */}
        <section style={{ display: "flex", flexDirection: "column", gap: 16 }}>
          {/* 1. Case Header & Prompt Input Card */}
          <div
            style={{
              background: "var(--bg-card)",
              border: "1px solid var(--border-light)",
              borderRadius: "var(--radius-lg)",
              padding: "18px 22px",
              boxShadow: "var(--shadow-card)",
            }}
          >
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                gap: 10,
                flexWrap: "wrap",
                marginBottom: 10,
              }}
            >
              <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                <span
                  style={{
                    fontSize: 14,
                    fontWeight: 800,
                    padding: "3px 10px",
                    borderRadius: 8,
                    background: "var(--brand-navy)",
                    color: "#fff",
                  }}
                >
                  {selectedCase.id}
                </span>
                <span
                  style={{
                    fontSize: 12,
                    fontWeight: 700,
                    padding: "3px 10px",
                    borderRadius: 999,
                    background: "var(--bg-subtle)",
                    color: "var(--text-muted)",
                  }}
                >
                  {selectedCase.category}
                </span>
                {selectedCase.seedStateSensitive && (
                  <span
                    style={{
                      fontSize: 12,
                      fontWeight: 700,
                      padding: "3px 10px",
                      borderRadius: 999,
                      background: "#eff6ff",
                      color: "#0052cc",
                    }}
                  >
                    📦 Uses Seed Inventory/Recipes
                  </span>
                )}
              </div>

              <div style={{ display: "flex", gap: 6 }}>
                <button
                  type="button"
                  className="btn secondary"
                  style={{ minHeight: 34, padding: "4px 12px", fontSize: 13 }}
                  disabled={!prevCase}
                  onClick={() => prevCase && setSelectedId(prevCase.id)}
                >
                  ← Prev
                </button>
                <button
                  type="button"
                  className="btn secondary"
                  style={{ minHeight: 34, padding: "4px 12px", fontSize: 13 }}
                  disabled={!nextCase}
                  onClick={() => nextCase && setSelectedId(nextCase.id)}
                >
                  Next →
                </button>
              </div>
            </div>

            <h2 style={{ margin: "0 0 12px", fontSize: 19, fontWeight: 800 }}>
              {selectedCase.title}
            </h2>

            <label
              style={{
                display: "block",
                fontSize: 12,
                fontWeight: 700,
                textTransform: "uppercase",
                letterSpacing: "0.04em",
                color: "var(--text-soft)",
                marginBottom: 6,
              }}
            >
              Prompt Sent to Purchasing Agent (Editable)
            </label>
            <textarea
              rows={3}
              value={activePromptText}
              onChange={(e) =>
                updateCaseRecord(selectedCase.id, (prev) => ({
                  ...prev,
                  customPrompt:
                    e.target.value === selectedCase.prompt ? undefined : e.target.value,
                }))
              }
              style={{
                width: "100%",
                padding: "12px 14px",
                borderRadius: 12,
                border: "1px solid var(--border-strong)",
                fontSize: 15,
                lineHeight: 1.5,
                fontFamily: "inherit",
                background: "#f8fafc",
              }}
            />

            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                gap: 10,
                flexWrap: "wrap",
                marginTop: 12,
              }}
            >
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                <button
                  type="button"
                  className="btn primary"
                  disabled={runningId !== null}
                  onClick={() => void executeCaseTurn(selectedCase)}
                  style={{ minHeight: 42, padding: "8px 18px", fontSize: 14 }}
                >
                  {runningId === selectedCase.id
                    ? "⏳ Running against /v1/agent/chat..."
                    : selectedRecord.turns.length > 0
                      ? "↻ Re-Run Prompt Against LLM"
                      : "▶ Run Prompt Against LLM"}
                </button>

                <button
                  type="button"
                  className="btn secondary"
                  style={{ minHeight: 42, padding: "8px 14px", fontSize: 13 }}
                  onClick={() => {
                    void navigator.clipboard.writeText(activePromptText);
                    props.onMessage("Prompt copied to clipboard.", "info");
                  }}
                >
                  📋 Copy Prompt
                </button>

                {selectedRecord.customPrompt !== undefined && (
                  <button
                    type="button"
                    className="btn secondary"
                    style={{ minHeight: 42, padding: "8px 14px", fontSize: 13 }}
                    onClick={() =>
                      updateCaseRecord(selectedCase.id, (prev) => ({
                        ...prev,
                        customPrompt: undefined,
                      }))
                    }
                  >
                    Restore Original Prompt
                  </button>
                )}
              </div>
            </div>
          </div>

          {/* 2. Expected Behavior & Automated Sanity Warnings */}
          <div
            style={{
              background: "var(--bg-card)",
              border: "1px solid var(--border-light)",
              borderRadius: "var(--radius-lg)",
              padding: "16px 22px",
              boxShadow: "var(--shadow-card)",
            }}
          >
            <div style={{ fontWeight: 800, fontSize: 14, marginBottom: 8 }}>
              🎯 Expected Accurate Behavior
            </div>
            <ul style={{ margin: 0, paddingLeft: 20, fontSize: 14, color: "var(--text-muted)" }}>
              {selectedCase.expectedBehavior.map((b, idx) => (
                <li key={idx} style={{ marginBottom: 5 }}>
                  {b}
                </li>
              ))}
            </ul>

            {((selectedCase.expectedTools?.length ?? 0) > 0 ||
              (selectedCase.forbiddenTools?.length ?? 0) > 0) && (
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 10 }}>
                {selectedCase.expectedTools?.map((t) => (
                  <span
                    key={`exp-${t}`}
                    style={{
                      fontSize: 12,
                      padding: "3px 9px",
                      borderRadius: 999,
                      background: "#ecfdf5",
                      color: "#065f46",
                      border: "1px solid #a7f3d0",
                      fontWeight: 600,
                    }}
                  >
                    Expect tool: <code>{t}</code>
                  </span>
                ))}
                {selectedCase.forbiddenTools?.map((t) => (
                  <span
                    key={`forb-${t}`}
                    style={{
                      fontSize: 12,
                      padding: "3px 9px",
                      borderRadius: 999,
                      background: "#fef2f2",
                      color: "#991b1b",
                      border: "1px solid #fecaca",
                      fontWeight: 600,
                    }}
                  >
                    Must NOT call: <code>{t}</code>
                  </span>
                ))}
              </div>
            )}

            {sanityWarnings.length > 0 && (
              <div
                style={{
                  marginTop: 12,
                  padding: "10px 14px",
                  borderRadius: 10,
                  background: "#fffbeb",
                  border: "1px solid #fde68a",
                  color: "#92400e",
                  fontSize: 13,
                }}
              >
                <strong>⚠ Automated Trace Warnings:</strong>
                <ul style={{ margin: "4px 0 0", paddingLeft: 18 }}>
                  {sanityWarnings.map((w, i) => (
                    <li key={i}>{w}</li>
                  ))}
                </ul>
              </div>
            )}
          </div>

          {/* 3. Live LLM Response & Tool Call Inspector */}
          <div
            style={{
              background: "var(--bg-card)",
              border: "1px solid var(--border-light)",
              borderRadius: "var(--radius-lg)",
              padding: "18px 22px",
              boxShadow: "var(--shadow-card)",
            }}
          >
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                marginBottom: 12,
              }}
            >
              <div style={{ fontWeight: 800, fontSize: 15 }}>
                🤖 LLM Agent Response &amp; Tool Call Trace
              </div>
              {selectedRecord.turns.length > 0 && (
                <button
                  type="button"
                  className="link-quiet"
                  style={{ fontSize: 12 }}
                  onClick={() =>
                    updateCaseRecord(selectedCase.id, (prev) => ({
                      ...prev,
                      turns: [],
                    }))
                  }
                >
                  Clear Run Output
                </button>
              )}
            </div>

            {selectedRecord.turns.length === 0 ? (
              <div
                style={{
                  padding: "28px 16px",
                  textAlign: "center",
                  borderRadius: 12,
                  background: "var(--bg-subtle)",
                  color: "var(--text-soft)",
                  fontSize: 14,
                }}
              >
                Click <strong>▶ Run Prompt Against LLM</strong> above to execute this case and
                inspect the live reply + tool calls.
              </div>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
                {selectedRecord.turns.map((turn, tIdx) => (
                  <div
                    key={tIdx}
                    style={{
                      border: "1px solid var(--border-light)",
                      borderRadius: 12,
                      overflow: "hidden",
                    }}
                  >
                    <div
                      style={{
                        padding: "8px 14px",
                        background: "var(--bg-subtle)",
                        borderBottom: "1px solid var(--border-light)",
                        display: "flex",
                        justifyContent: "space-between",
                        fontSize: 12,
                        color: "var(--text-muted)",
                        flexWrap: "wrap",
                        gap: 8,
                      }}
                    >
                      <span>
                        <strong>Turn {tIdx + 1}</strong> ·{" "}
                        {turn.provider ? `${turn.provider}/${turn.model}` : "gateway"}
                      </span>
                      <span>
                        {(turn.latencyMs / 1000).toFixed(2)}s · {turn.toolTrace.length} tool call
                        {turn.toolTrace.length === 1 ? "" : "s"}
                      </span>
                    </div>

                    {tIdx > 0 && (
                      <div
                        style={{
                          padding: "10px 14px",
                          background: "#eff6ff",
                          borderBottom: "1px solid #dbeafe",
                          fontSize: 13,
                        }}
                      >
                        <strong>Follow-up User:</strong> {turn.userMessage}
                      </div>
                    )}

                    {/* Tool Calls List */}
                    {turn.toolTrace.length > 0 && (
                      <div
                        style={{
                          padding: "10px 14px",
                          background: "#f8fafc",
                          borderBottom: "1px solid var(--border-light)",
                        }}
                      >
                        <div
                          style={{
                            fontSize: 11,
                            fontWeight: 700,
                            textTransform: "uppercase",
                            color: "var(--text-soft)",
                            marginBottom: 6,
                          }}
                        >
                          Tool Execution Chain (click any step to inspect JSON args &amp; output)
                        </div>
                        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                          {turn.toolTrace.map((tr, callIdx) => {
                            const traceKey = `${selectedCase.id}-${tIdx}-${callIdx}`;
                            const open = Boolean(expandedTraces[traceKey]);
                            return (
                              <div
                                key={traceKey}
                                style={{
                                  border: `1px solid ${tr.ok ? "#cbd5e1" : "#fecaca"}`,
                                  borderRadius: 8,
                                  background: tr.ok ? "#fff" : "#fef2f2",
                                }}
                              >
                                <button
                                  type="button"
                                  onClick={() =>
                                    setExpandedTraces((prev) => ({
                                      ...prev,
                                      [traceKey]: !open,
                                    }))
                                  }
                                  style={{
                                    width: "100%",
                                    padding: "7px 10px",
                                    background: "none",
                                    border: "none",
                                    display: "flex",
                                    justifyContent: "space-between",
                                    alignItems: "center",
                                    cursor: "pointer",
                                    fontSize: 13,
                                    fontFamily: "inherit",
                                  }}
                                >
                                  <span>
                                    <strong>
                                      {callIdx + 1}. {tr.name}
                                    </strong>{" "}
                                    {tr.agent && (
                                      <span
                                        style={{
                                          fontSize: 11,
                                          color: "var(--text-soft)",
                                          marginLeft: 6,
                                        }}
                                      >
                                        [{tr.agent}]
                                      </span>
                                    )}
                                  </span>
                                  <span style={{ fontSize: 12, color: tr.ok ? "#059669" : "#dc2626" }}>
                                    {tr.ok ? "✓ ok" : "✗ error"} {open ? "▴" : "▾"}
                                  </span>
                                </button>
                                {open && (
                                  <div
                                    style={{
                                      padding: "8px 10px",
                                      borderTop: "1px solid var(--border-light)",
                                      fontSize: 12,
                                    }}
                                  >
                                    {tr.args !== undefined && (
                                      <div style={{ marginBottom: 8 }}>
                                        <div style={{ fontWeight: 700, marginBottom: 3 }}>
                                          Arguments passed by LLM:
                                        </div>
                                        <pre
                                          style={{
                                            margin: 0,
                                            padding: 8,
                                            borderRadius: 6,
                                            background: "#0f172a",
                                            color: "#e2e8f0",
                                            overflowX: "auto",
                                            maxHeight: 200,
                                          }}
                                        >
                                          {formatJsonPretty(tr.args)}
                                        </pre>
                                      </div>
                                    )}
                                    {tr.resultSummary && (
                                      <div>
                                        <div style={{ fontWeight: 700, marginBottom: 3 }}>
                                          Gateway Tool Output:
                                        </div>
                                        <pre
                                          style={{
                                            margin: 0,
                                            padding: 8,
                                            borderRadius: 6,
                                            background: "#f1f5f9",
                                            color: "#0f172a",
                                            overflowX: "auto",
                                            maxHeight: 240,
                                          }}
                                        >
                                          {formatJsonPretty(tr.resultSummary)}
                                        </pre>
                                      </div>
                                    )}
                                  </div>
                                )}
                              </div>
                            );
                          })}
                        </div>
                      </div>
                    )}

                    {/* Assistant Text Reply */}
                    <div style={{ padding: "14px 16px", fontSize: 14 }}>
                      {turn.error ? (
                        <div style={{ color: "#dc2626", fontWeight: 700 }}>
                          Error calling /v1/agent/chat: {turn.error}
                        </div>
                      ) : turn.reply ? (
                        renderReplyMarkdown(turn.reply)
                      ) : (
                        <span style={{ color: "var(--text-soft)" }}>(Empty text reply)</span>
                      )}
                    </div>
                  </div>
                ))}

                {/* Optional Multi-Turn Follow-up Box */}
                <div style={{ display: "flex", gap: 8 }}>
                  <input
                    type="text"
                    placeholder="Optional multi-turn follow-up (e.g. 'Make the butter 3 kg' or 'Yes, place the order')..."
                    value={followUpText}
                    onChange={(e) => setFollowUpText(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && followUpText.trim() && runningId === null) {
                        void executeCaseTurn(selectedCase, {
                          followUp: followUpText,
                          keepHistory: true,
                        });
                      }
                    }}
                    style={{
                      flex: 1,
                      padding: "9px 12px",
                      borderRadius: 10,
                      border: "1px solid var(--border-strong)",
                      fontSize: 13,
                    }}
                  />
                  <button
                    type="button"
                    className="btn secondary"
                    disabled={!followUpText.trim() || runningId !== null}
                    onClick={() =>
                      void executeCaseTurn(selectedCase, {
                        followUp: followUpText,
                        keepHistory: true,
                      })
                    }
                    style={{ minHeight: 38, padding: "6px 14px", fontSize: 13 }}
                  >
                    Send Follow-Up
                  </button>
                </div>
              </div>
            )}
          </div>

          {/* 4. Manual Accuracy Marking & Failure Notes Card */}
          <div
            style={{
              background: "var(--bg-card)",
              border: "2px solid var(--border-strong)",
              borderRadius: "var(--radius-lg)",
              padding: "18px 22px",
              boxShadow: "var(--shadow-card)",
            }}
          >
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                gap: 10,
                flexWrap: "wrap",
                marginBottom: 12,
              }}
            >
              <div style={{ fontWeight: 800, fontSize: 15 }}>
                📝 Mark Result Accuracy ({selectedCase.id})
              </div>
              {selectedRecord.verdict !== "untested" && (
                <button
                  type="button"
                  className="link-quiet"
                  style={{ fontSize: 12 }}
                  onClick={() =>
                    updateCaseRecord(selectedCase.id, (prev) => ({
                      ...prev,
                      verdict: "untested",
                    }))
                  }
                >
                  Clear Verdict
                </button>
              )}
            </div>

            <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginBottom: 14 }}>
              {(
                [
                  {
                    id: "accurate" as const,
                    label: "✅ Accurate (Pass)",
                    activeBg: "#059669",
                    idleBg: "#ecfdf5",
                    idleColor: "#065f46",
                  },
                  {
                    id: "partial" as const,
                    label: "⚠️ Partial / Minor Issue",
                    activeBg: "#d97706",
                    idleBg: "#fffbeb",
                    idleColor: "#92400e",
                  },
                  {
                    id: "inaccurate" as const,
                    label: "❌ Inaccurate (Needs Fix)",
                    activeBg: "#dc2626",
                    idleBg: "#fef2f2",
                    idleColor: "#991b1b",
                  },
                ] as const
              ).map((btn) => {
                const active = selectedRecord.verdict === btn.id;
                return (
                  <button
                    key={btn.id}
                    type="button"
                    onClick={() =>
                      updateCaseRecord(selectedCase.id, (prev) => ({
                        ...prev,
                        verdict: btn.id,
                      }))
                    }
                    style={{
                      padding: "10px 18px",
                      borderRadius: 12,
                      fontWeight: 800,
                      fontSize: 14,
                      cursor: "pointer",
                      border: active ? `2px solid ${btn.activeBg}` : "1px solid var(--border-strong)",
                      background: active ? btn.activeBg : btn.idleBg,
                      color: active ? "#fff" : btn.idleColor,
                      fontFamily: "inherit",
                    }}
                  >
                    {btn.label}
                  </button>
                );
              })}
            </div>

            <div style={{ marginBottom: 12 }}>
              <div
                style={{
                  fontSize: 12,
                  fontWeight: 700,
                  color: "var(--text-soft)",
                  marginBottom: 6,
                }}
              >
                Quick Failure / Inaccuracy Tags (click all that apply):
              </div>
              <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                {FAILURE_REASON_TAGS.map((tag) => {
                  const selected = selectedRecord.tags.includes(tag);
                  return (
                    <button
                      key={tag}
                      type="button"
                      onClick={() =>
                        updateCaseRecord(selectedCase.id, (prev) => {
                          const has = prev.tags.includes(tag);
                          const nextTags = has
                            ? prev.tags.filter((t) => t !== tag)
                            : [...prev.tags, tag];
                          return {
                            ...prev,
                            tags: nextTags,
                            verdict:
                              !has && prev.verdict === "untested" ? "inaccurate" : prev.verdict,
                          };
                        })
                      }
                      style={{
                        padding: "5px 10px",
                        borderRadius: 999,
                        fontSize: 12,
                        fontWeight: 600,
                        cursor: "pointer",
                        border: selected ? "1px solid #dc2626" : "1px solid var(--border-light)",
                        background: selected ? "#fef2f2" : "var(--bg-subtle)",
                        color: selected ? "#991b1b" : "var(--text-muted)",
                        fontFamily: "inherit",
                      }}
                    >
                      {selected ? `✗ ${tag}` : tag}
                    </button>
                  );
                })}
              </div>
            </div>

            <textarea
              rows={3}
              placeholder="Write notes on what was inaccurate (e.g. 'Pinned 40L from milk onto bananas', 'Ordered cream even though batch expires in 2 days', 'Hallucinated pack price')..."
              value={selectedRecord.notes}
              onChange={(e) =>
                updateCaseRecord(selectedCase.id, (prev) => ({
                  ...prev,
                  notes: e.target.value,
                }))
              }
              style={{
                width: "100%",
                padding: "10px 12px",
                borderRadius: 10,
                border: "1px solid var(--border-strong)",
                fontSize: 14,
                fontFamily: "inherit",
              }}
            />
          </div>
        </section>
      </div>
    </div>
  );
}
