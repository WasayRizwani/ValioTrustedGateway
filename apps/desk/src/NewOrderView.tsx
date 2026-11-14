import { useEffect, useRef, useState } from "react";
import {
  api,
  getApiKey,
  nextMonday,
  type Intent,
  type Mandate,
  type Offer,
  type ValioSuggestion,
} from "./api";
import { day, money, originLabel, qty, tidy, unitLabel } from "./format";
import { InventorySyncGuardCard } from "./InventorySyncGuardCard";
import { PhoneCallHero } from "./PhoneCallHero";

type Unit = "litre" | "kg" | "each" | "pack";

type ParsedNeed = {
  productIntent: string;
  quantity: number;
  unit: Unit;
  neededBy: string;
  clarificationRequired?: string;
  ingredientId?: string;
  ingredientQuantity?: number;
  ingredientUnit?: Unit;
  constraints?: {
    lactoseFree?: boolean;
    organic?: boolean;
    vegan?: boolean;
    origin?: string;
    keywords?: string[];
    excludeAllergens?: string[];
    maxPricePerUnit?: number;
  };
};

type BundleItemState = {
  id: string;
  label: string;
  need: ParsedNeed;
  offers: Offer[];
  selectedProductId: string | null;
  contextNote?: string;
  urgency?: "critical" | "low" | "recipe" | "requested";
};

type CoveredItemNote = {
  ingredientId?: string;
  name: string;
  requiredQty: number;
  onHand: number;
  unit: string;
  needToAdd: ParsedNeed;
};

type AgentToolTrace = {
  agent?: string;
  name: string;
  ok: boolean;
  resultSummary?: string;
};

type UnifiedAssistantApiResponse = {
  mode: "bundle" | "clarification" | "assistant";
  sourceKind?: "single" | "multi" | "recipe" | "restock" | "chat";
  bundleTitle?: string;
  assistantSummary: string;
  bundleItems?: Array<{
    id: string;
    label: string;
    need: ParsedNeed;
    offers: Offer[];
    recommendedProductId: string | null;
    contextNote?: string;
    urgency?: "critical" | "low" | "recipe" | "requested";
  }>;
  coveredItems?: CoveredItemNote[];
  clarification?: {
    rawText: string;
    missingItem: string;
    preservedItemsText?: string;
    message: string;
  };
  chatReply?: string;
  toolTrace?: AgentToolTrace[];
  createdPendingOrder?: boolean;
  committedOrder?: boolean;
};

type ChatHistoryMsg = {
  role: "user" | "assistant";
  content: string;
};

type StrategyKey = "balanced" | "price" | "carbon" | "reliability";

const STRATEGY_OPTIONS: Array<{
  id: StrategyKey;
  label: string;
  preferences: { price: number; reliability: number; carbon: number; delivery: number };
}> = [
  {
    id: "balanced",
    label: "⚖️ Balanced",
    preferences: { price: 1, reliability: 1, carbon: 1, delivery: 1 },
  },
  {
    id: "price",
    label: "💶 Lowest Price",
    preferences: { price: 5, reliability: 0.5, carbon: 0.5, delivery: 1 },
  },
  {
    id: "carbon",
    label: "🌱 Lowest CO₂e Carbon",
    preferences: { carbon: 5, price: 0.5, reliability: 1, delivery: 1 },
  },
  {
    id: "reliability",
    label: "🚚 Highest Reliability",
    preferences: { reliability: 5, delivery: 3, price: 0.5, carbon: 0.5 },
  },
];

const DAIRY_WORDS = [
  "milk",
  "maito",
  "cream",
  "kerma",
  "yogurt",
  "yoghurt",
  "jogurtti",
  "butter",
  "cheese",
  "juusto",
  "kefir",
  "viili",
  "quark",
  "rahka",
  "skyr",
  "custard",
];

function isDairyText(text: string): boolean {
  const t = text.toLowerCase();
  return DAIRY_WORDS.some((w) => t.includes(w)) || /\bvoi(?:ta|n|ssa|lla|sta)?\b/i.test(t);
}

function hasAllergenMatch(productAllergens: string[], restricted: string): boolean {
  const r = restricted.toLowerCase().trim();
  if (!r || r === "must_be_lactose_free") return false;
  return productAllergens.some((a) => {
    const al = a.toLowerCase();
    if (al.includes(r) || r.includes(al)) return true;
    if (
      (r === "nuts" || r === "tree nuts") &&
      (al.includes("nut") || al.includes("almond") || al.includes("hazelnut"))
    ) {
      return true;
    }
    return false;
  });
}

function computeLineAutoEligible(
  offer: Offer,
  mandate: Mandate | null,
  need: ParsedNeed,
): boolean {
  if (!offer.canFulfil) return false;
  if (offer.cutoffRisk) return false;
  if (offer.availableDate && offer.availableDate > need.neededBy) return false;

  if (!mandate) {
    return !offer.isSubstitution;
  }

  if (mandate.expiresAt && new Date(mandate.expiresAt).getTime() < Date.now()) {
    return false;
  }
  if (mandate.autoPurchaseIf?.withinMaxOrderValue === false) return false;
  if (mandate.autoPurchaseIf?.deliveryOnOrBeforeNeededBy === false) return false;

  if (offer.isSubstitution) {
    if (!mandate.allowedSubstitutions || mandate.requireApprovalFor?.includes("substitution")) {
      return false;
    }
  }

  if (offer.deliveryReliability == null && !mandate.autoPurchaseIf?.reliabilityUnknownOk) {
    return false;
  }

  if (need.constraints?.maxPricePerUnit != null) {
    const perUnit =
      offer.comparisonPrice ??
      (offer.totalQuantity > 0 ? offer.totalPrice / offer.totalQuantity : null);
    if (perUnit != null && perUnit > need.constraints.maxPricePerUnit) {
      return false;
    }
  }

  if (mandate.allergenRestrictions?.includes("must_be_lactose_free")) {
    const requiresLf =
      Boolean(need.constraints?.lactoseFree) ||
      isDairyText(`${need.productIntent} ${offer.productName}`);
    if (requiresLf) {
      const isLf =
        Boolean(offer.labels?.includes("lactose-free")) ||
        /lactose[\s-]?free|laktoositon|laktosfri/i.test(offer.productName);
      if (!isLf) return false;
    }
  }

  const allProductAllergens = [...(offer.allergens ?? []), ...(offer.mayContain ?? [])];
  const allRestricted = [
    ...(mandate.allergenRestrictions ?? []).filter((r) => r !== "must_be_lactose_free"),
    ...(need.constraints?.excludeAllergens ?? []),
  ];
  for (const rest of allRestricted) {
    if (hasAllergenMatch(allProductAllergens, rest)) {
      return false;
    }
  }

  if (
    mandate.allowedBrands &&
    mandate.allowedBrands.length > 0 &&
    !mandate.allowedBrands.includes("*") &&
    offer.brand
  ) {
    const brandOk = mandate.allowedBrands.some(
      (b) => b.toLowerCase() === offer.brand!.toLowerCase(),
    );
    if (!brandOk) return false;
  }

  if (
    mandate.allowedCategories &&
    mandate.allowedCategories.length > 0 &&
    !mandate.allowedCategories.includes("*") &&
    offer.category
  ) {
    const hay = `${offer.category} ${offer.productName} ${need.productIntent}`.toLowerCase();
    const catOk = mandate.allowedCategories.some((c) => hay.includes(c.toLowerCase()));
    if (!catOk) return false;
  }

  return true;
}

function computeBundleAutoEligible(
  items: Array<{ need: ParsedNeed; selectedOffer: Offer | null }>,
  mandate: Mandate | null,
): boolean {
  if (items.length === 0) return false;
  const autoLimit = mandate?.maxOrderValueEur ?? 500;
  let totalPrice = 0;
  const qtyByUnit = new Map<string, number>();

  for (const it of items) {
    if (!it.selectedOffer) return false;
    if (!computeLineAutoEligible(it.selectedOffer, mandate, it.need)) return false;
    totalPrice += it.selectedOffer.totalPrice;
    qtyByUnit.set(it.need.unit, (qtyByUnit.get(it.need.unit) ?? 0) + it.need.quantity);
  }

  if (totalPrice > autoLimit) return false;

  if (mandate) {
    for (const [unitKey, sumQty] of qtyByUnit.entries()) {
      const cap =
        mandate.maxQuantities?.[unitKey] ??
        (mandate.maxQuantity?.unit === unitKey ? mandate.maxQuantity.value : undefined);
      if (cap != null && sumQty > cap) {
        return false;
      }
    }
  }

  return true;
}

function friendlyAgentBadge(agentId?: string, toolName?: string): { icon: string; label: string } {
  if (agentId === "planner" || /inventory|recipe|restock|event|plan/i.test(toolName ?? "")) {
    return { icon: "📋", label: "Planner" };
  }
  if (agentId === "procurement" || /intent|commit|order|approve|quote_use/i.test(toolName ?? "")) {
    return { icon: "🛒", label: "Procurement" };
  }
  if (agentId === "valio-account" || /suggestion|account/i.test(toolName ?? "")) {
    return { icon: "🏢", label: "Valio Account" };
  }
  return { icon: "🔍", label: "Sourcing" };
}

function friendlyToolName(name: string): string {
  const map: Record<string, string> = {
    parse_need: "Understood request",
    search_products: "Searched Valio catalog",
    rank_offers: "Compared live contract offers",
    get_prices: "Checked fixed prices",
    get_availability: "Checked delivery stock",
    get_mandate: "Checked kitchen rules",
    get_inventory: "Checked fridge & pantry",
    get_recipes: "Checked kitchen recipes",
    recommend_restock: "Checked low pantry stock",
    smart_restock: "Optimized pack sizes",
    plan_menu_sourcing: "Planned menu ingredients",
    request_quote: "Locked 30-min firm quote",
    create_order_intent: "Prepared order draft",
    commit_order: "Placed automatic order",
    list_events: "Checked scheduled events",
    create_event: "Created event plan",
    order_event: "Ordered event ingredients",
    list_suggestions: "Checked supplier alerts",
    run_account_check: "Ran Valio supplier check",
  };
  return map[name] ?? name.replace(/_/g, " ");
}

function renderFormattedReply(text: string) {
  const lines = tidy(text).split("\n");
  return lines.map((line, i) => {
    const trimmed = line.trim();
    if (!trimmed) return <div key={i} style={{ height: 6 }} />;
    const parts = line.split(/(\*\*[^*]+\*\*)/g);
    return (
      <div key={i} style={{ marginBottom: 3, lineHeight: 1.55 }}>
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

export function NewOrderView(props: {
  customerId?: string;
  mandate: Mandate | null;
  onChanged?: () => Promise<void> | void;
  onGoApprove?: (intentId?: string) => void;
  onOrderCreated: (intent: Intent, committedOrderId?: string) => void;
  onMessage: (msg: string, tone?: "success" | "warn" | "info") => void;
  onNavigateTab?: (
    tab: "order" | "kitchen" | "approval" | "rules" | "history" | "arena",
    subView?: string,
  ) => void;
}) {
  const [promptText, setPromptText] = useState("");
  const [strategy, setStrategy] = useState<StrategyKey>("balanced");

  // Unified Assistant response state
  const [sourceKind, setSourceKind] = useState<
    "single" | "multi" | "recipe" | "restock" | "chat"
  >("multi");
  const [bundleTitle, setBundleTitle] = useState<string>("");
  const [assistantSummary, setAssistantSummary] = useState<string>("");
  const [bundleItems, setBundleItems] = useState<BundleItemState[] | null>(null);
  const [coveredItems, setCoveredItems] = useState<CoveredItemNote[]>([]);

  // Which bundle item IDs currently have their Alternatives drawer open
  const [expandedItemIds, setExpandedItemIds] = useState<Record<string, boolean>>({});
  const [showAllAltsForId, setShowAllAltsForId] = useState<Record<string, boolean>>({});

  // Inline "+ Add item to bundle" state
  const [showAddBuilder, setShowAddBuilder] = useState(false);
  const [addText, setAddText] = useState("");
  const [addingItem, setAddingItem] = useState(false);

  // Structured manual item builder state
  const [showManualForm, setShowManualForm] = useState(false);
  const [manualItem, setManualItem] = useState("whipping cream");
  const [manualQty, setManualQty] = useState(20);
  const [manualUnit, setManualUnit] = useState<Unit>("litre");
  const [manualDate, setManualDate] = useState(nextMonday());
  const [manualLf, setManualLf] = useState(true);
  const [manualOrganic, setManualOrganic] = useState(false);

  // Clarification prompt state
  const [clarification, setClarification] = useState<{
    rawText: string;
    missingItem: string;
    preservedItemsText?: string;
    message: string;
  } | null>(null);

  // Conversational Assistant answer card (when the prompt was an open-ended question / event / comparison)
  const [assistantTurn, setAssistantTurn] = useState<{
    user: string;
    reply: string;
    traces: AgentToolTrace[];
    createdPendingOrder: boolean;
    committedOrder: boolean;
  } | null>(null);
  const [chatHistory, setChatHistory] = useState<ChatHistoryMsg[]>([]);

  // Proactive Valio Supplier Alerts state
  const [suggestions, setSuggestions] = useState<ValioSuggestion[]>([]);
  const [suggestionBusyId, setSuggestionBusyId] = useState<string | null>(null);
  const [checkingSupplier, setCheckingSupplier] = useState(false);

  const [busy, setBusy] = useState(false);
  const [orderingBundle, setOrderingBundle] = useState(false);
  const [orderingSingleOfferId, setOrderingSingleOfferId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const lastAutoCustomerRef = useRef<string | null>(null);
  const lastAutoApiKeyRef = useRef<string | null>(null);

  async function loadSuggestions() {
    try {
      const res = await api<{ suggestions: ValioSuggestion[] }>("/v1/suggestions");
      setSuggestions(res.suggestions ?? []);
    } catch {
      // Non-fatal on initial load
    }
  }

  async function runSupplierCheck() {
    setCheckingSupplier(true);
    setError(null);
    try {
      const runRes = await api<{ checked: number; created: ValioSuggestion[]; notes?: string[] }>(
        "/v1/valio-agent/run",
        {
          method: "POST",
          body: JSON.stringify({}),
        },
      );
      const listRes = await api<{ suggestions: ValioSuggestion[] }>("/v1/suggestions");
      const allOpen = (listRes.suggestions ?? []).filter((s) => s.status === "new");
      setSuggestions(listRes.suggestions ?? []);
      if ((runRes.created?.length ?? 0) > 0 || allOpen.length > 0) {
        props.onMessage(
          `Valio Supplier Agent flagged ${allOpen.length} proactive update${allOpen.length === 1 ? "" : "s"} above.`,
          "warn",
        );
      } else {
        props.onMessage(
          runRes.checked > 0
            ? `Checked ${runRes.checked} usual Valio products — stock & contract prices look healthy!`
            : `Checked Valio supplier feed — no stock-out risks on your recent orders.`,
          "info",
        );
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setCheckingSupplier(false);
    }
  }

  async function handleAcceptSuggestion(s: ValioSuggestion) {
    setSuggestionBusyId(s.id);
    setError(null);
    try {
      const res = await api<{ intent: Intent }>(
        `/v1/suggestions/${encodeURIComponent(s.id)}/accept`,
        {
          method: "POST",
          body: JSON.stringify({}),
        },
      );
      await loadSuggestions();
      const intent = res.intent;
      if (intent.status === "blocked" || intent.policy.decision === "blocked") {
        setError(
          `Stopped by your kitchen safety rules: ${intent.policy.reasons.join(" · ") || "Allergen or category restriction."}`,
        );
        return;
      }
      if (intent.status === "auto_eligible" || intent.policy.decision === "auto_commit") {
        const commitRes = await api<{ confirmation: { orderId: string } }>(
          `/v1/orders/${intent.id}/commit`,
          {
            method: "POST",
            body: JSON.stringify({ idempotencyKey: `desk-sugg-${intent.id}` }),
          },
        );
        props.onOrderCreated(intent, commitRes.confirmation.orderId);
      } else {
        props.onOrderCreated(intent);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSuggestionBusyId(null);
    }
  }

  async function handleDismissSuggestion(s: ValioSuggestion) {
    setSuggestionBusyId(s.id);
    try {
      await api(`/v1/suggestions/${encodeURIComponent(s.id)}/dismiss`, {
        method: "POST",
        body: JSON.stringify({}),
      });
      setSuggestions((prev) => prev.filter((item) => item.id !== s.id));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSuggestionBusyId(null);
    }
  }

  async function handleUnifiedSubmit(customText?: string, overrideStrategy?: StrategyKey) {
    const queryText = (customText ?? promptText).trim();
    if (!queryText) return;
    if (customText !== undefined) setPromptText(customText);

    const chosenStrategy = overrideStrategy ?? strategy;
    const prefs =
      STRATEGY_OPTIONS.find((s) => s.id === chosenStrategy)?.preferences ??
      STRATEGY_OPTIONS[0].preferences;

    setBusy(true);
    setError(null);
    setClarification(null);
    setShowAllAltsForId({});

    try {
      const res = await api<UnifiedAssistantApiResponse>("/v1/assistant/query", {
        method: "POST",
        body: JSON.stringify({
          text: queryText,
          preferences: prefs,
          history: chatHistory,
        }),
      });

      if (res.mode === "clarification" && res.clarification) {
        setBundleItems(null);
        setCoveredItems([]);
        setAssistantTurn(null);
        setClarification(res.clarification);
        return;
      }

      if (res.mode === "assistant") {
        const replyText = res.chatReply ?? res.assistantSummary;
        setChatHistory((prev) => [
          ...prev.slice(-8),
          { role: "user", content: queryText },
          { role: "assistant", content: replyText },
        ]);
        setAssistantTurn({
          user: queryText,
          reply: replyText,
          traces: res.toolTrace ?? [],
          createdPendingOrder: Boolean(res.createdPendingOrder),
          committedOrder: Boolean(res.committedOrder),
        });
        if (res.createdPendingOrder || res.committedOrder) {
          void props.onChanged?.();
        }
        if (res.bundleItems && res.bundleItems.length > 0) {
          const mapped: BundleItemState[] = res.bundleItems.map((it) => ({
            id: it.id,
            label: it.label,
            need: it.need,
            offers: it.offers,
            selectedProductId:
              it.recommendedProductId ??
              it.offers.find((o) => o.canFulfil)?.productId ??
              it.offers[0]?.productId ??
              null,
            contextNote: it.contextNote,
            urgency: it.urgency,
          }));
          setBundleItems(mapped);
          setExpandedItemIds(mapped.length === 1 ? { [mapped[0].id]: true } : {});
          setBundleTitle(res.bundleTitle ?? "Interactive Options");
          setAssistantSummary("");
        } else {
          setBundleItems(null);
        }
        setCoveredItems([]);
        return;
      }

      // Bundle mode (single-item, multi-item, recipe, or pantry restock)
      setAssistantTurn(null);
      setSourceKind(res.sourceKind ?? "multi");
      setBundleTitle(res.bundleTitle ?? "Ready-to-Order Bundle");
      setAssistantSummary(res.assistantSummary);
      setCoveredItems(res.coveredItems ?? []);

      const mapped: BundleItemState[] = (res.bundleItems ?? []).map((it, idx) => ({
        id: it.id || `item-${idx}`,
        label: it.label,
        need: it.need,
        offers: it.offers,
        selectedProductId:
          it.recommendedProductId ??
          it.offers.find((o) => o.canFulfil)?.productId ??
          it.offers[0]?.productId ??
          null,
        contextNote: it.contextNote,
        urgency: it.urgency,
      }));
      setBundleItems(mapped);
      // Expand alternatives automatically when there is only 1 item; keep multi-item bundles compact until clicked
      setExpandedItemIds(mapped.length === 1 ? { [mapped[0].id]: true } : {});
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function handleStrategyChange(nextStrategy: StrategyKey) {
    setStrategy(nextStrategy);
    if (!bundleItems || bundleItems.length === 0) return;

    const prefs =
      STRATEGY_OPTIONS.find((s) => s.id === nextStrategy)?.preferences ??
      STRATEGY_OPTIONS[0].preferences;

    setBusy(true);
    setError(null);
    try {
      if (bundleItems.length === 1) {
        const res = await api<{ offers: Offer[] }>("/v1/offers/rank", {
          method: "POST",
          body: JSON.stringify({ need: bundleItems[0].need, preferences: prefs }),
        });
        const top = res.offers.find((o) => o.canFulfil) ?? res.offers[0] ?? null;
        setBundleItems([
          {
            ...bundleItems[0],
            offers: res.offers,
            selectedProductId: top?.productId ?? null,
          },
        ]);
      } else {
        const res = await api<{ items: Array<{ need: ParsedNeed; offers: Offer[] }> }>(
          "/v1/offers/rank",
          {
            method: "POST",
            body: JSON.stringify({
              needs: bundleItems.map((b) => b.need),
              preferences: prefs,
            }),
          },
        );
        setBundleItems((prev) =>
          (prev ?? []).map((item, idx) => {
            const updatedOffers = res.items?.[idx]?.offers ?? item.offers;
            const top = updatedOffers.find((o) => o.canFulfil) ?? updatedOffers[0] ?? null;
            return {
              ...item,
              offers: updatedOffers,
              selectedProductId: top?.productId ?? item.selectedProductId,
            };
          }),
        );
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function appendNeedsToBundle(
    newEntries: Array<{ label: string; need: ParsedNeed; contextNote?: string }>,
  ) {
    if (newEntries.length === 0) return;
    const prefs =
      STRATEGY_OPTIONS.find((s) => s.id === strategy)?.preferences ??
      STRATEGY_OPTIONS[0].preferences;

    setAddingItem(true);
    setError(null);
    try {
      const rankRes =
        newEntries.length === 1
          ? await api<{ offers: Offer[] }>("/v1/offers/rank", {
              method: "POST",
              body: JSON.stringify({ need: newEntries[0].need, preferences: prefs }),
            }).then((r) => ({ items: [{ need: newEntries[0].need, offers: r.offers }] }))
          : await api<{ items: Array<{ need: ParsedNeed; offers: Offer[] }> }>("/v1/offers/rank", {
              method: "POST",
              body: JSON.stringify({
                needs: newEntries.map((e) => e.need),
                preferences: prefs,
              }),
            });

      const appended: BundleItemState[] = rankRes.items.map((it, idx) => {
        const meta = newEntries[idx];
        const top = it.offers.find((o) => o.canFulfil) ?? it.offers[0] ?? null;
        return {
          id: `item-${Date.now()}-${idx}`,
          label: meta?.label ?? it.need.productIntent,
          need: it.need,
          offers: it.offers,
          selectedProductId: top?.productId ?? null,
          contextNote: meta?.contextNote,
          urgency: "requested",
        };
      });

      setBundleItems((prev) => {
        const next = [...(prev ?? []), ...appended];
        if (next.length > 1) {
          setBundleTitle(`Ready-to-Order Bundle · ${next.length} Items`);
          setSourceKind("multi");
        }
        return next;
      });
      setAddText("");
      setShowAddBuilder(false);
      setShowManualForm(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setAddingItem(false);
    }
  }

  async function handleAddFreeformItem() {
    const raw = addText.trim();
    if (!raw) return;
    setAddingItem(true);
    setError(null);
    try {
      const parsed = await api<
        Partial<ParsedNeed> & { needs?: ParsedNeed[]; clarificationRequired?: string }
      >("/v1/need/parse", {
        method: "POST",
        body: JSON.stringify({ text: raw }),
      });
      if (parsed.clarificationRequired || (!parsed.needs?.length && !parsed.quantity)) {
        setError(
          parsed.clarificationRequired ??
            `Please include a quantity and unit when adding an item (e.g. "20 L whipping cream" or "10 bananas").`,
        );
        setAddingItem(false);
        return;
      }
      const needsList =
        parsed.needs && parsed.needs.length > 0
          ? parsed.needs
          : [
              {
                productIntent: parsed.productIntent || raw,
                quantity: parsed.quantity!,
                unit: parsed.unit!,
                neededBy: parsed.neededBy || nextMonday(),
                constraints: parsed.constraints,
              },
            ];
      await appendNeedsToBundle(
        needsList.map((n) => ({ label: n.productIntent, need: n })),
      );
    } catch (e) {
      setAddingItem(false);
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  async function handleAddManualItem(replaceExisting: boolean) {
    const trimmed = manualItem.trim() || "lactose-free milk";
    const need: ParsedNeed = {
      productIntent: trimmed,
      quantity: manualQty,
      unit: manualUnit,
      neededBy: manualDate,
      constraints: {
        lactoseFree: manualLf || undefined,
        organic: manualOrganic || undefined,
        keywords: trimmed.split(/\s+/).filter(Boolean),
      },
    };
    if (replaceExisting || !bundleItems || bundleItems.length === 0) {
      const desc = [
        manualOrganic && !/organic|luomu/i.test(trimmed) ? "organic" : "",
        manualLf && !/lactose/i.test(trimmed) ? "lactose-free" : "",
        trimmed,
      ]
        .filter(Boolean)
        .join(" ");
      setShowManualForm(false);
      await handleUnifiedSubmit(`${manualQty} ${unitLabel(manualUnit)} ${desc} by ${manualDate}`);
    } else {
      await appendNeedsToBundle([{ label: trimmed, need }]);
    }
  }

  function handleRemoveBundleItem(id: string) {
    setBundleItems((prev) => {
      if (!prev) return prev;
      const next = prev.filter((item) => item.id !== id);
      if (next.length === 1) {
        setExpandedItemIds({ [next[0].id]: true });
      }
      return next;
    });
  }

  async function handleIncludeCoveredItem(cov: CoveredItemNote) {
    setCoveredItems((prev) => prev.filter((c) => c.name !== cov.name));
    await appendNeedsToBundle([
      {
        label: cov.name,
        need: cov.needToAdd,
        contextNote: `Added manually (${cov.onHand} ${cov.unit} already in fridge)`,
      },
    ]);
  }

  async function handleOrderBundle(singleOfferOverride?: Offer) {
    if (!bundleItems || bundleItems.length === 0) return;

    const chosenLines = bundleItems
      .map((item, idx) => {
        const selectedOffer =
          idx === 0 && singleOfferOverride
            ? singleOfferOverride
            : item.offers.find((o) => o.productId === item.selectedProductId) ??
              item.offers[0] ??
              null;
        return { item, selectedOffer };
      })
      .filter((x): x is { item: BundleItemState; selectedOffer: Offer } => x.selectedOffer !== null);

    if (chosenLines.length === 0) {
      setError("No valid Valio product offers are available to order in this bundle.");
      return;
    }

    if (singleOfferOverride) {
      setOrderingSingleOfferId(singleOfferOverride.productId);
    } else {
      setOrderingBundle(true);
    }
    setError(null);

    try {
      let intent: Intent;

      if (chosenLines.length === 1) {
        const only = chosenLines[0];
        const shortlistIds = Array.from(
          new Set([
            only.selectedOffer.productId,
            ...only.item.offers.slice(0, 3).map((o) => o.productId),
          ]),
        );
        const quote = await api<{ quoteId: string }>("/v1/quotes", {
          method: "POST",
          body: JSON.stringify({ need: only.item.need, productIds: shortlistIds }),
        });
        const res = await api<{ intent: Intent }>("/v1/orders/intent", {
          method: "POST",
          body: JSON.stringify({
            quoteId: quote.quoteId,
            offerProductId: only.selectedOffer.productId,
          }),
        });
        intent = res.intent;
      } else {
        const quote = await api<{ quoteId: string }>("/v1/quotes", {
          method: "POST",
          body: JSON.stringify({
            items: chosenLines.map((c) => ({
              need: c.item.need,
              productId: c.selectedOffer.productId,
            })),
          }),
        });
        const res = await api<{ intent: Intent }>("/v1/orders/intent", {
          method: "POST",
          body: JSON.stringify({ quoteId: quote.quoteId }),
        });
        intent = res.intent;
      }

      if (intent.status === "blocked" || intent.policy.decision === "blocked") {
        setError(
          `Stopped by your kitchen safety rules: ${intent.policy.reasons.join(" · ") || "Allergen or category restriction."}`,
        );
        return;
      }

      if (intent.status === "auto_eligible" || intent.policy.decision === "auto_commit") {
        const commitRes = await api<{ confirmation: { orderId: string } }>(
          `/v1/orders/${intent.id}/commit`,
          {
            method: "POST",
            body: JSON.stringify({ idempotencyKey: `desk-bundle-${intent.id}` }),
          },
        );
        props.onOrderCreated(intent, commitRes.confirmation.orderId);
      } else {
        props.onOrderCreated(intent);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setOrderingBundle(false);
      setOrderingSingleOfferId(null);
    }
  }

  // Initial load once per customer & clean reset on customer switch
  useEffect(() => {
    const currentKey = getApiKey();
    const resolvedCustomer = props.customerId ?? props.mandate?.customerId ?? "default";

    if (lastAutoCustomerRef.current === null) {
      lastAutoCustomerRef.current = resolvedCustomer;
      lastAutoApiKeyRef.current = currentKey;
      void loadSuggestions();
      return;
    }

    if (
      lastAutoCustomerRef.current === "default" &&
      resolvedCustomer !== "default" &&
      lastAutoApiKeyRef.current === currentKey
    ) {
      lastAutoCustomerRef.current = resolvedCustomer;
      return;
    }

    if (
      resolvedCustomer !== lastAutoCustomerRef.current ||
      currentKey !== lastAutoApiKeyRef.current
    ) {
      lastAutoCustomerRef.current = resolvedCustomer;
      lastAutoApiKeyRef.current = currentKey;
      setPromptText("");
      setBundleItems(null);
      setCoveredItems([]);
      setBundleTitle("");
      setAssistantSummary("");
      setChatHistory([]);
      setAssistantTurn(null);
      setClarification(null);
      setError(null);
      void loadSuggestions();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.customerId, props.mandate?.customerId]);

  const openSuggestions = suggestions.filter((s) => s.status === "new");
  const activeCustomerKey = props.customerId ?? props.mandate?.customerId ?? "default";

  // Derived bundle summary metrics
  const resolvedBundleRows = (bundleItems ?? []).map((item) => {
    const selectedOffer =
      item.offers.find((o) => o.productId === item.selectedProductId) ?? item.offers[0] ?? null;
    return { item, selectedOffer };
  });
  const validBundleRows = resolvedBundleRows.filter((r) => r.selectedOffer !== null);
  const totalBundlePrice = validBundleRows.reduce(
    (sum, r) => sum + (r.selectedOffer?.totalPrice ?? 0),
    0,
  );
  const totalBundlePacks = validBundleRows.reduce(
    (sum, r) => sum + (r.selectedOffer?.requiredPacks ?? 0),
    0,
  );
  const bundleLikelyAuto =
    resolvedBundleRows.length > 0 &&
    resolvedBundleRows.every((r) => r.selectedOffer !== null) &&
    computeBundleAutoEligible(
      resolvedBundleRows.map((r) => ({ need: r.item.need, selectedOffer: r.selectedOffer })),
      props.mandate,
    );

  // Tailored quick-quantity chips for clarification prompts
  const missingItemLower = clarification?.missingItem.toLowerCase() ?? "";
  const quickAmounts = /\b(banana|apple|orange|egg|lemon|avocado|tomato|roll|croissant|muffin|bun)s?\b/i.test(
    missingItemLower,
  )
    ? ["10 pcs", "30 pcs", "5 kg", "10 kg"]
    : /\b(milk|maito|cream|kerma|juice|oat|buttermilk|kefir|drink)\b/i.test(missingItemLower)
      ? ["20 L", "100 L", "250 L", "10 packs"]
      : ["5 kg", "10 kg", "25 kg", "10 packs"];

  return (
    <div className="page-wrap">
      {/* Proactive Valio Supplier Alerts Strip */}
      {openSuggestions.length > 0 && (
        <div style={{ display: "flex", flexDirection: "column", gap: 12, marginBottom: 22 }}>
          {openSuggestions.map((s) => {
            const isStockout = s.kind === "stockout_alert";
            const isWorking = suggestionBusyId === s.id;
            return (
              <div
                key={s.id}
                className={`banner ${isStockout ? "warn" : "info"}`}
                style={{
                  alignItems: "center",
                  flexWrap: "wrap",
                  padding: "16px 20px",
                }}
              >
                <div style={{ flex: "1 1 420px" }}>
                  <div
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 8,
                      flexWrap: "wrap",
                      marginBottom: 6,
                    }}
                  >
                    <span className={`pill ${isStockout ? "amber" : "blue"}`}>
                      {isStockout ? "⚠ Valio Supplier Stock-Out Alert" : "💶 Valio Contract Savings Tip"}
                    </span>
                    <span className="pill green">
                      {s.deltaEur <= 0
                        ? `Saves ${money(Math.abs(s.deltaEur))}`
                        : `+${money(s.deltaEur)}`}
                    </span>
                  </div>
                  <div style={{ fontWeight: 800, fontSize: 15.5, color: "var(--text-main)" }}>
                    {tidy(s.title)}
                  </div>
                  <div style={{ fontSize: 13.5, marginTop: 3, lineHeight: 1.45 }}>
                    {tidy(s.body)} · Recommended: <strong>{s.suggestedProductName}</strong>
                  </div>
                </div>

                <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                  <button
                    type="button"
                    className="btn primary"
                    style={{ minHeight: 42, padding: "9px 16px", fontSize: 13.5 }}
                    disabled={isWorking}
                    onClick={() => void handleAcceptSuggestion(s)}
                  >
                    {isWorking ? "Preparing…" : "Accept & Review"}
                  </button>
                  <button
                    type="button"
                    className="btn secondary"
                    style={{ minHeight: 42, padding: "9px 14px", fontSize: 13.5 }}
                    disabled={isWorking}
                    onClick={() => void handleDismissSuggestion(s)}
                  >
                    Dismiss
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Slim 1-Row Auto-Restock & Inventory Sync Status Strip */}
      <InventorySyncGuardCard
        variant="compact"
        customerId={activeCustomerKey}
        mandate={props.mandate}
        onChanged={props.onChanged}
        onMessage={props.onMessage}
        onGoApprove={props.onGoApprove}
        onOpenSettings={() => props.onNavigateTab?.("kitchen", "pantry")}
      />

      {/* Prominent Zero-Portal Phone Call Attraction */}
      <PhoneCallHero
        customerId={activeCustomerKey}
        onMessage={props.onMessage}
        onNavigateTab={props.onNavigateTab}
        onVoiceOrderPrompt={(spoken) => {
          void handleUnifiedSubmit(spoken);
        }}
      />

      <div className="page-header" style={{ marginBottom: 20 }}>
        <h1 className="page-title">What does your kitchen need?</h1>
        <p className="page-subtitle">
          Ask for one item, multiple items, recipe ingredients, or pantry restock — your assistant prepares a ready-to-order Valio bundle.
        </p>
      </div>

      {/* Single Unified Kitchen AI Assistant Input */}
      <div style={{ maxWidth: 940, margin: "0 auto 24px" }}>
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
            <span className="pill blue" style={{ fontSize: 12.5 }}>
              ✨ Unified Kitchen Assistant
            </span>
            <span style={{ fontSize: 12.5, color: "var(--text-soft)", fontWeight: 600 }}>
              Single items · Multi-item bundles · Recipes · Pantry &amp; Questions
            </span>
          </div>

          <button
            type="button"
            className="chip-btn"
            disabled={checkingSupplier || busy}
            onClick={() => void runSupplierCheck()}
            style={{
              fontSize: 12.5,
              opacity: checkingSupplier || busy ? 0.55 : 1,
              cursor: checkingSupplier || busy ? "not-allowed" : "pointer",
            }}
          >
            {checkingSupplier ? "Checking Valio feed…" : "🔔 Check Valio Supplier Alerts"}
          </button>
        </div>

        <form
          onSubmit={(e) => {
            e.preventDefault();
            void handleUnifiedSubmit();
          }}
          className="search-box"
        >
          <input
            type="text"
            className="search-input"
            value={promptText}
            onChange={(e) => setPromptText(e.target.value)}
            placeholder="Describe what your kitchen needs — items, recipe ingredients, or pantry restock…"
            aria-label="What does your kitchen need?"
          />
          <button type="submit" className="btn primary" disabled={busy || !promptText.trim()}>
            {busy ? "Preparing…" : "Prepare Order"}
          </button>
        </form>

        <div className="chips-row">
          <span style={{ fontSize: 13, fontWeight: 600, color: "var(--text-soft)" }}>
            Try:
          </span>
          <button
            type="button"
            className="chip-btn"
            disabled={busy}
            style={{ opacity: busy ? 0.55 : 1, cursor: busy ? "not-allowed" : "pointer" }}
            onClick={() =>
              void handleUnifiedSubmit("100 litres of lactose-free milk and 10 bananas by Monday")
            }
          >
            🛒 100 L Milk + 10 Bananas
          </button>
          <button
            type="button"
            className="chip-btn"
            disabled={busy}
            style={{ opacity: busy ? 0.55 : 1, cursor: busy ? "not-allowed" : "pointer" }}
            onClick={() =>
              void handleUnifiedSubmit(
                "Order ingredients for 4 batches of buttermilk pancakes by Monday",
              )
            }
          >
            🍳 Pancakes Recipe Bundle
          </button>
          <button
            type="button"
            className="chip-btn"
            disabled={busy}
            style={{ opacity: busy ? 0.55 : 1, cursor: busy ? "not-allowed" : "pointer" }}
            onClick={() => void handleUnifiedSubmit("100 litres of lactose-free milk by Monday")}
          >
            100 L Milk (Auto-orders)
          </button>
          <button
            type="button"
            className="chip-btn"
            disabled={busy}
            style={{ opacity: busy ? 0.55 : 1, cursor: busy ? "not-allowed" : "pointer" }}
            onClick={() => void handleUnifiedSubmit("1000 litres of lactose-free milk by Monday")}
          >
            1,000 L Banquet Milk (Needs OK)
          </button>
          <button
            type="button"
            className="chip-btn"
            disabled={busy}
            style={{ opacity: busy ? 0.55 : 1, cursor: busy ? "not-allowed" : "pointer" }}
            onClick={() => void handleUnifiedSubmit("What is running low in our pantry this week?")}
          >
            🥛 Restock Low Pantry
          </button>
          <button
            type="button"
            className="link-quiet"
            style={{ marginLeft: "auto" }}
            onClick={() => setShowManualForm((s) => !s)}
          >
            {showManualForm ? "Hide item builder" : "+ Custom item / date"}
          </button>
        </div>

        {showManualForm && (
          <div className="card" style={{ marginTop: 14, padding: 18 }}>
            <div style={{ display: "flex", gap: 12, flexWrap: "wrap", alignItems: "flex-end" }}>
              <label
                style={{
                  flex: "2 1 200px",
                  display: "flex",
                  flexDirection: "column",
                  gap: 5,
                  fontSize: 13,
                  fontWeight: 700,
                }}
              >
                Item
                <input
                  className="field-input"
                  value={manualItem}
                  onChange={(e) => setManualItem(e.target.value)}
                />
              </label>
              <label
                style={{
                  flex: "1 1 90px",
                  display: "flex",
                  flexDirection: "column",
                  gap: 5,
                  fontSize: 13,
                  fontWeight: 700,
                }}
              >
                Amount
                <input
                  type="number"
                  min={1}
                  className="field-input"
                  value={manualQty}
                  onChange={(e) => setManualQty(Math.max(1, Number(e.target.value) || 1))}
                />
              </label>
              <label
                style={{
                  flex: "1 1 110px",
                  display: "flex",
                  flexDirection: "column",
                  gap: 5,
                  fontSize: 13,
                  fontWeight: 700,
                }}
              >
                Unit
                <select
                  className="field-select"
                  value={manualUnit}
                  onChange={(e) => setManualUnit(e.target.value as Unit)}
                >
                  <option value="litre">Litres (L)</option>
                  <option value="kg">Kilograms (kg)</option>
                  <option value="each">Pieces</option>
                  <option value="pack">Packs</option>
                </select>
              </label>
              <label
                style={{
                  flex: "1 1 145px",
                  display: "flex",
                  flexDirection: "column",
                  gap: 5,
                  fontSize: 13,
                  fontWeight: 700,
                }}
              >
                Delivery by
                <input
                  type="date"
                  className="field-input"
                  value={manualDate}
                  onChange={(e) => setManualDate(e.target.value)}
                />
              </label>
              <label
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 7,
                  fontSize: 13.5,
                  fontWeight: 600,
                  paddingBottom: 10,
                }}
              >
                <input
                  type="checkbox"
                  checked={manualLf}
                  onChange={(e) => setManualLf(e.target.checked)}
                />
                Lactose-free
              </label>
              <label
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 7,
                  fontSize: 13.5,
                  fontWeight: 600,
                  paddingBottom: 10,
                }}
              >
                <input
                  type="checkbox"
                  checked={manualOrganic}
                  onChange={(e) => setManualOrganic(e.target.checked)}
                />
                Organic
              </label>
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                {bundleItems && bundleItems.length > 0 && (
                  <button
                    type="button"
                    className="btn primary"
                    disabled={busy || addingItem}
                    onClick={() => void handleAddManualItem(false)}
                  >
                    {addingItem ? "Adding…" : "+ Add to Bundle"}
                  </button>
                )}
                <button
                  type="button"
                  className="btn secondary"
                  disabled={busy || addingItem}
                  onClick={() => void handleAddManualItem(true)}
                >
                  Replace Search
                </button>
              </div>
            </div>
          </div>
        )}
      </div>

      {error && (
        <div className="banner error" style={{ maxWidth: 940, margin: "0 auto 20px" }}>
          <div>{error}</div>
          <button type="button" className="link-quiet" onClick={() => setError(null)}>
            Dismiss
          </button>
        </div>
      )}

      {/* Friendly Inline Quantity Clarification (Supports Both Single & Multi-Item Prompts) */}
      {clarification && (
        <div className="card" style={{ maxWidth: 940, margin: "0 auto 24px" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
            <span className="pill amber">Quick Quantity Check</span>
            <span style={{ fontSize: 13, color: "var(--text-muted)", fontWeight: 600 }}>
              We never guess quantities on your behalf
            </span>
          </div>
          <h3 style={{ margin: "0 0 6px", fontSize: 18, fontWeight: 800 }}>
            How much “{clarification.missingItem}” should we include?
          </h3>
          <p style={{ margin: "0 0 14px", fontSize: 14, color: "var(--text-muted)" }}>
            {tidy(clarification.message)}
          </p>

          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
            {quickAmounts.map((amt) => {
              const completedPrompt = clarification.preservedItemsText
                ? `${clarification.preservedItemsText} and ${amt} ${clarification.missingItem}`
                : `${amt} of ${clarification.missingItem} by ${nextMonday()}`;
              return (
                <button
                  key={amt}
                  type="button"
                  className="btn secondary"
                  style={{ minHeight: 42, padding: "8px 16px", fontSize: 13.5 }}
                  disabled={busy}
                  onClick={() => void handleUnifiedSubmit(completedPrompt)}
                >
                  {amt} {clarification.missingItem} →
                </button>
              );
            })}
          </div>
        </div>
      )}

      {/* Conversational Specialist Answer Card (Open-Ended Questions, Events, Read-Only Comparisons) */}
      {assistantTurn && (
        <div className="card" style={{ maxWidth: 940, margin: "0 auto 24px", padding: 22 }}>
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
              gap: 8,
              flexWrap: "wrap",
              background: "var(--bg-subtle)",
              padding: "9px 14px",
              borderRadius: 10,
              marginBottom: 14,
            }}
          >
            <span style={{ fontSize: 13.5, fontWeight: 700, color: "var(--brand-navy)" }}>
              👨‍🍳 You asked: “{assistantTurn.user}”
            </span>
            <button
              type="button"
              className="link-quiet"
              onClick={() => setAssistantTurn(null)}
            >
              Dismiss
            </button>
          </div>

          {assistantTurn.traces.length > 0 && (
            <div
              style={{
                display: "flex",
                gap: 6,
                flexWrap: "wrap",
                alignItems: "center",
                marginBottom: 12,
              }}
            >
              {Array.from(
                new Map(
                  assistantTurn.traces.map((t) => {
                    const b = friendlyAgentBadge(t.agent, t.name);
                    return [b.label, b];
                  }),
                ).values(),
              ).map((ag) => (
                <span key={ag.label} className="pill blue">
                  {ag.icon} {ag.label}
                </span>
              ))}
              {assistantTurn.traces.slice(0, 5).map((tr, tIdx) => (
                <span
                  key={tIdx}
                  className={`pill ${tr.ok ? "gray" : "amber"}`}
                  style={{ fontWeight: 600, fontSize: 12 }}
                >
                  {tr.ok ? "✓" : "⚠"} {friendlyToolName(tr.name)}
                </span>
              ))}
            </div>
          )}

          <div style={{ fontSize: 14.5, color: "var(--text-main)" }}>
            {renderFormattedReply(assistantTurn.reply)}
          </div>

          {(assistantTurn.createdPendingOrder || assistantTurn.committedOrder) &&
            props.onNavigateTab && (
              <div
                style={{
                  display: "flex",
                  gap: 10,
                  flexWrap: "wrap",
                  marginTop: 14,
                  paddingTop: 12,
                  borderTop: "1px solid var(--border-light)",
                }}
              >
                {assistantTurn.createdPendingOrder && !assistantTurn.committedOrder && (
                  <button
                    type="button"
                    className="btn primary"
                    style={{ minHeight: 42, padding: "8px 16px", fontSize: 13.5 }}
                    onClick={() => props.onNavigateTab?.("approval")}
                  >
                    Review in Needs Your OK →
                  </button>
                )}
                {assistantTurn.committedOrder && (
                  <button
                    type="button"
                    className="btn success"
                    style={{ minHeight: 42, padding: "8px 16px", fontSize: 13.5 }}
                    onClick={() => props.onNavigateTab?.("history")}
                  >
                    ✓ View Placed Order in Past Orders →
                  </button>
                )}
              </div>
            )}
        </div>
      )}

      {/* Interactive Unified Order Bundle (Works for 1 Item, Multi-Item Bundles, Recipes & Pantry Restock) */}
      {bundleItems && bundleItems.length > 0 && (
        <div style={{ maxWidth: 940, margin: "0 auto" }}>
          {/* Assistant Summary + Strategy Switcher */}
          <div
            style={{
              display: "flex",
              flexWrap: "wrap",
              alignItems: "center",
              justifyContent: "space-between",
              gap: 12,
              marginBottom: 16,
            }}
          >
            {assistantSummary && (
              <div className="banner info" style={{ flex: "1 1 420px", padding: "13px 18px" }}>
                <div style={{ fontSize: 14 }}>{renderFormattedReply(assistantSummary)}</div>
              </div>
            )}

            <div
              role="group"
              aria-label="Ranking priority"
              style={{
                display: "flex",
                alignItems: "center",
                gap: 6,
                flexWrap: "wrap",
                background: "#ffffff",
                padding: "6px 8px",
                borderRadius: 14,
                border: "1px solid var(--border-light)",
                boxShadow: "var(--shadow-card)",
              }}
            >
              <span
                style={{
                  fontSize: 12,
                  fontWeight: 700,
                  color: "var(--text-soft)",
                  padding: "0 6px",
                }}
              >
                Rank by:
              </span>
              {STRATEGY_OPTIONS.map((opt) => {
                const active = strategy === opt.id;
                return (
                  <button
                    key={opt.id}
                    type="button"
                    disabled={busy}
                    onClick={() => void handleStrategyChange(opt.id)}
                    style={{
                      appearance: "none",
                      border: active
                        ? "1.5px solid var(--brand-blue)"
                        : "1px solid transparent",
                      background: active ? "var(--bg-blue-soft)" : "transparent",
                      color: active ? "var(--brand-blue)" : "var(--text-muted)",
                      fontFamily: "inherit",
                      fontSize: 12.5,
                      fontWeight: 700,
                      padding: "6px 11px",
                      borderRadius: 999,
                      cursor: busy ? "not-allowed" : "pointer",
                      opacity: busy ? 0.6 : 1,
                    }}
                  >
                    {opt.label}
                  </button>
                );
              })}
            </div>
          </div>

          {/* Recipe Covered-in-Fridge Strip */}
          {coveredItems.length > 0 && (
            <div
              className="card-subtle"
              style={{
                marginBottom: 16,
                padding: "12px 16px",
                display: "flex",
                alignItems: "center",
                gap: 10,
                flexWrap: "wrap",
              }}
            >
              <span style={{ fontSize: 13, fontWeight: 700, color: "var(--green-text)" }}>
                ✓ Already covered in fridge:
              </span>
              {coveredItems.map((cov) => (
                <span
                  key={cov.name}
                  style={{
                    display: "inline-flex",
                    alignItems: "center",
                    gap: 8,
                    background: "#ffffff",
                    border: "1px solid var(--border-light)",
                    borderRadius: 999,
                    padding: "4px 12px",
                    fontSize: 12.5,
                    fontWeight: 600,
                  }}
                >
                  <span>
                    {cov.name} ({cov.requiredQty} {cov.unit} needed · {cov.onHand} {cov.unit} on hand)
                  </span>
                  <button
                    type="button"
                    className="link-quiet"
                    style={{ fontSize: 12, fontWeight: 700 }}
                    disabled={addingItem}
                    onClick={() => void handleIncludeCoveredItem(cov)}
                  >
                    + Include anyway
                  </button>
                </span>
              ))}
            </div>
          )}

          {/* Main Bundle Container Card */}
          <div className="card" style={{ padding: 24 }}>
            {/* Bundle Checkout Header */}
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                gap: 16,
                flexWrap: "wrap",
                paddingBottom: 18,
                marginBottom: 18,
                borderBottom: "1px solid var(--border-light)",
              }}
            >
              <div>
                <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", marginBottom: 4 }}>
                  <span className="pill blue">
                    {sourceKind === "recipe"
                      ? "🍳 Recipe Ingredient Bundle"
                      : sourceKind === "restock"
                        ? "🥛 Pantry Restock Bundle"
                        : bundleItems.length > 1
                          ? `🛒 ${bundleItems.length}-Item Order Bundle`
                          : "⚡ Best Match Ready"}
                  </span>
                  <span
                    className={`pill ${bundleLikelyAuto ? "green" : "amber"}`}
                  >
                    {bundleLikelyAuto
                      ? `✓ Auto-orders within ${money(props.mandate?.maxOrderValueEur ?? 500, 0)} rule`
                      : "Needs quick OK in Approval"}
                  </span>
                </div>
                <h2 style={{ margin: 0, fontSize: 21, fontWeight: 800 }}>{bundleTitle}</h2>
                <div style={{ fontSize: 13.5, color: "var(--text-muted)", marginTop: 3 }}>
                  {bundleItems.length > 1
                    ? "Click any item below to view or swap alternative Valio products, or place the entire bundle at once."
                    : "Order the recommended match directly, swap an alternative below, or add more items to build a bundle."}
                </div>
              </div>

              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 14,
                  flexWrap: "wrap",
                }}
              >
                <div style={{ textAlign: "right" }}>
                  <div style={{ fontSize: 12, fontWeight: 700, color: "var(--text-soft)" }}>
                    {validBundleRows.length}{" "}
                    {validBundleRows.length === 1 ? "item" : "items"} · {totalBundlePacks}{" "}
                    {totalBundlePacks === 1 ? "pack" : "packs"}
                  </div>
                  <div className="price-big">{money(totalBundlePrice)}</div>
                </div>

                <button
                  type="button"
                  className="btn primary"
                  style={{ minHeight: 48, padding: "12px 22px", fontSize: 15 }}
                  disabled={orderingBundle || validBundleRows.length === 0 || busy}
                  onClick={() => void handleOrderBundle()}
                >
                  {orderingBundle
                    ? "Locking fixed prices…"
                    : bundleLikelyAuto
                      ? bundleItems.length > 1
                        ? `Order All ${validBundleRows.length} Items (${money(totalBundlePrice)})`
                        : `Order Now (${money(totalBundlePrice)})`
                      : bundleItems.length > 1
                        ? `Review & Approve Bundle (${money(totalBundlePrice)}) →`
                        : `Review & Approve (${money(totalBundlePrice)}) →`}
                </button>
              </div>
            </div>

            {/* Bundle Item Rows (Clickable to Expand/Swap Alternatives) */}
            <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
              {resolvedBundleRows.map(({ item, selectedOffer }, itemIdx) => {
                const isExpanded = Boolean(expandedItemIds[item.id]);
                const altCount = Math.max(0, item.offers.length - 1);
                const showAllAlts = Boolean(showAllAltsForId[item.id]);
                const displayedOffers = showAllAlts ? item.offers : item.offers.slice(0, 4);

                const toggleExpand = () => {
                  setExpandedItemIds((prev) => ({
                    ...prev,
                    [item.id]: !prev[item.id],
                  }));
                };

                const declaredAllergens = selectedOffer?.allergens ?? [];
                const mayContainList = selectedOffer?.mayContain ?? [];
                const countryName = originLabel(selectedOffer?.origin);
                const normCompUnit = unitLabel(selectedOffer?.comparisonUnit);
                const isLate = Boolean(
                  selectedOffer?.availableDate &&
                    selectedOffer.availableDate > item.need.neededBy,
                );

                return (
                  <div
                    key={item.id}
                    style={{
                      border: isExpanded
                        ? "2px solid var(--brand-blue)"
                        : "1.5px solid var(--border-light)",
                      borderRadius: 16,
                      background: "#ffffff",
                      overflow: "hidden",
                      transition: "border-color 150ms ease, box-shadow 150ms ease",
                    }}
                  >
                    {/* Clickable Item Summary Row */}
                    <div
                      role="button"
                      tabIndex={0}
                      onClick={toggleExpand}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" || e.key === " ") {
                          e.preventDefault();
                          toggleExpand();
                        }
                      }}
                      style={{
                        padding: "16px 18px",
                        cursor: "pointer",
                        display: "flex",
                        justifyContent: "space-between",
                        alignItems: "flex-start",
                        gap: 16,
                        flexWrap: "wrap",
                        background: isExpanded ? "var(--bg-blue-soft)" : "#ffffff",
                      }}
                    >
                      <div style={{ flex: "1 1 420px" }}>
                        {/* Item Header Badges */}
                        <div
                          style={{
                            display: "flex",
                            alignItems: "center",
                            gap: 8,
                            flexWrap: "wrap",
                            marginBottom: 6,
                          }}
                        >
                          <span className="pill gray" style={{ fontWeight: 800 }}>
                            Item {itemIdx + 1}
                          </span>
                          <span style={{ fontSize: 13.5, fontWeight: 700, color: "var(--brand-navy)" }}>
                            Need: {qty(item.need.quantity, item.need.unit)} of {item.need.productIntent} · by{" "}
                            {day(item.need.neededBy)}
                          </span>
                          {item.urgency === "critical" && (
                            <span className="pill red" style={{ fontSize: 11.5 }}>
                              Critical Stock
                            </span>
                          )}
                          {item.contextNote && (
                            <span style={{ fontSize: 12.5, color: "var(--text-muted)" }}>
                              ({item.contextNote})
                            </span>
                          )}
                        </div>

                        {selectedOffer ? (
                          <>
                            <div style={{ fontSize: 17, fontWeight: 800, color: "var(--text-main)" }}>
                              {selectedOffer.productName}
                            </div>

                            <div
                              style={{
                                display: "flex",
                                alignItems: "center",
                                gap: 10,
                                flexWrap: "wrap",
                                fontSize: 13.5,
                                color: "var(--text-muted)",
                                marginTop: 4,
                              }}
                            >
                              <strong style={{ color: "var(--text-main)" }}>
                                {selectedOffer.requiredPacks} ×{" "}
                                {qty(selectedOffer.packSize, selectedOffer.packUnit)} (
                                {qty(selectedOffer.totalQuantity, selectedOffer.quantityUnit)} total)
                              </strong>
                              <span>
                                · {money(selectedOffer.unitPrice)} / pack
                                {selectedOffer.comparisonPrice != null && normCompUnit
                                  ? ` (${money(selectedOffer.comparisonPrice)} / ${normCompUnit})`
                                  : ""}
                              </span>
                              <span
                                style={{
                                  fontWeight: 600,
                                  color: isLate ? "var(--amber-text)" : "var(--green-main)",
                                }}
                              >
                                {isLate
                                  ? `⚠ Arrives ${day(selectedOffer.availableDate)}`
                                  : `✓ ${
                                      selectedOffer.availableDate
                                        ? `Arrives ${day(selectedOffer.availableDate)}`
                                        : `On time for ${day(item.need.neededBy)}`
                                    }`}
                              </span>
                            </div>

                            {/* Compact Dietary, Carbon & Allergen Badges */}
                            <div
                              style={{
                                display: "flex",
                                gap: 6,
                                flexWrap: "wrap",
                                alignItems: "center",
                                marginTop: 8,
                              }}
                            >
                              {selectedOffer.labels?.some((l) => /lactose/i.test(l)) && (
                                <span className="pill green" style={{ fontSize: 11.5, padding: "2px 8px" }}>
                                  ✓ Lactose-Free
                                </span>
                              )}
                              {countryName && (
                                <span className="pill gray" style={{ fontSize: 11.5, padding: "2px 8px" }}>
                                  {countryName}
                                </span>
                              )}
                              {selectedOffer.carbonKgPerKg != null && (
                                <span className="pill gray" style={{ fontSize: 11.5, padding: "2px 8px" }}>
                                  🌱 {selectedOffer.carbonKgPerKg.toFixed(2)} kg CO₂e/kg
                                </span>
                              )}
                              {selectedOffer.deliveryReliability != null && (
                                <span className="pill gray" style={{ fontSize: 11.5, padding: "2px 8px" }}>
                                  🚚 {Math.round(selectedOffer.deliveryReliability * 100)}% on-time
                                </span>
                              )}
                              {declaredAllergens.length > 0 ? (
                                <span className="pill amber" style={{ fontSize: 11.5, padding: "2px 8px" }}>
                                  Contains: {declaredAllergens.join(", ")}
                                </span>
                              ) : mayContainList.length > 0 ? (
                                <span className="pill red" style={{ fontSize: 11.5, padding: "2px 8px" }}>
                                  May contain: {mayContainList.join(", ")}
                                </span>
                              ) : (
                                <span className="pill gray" style={{ fontSize: 11.5, padding: "2px 8px" }}>
                                  Allergens: none declared
                                </span>
                              )}
                            </div>
                          </>
                        ) : (
                          <div style={{ fontSize: 14, color: "var(--amber-text)", fontWeight: 600 }}>
                            ⚠ No matching Valio catalog SKU found for this item.
                          </div>
                        )}
                      </div>

                      {/* Right Side: Line Price + Swap Alternatives Toggle + Remove */}
                      <div
                        style={{
                          display: "flex",
                          flexDirection: "column",
                          alignItems: "flex-end",
                          gap: 8,
                        }}
                        onClick={(e) => e.stopPropagation()}
                      >
                        {selectedOffer && (
                          <div style={{ fontSize: 20, fontWeight: 800, color: "var(--text-main)" }}>
                            {money(selectedOffer.totalPrice)}
                          </div>
                        )}

                        <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                          {item.offers.length > 1 && (
                            <button
                              type="button"
                              className="btn secondary"
                              style={{ minHeight: 36, padding: "6px 12px", fontSize: 12.5 }}
                              onClick={toggleExpand}
                            >
                              {isExpanded
                                ? "Hide Alternatives ▲"
                                : `⇄ Swap / Alternatives (${altCount}) ▾`}
                            </button>
                          )}

                          {bundleItems.length > 1 && (
                            <button
                              type="button"
                              className="link-quiet"
                              style={{ fontSize: 12.5, color: "var(--text-soft)" }}
                              onClick={() => handleRemoveBundleItem(item.id)}
                            >
                              Remove
                            </button>
                          )}
                        </div>
                      </div>
                    </div>

                    {/* Expandable Alternatives Drawer */}
                    {isExpanded && item.offers.length > 0 && (
                      <div
                        style={{
                          padding: "16px 18px 18px",
                          borderTop: "1px solid var(--border-light)",
                          background: "var(--bg-canvas)",
                        }}
                      >
                        <div
                          style={{
                            display: "flex",
                            justifyContent: "space-between",
                            alignItems: "center",
                            gap: 8,
                            marginBottom: 12,
                            flexWrap: "wrap",
                          }}
                        >
                          <div style={{ fontSize: 13.5, fontWeight: 800, color: "var(--text-main)" }}>
                            Select a Valio option for {qty(item.need.quantity, item.need.unit)} of{" "}
                            {item.need.productIntent}:
                          </div>
                          {item.offers.length > 4 && (
                            <button
                              type="button"
                              className="link-quiet"
                              style={{ fontSize: 12.5 }}
                              onClick={() =>
                                setShowAllAltsForId((prev) => ({
                                  ...prev,
                                  [item.id]: !prev[item.id],
                                }))
                              }
                            >
                              {showAllAlts
                                ? "Show top 4 options"
                                : `See all ${item.offers.length} matching options`}
                            </button>
                          )}
                        </div>

                        <div
                          style={{
                            display: "grid",
                            gridTemplateColumns: "repeat(auto-fill, minmax(250px, 1fr))",
                            gap: 12,
                          }}
                        >
                          {displayedOffers.map((alt, altIdx) => {
                            const isSelected = alt.productId === selectedOffer?.productId;
                            const delta = selectedOffer ? alt.totalPrice - selectedOffer.totalPrice : 0;
                            const altCompUnit = unitLabel(alt.comparisonUnit);

                            return (
                              <div
                                key={alt.productId}
                                style={{
                                  background: "#ffffff",
                                  border: isSelected
                                    ? "2px solid var(--brand-blue)"
                                    : "1px solid var(--border-light)",
                                  borderRadius: 14,
                                  padding: 14,
                                  display: "flex",
                                  flexDirection: "column",
                                  justifyContent: "space-between",
                                  gap: 10,
                                }}
                              >
                                <div>
                                  <div
                                    style={{
                                      display: "flex",
                                      gap: 6,
                                      flexWrap: "wrap",
                                      marginBottom: 6,
                                    }}
                                  >
                                    {isSelected ? (
                                      <span className="pill blue" style={{ fontSize: 11.5 }}>
                                        ✓ Selected in Bundle
                                      </span>
                                    ) : altIdx === 0 ? (
                                      <span className="pill green" style={{ fontSize: 11.5 }}>
                                        ★ Top Ranked
                                      </span>
                                    ) : alt.isSubstitution ? (
                                      <span className="pill amber" style={{ fontSize: 11.5 }}>
                                        Close Substitute
                                      </span>
                                    ) : (
                                      <span className="pill gray" style={{ fontSize: 11.5 }}>
                                        Alternative
                                      </span>
                                    )}

                                    {!isSelected && Math.abs(delta) >= 0.01 && (
                                      <span
                                        className={`pill ${delta < 0 ? "green" : "gray"}`}
                                        style={{ fontSize: 11.5 }}
                                      >
                                        {delta < 0
                                          ? `Save ${money(Math.abs(delta))}`
                                          : `+${money(delta)}`}
                                      </span>
                                    )}
                                  </div>

                                  <div style={{ fontWeight: 800, fontSize: 14.5, lineHeight: 1.3 }}>
                                    {alt.productName}
                                  </div>

                                  <div
                                    style={{
                                      fontSize: 12.5,
                                      color: "var(--text-muted)",
                                      marginTop: 5,
                                      lineHeight: 1.45,
                                    }}
                                  >
                                    <div>
                                      • {alt.requiredPacks} × {qty(alt.packSize, alt.packUnit)} (
                                      {qty(alt.totalQuantity, alt.quantityUnit)})
                                    </div>
                                    <div>
                                      • {money(alt.unitPrice)} / pack
                                      {alt.comparisonPrice != null && altCompUnit
                                        ? ` (${money(alt.comparisonPrice)}/${altCompUnit})`
                                        : ""}
                                    </div>
                                    <div style={{ color: "var(--green-main)", fontWeight: 600 }}>
                                      ✓{" "}
                                      {alt.availableDate
                                        ? `Arrives ${day(alt.availableDate)}`
                                        : `Target ${day(item.need.neededBy)}`}
                                      {!alt.canFulfil ? " (partial stock)" : ""}
                                    </div>
                                  </div>
                                </div>

                                <div
                                  style={{
                                    borderTop: "1px solid var(--border-light)",
                                    paddingTop: 10,
                                    display: "flex",
                                    alignItems: "center",
                                    justifyContent: "space-between",
                                    gap: 8,
                                  }}
                                >
                                  <span style={{ fontWeight: 800, fontSize: 16 }}>
                                    {money(alt.totalPrice)}
                                  </span>

                                  {bundleItems.length === 1 && !isSelected ? (
                                    <div style={{ display: "flex", gap: 6 }}>
                                      <button
                                        type="button"
                                        className="btn secondary"
                                        style={{ minHeight: 34, padding: "5px 10px", fontSize: 12 }}
                                        onClick={() => {
                                          setBundleItems((prev) =>
                                            (prev ?? []).map((b) =>
                                              b.id === item.id
                                                ? { ...b, selectedProductId: alt.productId }
                                                : b,
                                            ),
                                          );
                                        }}
                                      >
                                        Select
                                      </button>
                                      <button
                                        type="button"
                                        className="btn primary"
                                        style={{ minHeight: 34, padding: "5px 10px", fontSize: 12 }}
                                        disabled={orderingSingleOfferId !== null || orderingBundle}
                                        onClick={() => void handleOrderBundle(alt)}
                                      >
                                        {orderingSingleOfferId === alt.productId
                                          ? "Ordering…"
                                          : "Order"}
                                      </button>
                                    </div>
                                  ) : (
                                    <button
                                      type="button"
                                      className={`btn ${isSelected ? "secondary" : "primary"}`}
                                      style={{ minHeight: 34, padding: "5px 12px", fontSize: 12.5 }}
                                      disabled={isSelected}
                                      onClick={() => {
                                        setBundleItems((prev) =>
                                          (prev ?? []).map((b) =>
                                            b.id === item.id
                                              ? { ...b, selectedProductId: alt.productId }
                                              : b,
                                          ),
                                        );
                                        if (bundleItems.length > 1) {
                                          setExpandedItemIds((prev) => ({
                                            ...prev,
                                            [item.id]: false,
                                          }));
                                        }
                                      }}
                                    >
                                      {isSelected ? "✓ Active" : "Swap to This"}
                                    </button>
                                  )}
                                </div>
                              </div>
                            );
                          })}
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>

            {/* Inline "+ Add Another Item to Bundle" Bar + Bottom Checkout Footer */}
            <div
              style={{
                marginTop: 18,
                paddingTop: 16,
                borderTop: "1px solid var(--border-light)",
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                gap: 12,
                flexWrap: "wrap",
              }}
            >
              {showAddBuilder ? (
                <form
                  onSubmit={(e) => {
                    e.preventDefault();
                    void handleAddFreeformItem();
                  }}
                  style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", flex: "1 1 380px" }}
                >
                  <input
                    type="text"
                    className="field-input"
                    style={{ flex: "1 1 240px", minHeight: 40 }}
                    value={addText}
                    onChange={(e) => setAddText(e.target.value)}
                    placeholder="e.g. 20 L whipping cream or 5 kg butter"
                    autoFocus
                  />
                  <button
                    type="submit"
                    className="btn primary"
                    style={{ minHeight: 40, padding: "8px 14px", fontSize: 13 }}
                    disabled={addingItem}
                  >
                    {addingItem ? "Adding…" : "Add Item"}
                  </button>
                  <button
                    type="button"
                    className="link-quiet"
                    onClick={() => {
                      setShowAddBuilder(false);
                      setAddText("");
                    }}
                  >
                    Cancel
                  </button>
                </form>
              ) : (
                <button
                  type="button"
                  className="btn secondary"
                  style={{ minHeight: 40, padding: "8px 14px", fontSize: 13 }}
                  onClick={() => setShowAddBuilder(true)}
                >
                  + Add Another Item to Bundle
                </button>
              )}

              {bundleItems.length > 1 && (
                <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
                  <span style={{ fontSize: 14, fontWeight: 700, color: "var(--text-muted)" }}>
                    Bundle Total: <strong style={{ color: "var(--text-main)", fontSize: 17 }}>{money(totalBundlePrice)}</strong>
                  </span>
                  <button
                    type="button"
                    className="btn primary"
                    style={{ minHeight: 44, padding: "10px 20px", fontSize: 14.5 }}
                    disabled={orderingBundle || validBundleRows.length === 0 || busy}
                    onClick={() => void handleOrderBundle()}
                  >
                    {orderingBundle
                      ? "Locking fixed prices…"
                      : bundleLikelyAuto
                        ? `Order All ${validBundleRows.length} Items (${money(totalBundlePrice)})`
                        : `Review & Approve Bundle (${money(totalBundlePrice)}) →`}
                  </button>
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
