import { config } from "../config.js";
import {
  agentToolDefs,
  executeAgentTool,
  purchasingSystemPrompt,
  type AgentToolContext,
  type ToolTrace,
} from "./tools.js";
import { fenceToolOutput } from "./sanitize.js";
import { parseComplexNeedFromText, parseNeedFromText } from "../need/parse.js";
import { ValioRateLimitError } from "../valio/client.js";
import type { Need } from "@tta/shared";

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
  const parsedComplexFromUser = parseComplexNeedFromText(trustedUserText);
  const toolContext: AgentToolContext = {
    trustedUserText,
    trustedNeed: restockAsk && Boolean((parsedFromUser as { clarificationRequired?: string }).clarificationRequired) ? undefined : parsedFromUser,
    trustedComplexNeed:
      restockAsk && "clarificationRequired" in parsedComplexFromUser
        ? undefined
        : parsedComplexFromUser,
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
  const parsedComplexFromUser = parseComplexNeedFromText(trustedUserText);
  const toolContext: AgentToolContext = {
    trustedUserText,
    trustedNeed: restockAsk && Boolean((parsedFromUser as { clarificationRequired?: string }).clarificationRequired) ? undefined : parsedFromUser,
    trustedComplexNeed:
      restockAsk && "clarificationRequired" in parsedComplexFromUser
        ? undefined
        : parsedComplexFromUser,
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
  const parsedComplexFromUser = parseComplexNeedFromText(userText);
  const toolContext: AgentToolContext = {
    trustedUserText: userText,
    trustedNeed: restockAsk && Boolean((parsedFromUser as { clarificationRequired?: string }).clarificationRequired) ? undefined : parsedFromUser,
    trustedComplexNeed:
      restockAsk && "clarificationRequired" in parsedComplexFromUser
        ? undefined
        : parsedComplexFromUser,
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
    | (Record<string, unknown> & { needs?: Need[]; isMultiItem?: boolean });

  if ("clarificationRequired" in parsed) {
    // Check if the buyer is asking to source a kitchen recipe by name (e.g. "Order ingredients for buttermilk pancakes")
    const recipeData = (await run("get_recipes", {})) as {
      recipes?: Array<{ recipeId: string; name: string; servingsPerBatch: number; batchesPerWeek: number }>;
    };
    const lowerText = userText.toLowerCase();
    const matchedRecipes = (recipeData.recipes ?? []).filter((r) => {
      const words = r.name
        .toLowerCase()
        .replace(/\([^)]*\)/g, " ")
        .split(/[^\p{L}\p{N}]+/u)
        .filter((w) => w.length >= 4 && !["hotel", "daily", "lobby", "evening", "milk", "cream"].includes(w));
      return words.some((w) => lowerText.includes(w) || (w.endsWith("s") && lowerText.includes(w.slice(0, -1))));
    });
    if (matchedRecipes.length > 0) {
      const batchMatch = lowerText.match(/\b(\d+)\s*batch(?:es)?\b/);
      const guestMatch = lowerText.match(/\b(\d+)\s*(?:guests?|people|servings?|portions?)\b/);
      const planRes = (await run("plan_menu_sourcing", {
        neededBy: parseComplexNeedFromText(`1 pack item ${userText}`) && !("clarificationRequired" in parseComplexNeedFromText(`1 pack item ${userText}`))
          ? (parseComplexNeedFromText(`1 pack item ${userText}`) as { needs: Need[] }).needs[0].neededBy
          : new Date(Date.now() + 3 * 86_400_000).toISOString().slice(0, 10),
        recipes: matchedRecipes.map((r) => ({
          recipeId: r.recipeId,
          batches: batchMatch
            ? Math.max(1, Number(batchMatch[1]))
            : guestMatch
              ? Math.max(1, Math.ceil(Number(guestMatch[1]) / Math.max(1, r.servingsPerBatch)))
              : undefined,
        })),
        createIntents: !readOnlyRequest,
      })) as {
        summary?: string;
        lines?: Array<{
          name: string;
          status: string;
          shortfall: number;
          unit: string;
          chosen?: { productName: string; totalPrice: number };
          intent?: { id: string; status: string };
        }>;
      };
      const committedIds: string[] = [];
      for (const ln of planRes.lines ?? []) {
        if (!readOnlyRequest && ln.intent?.status === "auto_eligible") {
          const c = (await run("commit_order", {
            intentId: ln.intent.id,
            idempotencyKey: `agent-recipe-${ln.intent.id}`,
          })) as { committedOrderId?: string };
          if (c.committedOrderId) committedIds.push(c.committedOrderId);
        }
      }
      const lineSummaries = (planRes.lines ?? []).map((ln) =>
        ln.status === "covered"
          ? `• ${ln.name}: covered in fridge`
          : `• ${ln.name} (${ln.shortfall} ${ln.unit}): ${ln.chosen?.productName ?? ln.status}${ln.chosen ? ` · €${ln.chosen.totalPrice.toFixed(2)}` : ""}${ln.intent ? ` [${ln.intent.status}]` : ""}`,
      );
      const reply = [
        planRes.summary ?? `Planned recipe ingredients for ${matchedRecipes.map((r) => r.name).join(", ")}.`,
        ...lineSummaries,
        committedIds.length > 0 ? `Auto-committed ${committedIds.length} order(s): ${committedIds.join(", ")}.` : "",
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

  if (parsed.isMultiItem && Array.isArray(parsed.needs) && parsed.needs.length > 1) {
    const batchRanked = (await run("rank_offers", { needs: parsed.needs })) as {
      explanation?: string;
      items?: Array<{
        need: Need;
        explanation?: string;
        offers?: Array<{ productId: string; productName: string; canFulfil: boolean; totalPrice: number }>;
      }>;
    };
    const items = batchRanked.items ?? [];
    const chosenItems: Array<{ need: Need; offerProductId: string; productName: string; totalPrice: number }> = [];
    const missingItems: string[] = [];

    for (const entry of items) {
      const pick = entry.offers?.find((o) => o.canFulfil) ?? entry.offers?.[0];
      if (!pick) {
        missingItems.push(`${entry.need.quantity} ${entry.need.unit} ${entry.need.productIntent}`);
      } else {
        chosenItems.push({
          need: entry.need,
          offerProductId: pick.productId,
          productName: pick.productName,
          totalPrice: pick.totalPrice,
        });
      }
    }

    if (chosenItems.length === 0) {
      const reply = "No fulfilable Valio offers found for the requested items.";
      messages.push({ role: "assistant", content: reply });
      return {
        reply,
        messages,
        toolTrace,
        provider: "heuristic",
        model: "deterministic-fallback",
      };
    }

    const bundleSummary = chosenItems
      .map(
        (c, idx) =>
          `${idx + 1}. **${c.need.quantity} ${c.need.unit} ${c.need.productIntent}** → ${c.productName} (€${c.totalPrice.toFixed(2)})`,
      )
      .join("\n");
    const combinedEst = chosenItems.reduce((s, c) => s + c.totalPrice, 0);

    if (readOnlyRequest) {
      const reply = [
        `Ranked ${chosenItems.length}-item bundle (combined €${combinedEst.toFixed(2)}):`,
        bundleSummary,
        missingItems.length ? `Unmatched: ${missingItems.join(", ")}.` : "",
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
      items: chosenItems.map((c) => ({ need: c.need, offerProductId: c.offerProductId })),
    })) as {
      intent?: {
        id: string;
        status: string;
        totalPrice: number;
        snapshotHash: string;
        runId: string;
        policy: { decision: string; failingRules: string[]; reasons: string[] };
      };
    };

    const intent = intentRes.intent;
    if (!intent) {
      const reply = "Failed to create consolidated multi-item order intent.";
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
      })) as { committedOrderId?: string };
      const reply = [
        `Bundled & ordered ${chosenItems.length} items in one consolidated order:`,
        bundleSummary,
        missingItems.length ? `Note — no catalog match for: ${missingItems.join(", ")}.` : "",
        `Policy: auto_commit. Committed order ${committed.committedOrderId ?? "(see tools)"} · Total €${intent.totalPrice.toFixed(2)}.`,
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
      `Prepared ${chosenItems.length}-item bundle intent ${intent.id} (€${intent.totalPrice.toFixed(2)}):`,
      bundleSummary,
      missingItems.length ? `Note — no catalog match for: ${missingItems.join(", ")}.` : "",
      `Policy: ${intent.policy.decision}. Failing rules: ${intent.policy.failingRules.join(", ") || "none"}.`,
      ...intent.policy.reasons,
      `Open Approval to review and authorize this multi-item bundle.`,
      `Snapshot: ${intent.snapshotHash.slice(0, 16)}… · Run: ${intent.runId}`,
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
