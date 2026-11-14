import { config } from "../config.js";
import {
  agentToolDefs,
  executeAgentTool,
  purchasingSystemPrompt,
  type AgentToolContext,
  type ToolTrace,
} from "./tools.js";
import { fenceToolOutput } from "./sanitize.js";
import { parseNeedFromText } from "../need/parse.js";
import { ValioRateLimitError } from "../valio/client.js";

export type ChatMessage = {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  /** Kimi/Verda reasoning — must be echoed back on multi-turn tool calls */
  reasoning_content?: string | null;
  /** Gemini 3.x / 4.x thought signatures — must be echoed back on multi-turn tool calls */
  extra_content?: unknown;
  tool_call_id?: string;
  tool_calls?: Array<{
    id: string;
    type: "function";
    function: { name: string; arguments: string };
    extra_content?: unknown;
  }>;
  name?: string;
};

export type AgentChatResult = {
  reply: string;
  messages: ChatMessage[];
  toolTrace: ToolTrace[];
  provider: string;
  model: string;
};

function llmConfigured(): { provider: "openai" | "anthropic" | "gemini"; key: string; model: string; baseUrl: string } | null {
  if (config.geminiApiKey) {
    return {
      provider: "gemini",
      key: config.geminiApiKey,
      model: config.geminiModel,
      baseUrl: config.geminiBaseUrl,
    };
  }
  if (config.openaiApiKey) {
    const isGeminiUrl = config.openaiBaseUrl.includes("generativelanguage.googleapis.com");
    return {
      provider: isGeminiUrl ? "gemini" : "openai",
      key: config.openaiApiKey,
      model: config.llmModel,
      baseUrl: config.openaiBaseUrl,
    };
  }
  if (config.anthropicApiKey) {
    return {
      provider: "anthropic",
      key: config.anthropicApiKey,
      model: config.anthropicModel,
      baseUrl: "https://api.anthropic.com",
    };
  }
  return null;
}

export function getLlmStatus() {
  const cfg = llmConfigured();
  const isVerda = !!cfg?.baseUrl.includes("verda.com");
  return {
    configured: !!cfg,
    provider: cfg ? (isVerda ? "verda" : cfg.provider) : null,
    model: cfg?.model ?? null,
    baseUrl: cfg?.baseUrl ?? null,
  };
}

function isReadOnlyRequest(text: string): boolean {
  return /\b(?:do not|don't|dont|never)\s+(?:place|make|create|submit|commit)\s+(?:an?\s+)?(?:order|purchase)\b|\b(?:do not|don't|dont|never)\s+order\b|\bjust\s+(?:compare|find|show|search)\b/i.test(
    text,
  );
}

async function runOpenAiLoop(
  customerId: string,
  history: ChatMessage[],
  callerRole?: string,
): Promise<AgentChatResult> {
  const cfg = llmConfigured();
  if (!cfg || (cfg.provider !== "openai" && cfg.provider !== "gemini")) {
    throw new Error("OpenAI/Gemini not configured");
  }

  const messages: ChatMessage[] = [
    { role: "system", content: purchasingSystemPrompt(customerId) },
    ...history.filter((m) => m.role !== "system"),
  ];
  const trustedUserText = [...history].reverse().find((m) => m.role === "user")?.content ?? "";
  const restockAsk = /restock|what should we order|running low|inventory|recipes|order history|replenish|low stock/i.test(trustedUserText);
  const parsedFromUser = parseNeedFromText(trustedUserText);
  const toolContext: AgentToolContext = {
    trustedUserText,
    trustedNeed: restockAsk && Boolean((parsedFromUser as { clarificationRequired?: string }).clarificationRequired) ? undefined : parsedFromUser,
    readOnlyRequest: isReadOnlyRequest(trustedUserText),
    callerRole,
  };
  const toolTrace: ToolTrace[] = [];

  const isVerda = cfg.baseUrl.includes("verda.com");
  const isGemini = cfg.provider === "gemini" || cfg.baseUrl.includes("generativelanguage.googleapis.com");
  const providerLabel = isVerda ? "verda" : isGemini ? "gemini" : "openai";

  for (let i = 0; i < 12; i++) {
    const body: Record<string, unknown> = {
      model: cfg.model,
      messages,
      tools: agentToolDefs,
      tool_choice: "auto",
      temperature: 0.2,
    };
    // Kimi on Verda: leave room for reasoning; keep effort low for snappy tool use
    if (isVerda || cfg.model.includes("kimi")) {
      body.max_tokens = 8192;
      body.reasoning_effort = config.llmReasoningEffort;
    } else if (isGemini) {
      body.reasoning_effort = config.llmReasoningEffort;
    }

    const res = await fetch(`${cfg.baseUrl.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${cfg.key}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      throw new Error(`LLM error ${res.status}: ${await res.text()}`);
    }
    const data = (await res.json()) as {
      choices: Array<{
        message: ChatMessage & { reasoning_content?: string | null; extra_content?: unknown };
        finish_reason?: string;
      }>;
    };
    const msg = data.choices[0]?.message;
    if (!msg) throw new Error("Empty LLM response");
    messages.push({
      role: "assistant",
      content: msg.content ?? null,
      ...(msg.reasoning_content != null ? { reasoning_content: msg.reasoning_content } : {}),
      ...(msg.extra_content != null ? { extra_content: msg.extra_content } : {}),
      ...(msg.tool_calls ? { tool_calls: msg.tool_calls } : {}),
    });

    if (!msg.tool_calls?.length) {
      const reply =
        (msg.content && msg.content.trim()) ||
        (msg.reasoning_content ? "(model returned reasoning only)" : "");
      return {
        reply,
        messages: messages.filter((m) => m.role !== "system"),
        toolTrace,
        provider: providerLabel,
        model: cfg.model,
      };
    }

    for (const call of msg.tool_calls) {
      let args: Record<string, unknown> = {};
      try {
        args = JSON.parse(call.function.arguments || "{}");
      } catch {
        args = {};
      }
      const { result, trace } = await executeAgentTool(
        customerId,
        call.function.name,
        args,
        toolContext,
      );
      toolTrace.push(trace);
      messages.push({
        role: "tool",
        tool_call_id: call.id,
        content: fenceToolOutput(call.function.name, result),
        name: call.function.name,
      });
    }
  }

  return {
    reply: "Stopped after max tool iterations. Check tool trace and retry.",
    messages: messages.filter((m) => m.role !== "system"),
    toolTrace,
    provider: providerLabel,
    model: cfg.model,
  };
}

async function runAnthropicLoop(
  customerId: string,
  history: ChatMessage[],
  callerRole?: string,
): Promise<AgentChatResult> {
  const cfg = llmConfigured();
  if (!cfg || cfg.provider !== "anthropic") {
    throw new Error("Anthropic not configured");
  }

  type AContent =
    | { type: "text"; text: string }
    | {
        type: "tool_use";
        id: string;
        name: string;
        input: Record<string, unknown>;
      }
    | {
        type: "tool_result";
        tool_use_id: string;
        content: string;
      };

  const tools = agentToolDefs.map((t) => ({
    name: t.function.name,
    description: t.function.description,
    input_schema: t.function.parameters,
  }));

  const messages: Array<{ role: "user" | "assistant"; content: string | AContent[] }> =
    [];
  for (const m of history) {
    if (m.role === "user") messages.push({ role: "user", content: m.content ?? "" });
    if (m.role === "assistant" && m.content) {
      messages.push({ role: "assistant", content: m.content });
    }
  }

  const toolTrace: ToolTrace[] = [];
  const outMessages: ChatMessage[] = [...history];
  const trustedUserText = [...history].reverse().find((m) => m.role === "user")?.content ?? "";
  const restockAsk = /restock|what should we order|running low|inventory|recipes|order history|replenish|low stock/i.test(trustedUserText);
  const parsedFromUser = parseNeedFromText(trustedUserText);
  const toolContext: AgentToolContext = {
    trustedUserText,
    trustedNeed: restockAsk && Boolean((parsedFromUser as { clarificationRequired?: string }).clarificationRequired) ? undefined : parsedFromUser,
    readOnlyRequest: isReadOnlyRequest(trustedUserText),
    callerRole,
  };

  for (let i = 0; i < 12; i++) {
    const res = await fetch(`${cfg.baseUrl}/v1/messages`, {
      method: "POST",
      headers: {
        "x-api-key": cfg.key,
        "anthropic-version": "2023-06-01",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: cfg.model,
        max_tokens: 1600,
        system: purchasingSystemPrompt(customerId),
        tools,
        messages,
      }),
    });
    if (!res.ok) {
      throw new Error(`LLM error ${res.status}: ${await res.text()}`);
    }
    const data = (await res.json()) as {
      content: AContent[];
      stop_reason?: string;
    };

    const toolUses = data.content.filter(
      (c): c is Extract<AContent, { type: "tool_use" }> => c.type === "tool_use",
    );
    const text = data.content
      .filter((c): c is Extract<AContent, { type: "text" }> => c.type === "text")
      .map((c) => c.text)
      .join("\n");

    if (!toolUses.length) {
      outMessages.push({ role: "assistant", content: text });
      return {
        reply: text,
        messages: outMessages,
        toolTrace,
        provider: "anthropic",
        model: cfg.model,
      };
    }

    messages.push({ role: "assistant", content: data.content });
    outMessages.push({
      role: "assistant",
      content: text || null,
      tool_calls: toolUses.map((t) => ({
        id: t.id,
        type: "function" as const,
        function: { name: t.name, arguments: JSON.stringify(t.input) },
      })),
    });

    const toolResults: AContent[] = [];
    for (const t of toolUses) {
      const { result, trace } = await executeAgentTool(
        customerId,
        t.name,
        t.input,
        toolContext,
      );
      toolTrace.push(trace);
      const payload = fenceToolOutput(t.name, result);
      toolResults.push({
        type: "tool_result",
        tool_use_id: t.id,
        content: payload,
      });
      outMessages.push({
        role: "tool",
        tool_call_id: t.id,
        content: payload,
        name: t.name,
      });
    }
    messages.push({ role: "user", content: toolResults });
  }

  return {
    reply: "Stopped after max tool iterations. Check tool trace and retry.",
    messages: outMessages,
    toolTrace,
    provider: "anthropic",
    model: cfg.model,
  };
}

/** Deterministic fallback purchasing agent when no LLM key is set. */
export async function runHeuristicAgent(
  customerId: string,
  userText: string,
  callerRole?: string,
): Promise<AgentChatResult> {
  const toolTrace: ToolTrace[] = [];
  const messages: ChatMessage[] = [{ role: "user", content: userText }];
  const readOnlyRequest = isReadOnlyRequest(userText);
  const restockAsk =
    /restock|what should we order|running low|inventory|recipes|order history|replenish|low stock/i.test(
      userText,
    );
  const parsedFromUser = parseNeedFromText(userText);
  const toolContext: AgentToolContext = {
    trustedUserText: userText,
    trustedNeed: restockAsk && Boolean((parsedFromUser as { clarificationRequired?: string }).clarificationRequired) ? undefined : parsedFromUser,
    readOnlyRequest,
    callerRole,
  };

  const run = async (name: string, args: Record<string, unknown>) => {
    const { result, trace } = await executeAgentTool(customerId, name, args, toolContext);
    toolTrace.push(trace);
    messages.push({
      role: "assistant",
      content: null,
      tool_calls: [
        {
          id: `local_${toolTrace.length}`,
          type: "function",
          function: { name, arguments: JSON.stringify(args) },
        },
      ],
    });
    messages.push({
      role: "tool",
      tool_call_id: `local_${toolTrace.length}`,
      content: fenceToolOutput(name, result),
      name,
    });
    return result;
  };

  await run("get_mandate", {});

  if (restockAsk) {
    const rec = (await run("recommend_restock", { daysCover: 7 })) as {
      summary?: string;
      recommendations?: Array<{
        name: string;
        suggestedOrderQty: number;
        unit: string;
        urgency: string;
        catalogHints: string[];
        lactoseFreePreferred?: boolean;
      }>;
    };
    const top = (rec.recommendations ?? [])
      .filter((r) => r.urgency === "critical" || r.urgency === "low")
      .slice(0, 2);
    if (!top.length) {
      const reply = rec.summary ?? "Nothing to restock right now.";
      messages.push({ role: "assistant", content: reply });
      return {
        reply,
        messages,
        toolTrace,
        provider: "heuristic",
        model: "deterministic-fallback",
      };
    }

    const intentLines: string[] = [];
    for (const item of top) {
      const needText = `I need ${item.suggestedOrderQty} ${item.unit} of ${item.catalogHints[0] ?? item.name} by Monday${item.lactoseFreePreferred ? " lactose-free" : ""}`;
      const parsedNeed = (await run("parse_need", { text: needText })) as
        | { clarificationRequired: string }
        | Record<string, unknown>;
      if ("clarificationRequired" in parsedNeed) {
        intentLines.push(
          `${item.name}: need clearer date/qty before ordering.`,
        );
        continue;
      }
      const ranked = (await run("rank_offers", { need: parsedNeed })) as {
        explanation?: string;
        offers?: Array<{
          productId: string;
          canFulfil: boolean;
          totalPrice: number;
          shortfall?: number | null;
          substitutionLabel?: string;
        }>;
        partialAvailability?: boolean;
      };
      const pick =
        ranked.offers?.find((o) => o.canFulfil) ?? ranked.offers?.[0];
      if (!pick) {
        intentLines.push(`${item.name}: no Valio offers found.`);
        continue;
      }
      const partialNote = !pick.canFulfil
        ? ` partial shortfall=${pick.shortfall ?? "?"}`
        : "";
      const gbb = pick.substitutionLabel
        ? ` · ${pick.substitutionLabel}`
        : "";
      if (readOnlyRequest) {
        intentLines.push(
          `${item.name}: top offer ${pick.productId} · €${pick.totalPrice.toFixed(2)}${partialNote}${gbb}.`,
        );
        continue;
      }
      const intentRes = (await run("create_order_intent", {
        need: parsedNeed,
        offerProductId: pick.productId,
      })) as {
        intent?: {
          id: string;
          status: string;
          totalPrice: number;
          snapshotHash: string;
          policy: { decision: string; failingRules: string[] };
        };
      };
      const intent = intentRes.intent;
      intentLines.push(
        intent
          ? `${item.name}: intent ${intent.id} · ${intent.status} · €${intent.totalPrice.toFixed(2)}${partialNote}${gbb}. Snapshot ${intent.snapshotHash.slice(0, 12)}…`
          : `${item.name}: failed to create intent.`,
      );
      if (intent?.status === "auto_eligible") {
        await run("commit_order", {
          intentId: intent.id,
          idempotencyKey: `agent-restock-${intent.id}`,
        });
        intentLines.push(`  → auto-committed.`);
      }
    }

    const needsApproval = intentLines.some((l) => l.includes("pending_approval"));
    const reply = [
      rec.summary,
      readOnlyRequest
        ? `Ranked offers for top ${top.length} urgent item(s) (read-only request: no order intent was created):`
        : `Created order intents for top ${top.length} urgent item(s):`,
      ...intentLines,
      !readOnlyRequest && needsApproval
        ? "Open Approval to authorize overrides — I will not silently override the mandate."
        : "",
    ]
      .filter(Boolean)
      .join("\n");
    messages.push({ role: "assistant", content: reply });
    return {
      reply,
      messages,
      toolTrace,
      provider: "heuristic",
      model: "deterministic-fallback",
    };
  }

  const parsed = (await run("parse_need", { text: userText })) as
    | { clarificationRequired: string }
    | Record<string, unknown>;

  if ("clarificationRequired" in parsed) {
    const reply = `I need a clearer purchase request before I can order. ${parsed.clarificationRequired}`;
    messages.push({ role: "assistant", content: reply });
    return {
      reply,
      messages,
      toolTrace,
      provider: "heuristic",
      model: "deterministic-fallback",
    };
  }

  const need = parsed;
  const ranked = (await run("rank_offers", { need })) as {
    explanation?: string;
    offers?: Array<{ productId: string; canFulfil: boolean; totalPrice: number }>;
  };
  const top = ranked.offers?.find((o) => o.canFulfil) ?? ranked.offers?.[0];
  if (!top) {
    const reply = "No fulfilable offers found for that need.";
    messages.push({ role: "assistant", content: reply });
    return {
      reply,
      messages,
      toolTrace,
      provider: "heuristic",
      model: "deterministic-fallback",
    };
  }

  if (readOnlyRequest) {
    const reply = [
      ranked.explanation,
      `Top offer: ${top.productId} (€${top.totalPrice.toFixed(2)}).`,
      "Read-only request: no quote or order intent was created.",
    ]
      .filter(Boolean)
      .join("\n\n");
    messages.push({ role: "assistant", content: reply });
    return {
      reply,
      messages,
      toolTrace,
      provider: "heuristic",
      model: "deterministic-fallback",
    };
  }

  const intentRes = (await run("create_order_intent", {
    need,
    offerProductId: top.productId,
  })) as {
    intent?: {
      id: string;
      status: string;
      totalPrice: number;
      snapshotHash: string;
      runId: string;
      policy: { decision: string; failingRules: string[]; reasons: string[] };
    };
    explanation?: string;
  };

  const intent = intentRes.intent;
  if (!intent) {
    const reply = "Failed to create order intent.";
    messages.push({ role: "assistant", content: reply });
    return {
      reply,
      messages,
      toolTrace,
      provider: "heuristic",
      model: "deterministic-fallback",
    };
  }

  if (intent.status === "auto_eligible") {
    const committed = (await run("commit_order", {
      intentId: intent.id,
      idempotencyKey: `agent-${intent.id}`,
    })) as { committedOrderId?: string; status?: string };
    const reply = [
      ranked.explanation,
      `Policy: auto_commit. Committed order ${committed.committedOrderId ?? "(see tools)"}.`,
      `Total €${intent.totalPrice.toFixed(2)}.`,
    ]
      .filter(Boolean)
      .join("\n\n");
    messages.push({ role: "assistant", content: reply });
    return {
      reply,
      messages,
      toolTrace,
      provider: "heuristic",
      model: "deterministic-fallback",
    };
  }

  const reply = [
    ranked.explanation,
    `Created order intent ${intent.id} (€${intent.totalPrice.toFixed(2)}).`,
    `Policy: ${intent.policy.decision}. Failing rules: ${intent.policy.failingRules.join(", ") || "none"}.`,
    ...intent.policy.reasons,
    `I cannot silently override your mandate. Open Approval and authorize an explicit override (or raise the mandate).`,
    `Snapshot: ${intent.snapshotHash.slice(0, 16)}… · Run: ${intent.runId}`,
  ].join("\n\n");
  messages.push({ role: "assistant", content: reply });
  return {
    reply,
    messages,
    toolTrace,
    provider: "heuristic",
    model: "deterministic-fallback",
  };
}

export async function runPurchasingAgent(params: {
  customerId: string;
  message: string;
  history?: ChatMessage[];
  callerRole?: string;
}): Promise<AgentChatResult> {
  const history: ChatMessage[] = [
    ...(params.history ?? []),
    { role: "user", content: params.message },
  ];

  const cfg = llmConfigured();
  if (!cfg) {
    return runHeuristicAgent(params.customerId, params.message, params.callerRole);
  }
  try {
    if (cfg.provider === "anthropic") {
      return await runAnthropicLoop(params.customerId, history, params.callerRole);
    }
    return await runOpenAiLoop(params.customerId, history, params.callerRole);
  } catch (e) {
    if (e instanceof ValioRateLimitError) {
      return {
        reply: `Valio's mock API is still rate-limited after its Retry-After window. No order was created. Please try again in ${e.retryAfterSec} seconds.`,
        messages: history,
        toolTrace: [],
        provider: "gateway",
        model: cfg.model,
      };
    }
    const msg = e instanceof Error ? e.message : String(e);
    // Keep the demo usable when the org is out of credits / key rejected / upstream LLM unreachable
    if (
      msg.includes("429") ||
      msg.includes("insufficient_quota") ||
      msg.includes("401") ||
      msg.includes("invalid_api_key") ||
      msg.includes("credit_balance") ||
      msg.includes("fetch failed") ||
      msg.includes("ECONNREFUSED") ||
      msg.includes("ENOTFOUND") ||
      msg.includes("ETIMEDOUT") ||
      msg.includes("AbortError") ||
      /\b50[0234]\b/.test(msg)
    ) {
      const fallback = await runHeuristicAgent(params.customerId, params.message, params.callerRole);
      const reason =
        msg.includes("429") || msg.includes("credit") || msg.includes("insufficient_quota")
          ? "OpenAI quota exhausted"
          : msg.includes("401") || msg.includes("invalid_api_key")
            ? "LLM auth/quota error"
            : "LLM endpoint unreachable";
      return {
        ...fallback,
        reply: `${fallback.reply}\n\n(Note: LLM unavailable — ${reason}; used deterministic tool agent.)`,
      };
    }
    throw e;
  }
}

/** Cheap reachability check for the configured LLM (used by the self-test). */
export async function pingLlm(): Promise<{ ok: boolean; ms: number; detail: string }> {
  const cfg = llmConfigured();
  const t0 = Date.now();
  if (!cfg) {
    return { ok: false, ms: 0, detail: "No LLM key configured — the heuristic tool agent is used instead" };
  }
  try {
    const useOpenAiCompat = cfg.provider === "openai" || cfg.provider === "gemini";
    const url = useOpenAiCompat
      ? `${cfg.baseUrl.replace(/\/$/, "")}/chat/completions`
      : "https://api.anthropic.com/v1/messages";
    const headers: Record<string, string> = useOpenAiCompat
      ? { "Content-Type": "application/json", Authorization: `Bearer ${cfg.key}` }
      : { "Content-Type": "application/json", "x-api-key": cfg.key, "anthropic-version": "2023-06-01" };
    const res = await fetch(url, {
      method: "POST",
      headers,
      signal: AbortSignal.timeout(25_000),
      body: JSON.stringify({
        model: cfg.model,
        max_tokens: 256,
        ...(cfg.provider === "gemini" ? { reasoning_effort: "low" } : {}),
        messages: [{ role: "user", content: "Reply with the single word OK." }],
      }),
    });
    const ms = Date.now() - t0;
    if (!res.ok) return { ok: false, ms, detail: `HTTP ${res.status}: ${(await res.text()).slice(0, 120)}` };
    return { ok: true, ms, detail: `${cfg.model} responded` };
  } catch (e) {
    return { ok: false, ms: Date.now() - t0, detail: e instanceof Error ? e.message : String(e) };
  }
}
