import { Fragment, useCallback, useEffect, useState } from "react";
import {
  api,
  clearApiCache,
  localDate,
  nextMonday,
  type Mandate,
  type VoiceReadiness,
  type VoiceSimulateResponse,
} from "./api";
import { day, money, qty, tidy, unitLabel } from "./format";
import { InventorySyncGuardCard } from "./InventorySyncGuardCard";

type SectionId = "events" | "pantry" | "recipes" | "recurring";

type SubstituteOption = {
  label: "good" | "better" | "best";
  productId: string;
  productName: string;
  totalPrice: number;
  availableDate: string | null;
  deliveryReliability: number | null;
  tradeOff: string;
  culinaryNote?: string;
  verifiedBy?: "llm_judge" | "catalog_declared" | "category_gate";
};

type PlanLine = {
  usualUse?: number;
  ingredientId: string;
  name: string;
  unit: string;
  required: number;
  onHand: number;
  onOrder: number;
  shortfall: number;
  usedBy: string[];
  status: "covered" | "sourced" | "substitute_proposed" | "partial" | "unsourceable";
  chosen?: {
    productId: string;
    productName: string;
    totalPrice: number;
    availableDate: string | null;
    isSubstitution: boolean;
  };
  substitutes: SubstituteOption[];
  intent?: { id: string; status: string; reasons: string[] };
  explanation: string;
};

type EventVoiceState = {
  eventId: string;
  delivery: string;
  approval: string;
  attempts: number;
  updatedAt: string;
  approvalUrl?: string;
  errorCode?: string;
};

type EventItem = {
  id: string;
  name: string;
  date: string;
  guests: number;
  bufferPct: number;
  autoOrder: boolean;
  leadDays: number;
  prepDays: number;
  notes: string;
  status: "planned" | "ordered" | "done" | "cancelled";
  recipes: Array<{ recipeId: string; servings?: number }>;
  extras: Array<{ ingredientId: string; qty: number }>;
  deliverBy: string;
  orderBy: string;
  daysAway: number;
  daysToOrderBy: number;
  orderDue: boolean;
  readiness: "unplanned" | "covered" | "ready_to_order" | "at_risk" | "ordered" | "past";
  headline: string;
  plan: {
    neededBy: string;
    runId: string;
    lines: PlanLine[];
    summary: string;
    flags: string[];
    estTotal: number;
    canMeetDate: boolean;
    at: string;
  } | null;
  orders: Array<{ ingredient: string; intentId: string; status: string; total: number }> | null;
  voice?: EventVoiceState | null;
};

type IngredientItem = {
  ingredientId: string;
  name: string;
  onHand: number;
  onOrder: number;
  unit: string;
  parLevel: number;
  targetQty: number;
  status: "critical" | "low" | "ok";
  lactoseFreePreferred?: boolean;
  expiresOn?: string;
};

type RecipeItem = {
  recipeId: string;
  name: string;
  servingsPerBatch: number;
  batchesPerWeek: number;
  ingredients: Array<{ ingredientId: string; qtyPerBatch: number; unit: string }>;
};

type RestockRec = {
  ingredientId: string;
  name: string;
  unit: string;
  onHand: number;
  onOrder: number;
  parLevel: number;
  suggestedOrderQty: number;
  urgency: "critical" | "low" | "ok";
};

type SmartRestockData = {
  hotelName: string;
  neededBy: string;
  totalSavingEur: number;
  useFirst: Array<{
    ingredientId: string;
    name: string;
    kind: "expiring" | "slow_moving";
    qty: number;
    unit: string;
    headline: string;
    detail: string;
    wasteEur?: number | null;
  }>;
  lines: Array<{
    ingredientId: string;
    name: string;
    urgency: string;
    unit: string;
    savingEur: number;
    recommendation: "smart" | "exact";
    note: string;
    smart: { productName: string; packLabel: string; totalEur: number } | null;
    exact: { productName: string; packLabel: string; totalEur: number } | null;
  }>;
};

type AutomationResp = {
  policy: {
    enabled: boolean;
    daysCover: number;
    maxItems: number;
    smartQuantities: boolean;
  };
  lastRun: {
    ranAt: string;
    summary: string;
    committedCount: number;
    pendingApprovalCount: number;
  } | null;
};

type StandingOrderItem = {
  id: string;
  ingredientId: string;
  ingredientName: string;
  quantity: number;
  unit: string;
  weekday: number;
  leadTimeDays: number;
  enabled: boolean;
  nextDelivery: string;
  nextOrderOn: string;
  lastRun: { deliveryDate: string; status: string; detail: string; intentId: string | null } | null;
};

type StandingSuggestion = {
  ingredientId: string;
  name: string;
  quantity: number;
  unit: string;
  weekday: number;
  leadTimeDays: number;
  orders: number;
  reason: string;
};

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

function futureIso(daysAhead: number): string {
  const d = new Date();
  d.setDate(d.getDate() + daysAhead);
  return localDate(d);
}

export function EventsAndKitchenView(props: {
  customerId?: string;
  mandate: Mandate | null;
  initialSection?: SectionId;
  onChanged: () => Promise<void> | void;
  onMessage: (msg: string, tone?: "success" | "warn" | "info") => void;
  onGoApprove: (intentId?: string) => void;
  onGoHistory: () => void;
}) {
  const [section, setSection] = useState<SectionId>(props.initialSection ?? "pantry");
  const [loading, setLoading] = useState(true);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [syncCardEpoch, setSyncCardEpoch] = useState(0);

  const [events, setEvents] = useState<EventItem[]>([]);
  const [voiceInfo, setVoiceInfo] = useState<VoiceReadiness | null>(null);
  const [inventory, setInventory] = useState<IngredientItem[]>([]);
  const [recipes, setRecipes] = useState<RecipeItem[]>([]);
  const [restockRecs, setRestockRecs] = useState<RestockRec[]>([]);
  const [smartRestock, setSmartRestock] = useState<SmartRestockData | null>(null);
  const [autoPolicy, setAutoPolicy] = useState<AutomationResp | null>(null);
  const [standingOrders, setStandingOrders] = useState<StandingOrderItem[]>([]);
  const [standingSuggestions, setStandingSuggestions] = useState<StandingSuggestion[]>([]);

  // Event composer state
  const [showEventForm, setShowEventForm] = useState(false);
  const [editingEventId, setEditingEventId] = useState<string | null>(null);
  const [evName, setEvName] = useState("Saturday Wedding Brunch");
  const [evDate, setEvDate] = useState(() => futureIso(10));
  const [evGuests, setEvGuests] = useState(120);
  const [evBufferPct, setEvBufferPct] = useState(10);
  const [evAutoOrder, setEvAutoOrder] = useState(true);
  const [evNotes, setEvNotes] = useState("");
  const [evRecipeServings, setEvRecipeServings] = useState<Record<string, number>>({});
  const [expandedSubs, setExpandedSubs] = useState<Record<string, boolean>>({});
  const [callPreview, setCallPreview] = useState<VoiceSimulateResponse | null>(null);

  // Pantry modals / inline drawers
  const [showAddIngredient, setShowAddIngredient] = useState(false);
  const [newIngName, setNewIngName] = useState("");
  const [newIngOnHand, setNewIngOnHand] = useState(10);
  const [newIngPar, setNewIngPar] = useState(30);
  const [newIngUnit, setNewIngUnit] = useState<"litre" | "kg" | "each" | "pack">("litre");
  const [newIngLf, setNewIngLf] = useState(true);
  const [stockoutResult, setStockoutResult] = useState<{
    ingredientId: string;
    ingredientName: string;
    lines: PlanLine[];
  } | null>(null);

  // Recipe form & multi-recipe check
  const [showAddRecipe, setShowAddRecipe] = useState(false);
  const [recName, setRecName] = useState("");
  const [recServings, setRecServings] = useState(25);
  const [recBatchesWeek, setRecBatchesWeek] = useState(3);
  const [recIngId, setRecIngId] = useState("");
  const [recIngQty, setRecIngQty] = useState(5);
  const [menuBatches, setMenuBatches] = useState<Record<string, number>>({});
  const [menuNeededBy, setMenuNeededBy] = useState(() => nextMonday());
  const [menuCheckResult, setMenuCheckResult] = useState<{ summary: string; lines: PlanLine[] } | null>(null);

  // Standing order form
  const [showAddStanding, setShowAddStanding] = useState(false);
  const [stIngId, setStIngId] = useState("");
  const [stQty, setStQty] = useState(40);
  const [stWeekday, setStWeekday] = useState(1);
  const [stLeadDays, setStLeadDays] = useState(2);

  useEffect(() => {
    if (props.initialSection) setSection(props.initialSection);
  }, [props.initialSection]);

  const loadAll = useCallback(async () => {
    setLoading(true);
    try {
      const [evRes, invRes, recRes, restockRes, smartRes, autoRes, stRes, vRes] =
        await Promise.allSettled([
          api<{ events: EventItem[] }>("/v1/events"),
          api<{ inventory: IngredientItem[] }>("/v1/kitchen/inventory"),
          api<{ recipes: RecipeItem[] }>("/v1/kitchen/recipes"),
          api<{ recommendations: RestockRec[] }>("/v1/kitchen/restock?daysCover=7"),
          api<SmartRestockData>("/v1/kitchen/restock/smart?daysCover=7"),
          api<AutomationResp>("/v1/kitchen/restock/automation"),
          api<{ standingOrders: StandingOrderItem[]; suggestions: StandingSuggestion[] }>("/v1/standing-orders"),
          api<VoiceReadiness>("/v1/voice/readiness"),
        ]);

      if (evRes.status === "fulfilled") setEvents(evRes.value.events ?? []);
      if (invRes.status === "fulfilled") {
        const items = invRes.value.inventory ?? [];
        setInventory(items);
        if (items[0] && !recIngId) setRecIngId(items[0].ingredientId);
        if (items[0] && !stIngId) setStIngId(items[0].ingredientId);
      }
      if (recRes.status === "fulfilled") {
        const rList = recRes.value.recipes ?? [];
        setRecipes(rList);
        setMenuBatches((prev) => {
          if (Object.keys(prev).length > 0) return prev;
          return Object.fromEntries(rList.map((r) => [r.recipeId, r.batchesPerWeek || 1]));
        });
      }
      if (restockRes.status === "fulfilled") setRestockRecs(restockRes.value.recommendations ?? []);
      if (smartRes.status === "fulfilled") setSmartRestock(smartRes.value);
      if (autoRes.status === "fulfilled") setAutoPolicy(autoRes.value);
      if (stRes.status === "fulfilled") {
        setStandingOrders(stRes.value.standingOrders ?? []);
        setStandingSuggestions(stRes.value.suggestions ?? []);
      }
      if (vRes.status === "fulfilled") setVoiceInfo(vRes.value);
    } finally {
      setLoading(false);
    }
  }, [recIngId, stIngId]);

  useEffect(() => {
    void loadAll();
  }, [loadAll, props.customerId]);

  function openNewEventForm() {
    setEditingEventId(null);
    setEvName("Saturday Wedding Brunch");
    setEvDate(futureIso(10));
    setEvGuests(120);
    setEvBufferPct(10);
    setEvAutoOrder(true);
    setEvNotes("");
    const defaults: Record<string, number> = {};
    for (const r of recipes.slice(0, 2)) defaults[r.recipeId] = 120;
    setEvRecipeServings(defaults);
    setShowEventForm(true);
  }

  function openEditEvent(ev: EventItem) {
    setEditingEventId(ev.id);
    setEvName(ev.name);
    setEvDate(ev.date);
    setEvGuests(ev.guests);
    setEvBufferPct(ev.bufferPct);
    setEvAutoOrder(ev.autoOrder);
    setEvNotes(ev.notes ?? "");
    const map: Record<string, number> = {};
    for (const r of ev.recipes) map[r.recipeId] = r.servings ?? ev.guests;
    setEvRecipeServings(map);
    setShowEventForm(true);
  }

  async function saveEvent() {
    const selectedRecipes = Object.entries(evRecipeServings)
      .filter(([, servings]) => servings > 0)
      .map(([recipeId, servings]) => ({ recipeId, servings }));
    if (!evName.trim()) {
      props.onMessage("Please enter an event name.", "warn");
      return;
    }
    if (selectedRecipes.length === 0) {
      props.onMessage("Select at least one recipe for the event.", "warn");
      return;
    }
    setBusyKey("save-event");
    try {
      const payload = {
        name: evName.trim(),
        date: evDate,
        guests: Math.max(1, Number(evGuests) || 50),
        bufferPct: Math.max(0, Number(evBufferPct) || 0),
        autoOrder: evAutoOrder,
        notes: evNotes.trim(),
        recipes: selectedRecipes,
      };
      if (editingEventId) {
        await api(`/v1/events/${editingEventId}`, { method: "PUT", body: JSON.stringify(payload) });
        props.onMessage(`Updated "${evName}" and recalculated Valio lead-time plan.`, "success");
      } else {
        await api("/v1/events", { method: "POST", body: JSON.stringify(payload) });
        props.onMessage(`Planned "${evName}" — extra shortfall calculated on top of normal weekly use.`, "success");
      }
      setShowEventForm(false);
      await loadAll();
      await props.onChanged();
    } catch (e) {
      props.onMessage(e instanceof Error ? e.message : String(e), "warn");
    } finally {
      setBusyKey(null);
    }
  }

  async function addQuickPreset(kind: "brunch" | "gala") {
    if (recipes.length === 0) {
      props.onMessage("No saved recipes found for this kitchen yet.", "warn");
      return;
    }
    setBusyKey(`preset-${kind}`);
    try {
      const chosen = kind === "brunch" ? recipes.slice(0, 2) : recipes.slice(0, Math.min(3, recipes.length));
      const guests = kind === "brunch" ? 120 : 350;
      const payload = {
        name: kind === "brunch" ? "Saturday Wedding Brunch" : "Nordic Tech Gala Banquet",
        date: futureIso(kind === "brunch" ? 9 : 12),
        guests,
        bufferPct: kind === "brunch" ? 10 : 15,
        autoOrder: true,
        notes: kind === "brunch" ? "100% lactose-free buffet service" : "VIP plated banquet — strict cold-chain delivery",
        recipes: chosen.map((r) => ({ recipeId: r.recipeId, servings: guests })),
      };
      await api("/v1/events", { method: "POST", body: JSON.stringify(payload) });
      props.onMessage(`Created "${payload.name}" (${guests} guests) with live Valio stock check!`, "success");
      await loadAll();
      await props.onChanged();
    } catch (e) {
      props.onMessage(e instanceof Error ? e.message : String(e), "warn");
    } finally {
      setBusyKey(null);
    }
  }

  async function simulatePhoneEventCall() {
    setBusyKey("sim-voice");
    try {
      const res = await api<VoiceSimulateResponse>("/v1/voice/simulate", {
        method: "POST",
        body: JSON.stringify({ preset: "wedding" }),
      });
      setCallPreview(res);
      props.onMessage("Chef phone call recorded as a safe non-ordering proposal — awaiting buyer sign-off!", "info");
      await loadAll();
      await props.onChanged();
    } catch (e) {
      props.onMessage(e instanceof Error ? e.message : String(e), "warn");
    } finally {
      setBusyKey(null);
    }
  }

  async function approvePhoneProposal(ev: EventItem) {
    setBusyKey(`voice-approve-${ev.id}`);
    try {
      try {
        await api(`/v1/events/${ev.id}/voice-approve`, { method: "POST", body: JSON.stringify({}) });
      } catch {
        if (ev.voice?.approvalUrl) {
          await fetch(ev.voice.approvalUrl, { method: "POST" });
          clearApiCache();
        } else {
          throw new Error("Could not approve phone plan");
        }
      }
      props.onMessage(`Phone plan "${ev.name}" approved! Orders are now unlocked.`, "success");
      await loadAll();
      await props.onChanged();
    } catch (e) {
      props.onMessage(e instanceof Error ? e.message : String(e), "warn");
    } finally {
      setBusyKey(null);
    }
  }

  async function placeEventOrders(ev: EventItem) {
    setBusyKey(`order-${ev.id}`);
    try {
      const res = await api<{ event: EventItem }>(`/v1/events/${ev.id}/order`, {
        method: "POST",
        body: JSON.stringify({}),
      });
      const orders = res.event.orders ?? [];
      const waiting = orders.filter((o) => o.status === "pending_approval");
      const committed = orders.filter((o) => o.status === "committed");
      await loadAll();
      await props.onChanged();
      if (waiting.length > 0) {
        props.onMessage(
          `${committed.length} item(s) ordered automatically; ${waiting.length} need your approval.`,
          "info",
        );
        props.onGoApprove(waiting[0]?.intentId);
      } else {
        props.onMessage(`Placed ${orders.length} Valio order(s) for "${ev.name}"!`, "success");
      }
    } catch (e) {
      props.onMessage(e instanceof Error ? e.message : String(e), "warn");
    } finally {
      setBusyKey(null);
    }
  }

  async function replanSingleEvent(id: string) {
    setBusyKey(`replan-${id}`);
    try {
      await api(`/v1/events/${id}/replan`, { method: "POST", body: JSON.stringify({}) });
      props.onMessage("Re-checked live Valio stock, prices, and kitchen pantry.", "info");
      await loadAll();
    } catch (e) {
      props.onMessage(e instanceof Error ? e.message : String(e), "warn");
    } finally {
      setBusyKey(null);
    }
  }

  async function cancelSingleEvent(ev: EventItem) {
    setBusyKey(`cancel-${ev.id}`);
    try {
      await api(`/v1/events/${ev.id}`, { method: "DELETE" });
      props.onMessage(`Cancelled "${ev.name}".`, "info");
      await loadAll();
      await props.onChanged();
    } catch (e) {
      props.onMessage(e instanceof Error ? e.message : String(e), "warn");
    } finally {
      setBusyKey(null);
    }
  }

  async function adjustPantryStock(ing: IngredientItem, delta: number) {
    setBusyKey(`adj-${ing.ingredientId}`);
    try {
      await api("/v1/kitchen/inventory/adjust", {
        method: "POST",
        body: JSON.stringify({ ingredientId: ing.ingredientId, delta, reason: "Kitchen shelf count" }),
      });
      await loadAll();
      setSyncCardEpoch((n) => n + 1);
      await props.onChanged();
    } catch (e) {
      props.onMessage(e instanceof Error ? e.message : String(e), "warn");
    } finally {
      setBusyKey(null);
    }
  }

  async function runRestockNow(onlyIngredientId?: string) {
    setBusyKey(onlyIngredientId ? `restock-${onlyIngredientId}` : "restock-all");
    try {
      const raw = await api<{
        result?: {
          summary: string;
          committedCount: number;
          pendingApprovalCount: number;
          lines: Array<{ intentId?: string; status?: string }>;
        };
        summary?: string;
        committedCount?: number;
        pendingApprovalCount?: number;
        lines?: Array<{ intentId?: string; status?: string }>;
      }>("/v1/kitchen/restock/run", {
        method: "POST",
        body: JSON.stringify({
          force: true,
          all: !onlyIngredientId,
          only: onlyIngredientId ? [onlyIngredientId] : undefined,
          choice: "smart",
        }),
      });
      const res = raw.result ?? {
        summary: raw.summary ?? "Smart restock completed!",
        committedCount: raw.committedCount ?? 0,
        pendingApprovalCount: raw.pendingApprovalCount ?? 0,
        lines: raw.lines ?? [],
      };
      await loadAll();
      setSyncCardEpoch((n) => n + 1);
      await props.onChanged();
      if (res.pendingApprovalCount > 0) {
        const firstPending = res.lines.find((l) => l.status === "pending_approval")?.intentId;
        props.onMessage(tidy(res.summary), "info");
        if (firstPending) props.onGoApprove(firstPending);
      } else {
        props.onMessage(tidy(res.summary || "Smart restock completed!"), "success");
      }
    } catch (e) {
      props.onMessage(e instanceof Error ? e.message : String(e), "warn");
    } finally {
      setBusyKey(null);
    }
  }

  async function toggleAutoRestock(enabled: boolean) {
    setBusyKey("toggle-auto-restock");
    try {
      await api("/v1/kitchen/restock/automation", {
        method: "PUT",
        body: JSON.stringify({ enabled, smartQuantities: true }),
      });
      props.onMessage(
        enabled ? "Scheduled Smart Auto-Restock enabled (under your mandate rules)." : "Scheduled Auto-Restock paused.",
        "info",
      );
      await loadAll();
    } catch (e) {
      props.onMessage(e instanceof Error ? e.message : String(e), "warn");
    } finally {
      setBusyKey(null);
    }
  }

  async function checkStockoutSubstitute(ing: IngredientItem, createIntents: boolean) {
    setBusyKey(`stockout-${ing.ingredientId}-${createIntents ? "order" : "check"}`);
    try {
      const res = await api<{ lines: PlanLine[]; summary: string }>("/v1/kitchen/stockout", {
        method: "POST",
        body: JSON.stringify({
          ingredientId: ing.ingredientId,
          neededBy: nextMonday(),
          createIntents,
        }),
      });
      setStockoutResult({ ingredientId: ing.ingredientId, ingredientName: ing.name, lines: res.lines ?? [] });
      if (createIntents) {
        await loadAll();
        await props.onChanged();
        const createdIntent = res.lines.find((l) => l.intent)?.intent;
        props.onMessage(`Created substitute proposal for ${ing.name} — review in Needs Your OK.`, "info");
        if (createdIntent) props.onGoApprove(createdIntent.id);
      }
    } catch (e) {
      props.onMessage(e instanceof Error ? e.message : String(e), "warn");
    } finally {
      setBusyKey(null);
    }
  }

  async function saveNewIngredient() {
    if (!newIngName.trim()) return;
    setBusyKey("add-ing");
    try {
      await api("/v1/kitchen/inventory", {
        method: "PUT",
        body: JSON.stringify([
          {
            name: newIngName.trim(),
            onHand: Number(newIngOnHand) || 0,
            parLevel: Number(newIngPar) || 10,
            unit: newIngUnit,
            lactoseFreePreferred: newIngLf,
            catalogHints: [newIngName.trim().toLowerCase()],
          },
        ]),
      });
      setShowAddIngredient(false);
      setNewIngName("");
      props.onMessage(`Added "${newIngName.trim()}" to kitchen pantry.`, "success");
      await loadAll();
    } catch (e) {
      props.onMessage(e instanceof Error ? e.message : String(e), "warn");
    } finally {
      setBusyKey(null);
    }
  }

  async function cookBatch(r: RecipeItem) {
    setBusyKey(`cook-${r.recipeId}`);
    try {
      await api(`/v1/kitchen/recipes/${r.recipeId}/cook`, {
        method: "POST",
        body: JSON.stringify({ batches: 1 }),
      });
      props.onMessage(`Cooked 1 batch of "${r.name}" (${r.servingsPerBatch} servings) — pantry stock updated.`, "success");
      await loadAll();
      await props.onChanged();
    } catch (e) {
      props.onMessage(e instanceof Error ? e.message : String(e), "warn");
    } finally {
      setBusyKey(null);
    }
  }

  async function saveNewRecipe() {
    if (!recName.trim() || !recIngId) return;
    const ing = inventory.find((i) => i.ingredientId === recIngId);
    setBusyKey("save-recipe");
    try {
      await api("/v1/kitchen/recipes", {
        method: "POST",
        body: JSON.stringify({
          name: recName.trim(),
          servingsPerBatch: Math.max(1, Number(recServings) || 20),
          batchesPerWeek: Math.max(0, Number(recBatchesWeek) || 1),
          ingredients: [
            {
              ingredientId: recIngId,
              qtyPerBatch: Math.max(0.1, Number(recIngQty) || 1),
              unit: ing?.unit ?? "litre",
            },
          ],
        }),
      });
      setShowAddRecipe(false);
      setRecName("");
      props.onMessage(`Saved recipe "${recName.trim()}".`, "success");
      await loadAll();
    } catch (e) {
      props.onMessage(e instanceof Error ? e.message : String(e), "warn");
    } finally {
      setBusyKey(null);
    }
  }

  async function runMenuCheck(createIntents: boolean) {
    const selected = Object.entries(menuBatches)
      .filter(([, b]) => b > 0)
      .map(([recipeId, batches]) => ({ recipeId, batches }));
    if (selected.length === 0) {
      props.onMessage("Set at least 1 batch on a recipe to check menu stock.", "warn");
      return;
    }
    setBusyKey(createIntents ? "menu-order" : "menu-check");
    try {
      const res = await api<{ summary: string; lines: PlanLine[] }>("/v1/kitchen/plan", {
        method: "POST",
        body: JSON.stringify({ neededBy: menuNeededBy, recipes: selected, createIntents }),
      });
      setMenuCheckResult({ summary: res.summary, lines: res.lines ?? [] });
      if (createIntents) {
        await loadAll();
        await props.onChanged();
        const pendingLine = res.lines.find((l) => l.intent?.status === "pending_approval");
        props.onMessage("Created Valio order proposals for menu shortfalls!", "success");
        if (pendingLine?.intent?.id) props.onGoApprove(pendingLine.intent.id);
      }
    } catch (e) {
      props.onMessage(e instanceof Error ? e.message : String(e), "warn");
    } finally {
      setBusyKey(null);
    }
  }

  async function createStandingOrder(input: {
    ingredientId: string;
    quantity: number;
    weekday: number;
    leadTimeDays: number;
  }) {
    setBusyKey(`st-create-${input.ingredientId}`);
    try {
      await api("/v1/standing-orders", { method: "POST", body: JSON.stringify(input) });
      setShowAddStanding(false);
      props.onMessage("Weekly standing order scheduled!", "success");
      await loadAll();
    } catch (e) {
      props.onMessage(e instanceof Error ? e.message : String(e), "warn");
    } finally {
      setBusyKey(null);
    }
  }

  async function toggleStanding(st: StandingOrderItem) {
    setBusyKey(`st-toggle-${st.id}`);
    try {
      await api(`/v1/standing-orders/${st.id}`, {
        method: "PUT",
        body: JSON.stringify({ enabled: !st.enabled }),
      });
      await loadAll();
    } catch (e) {
      props.onMessage(e instanceof Error ? e.message : String(e), "warn");
    } finally {
      setBusyKey(null);
    }
  }

  async function removeStanding(st: StandingOrderItem) {
    setBusyKey(`st-del-${st.id}`);
    try {
      await api(`/v1/standing-orders/${st.id}`, { method: "DELETE" });
      props.onMessage(`Removed standing order for ${st.ingredientName}.`, "info");
      await loadAll();
    } catch (e) {
      props.onMessage(e instanceof Error ? e.message : String(e), "warn");
    } finally {
      setBusyKey(null);
    }
  }

  async function runDueStandingNow(standingId?: string) {
    setBusyKey(standingId ? `st-run-${standingId}` : "st-run-all");
    try {
      const res = await api<{
        results: Array<{ ingredient: string; outcome: string; detail: string; intentId?: string }>;
      }>("/v1/standing-orders/run", {
        method: "POST",
        body: JSON.stringify({ standingId, force: true }),
      });
      await loadAll();
      await props.onChanged();
      const results = res.results ?? [];
      const pending = results.find((r) => r.outcome === "pending_approval");
      if (pending?.intentId) {
        props.onMessage(`${pending.ingredient}: ${tidy(pending.detail)}`, "info");
        props.onGoApprove(pending.intentId);
      } else if (results.length > 0) {
        props.onMessage(results.map((r) => `${r.ingredient}: ${tidy(r.detail)}`).join(" · "), "success");
      } else {
        props.onMessage("No standing orders needed to run right now.", "info");
      }
    } catch (e) {
      props.onMessage(e instanceof Error ? e.message : String(e), "warn");
    } finally {
      setBusyKey(null);
    }
  }

  const phoneDisplay = voiceInfo?.phoneNumber?.trim() || "+1 269 665 8009";
  const phoneHref = `tel:${phoneDisplay.replace(/[^\d+]/g, "") || "+12696658009"}`;
  const lowCount = inventory.filter((i) => i.status === "critical" || i.status === "low").length;

  return (
    <div className="page-wrap">
      {/* Sub-navigation bar */}
      <div
        style={{
          display: "flex",
          gap: 8,
          flexWrap: "wrap",
          marginBottom: 24,
          background: "#ffffff",
          padding: 8,
          borderRadius: 16,
          border: "1px solid var(--border-light)",
        }}
      >
        {(
          [
            { id: "pantry", label: "🔄 Stock & Auto-Restock", badge: lowCount },
            { id: "events", label: "🎉 Events & Banquets", badge: events.length },
            { id: "recipes", label: "📖 Recipes & Menu Check", badge: recipes.length },
            { id: "recurring", label: "🔁 Weekly Standing Orders", badge: standingOrders.length },
          ] as const
        ).map((item) => {
          const active = section === item.id;
          const isUrgentPantry = item.id === "pantry" && lowCount > 0;
          return (
            <button
              key={item.id}
              type="button"
              onClick={() => setSection(item.id)}
              style={{
                flex: "1 1 190px",
                minHeight: 46,
                borderRadius: 12,
                border: active ? "1.5px solid var(--brand-blue)" : "1px solid transparent",
                background: active ? "var(--bg-blue-soft)" : "transparent",
                color: active ? "var(--brand-blue)" : "var(--text-muted)",
                fontWeight: active ? 800 : 600,
                fontSize: 14.5,
                cursor: "pointer",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                gap: 8,
                padding: "8px 14px",
              }}
            >
              <span>{item.label}</span>
              {item.badge > 0 && (
                <span
                  className={`pill ${isUrgentPantry ? "amber" : active ? "blue" : "neutral"}`}
                  style={{ fontSize: 12 }}
                >
                  {item.badge}
                </span>
              )}
            </button>
          );
        })}
      </div>

      {loading && events.length === 0 && inventory.length === 0 ? (
        <div className="card" style={{ textAlign: "center", padding: 40, color: "var(--text-muted)" }}>
          Loading kitchen planner, pantry & upcoming events…
        </div>
      ) : null}

      {/* ────────────────────── 1. EVENTS & BANQUETS ────────────────────── */}
      {section === "events" && (
        <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
          <div className="page-header" style={{ marginBottom: 4 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 16, flexWrap: "wrap" }}>
              <div>
                <h1 className="page-title">Events, Banquets & Peak Days</h1>
                <p className="page-subtitle">
                  Register a wedding, gala, or busy weekend once. Your assistant subtracts normal weekly kitchen usage,
                  checks Valio lead times backwards from prep day, and lines up recipe-compatible substitutes.
                </p>
              </div>
              <button type="button" className="btn btn-primary" onClick={openNewEventForm}>
                + Plan New Event
              </button>
            </div>

            <div className="chips-row" style={{ marginTop: 14 }}>
              <button
                type="button"
                className="chip-btn"
                disabled={busyKey !== null}
                onClick={() => void addQuickPreset("brunch")}
              >
                {busyKey === "preset-brunch" ? "Planning brunch…" : "🥞 Add 120-Guest Wedding Brunch"}
              </button>
              <button
                type="button"
                className="chip-btn"
                disabled={busyKey !== null}
                onClick={() => void addQuickPreset("gala")}
              >
                {busyKey === "preset-gala" ? "Planning gala…" : "🥂 Add 350-Guest Gala Banquet"}
              </button>
            </div>
          </div>

          {/* Phone Event Hotline Card */}
          <div
            className="card"
            style={{
              background: "linear-gradient(135deg, #003882 0%, #0052cc 100%)",
              color: "#ffffff",
              border: "none",
            }}
          >
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 16, flexWrap: "wrap" }}>
              <div>
                <div style={{ fontSize: 12, fontWeight: 800, textTransform: "uppercase", letterSpacing: "0.06em", opacity: 0.88 }}>
                  📞 Hands-Free Kitchen Event Hotline · Zero Money Spent on the Call
                </div>
                <div style={{ fontSize: 22, fontWeight: 800, marginTop: 4 }}>
                  Call <a href={phoneHref} style={{ color: "#ffffff", textDecoration: "underline" }}>{phoneDisplay}</a> from the walk-in cooler
                </div>
                <div style={{ fontSize: 14, opacity: 0.92, marginTop: 4 }}>
                  Speak the event date, guest count, and dishes. The voice agent saves a non-ordering proposal and sends a single-use approval link to your phone.
                </div>
              </div>
              <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
                <a
                  href={phoneHref}
                  className="btn"
                  style={{ background: "#ffffff", color: "#003882", textDecoration: "none", fontWeight: 800 }}
                >
                  📱 Call Now
                </a>
                <button
                  type="button"
                  className="btn"
                  disabled={busyKey !== null}
                  onClick={() => void simulatePhoneEventCall()}
                  style={{
                    background: "rgba(255,255,255,0.16)",
                    color: "#ffffff",
                    border: "1.5px solid rgba(255,255,255,0.45)",
                  }}
                >
                  {busyKey === "sim-voice" ? "Calling kitchen line…" : "🎙️ Simulate Chef Phone Call"}
                </button>
              </div>
            </div>

            {callPreview && (
              <div
                style={{
                  marginTop: 14,
                  background: "rgba(255,255,255,0.96)",
                  color: "var(--text-main)",
                  borderRadius: 14,
                  padding: "14px 16px",
                }}
              >
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
                  <strong style={{ fontSize: 14, color: "var(--brand-navy)" }}>
                    🎙️ Recorded Call Proposal — {callPreview.event?.name ?? "Kitchen Event"} ({callPreview.event?.guests ?? 120} guests)
                  </strong>
                  <button type="button" className="link-quiet" onClick={() => setCallPreview(null)}>
                    Dismiss
                  </button>
                </div>
                <div style={{ fontSize: 13.5, color: "var(--text-muted)" }}>
                  {tidy(callPreview.safetyNote)}
                </div>
              </div>
            )}
          </div>

          {/* Event Create / Edit Form */}
          {showEventForm && (
            <div className="card" style={{ border: "2px solid var(--brand-blue)" }}>
              <h2 style={{ margin: "0 0 14px", fontSize: 19, fontWeight: 800 }}>
                {editingEventId ? "Edit Event Plan" : "Plan a New Event or Busy Day"}
              </h2>
              <div className="controls-row">
                <div className="field-group" style={{ flex: "2 1 240px" }}>
                  <span className="field-label">Event Name</span>
                  <input
                    className="field-input"
                    value={evName}
                    onChange={(e) => setEvName(e.target.value)}
                    placeholder="e.g. Saturday Wedding Brunch"
                  />
                </div>
                <div className="field-group">
                  <span className="field-label">Event Date</span>
                  <input
                    type="date"
                    className="field-input"
                    value={evDate}
                    onChange={(e) => setEvDate(e.target.value)}
                  />
                </div>
                <div className="field-group">
                  <span className="field-label">Guests</span>
                  <input
                    type="number"
                    min={1}
                    className="field-input"
                    value={evGuests}
                    onChange={(e) => setEvGuests(Number(e.target.value))}
                  />
                </div>
                <div className="field-group">
                  <span className="field-label">Safety Buffer (%)</span>
                  <input
                    type="number"
                    min={0}
                    max={50}
                    className="field-input"
                    value={evBufferPct}
                    onChange={(e) => setEvBufferPct(Number(e.target.value))}
                  />
                </div>
              </div>

              <div style={{ marginTop: 16 }}>
                <div className="field-label" style={{ marginBottom: 8 }}>
                  Menu Recipes & Portions to Serve
                </div>
                <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(250px, 1fr))", gap: 10 }}>
                  {recipes.map((r) => {
                    const servings = evRecipeServings[r.recipeId] ?? 0;
                    const checked = servings > 0;
                    return (
                      <div
                        key={r.recipeId}
                        className="card-subtle"
                        style={{
                          borderColor: checked ? "var(--brand-blue)" : "var(--border-light)",
                          background: checked ? "var(--bg-blue-soft)" : "var(--bg-subtle)",
                        }}
                      >
                        <label style={{ display: "flex", alignItems: "center", gap: 8, fontWeight: 700, cursor: "pointer" }}>
                          <input
                            type="checkbox"
                            checked={checked}
                            onChange={(e) =>
                              setEvRecipeServings((prev) => ({
                                ...prev,
                                [r.recipeId]: e.target.checked ? evGuests : 0,
                              }))
                            }
                          />
                          <span>{r.name}</span>
                        </label>
                        {checked && (
                          <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 8 }}>
                            <span style={{ fontSize: 12.5, color: "var(--text-muted)" }}>Portions:</span>
                            <input
                              type="number"
                              min={1}
                              className="field-input"
                              style={{ minHeight: 36, padding: "4px 10px", width: 95 }}
                              value={servings}
                              onChange={(e) =>
                                setEvRecipeServings((prev) => ({
                                  ...prev,
                                  [r.recipeId]: Math.max(0, Number(e.target.value)),
                                }))
                              }
                            />
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>

              <div style={{ marginTop: 14, display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 12 }}>
                <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 14, fontWeight: 600, cursor: "pointer" }}>
                  <input
                    type="checkbox"
                    checked={evAutoOrder}
                    onChange={(e) => setEvAutoOrder(e.target.checked)}
                  />
                  <span>Place orders automatically when the Valio order-by date arrives (still gated by your rules)</span>
                </label>
                <div style={{ display: "flex", gap: 10 }}>
                  <button type="button" className="btn btn-outline" onClick={() => setShowEventForm(false)}>
                    Cancel
                  </button>
                  <button
                    type="button"
                    className="btn btn-primary"
                    disabled={busyKey === "save-event"}
                    onClick={() => void saveEvent()}
                  >
                    {busyKey === "save-event" ? "Calculating Plan…" : editingEventId ? "Save Changes" : "Save & Check Valio Stock"}
                  </button>
                </div>
              </div>
            </div>
          )}

          {/* Event Cards */}
          {events.length === 0 ? (
            <div className="empty-hero">
              <h2>No upcoming banquets or events planned yet</h2>
              <p>Add a wedding brunch, gala dinner, or simulate a chef phone call above to see backward lead-time planning in action.</p>
            </div>
          ) : (
            events.map((ev) => {
              const voicePending = Boolean(ev.voice && ev.voice.approval !== "approved");
              const pillTone =
                voicePending
                  ? "amber"
                  : ev.readiness === "ordered" || ev.readiness === "covered"
                    ? "green"
                    : ev.readiness === "at_risk"
                      ? "red"
                      : "blue";
              const pillText =
                voicePending
                  ? "📞 Phone Proposal — Needs Sign-Off"
                  : ev.readiness === "covered"
                    ? "✓ Pantry Covers It"
                    : ev.readiness === "ordered"
                      ? "✓ Orders Placed"
                      : ev.readiness === "at_risk"
                        ? "⚠ Shortfall / Lead-Time Risk"
                        : "Ready to Order";

              return (
                <div key={ev.id} className="card" style={{ display: "flex", flexDirection: "column", gap: 16 }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 12, flexWrap: "wrap" }}>
                    <div>
                      <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
                        <h2 style={{ margin: 0, fontSize: 20, fontWeight: 800 }}>{ev.name}</h2>
                        <span className={`pill ${pillTone}`}>{pillText}</span>
                        <span className="pill neutral">{ev.guests} guests · +{ev.bufferPct}% buffer</span>
                      </div>
                      <div style={{ fontSize: 14.5, color: "var(--text-muted)", marginTop: 6 }}>
                        {tidy(ev.headline)}
                      </div>
                    </div>
                    <div style={{ textAlign: "right" }}>
                      <div style={{ fontSize: 12, color: "var(--text-soft)", fontWeight: 700, textTransform: "uppercase" }}>
                        Est. Extra Spend
                      </div>
                      <div style={{ fontSize: 22, fontWeight: 800, color: "var(--brand-navy)" }}>
                        {money(ev.plan?.estTotal ?? 0)}
                      </div>
                    </div>
                  </div>

                  {/* Voice Approval Gate */}
                  {ev.voice && (
                    <div
                      className={`banner ${ev.voice.approval === "approved" ? "success" : "warn"}`}
                      style={{ marginBottom: 0, alignItems: "center" }}
                    >
                      <div>
                        <strong>
                          {ev.voice.approval === "approved"
                            ? "✓ Phone Call Plan Verified by Buyer"
                            : "📱 Created by Kitchen Phone Call — Locked Until You Approve"}
                        </strong>
                        <div style={{ fontSize: 13.5, marginTop: 2 }}>
                          {ev.voice.approval === "approved"
                            ? "Single-use approval completed. Auto-ordering on the Valio cut-off date is active."
                            : "Voice calls never spend money directly. Approve below or open the single-use mobile approval page."}
                        </div>
                      </div>
                      {ev.voice.approval !== "approved" && (
                        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                          <button
                            type="button"
                            className="btn btn-green"
                            style={{ minHeight: 40, padding: "8px 14px", fontSize: 13.5 }}
                            disabled={busyKey === `voice-approve-${ev.id}`}
                            onClick={() => void approvePhoneProposal(ev)}
                          >
                            {busyKey === `voice-approve-${ev.id}` ? "Approving…" : "✓ Approve Phone Plan"}
                          </button>
                          {ev.voice.approvalUrl && (
                            <a
                              href={ev.voice.approvalUrl}
                              target="_blank"
                              rel="noreferrer"
                              className="btn btn-outline"
                              style={{ minHeight: 40, padding: "8px 14px", fontSize: 13.5, textDecoration: "none" }}
                            >
                              Open Mobile Link ↗
                            </a>
                          )}
                        </div>
                      )}
                    </div>
                  )}

                  {/* 3-Step Backward Lead-Time Schedule */}
                  <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: 10 }}>
                    <div className="card-subtle">
                      <div style={{ fontSize: 11.5, fontWeight: 800, color: "var(--brand-blue)", textTransform: "uppercase" }}>
                        1. Order From Valio By
                      </div>
                      <div style={{ fontSize: 16, fontWeight: 800, marginTop: 2 }}>{day(ev.orderBy)}</div>
                      <div style={{ fontSize: 12.5, color: "var(--text-muted)" }}>
                        {ev.daysToOrderBy <= 0 ? "Order window open now" : `In ${ev.daysToOrderBy} day(s) (${ev.leadDays}d lead time)`}
                      </div>
                    </div>
                    <div className="card-subtle">
                      <div style={{ fontSize: 11.5, fontWeight: 800, color: "var(--green-text)", textTransform: "uppercase" }}>
                        2. On-Site Prep Delivery
                      </div>
                      <div style={{ fontSize: 16, fontWeight: 800, marginTop: 2 }}>{day(ev.deliverBy)}</div>
                      <div style={{ fontSize: 12.5, color: "var(--text-muted)" }}>
                        {ev.prepDays} day(s) before kitchen prep starts
                      </div>
                    </div>
                    <div className="card-subtle">
                      <div style={{ fontSize: 11.5, fontWeight: 800, color: "var(--text-muted)", textTransform: "uppercase" }}>
                        3. Event Service Day
                      </div>
                      <div style={{ fontSize: 16, fontWeight: 800, marginTop: 2 }}>{day(ev.date)}</div>
                      <div style={{ fontSize: 12.5, color: "var(--text-muted)" }}>
                        {ev.daysAway === 0 ? "Today" : `In ${ev.daysAway} day(s)`}
                      </div>
                    </div>
                  </div>

                  {/* Ingredient Shortfall Breakdown */}
                  {ev.plan && ev.plan.lines.length > 0 && (
                    <div style={{ overflowX: "auto" }}>
                      <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13.5 }}>
                        <thead>
                          <tr style={{ borderBottom: "1.5px solid var(--border-light)", textAlign: "left", color: "var(--text-soft)" }}>
                            <th style={{ padding: "8px 10px" }}>Ingredient</th>
                            <th style={{ padding: "8px 10px" }}>Event Need</th>
                            <th style={{ padding: "8px 10px" }}>Usual Kitchen Use</th>
                            <th style={{ padding: "8px 10px" }}>Pantry + Inbound</th>
                            <th style={{ padding: "8px 10px" }}>Extra Shortfall</th>
                            <th style={{ padding: "8px 10px" }}>Valio Match</th>
                          </tr>
                        </thead>
                        <tbody>
                          {ev.plan.lines.map((line) => {
                            const subKey = `${ev.id}:${line.ingredientId}`;
                            const isSubOpen = Boolean(expandedSubs[subKey]);
                            return (
                              <Fragment key={line.ingredientId}>
                                <tr style={{ borderBottom: "1px solid var(--border-light)" }}>
                                  <td style={{ padding: "10px", fontWeight: 700 }}>{line.name}</td>
                                  <td style={{ padding: "10px" }}>{qty(line.required, line.unit)}</td>
                                  <td style={{ padding: "10px", color: "var(--text-muted)" }}>
                                    {qty(line.usualUse ?? 0, line.unit)}
                                  </td>
                                  <td style={{ padding: "10px", color: "var(--text-muted)" }}>
                                    {qty(line.onHand + line.onOrder, line.unit)}
                                  </td>
                                  <td style={{ padding: "10px", fontWeight: 700 }}>
                                    {line.shortfall > 0 ? (
                                      <span className="pill amber">{qty(line.shortfall, line.unit)}</span>
                                    ) : (
                                      <span className="pill green">Covered</span>
                                    )}
                                  </td>
                                  <td style={{ padding: "10px" }}>
                                    {line.chosen ? (
                                      <div>
                                        <div style={{ fontWeight: 600 }}>
                                          {line.chosen.productName} · <strong>{money(line.chosen.totalPrice)}</strong>
                                        </div>
                                        {line.substitutes.length > 0 && (
                                          <button
                                            type="button"
                                            className="link-quiet"
                                            style={{ fontSize: 12, padding: 0, marginTop: 2 }}
                                            onClick={() =>
                                              setExpandedSubs((prev) => ({ ...prev, [subKey]: !prev[subKey] }))
                                            }
                                          >
                                            {isSubOpen
                                              ? "Hide compatible substitutes ▲"
                                              : `View ${line.substitutes.length} recipe-safe substitute(s) ▼`}
                                          </button>
                                        )}
                                      </div>
                                    ) : line.shortfall > 0 ? (
                                      <span className="pill red">Out of stock</span>
                                    ) : (
                                      <span style={{ color: "var(--text-soft)" }}>No order needed</span>
                                    )}
                                  </td>
                                </tr>
                                {isSubOpen && line.substitutes.length > 0 && (
                                  <tr key={`${line.ingredientId}-subs`} style={{ background: "var(--bg-subtle)" }}>
                                    <td colSpan={6} style={{ padding: "10px 14px" }}>
                                      <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
                                        {line.substitutes.map((s) => (
                                          <div
                                            key={s.productId}
                                            style={{
                                              background: "#ffffff",
                                              border: "1px solid var(--border-light)",
                                              borderRadius: 10,
                                              padding: "8px 12px",
                                              flex: "1 1 220px",
                                            }}
                                          >
                                            <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                                              <span className={`pill ${s.label === "best" ? "green" : "blue"}`} style={{ textTransform: "uppercase", fontSize: 10.5 }}>
                                                {s.label}
                                              </span>
                                              <strong style={{ fontSize: 13 }}>{s.productName}</strong>
                                            </div>
                                            <div style={{ fontSize: 12.5, color: "var(--text-muted)", marginTop: 4 }}>
                                              {money(s.totalPrice)} · {tidy(s.tradeOff)}
                                            </div>
                                            {s.culinaryNote && (
                                              <div style={{ fontSize: 11.5, color: "var(--green-text)", fontWeight: 600, marginTop: 3 }}>
                                                ✓ Chef fit: {s.culinaryNote}
                                              </div>
                                            )}
                                          </div>
                                        ))}
                                      </div>
                                    </td>
                                  </tr>
                                )}
                              </Fragment>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                  )}

                  {/* Event Actions */}
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
                    <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                      {ev.status !== "ordered" && (ev.plan?.lines.some((l) => l.shortfall > 0) ?? false) && (
                        <button
                          type="button"
                          className="btn btn-green"
                          disabled={voicePending || busyKey === `order-${ev.id}`}
                          onClick={() => void placeEventOrders(ev)}
                          title={voicePending ? "Approve the phone proposal above before placing orders" : undefined}
                        >
                          {busyKey === `order-${ev.id}`
                            ? "Placing Event Orders…"
                            : voicePending
                              ? "🔒 Approve Phone Plan First"
                              : "Place Event Orders Now"}
                        </button>
                      )}
                      <button
                        type="button"
                        className="btn btn-outline"
                        disabled={busyKey === `replan-${ev.id}`}
                        onClick={() => void replanSingleEvent(ev.id)}
                      >
                        {busyKey === `replan-${ev.id}` ? "Checking…" : "Re-check Stock & Prices"}
                      </button>
                    </div>
                    <div style={{ display: "flex", gap: 8 }}>
                      <button type="button" className="btn btn-outline" onClick={() => openEditEvent(ev)}>
                        Edit
                      </button>
                      <button
                        type="button"
                        className="btn btn-danger-soft"
                        disabled={busyKey === `cancel-${ev.id}`}
                        onClick={() => void cancelSingleEvent(ev)}
                      >
                        Cancel Event
                      </button>
                    </div>
                  </div>
                </div>
              );
            })
          )}
        </div>
      )}

      {/* ────────────────────── 2. INVENTORY SYNC & SMART RESTOCK ────────────────────── */}
      {section === "pantry" && (
        <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 16, flexWrap: "wrap" }}>
            <div>
              <h1 className="page-title" style={{ marginBottom: 4 }}>Pantry &amp; Auto-Restock</h1>
              <p className="page-subtitle">
                Syncs POS sales &amp; Valio deliveries automatically so low stock is ordered on time.
              </p>
            </div>
            <button
              type="button"
              className="btn btn-outline"
              onClick={() => setShowAddIngredient((v) => !v)}
            >
              {showAddIngredient ? "Close Form" : "+ Add Item"}
            </button>
          </div>

          {/* Full Inventory Auto-Sync + Low/Very-Low Ordering Control Bar */}
          <InventorySyncGuardCard
            variant="full"
            customerId={`${props.customerId ?? "default"}-${syncCardEpoch}`}
            mandate={props.mandate}
            onChanged={async () => {
              await loadAll();
              await props.onChanged();
            }}
            onMessage={props.onMessage}
            onGoApprove={props.onGoApprove}
            onGoHistory={props.onGoHistory}
          />

          {/* Compact Use-First Expiry & Waste Strip */}
          {smartRestock && smartRestock.useFirst.length > 0 && (
            <div className="banner warn" style={{ flexDirection: "column", alignItems: "stretch", gap: 8, padding: "12px 16px" }}>
              <div style={{ fontWeight: 800, fontSize: 13.5 }}>
                ⏳ Use First (Expiring or Untouched Stock)
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))", gap: 8 }}>
                {smartRestock.useFirst.map((u) => (
                  <div
                    key={u.ingredientId}
                    style={{
                      background: "rgba(255,255,255,0.88)",
                      borderRadius: 10,
                      padding: "8px 11px",
                      color: "var(--text-main)",
                      fontSize: 13,
                    }}
                  >
                    <strong>{tidy(u.headline)}</strong>
                  </div>
                ))}
              </div>
            </div>
          )}

          {showAddIngredient && (
            <div className="card" style={{ border: "2px solid var(--brand-blue)" }}>
              <h3 style={{ margin: "0 0 12px", fontSize: 17 }}>Add Ingredient to Pantry</h3>
              <div className="controls-row">
                <div className="field-group" style={{ flex: "2 1 200px" }}>
                  <span className="field-label">Ingredient Name</span>
                  <input
                    className="field-input"
                    value={newIngName}
                    onChange={(e) => setNewIngName(e.target.value)}
                    placeholder="e.g. Whipping cream"
                  />
                </div>
                <div className="field-group">
                  <span className="field-label">On Hand</span>
                  <input
                    type="number"
                    className="field-input"
                    value={newIngOnHand}
                    onChange={(e) => setNewIngOnHand(Number(e.target.value))}
                  />
                </div>
                <div className="field-group">
                  <span className="field-label">Target Par Level</span>
                  <input
                    type="number"
                    className="field-input"
                    value={newIngPar}
                    onChange={(e) => setNewIngPar(Number(e.target.value))}
                  />
                </div>
                <div className="field-group">
                  <span className="field-label">Unit</span>
                  <select
                    className="field-select"
                    value={newIngUnit}
                    onChange={(e) => setNewIngUnit(e.target.value as "litre" | "kg" | "each" | "pack")}
                  >
                    <option value="litre">Litres (L)</option>
                    <option value="kg">Kilograms (kg)</option>
                    <option value="each">Pieces (pcs)</option>
                    <option value="pack">Packs</option>
                  </select>
                </div>
              </div>
              <div style={{ marginTop: 12, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 14, fontWeight: 600 }}>
                  <input type="checkbox" checked={newIngLf} onChange={(e) => setNewIngLf(e.target.checked)} />
                  <span>Prefer lactose-free Valio products</span>
                </label>
                <button type="button" className="btn btn-primary" onClick={() => void saveNewIngredient()}>
                  Save Item
                </button>
              </div>
            </div>
          )}

          {stockoutResult && (
            <div className="card" style={{ border: "2px solid var(--amber-main)", background: "var(--bg-amber-soft)" }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
                <h3 style={{ margin: 0, fontSize: 17 }}>
                  🔄 Emergency Stock-Out Substitutes for {stockoutResult.ingredientName}
                </h3>
                <button type="button" className="link-quiet" onClick={() => setStockoutResult(null)}>
                  Close
                </button>
              </div>
              {stockoutResult.lines.map((l) => (
                <div key={l.ingredientId} style={{ fontSize: 14 }}>
                  <div>{tidy(l.explanation)}</div>
                  {l.substitutes.length > 0 && (
                    <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginTop: 10 }}>
                      {l.substitutes.map((s) => (
                        <div
                          key={s.productId}
                          style={{ background: "#ffffff", borderRadius: 10, padding: "10px 12px", border: "1px solid var(--border-light)", flex: "1 1 220px" }}
                        >
                          <strong>{s.productName}</strong> ({s.label.toUpperCase()}) · {money(s.totalPrice)}
                          <div style={{ fontSize: 12.5, color: "var(--text-muted)" }}>{tidy(s.tradeOff)}</div>
                          {s.culinaryNote && (
                            <div style={{ fontSize: 11.5, color: "var(--green-text)", fontWeight: 600, marginTop: 2 }}>
                              ✓ Chef fit: {s.culinaryNote}
                            </div>
                          )}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}

          {/* Pantry Grid (Sorted Very Low → Low → Healthy) */}
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(320px, 1fr))", gap: 14 }}>
            {[...inventory]
              .sort((a, b) => {
                const rank = { critical: 0, low: 1, ok: 2 } as const;
                return rank[a.status] - rank[b.status];
              })
              .map((ing) => {
              const rec = restockRecs.find((r) => r.ingredientId === ing.ingredientId);
              const smartLine = smartRestock?.lines.find((l) => l.ingredientId === ing.ingredientId);
              const pct = Math.min(100, Math.round(((ing.onHand + ing.onOrder) / Math.max(1, ing.targetQty)) * 100));
              const barColor =
                ing.status === "critical"
                  ? "var(--red-main)"
                  : ing.status === "low"
                    ? "var(--amber-main)"
                    : "var(--green-main)";

              return (
                <div key={ing.ingredientId} className="card" style={{ padding: 20, display: "flex", flexDirection: "column", gap: 12 }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 8 }}>
                    <div>
                      <div style={{ fontWeight: 800, fontSize: 17 }}>{ing.name}</div>
                      <div style={{ fontSize: 13, color: "var(--text-muted)", marginTop: 2 }}>
                        On hand: <strong>{qty(ing.onHand, ing.unit)}</strong>
                        {ing.onOrder > 0 ? ` · Inbound: ${qty(ing.onOrder, ing.unit)}` : ""} · Target: {qty(ing.targetQty, ing.unit)}
                      </div>
                    </div>
                    <span
                      className={`pill ${ing.status === "critical" ? "red" : ing.status === "low" ? "amber" : "green"}`}
                    >
                      {ing.status === "critical" ? "Very Low" : ing.status === "low" ? "Low Stock" : "Healthy"}
                    </span>
                  </div>

                  {/* Progress bar */}
                  <div style={{ height: 8, background: "var(--bg-subtle)", borderRadius: 999, overflow: "hidden" }}>
                    <div style={{ width: `${pct}%`, height: "100%", background: barColor }} />
                  </div>

                  {smartLine && smartLine.savingEur > 0 && smartLine.smart && (
                    <div style={{ fontSize: 12.5, background: "var(--bg-green-soft)", color: "var(--green-text)", padding: "6px 10px", borderRadius: 8, fontWeight: 600 }}>
                      💡 Smart Pack: {smartLine.smart.packLabel} {smartLine.smart.productName} saves {money(smartLine.savingEur)}
                    </div>
                  )}

                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 6, flexWrap: "nowrap", marginTop: "auto" }}>
                    <div style={{ display: "flex", gap: 5 }}>
                      <button
                        type="button"
                        className="chip-btn"
                        style={{ padding: "5px 10px", fontSize: 12.5 }}
                        disabled={busyKey === `adj-${ing.ingredientId}`}
                        onClick={() => void adjustPantryStock(ing, -1)}
                      >
                        −1 {unitLabel(ing.unit)}
                      </button>
                      <button
                        type="button"
                        className="chip-btn"
                        style={{ padding: "5px 10px", fontSize: 12.5 }}
                        disabled={busyKey === `adj-${ing.ingredientId}`}
                        onClick={() => void adjustPantryStock(ing, 1)}
                      >
                        +1 {unitLabel(ing.unit)}
                      </button>
                    </div>

                    <div style={{ display: "flex", gap: 5 }}>
                      {(rec?.suggestedOrderQty ?? 0) > 0 && (
                        <button
                          type="button"
                          className="chip-btn"
                          style={{
                            padding: "5px 11px",
                            fontSize: 12.5,
                            background: "var(--bg-blue-soft)",
                            borderColor: "var(--brand-blue)",
                            color: "var(--brand-blue)",
                            fontWeight: 700,
                            whiteSpace: "nowrap",
                          }}
                          disabled={busyKey === `restock-${ing.ingredientId}`}
                          onClick={() => void runRestockNow(ing.ingredientId)}
                        >
                          {busyKey === `restock-${ing.ingredientId}`
                            ? "Ordering…"
                            : `Order ${qty(rec?.suggestedOrderQty, ing.unit)}`}
                        </button>
                      )}
                      <button
                        type="button"
                        className="chip-btn"
                        style={{ padding: "5px 10px", fontSize: 12.5 }}
                        onClick={() => void checkStockoutSubstitute(ing, false)}
                        title="Find recipe-safe Valio substitute if primary SKU is out of stock"
                      >
                        Sub?
                      </button>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* ────────────────────── 3. RECIPES & MENU CHECK ────────────────────── */}
      {section === "recipes" && (
        <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 16, flexWrap: "wrap" }}>
            <div>
              <h1 className="page-title">Saved Kitchen Recipes & Menu Sourcing</h1>
              <p className="page-subtitle">
                Cook batches to deduct stock automatically, or check whether your pantry covers next week’s menu.
              </p>
            </div>
            <button type="button" className="btn btn-outline" onClick={() => setShowAddRecipe((v) => !v)}>
              + Add Recipe
            </button>
          </div>

          {showAddRecipe && (
            <div className="card" style={{ border: "2px solid var(--brand-blue)" }}>
              <h3 style={{ margin: "0 0 12px", fontSize: 17 }}>Add Kitchen Recipe</h3>
              <div className="controls-row">
                <div className="field-group" style={{ flex: "2 1 220px" }}>
                  <span className="field-label">Recipe Name</span>
                  <input
                    className="field-input"
                    value={recName}
                    onChange={(e) => setRecName(e.target.value)}
                    placeholder="e.g. Karelian Pastry Egg Butter"
                  />
                </div>
                <div className="field-group">
                  <span className="field-label">Servings / Batch</span>
                  <input
                    type="number"
                    className="field-input"
                    value={recServings}
                    onChange={(e) => setRecServings(Number(e.target.value))}
                  />
                </div>
                <div className="field-group">
                  <span className="field-label">Batches / Week</span>
                  <input
                    type="number"
                    className="field-input"
                    value={recBatchesWeek}
                    onChange={(e) => setRecBatchesWeek(Number(e.target.value))}
                  />
                </div>
                <div className="field-group">
                  <span className="field-label">Primary Ingredient</span>
                  <select className="field-select" value={recIngId} onChange={(e) => setRecIngId(e.target.value)}>
                    {inventory.map((i) => (
                      <option key={i.ingredientId} value={i.ingredientId}>
                        {i.name} ({unitLabel(i.unit)})
                      </option>
                    ))}
                  </select>
                </div>
                <div className="field-group">
                  <span className="field-label">Qty / Batch</span>
                  <input
                    type="number"
                    step="0.5"
                    className="field-input"
                    value={recIngQty}
                    onChange={(e) => setRecIngQty(Number(e.target.value))}
                  />
                </div>
              </div>
              <div style={{ marginTop: 12, display: "flex", justifyContent: "flex-end" }}>
                <button type="button" className="btn btn-primary" onClick={() => void saveNewRecipe()}>
                  Save Recipe
                </button>
              </div>
            </div>
          )}

          {/* Recipe Cards */}
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(310px, 1fr))", gap: 14 }}>
            {recipes.map((r) => (
              <div key={r.recipeId} className="card" style={{ padding: 20, display: "flex", flexDirection: "column", gap: 12 }}>
                <div>
                  <div style={{ fontWeight: 800, fontSize: 17 }}>{r.name}</div>
                  <div style={{ fontSize: 13, color: "var(--text-muted)", marginTop: 2 }}>
                    {r.servingsPerBatch} servings/batch · Usually {r.batchesPerWeek}× per week
                  </div>
                </div>
                <div style={{ fontSize: 13.5, color: "var(--text-main)" }}>
                  {r.ingredients.map((ri) => {
                    const ingName = inventory.find((x) => x.ingredientId === ri.ingredientId)?.name ?? ri.ingredientId;
                    return (
                      <div key={ri.ingredientId}>
                        • {ingName}: <strong>{qty(ri.qtyPerBatch, ri.unit)}</strong> / batch
                      </div>
                    );
                  })}
                </div>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: "auto", pt: 8 } as React.CSSProperties}>
                  <button
                    type="button"
                    className="chip-btn"
                    disabled={busyKey === `cook-${r.recipeId}`}
                    onClick={() => void cookBatch(r)}
                  >
                    {busyKey === `cook-${r.recipeId}` ? "Deducting…" : "🍳 Cook 1 Batch (Deduct Stock)"}
                  </button>
                </div>
              </div>
            ))}
          </div>

          {/* Multi-Recipe Menu Sourcing Check */}
          <div className="card">
            <h2 style={{ margin: "0 0 8px", fontSize: 18, fontWeight: 800 }}>Multi-Recipe Menu Sourcing Check</h2>
            <p style={{ margin: "0 0 14px", fontSize: 14, color: "var(--text-muted)" }}>
              Verify Valio stock & pricing for your full menu by {day(menuNeededBy)} before creating order intents.
            </p>
            <div style={{ display: "flex", gap: 12, flexWrap: "wrap", alignItems: "flex-end" }}>
              <div className="field-group" style={{ maxWidth: 200 }}>
                <span className="field-label">Delivery Needed By</span>
                <input
                  type="date"
                  className="field-input"
                  value={menuNeededBy}
                  onChange={(e) => setMenuNeededBy(e.target.value)}
                />
              </div>
              <button
                type="button"
                className="btn btn-outline"
                disabled={busyKey === "menu-check"}
                onClick={() => void runMenuCheck(false)}
              >
                {busyKey === "menu-check" ? "Checking Valio…" : "Check Menu Shortfalls"}
              </button>
              <button
                type="button"
                className="btn btn-primary"
                disabled={busyKey === "menu-order"}
                onClick={() => void runMenuCheck(true)}
              >
                {busyKey === "menu-order" ? "Creating Proposals…" : "Order Missing Menu Items"}
              </button>
            </div>

            {menuCheckResult && (
              <div className="card-subtle" style={{ marginTop: 14 }}>
                <div style={{ fontWeight: 700, marginBottom: 8 }}>{tidy(menuCheckResult.summary)}</div>
                {menuCheckResult.lines
                  .filter((l) => l.shortfall > 0)
                  .map((l) => (
                    <div key={l.ingredientId} style={{ fontSize: 13.5, padding: "4px 0" }}>
                      • <strong>{l.name}</strong>: short {qty(l.shortfall, l.unit)} →{" "}
                      {l.chosen ? `${l.chosen.productName} (${money(l.chosen.totalPrice)})` : "Out of stock"}
                    </div>
                  ))}
              </div>
            )}
          </div>
        </div>
      )}

      {/* ────────────────────── 4. WEEKLY STANDING ORDERS ────────────────────── */}
      {section === "recurring" && (
        <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 16, flexWrap: "wrap" }}>
            <div>
              <h1 className="page-title">Weekly Standing Orders</h1>
              <p className="page-subtitle">
                Automate steady weekly staples. Orders trigger automatically ahead of delivery day and still pass through your spending & allergen rules.
              </p>
            </div>
            <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
              <button type="button" className="btn btn-outline" onClick={() => setShowAddStanding((v) => !v)}>
                + New Standing Order
              </button>
              <button
                type="button"
                className="btn btn-primary"
                disabled={busyKey === "st-run-all" || standingOrders.length === 0}
                onClick={() => void runDueStandingNow()}
              >
                {busyKey === "st-run-all" ? "Running…" : "▶ Order Next Delivery Now"}
              </button>
            </div>
          </div>

          {/* Smart Cadence Suggestions from Order History */}
          {standingSuggestions.length > 0 && (
            <div className="card" style={{ background: "var(--bg-blue-soft)", borderColor: "#bfdbfe" }}>
              <h2 style={{ margin: "0 0 8px", fontSize: 17, fontWeight: 800, color: "var(--brand-navy)" }}>
                ✨ Spotted in Your Past Orders — 1-Click Weekly Automation
              </h2>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))", gap: 12 }}>
                {standingSuggestions.map((s) => (
                  <div
                    key={s.ingredientId}
                    style={{
                      background: "#ffffff",
                      borderRadius: 12,
                      padding: "12px 14px",
                      border: "1px solid var(--border-light)",
                      display: "flex",
                      justifyContent: "space-between",
                      alignItems: "center",
                      gap: 10,
                    }}
                  >
                    <div>
                      <div style={{ fontWeight: 800 }}>
                        {s.name} · {qty(s.quantity, s.unit)} every {WEEKDAYS[s.weekday]}
                      </div>
                      <div style={{ fontSize: 12.5, color: "var(--text-muted)", marginTop: 2 }}>
                        {tidy(s.reason)}
                      </div>
                    </div>
                    <button
                      type="button"
                      className="btn btn-primary"
                      style={{ minHeight: 38, padding: "6px 12px", fontSize: 13 }}
                      disabled={busyKey === `st-create-${s.ingredientId}`}
                      onClick={() =>
                        void createStandingOrder({
                          ingredientId: s.ingredientId,
                          quantity: s.quantity,
                          weekday: s.weekday,
                          leadTimeDays: s.leadTimeDays,
                        })
                      }
                    >
                      Automate Weekly
                    </button>
                  </div>
                ))}
              </div>
            </div>
          )}

          {showAddStanding && (
            <div className="card" style={{ border: "2px solid var(--brand-blue)" }}>
              <h3 style={{ margin: "0 0 12px", fontSize: 17 }}>Schedule Weekly Standing Order</h3>
              <div className="controls-row">
                <div className="field-group" style={{ flex: "2 1 200px" }}>
                  <span className="field-label">Ingredient</span>
                  <select className="field-select" value={stIngId} onChange={(e) => setStIngId(e.target.value)}>
                    {inventory.map((i) => (
                      <option key={i.ingredientId} value={i.ingredientId}>
                        {i.name} ({unitLabel(i.unit)})
                      </option>
                    ))}
                  </select>
                </div>
                <div className="field-group">
                  <span className="field-label">Quantity</span>
                  <input
                    type="number"
                    min={1}
                    className="field-input"
                    value={stQty}
                    onChange={(e) => setStQty(Number(e.target.value))}
                  />
                </div>
                <div className="field-group">
                  <span className="field-label">Delivery Weekday</span>
                  <select
                    className="field-select"
                    value={stWeekday}
                    onChange={(e) => setStWeekday(Number(e.target.value))}
                  >
                    {WEEKDAYS.map((w, idx) => (
                      <option key={w} value={idx}>
                        Every {w}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="field-group">
                  <span className="field-label">Order Lead Days</span>
                  <input
                    type="number"
                    min={1}
                    max={7}
                    className="field-input"
                    value={stLeadDays}
                    onChange={(e) => setStLeadDays(Number(e.target.value))}
                  />
                </div>
              </div>
              <div style={{ marginTop: 12, display: "flex", justifyContent: "flex-end" }}>
                <button
                  type="button"
                  className="btn btn-primary"
                  onClick={() =>
                    void createStandingOrder({
                      ingredientId: stIngId,
                      quantity: stQty,
                      weekday: stWeekday,
                      leadTimeDays: stLeadDays,
                    })
                  }
                >
                  Save Standing Order
                </button>
              </div>
            </div>
          )}

          {standingOrders.length === 0 ? (
            <div className="empty-hero">
              <h2>No weekly standing orders scheduled yet</h2>
              <p>Accept a spotted cadence suggestion above or click "+ New Standing Order" to automate weekly dairy & kitchen staples.</p>
            </div>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
              {standingOrders.map((st) => (
                <div
                  key={st.id}
                  className="card"
                  style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 16, flexWrap: "wrap" }}
                >
                  <div>
                    <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
                      <strong style={{ fontSize: 17 }}>
                        {st.ingredientName} · {qty(st.quantity, st.unit)}
                      </strong>
                      <span className={`pill ${st.enabled ? "green" : "neutral"}`}>
                        {st.enabled ? `Every ${WEEKDAYS[st.weekday]}` : "Paused"}
                      </span>
                    </div>
                    <div style={{ fontSize: 13.5, color: "var(--text-muted)", marginTop: 4 }}>
                      Next delivery: <strong>{day(st.nextDelivery)}</strong> (auto-orders on {day(st.nextOrderOn)}, {st.leadTimeDays}d lead)
                      {st.lastRun ? ` · Last run: ${tidy(st.lastRun.detail)}` : ""}
                    </div>
                  </div>
                  <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                    <button
                      type="button"
                      className="btn btn-outline"
                      style={{ minHeight: 40, padding: "8px 14px", fontSize: 13.5 }}
                      disabled={busyKey === `st-run-${st.id}`}
                      onClick={() => void runDueStandingNow(st.id)}
                    >
                      Order Now
                    </button>
                    <button
                      type="button"
                      className="btn btn-outline"
                      style={{ minHeight: 40, padding: "8px 14px", fontSize: 13.5 }}
                      onClick={() => void toggleStanding(st)}
                    >
                      {st.enabled ? "Pause" : "Resume"}
                    </button>
                    <button
                      type="button"
                      className="btn btn-danger-soft"
                      style={{ minHeight: 40, padding: "8px 14px", fontSize: 13.5 }}
                      onClick={() => void removeStanding(st)}
                    >
                      Remove
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
