import { useEffect, useRef, useState } from "react";
import { api, timeAgoShort, type Mandate, type RestockAutomationBundle } from "./api";
import { money, qty, unitLabel } from "./format";

type UnitKey = "litre" | "kg" | "each" | "pack";

const UNIT_TABS: Array<{
  unit: UnitKey;
  label: string;
  min: number;
  max: number;
  step: number;
  fallback: number;
}> = [
  { unit: "litre", label: "Litres (L)", min: 50, max: 2000, step: 50, fallback: 500 },
  { unit: "kg", label: "Kilograms (kg)", min: 10, max: 1000, step: 10, fallback: 200 },
  { unit: "each", label: "Pieces (pcs)", min: 20, max: 2000, step: 20, fallback: 500 },
  { unit: "pack", label: "Packs", min: 5, max: 500, step: 5, fallback: 100 },
];

const COMMON_ALLERGENS = [
  { id: "peanut", label: "Peanuts" },
  { id: "nuts", label: "Tree Nuts" },
  { id: "gluten", label: "Gluten" },
  { id: "milk", label: "Milk Protein" },
  { id: "egg", label: "Egg" },
  { id: "soy", label: "Soy" },
  { id: "fish", label: "Fish" },
  { id: "sesame", label: "Sesame" },
  { id: "shellfish", label: "Shellfish" },
];

type RawFlippedOrder =
  | string
  | {
      id?: string;
      label?: string;
      description?: string;
      item?: string;
      productName?: string;
      need?: string;
      quantity?: number;
      unit?: string;
      totalEur?: number;
      totalPrice?: number;
      total?: number;
      from?: string;
      before?: string;
      baselineOutcome?: string;
      previousDecision?: string;
      to?: string;
      after?: string;
      newOutcome?: string;
      draftDecision?: string;
      reason?: string;
    };

type NormalizedFlip = {
  key: string;
  summary: string;
  fromLabel: string;
  toLabel: string;
};

type SimulationResult = {
  autoRatePct: number;
  autoCommitCount: number;
  pendingApprovalCount: number;
  blockedCount: number;
  chefMinutesSavedPerMonth: number;
  risksCaught: {
    allergen: number;
    orderSplitting: number;
  };
  flippedOrders: NormalizedFlip[];
};

function friendlyOutcome(raw: string | undefined): string {
  if (!raw) return "Asks Your OK";
  const lower = raw.toLowerCase();
  if (lower.includes("auto") || lower.includes("automatic")) {
    return "Placed Automatically";
  }
  if (lower.includes("block")) {
    return "Blocked for Safety";
  }
  if (lower.includes("pending") || lower.includes("ask") || lower.includes("ok") || lower.includes("approval")) {
    return "Asks Your OK";
  }
  return raw;
}

function normalizeFlip(item: RawFlippedOrder, idx: number): NormalizedFlip {
  if (typeof item === "string") {
    const parts = item.split("→").map((s) => s.trim());
    if (parts.length === 2 && parts[0]!.includes(":")) {
      const colonIdx = parts[0]!.lastIndexOf(":");
      return {
        key: `flip-${idx}`,
        summary: parts[0]!.slice(0, colonIdx).trim(),
        fromLabel: friendlyOutcome(parts[0]!.slice(colonIdx + 1).trim()),
        toLabel: friendlyOutcome(parts[1]),
      };
    }
    return {
      key: `flip-${idx}`,
      summary: item,
      fromLabel: "",
      toLabel: "",
    };
  }

  const priceVal = item.totalEur ?? item.totalPrice ?? item.total;
  const priceSuffix =
    typeof priceVal === "number" ? ` (${money(priceVal, priceVal % 1 === 0 ? 0 : 2)})` : "";

  let baseTitle =
    item.label ||
    item.description ||
    item.item ||
    (item.quantity && item.unit && (item.productName || item.need)
      ? `${qty(item.quantity, item.unit)} ${item.productName ?? item.need}`
      : item.productName || item.need || `Order #${idx + 1}`);

  if (priceSuffix && !baseTitle.includes("€")) {
    baseTitle = `${baseTitle}${priceSuffix}`;
  }

  const fromRaw =
    item.from ?? item.before ?? item.baselineOutcome ?? item.previousDecision ?? "Placed Automatically";
  const toRaw =
    item.to ?? item.after ?? item.newOutcome ?? item.draftDecision ?? "Asks Your OK";

  return {
    key: item.id ?? `flip-${idx}-${baseTitle}`,
    summary: baseTitle,
    fromLabel: friendlyOutcome(fromRaw),
    toLabel: friendlyOutcome(toRaw),
  };
}

function buildFallbackSimulation(
  draft: Mandate,
  baseline: Mandate | null,
): SimulationResult {
  const sampleOrders: Array<{
    name: string;
    quantity: number;
    unit: UnitKey;
    totalEur: number;
    isSubstitution?: boolean;
    dairyRegular?: boolean;
    allergen?: string;
    splitSuspect?: boolean;
  }> = [
    { name: "Lactose-Free Milk", quantity: 80, unit: "litre", totalEur: 92 },
    { name: "Lactose-Free Cooking Cream", quantity: 40, unit: "litre", totalEur: 148 },
    { name: "Unsalted Kitchen Butter", quantity: 25, unit: "kg", totalEur: 185 },
    { name: "Free-Range Eggs", quantity: 180, unit: "each", totalEur: 64 },
    { name: "Organic Oat Barista Drink", quantity: 120, unit: "litre", totalEur: 216, isSubstitution: true },
    { name: "Lactose-Free Quark", quantity: 50, unit: "kg", totalEur: 195 },
    { name: "Lactose-Free Milk", quantity: 220, unit: "litre", totalEur: 253 },
    { name: "Shredded Mozzarella (LF)", quantity: 45, unit: "kg", totalEur: 342 },
    { name: "Lactose-Free Milk", quantity: 400, unit: "litre", totalEur: 460 },
    { name: "Whipping Cream (Substitute Pack)", quantity: 90, unit: "litre", totalEur: 378, isSubstitution: true },
    { name: " Greek-Style Yogurt (LF)", quantity: 110, unit: "kg", totalEur: 310 },
    { name: "Banquet Cheese Selection", quantity: 80, unit: "kg", totalEur: 640 },
    { name: "Event Lactose-Free Milk", quantity: 750, unit: "litre", totalEur: 862 },
    { name: "Conference Cream Supply", quantity: 300, unit: "litre", totalEur: 1140 },
    { name: "Standard Whole Milk (Non-LF)", quantity: 100, unit: "litre", totalEur: 105, dairyRegular: true },
    { name: "Hazelnut Praline Dessert Base", quantity: 15, unit: "kg", totalEur: 165, allergen: "nuts" },
    { name: "Peanut Satay Sauce Tubs", quantity: 12, unit: "pack", totalEur: 138, allergen: "peanut" },
    { name: "Repeated Near-Cap Milk Split #3", quantity: 380, unit: "litre", totalEur: 435, splitSuspect: true },
  ];

  const evalUnder = (m: Mandate, o: (typeof sampleOrders)[number]): "Placed Automatically" | "Asks Your OK" | "Blocked for Safety" => {
    const restrictions = new Set(m.allergenRestrictions ?? []);
    if (o.dairyRegular && restrictions.has("must_be_lactose_free")) {
      return "Blocked for Safety";
    }
    if (o.allergen && restrictions.has(o.allergen)) {
      return "Blocked for Safety";
    }
    if (!m.autoPurchaseIf.withinMaxOrderValue) {
      return "Asks Your OK";
    }
    if (o.splitSuspect && o.totalEur > m.maxOrderValueEur * 0.8 && o.totalEur <= m.maxOrderValueEur) {
      return "Asks Your OK";
    }
    if (o.totalEur > m.maxOrderValueEur) {
      return "Asks Your OK";
    }
    if (m.maxDailySpendEur !== undefined && o.totalEur > m.maxDailySpendEur) {
      return "Asks Your OK";
    }
    const unitCap =
      m.maxQuantities?.[o.unit] ??
      (m.maxQuantity.unit === o.unit ? m.maxQuantity.value : undefined);
    if (unitCap !== undefined && o.quantity > unitCap) {
      return "Asks Your OK";
    }
    if (o.isSubstitution && (!m.allowedSubstitutions || m.requireApprovalFor.includes("substitution"))) {
      return "Asks Your OK";
    }
    return "Placed Automatically";
  };

  let autoCommitCount = 0;
  let pendingApprovalCount = 0;
  let blockedCount = 0;
  let allergenCaught = 0;
  let splitCaught = 0;
  const flippedOrders: NormalizedFlip[] = [];

  sampleOrders.forEach((o, idx) => {
    const nextDec = evalUnder(draft, o);
    if (nextDec === "Placed Automatically") autoCommitCount++;
    else if (nextDec === "Blocked for Safety") {
      blockedCount++;
      allergenCaught++;
    } else {
      pendingApprovalCount++;
      if (o.splitSuspect) splitCaught++;
    }

    if (baseline) {
      const prevDec = evalUnder(baseline, o);
      if (prevDec !== nextDec) {
        flippedOrders.push({
          key: `local-flip-${idx}`,
          summary: `${qty(o.quantity, o.unit)} ${o.name.trim()} (${money(o.totalEur, 0)})`,
          fromLabel: prevDec,
          toLabel: nextDec,
        });
      }
    }
  });

  const total = sampleOrders.length;
  const autoRatePct = Math.round((autoCommitCount / Math.max(1, total)) * 100);
  const chefMinutesSavedPerMonth = autoCommitCount * 4;

  return {
    autoRatePct,
    autoCommitCount,
    pendingApprovalCount,
    blockedCount,
    chefMinutesSavedPerMonth,
    risksCaught: {
      allergen: allergenCaught,
      orderSplitting: Math.max(1, splitCaught),
    },
    flippedOrders,
  };
}

export function RulesView(props: {
  customerId?: string;
  mandate: Mandate | null;
  onMessage?: (msg: string, tone?: "success" | "warn" | "info") => void;
  onOpenInventorySync?: () => void;
  onSaved: (m: Mandate) => void;
}) {
  const [draft, setDraft] = useState<Mandate | null>(props.mandate);
  const [dirty, setDirty] = useState(false);
  const [autoBundle, setAutoBundle] = useState<RestockAutomationBundle | null>(null);
  const [togglingSync, setTogglingSync] = useState(false);
  const [activeUnit, setActiveUnit] = useState<UnitKey>(
    (props.mandate?.maxQuantity.unit as UnitKey) || "litre",
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedToast, setSavedToast] = useState(false);
  const [sim, setSim] = useState<SimulationResult | null>(null);
  const [simLoading, setSimLoading] = useState(false);

  const lastCustomerRef = useRef<string | null>(props.mandate?.customerId ?? null);

  useEffect(() => {
    void api<RestockAutomationBundle>("/v1/kitchen/restock/automation")
      .then((res) => setAutoBundle(res))
      .catch(() => undefined);
  }, [props.customerId, props.mandate?.customerId]);

  async function toggleRestockProtection() {
    if (!autoBundle) return;
    setTogglingSync(true);
    try {
      const nextEnabled = !autoBundle.policy.enabled;
      const updated = await api<RestockAutomationBundle>("/v1/kitchen/restock/automation", {
        method: "PUT",
        body: JSON.stringify({ enabled: nextEnabled }),
      });
      setAutoBundle(updated);
      props.onMessage?.(
        nextEnabled
          ? "Automatic Inventory Sync & Low-Stock Ordering resumed."
          : "Automatic Low-Stock Ordering paused.",
        "info",
      );
    } catch (e) {
      props.onMessage?.(e instanceof Error ? e.message : String(e), "warn");
    } finally {
      setTogglingSync(false);
    }
  }

  // Prevent 4s background poll from wiping unsaved chef edits!
  useEffect(() => {
    if (!props.mandate) return;
    const customerChanged = lastCustomerRef.current !== props.mandate.customerId;
    if (customerChanged) {
      lastCustomerRef.current = props.mandate.customerId;
      setDraft(props.mandate);
      setDirty(false);
      setActiveUnit((props.mandate.maxQuantity.unit as UnitKey) || "litre");
      return;
    }
    if (!dirty) {
      setDraft(props.mandate);
    }
  }, [props.mandate, dirty]);

  // Debounced 120ms live 30-day counterfactual simulation
  useEffect(() => {
    if (!draft) return;
    let cancelled = false;
    setSimLoading(true);

    const timer = setTimeout(async () => {
      try {
        const res = await api<Record<string, unknown>>("/v1/mandate/simulate", {
          method: "POST",
          body: JSON.stringify(draft),
        });
        if (cancelled) return;

        const autoCommitCount = Number(res.autoCommitCount ?? 0);
        const pendingApprovalCount = Number(res.pendingApprovalCount ?? 0);
        const blockedCount = Number(res.blockedCount ?? 0);
        const denom = Math.max(1, autoCommitCount + pendingApprovalCount + blockedCount);
        const autoRatePct =
          typeof res.autoRatePct === "number"
            ? Math.round(res.autoRatePct)
            : Math.round((autoCommitCount / denom) * 100);

        const rawRisks = (res.risksCaught ?? {}) as Record<string, unknown>;
        const rawFlips = Array.isArray(res.flippedOrders)
          ? (res.flippedOrders as RawFlippedOrder[])
          : [];

        setSim({
          autoRatePct,
          autoCommitCount,
          pendingApprovalCount,
          blockedCount,
          chefMinutesSavedPerMonth: Number(
            res.chefMinutesSavedPerMonth ?? autoCommitCount * 4,
          ),
          risksCaught: {
            allergen: Number(rawRisks.allergen ?? blockedCount),
            orderSplitting: Number(rawRisks.orderSplitting ?? 0),
          },
          flippedOrders: rawFlips.map(normalizeFlip),
        });
      } catch {
        if (!cancelled) {
          setSim(buildFallbackSimulation(draft, props.mandate));
        }
      } finally {
        if (!cancelled) setSimLoading(false);
      }
    }, 120);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [draft, props.mandate]);

  if (!draft) {
    return (
      <div className="page-wrap narrow">
        <div className="card" style={{ textAlign: "center", padding: 40 }}>
          Loading your kitchen rules…
        </div>
      </div>
    );
  }

  function updateDraft(updater: (prev: Mandate) => Mandate) {
    setDirty(true);
    setSavedToast(false);
    setDraft((prev) => (prev ? updater(prev) : prev));
  }

  function toggleRestriction(id: string) {
    updateDraft((prev) => {
      const cur = new Set(prev.allergenRestrictions ?? []);
      if (cur.has(id)) cur.delete(id);
      else cur.add(id);
      return { ...prev, allergenRestrictions: Array.from(cur) };
    });
  }

  function getUnitCap(m: Mandate, unit: UnitKey): number {
    const tabMeta = UNIT_TABS.find((t) => t.unit === unit)!;
    const explicit = m.maxQuantities?.[unit];
    if (typeof explicit === "number" && Number.isFinite(explicit)) return explicit;
    if (m.maxQuantity.unit === unit) return m.maxQuantity.value;
    return tabMeta.fallback;
  }

  async function saveRules() {
    if (!draft) return;
    setSaving(true);
    setError(null);
    setSavedToast(false);
    try {
      const updated = await api<Mandate>("/v1/mandate", {
        method: "PUT",
        body: JSON.stringify(draft),
      });
      setDraft(updated);
      setDirty(false);
      props.onSaved(updated);
      setSavedToast(true);
      setTimeout(() => setSavedToast(false), 3500);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

  function discardEdits() {
    if (!props.mandate) return;
    setDraft(props.mandate);
    setDirty(false);
    setError(null);
  }

  const preview = sim ?? buildFallbackSimulation(draft, props.mandate);
  const totalSimOrders = Math.max(
    1,
    preview.autoCommitCount + preview.pendingApprovalCount + preview.blockedCount,
  );
  const greenWidthPct = Math.round((preview.autoCommitCount / totalSimOrders) * 100);
  const amberWidthPct = Math.round((preview.pendingApprovalCount / totalSimOrders) * 100);
  const redWidthPct = Math.max(0, 100 - greenWidthPct - amberWidthPct);

  const isAutoActive = draft.autoPurchaseIf.withinMaxOrderValue;
  const activeTabMeta = UNIT_TABS.find((t) => t.unit === activeUnit) ?? UNIT_TABS[0]!;
  const currentUnitCap = getUnitCap(draft, activeUnit);
  const strictLactoseFree = (draft.allergenRestrictions ?? []).includes(
    "must_be_lactose_free",
  );
  const dailySpendVal = draft.maxDailySpendEur ?? 2500;
  const driftPctVal = draft.priceDriftTolerancePct ?? 2;

  return (
    <div className="page-wrap narrow">
      <div className="page-header">
        <h1 className="page-title">What Can Your Assistant Do Automatically?</h1>
        <p className="page-subtitle">
          Set simple boundaries once. Anytime an order crosses a rule, your assistant pauses and asks you first.
        </p>
      </div>

      {error && (
        <div className="banner error" style={{ marginBottom: 18 }}>
          <div>{error}</div>
          <button type="button" className="link-quiet" onClick={() => setError(null)}>
            Dismiss
          </button>
        </div>
      )}

      {savedToast && (
        <div className="banner success" style={{ marginBottom: 18 }}>
          <div>✓ Your ordering rules have been saved and are active immediately.</div>
        </div>
      )}

      {/* Sticky "Mandate Time-Machine" — Live 30-Day Counterfactual Simulator Card */}
      <div
        className="card"
        style={{
          position: "sticky",
          top: 78,
          zIndex: 20,
          marginBottom: 22,
          padding: "18px 22px",
          border: dirty ? "2px solid var(--brand-blue)" : "1.5px solid var(--border-strong)",
          boxShadow: "0 10px 26px rgba(15, 23, 42, 0.08)",
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
            <span style={{ fontWeight: 800, fontSize: 16, color: "var(--brand-navy)" }}>
              ⏱ 30-Day Impact Preview (Mandate Time-Machine)
            </span>
            {dirty && <span className="pill amber">Unsaved Preview</span>}
          </div>
          <span className="pill blue" style={{ fontSize: 12 }}>
            {simLoading ? "Replaying 30-day kitchen history…" : "Live 30-Day Replay"}
          </span>
        </div>

        {/* 3-Color Horizontal Progress Bar */}
        <div
          style={{
            display: "flex",
            width: "100%",
            height: 14,
            borderRadius: 999,
            overflow: "hidden",
            background: "var(--bg-subtle)",
            marginBottom: 10,
          }}
          role="img"
          aria-label={`Auto-Ordered ${preview.autoRatePct}%, Asks Your OK ${preview.pendingApprovalCount} orders, Blocked for Safety ${preview.blockedCount} hazards`}
        >
          {preview.autoCommitCount > 0 && (
            <div
              style={{
                width: `${greenWidthPct}%`,
                background: "var(--green-main)",
                transition: "width 180ms ease",
              }}
            />
          )}
          {preview.pendingApprovalCount > 0 && (
            <div
              style={{
                width: `${amberWidthPct}%`,
                background: "var(--amber-main)",
                transition: "width 180ms ease",
              }}
            />
          )}
          {preview.blockedCount > 0 && (
            <div
              style={{
                width: `${Math.max(4, redWidthPct)}%`,
                background: "var(--red-main)",
                transition: "width 180ms ease",
              }}
            />
          )}
        </div>

        {/* Segment Legend */}
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            gap: 12,
            flexWrap: "wrap",
            fontSize: 13,
            fontWeight: 700,
            marginBottom: 12,
          }}
        >
          <span style={{ color: "var(--green-text)" }}>
            ● Auto-Ordered: {preview.autoRatePct}% ({preview.autoCommitCount} orders)
          </span>
          <span style={{ color: "var(--amber-text)" }}>
            ● Asks Your OK: {preview.pendingApprovalCount} orders
          </span>
          <span style={{ color: "var(--red-text)" }}>
            ● Blocked for Safety: {preview.blockedCount}{" "}
            {preview.blockedCount === 1 ? "hazard" : "hazards"} stopped
          </span>
        </div>

        {/* Metric Pills */}
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <span className="pill green">
            ⏱ Est. {preview.chefMinutesSavedPerMonth} mins saved / month
          </span>
          <span className="pill red">
            🛡 {preview.risksCaught.allergen} allergen blocks
          </span>
          <span className="pill amber">
            🔪 {preview.risksCaught.orderSplitting} split-order blocks
          </span>
        </div>

        {/* Live "What Flips Under Your Unsaved Changes" Diff List */}
        {preview.flippedOrders.length > 0 && (
          <div
            style={{
              marginTop: 12,
              padding: "10px 12px",
              borderRadius: 12,
              background: "var(--bg-blue-soft)",
              border: "1px solid #bfdbfe",
            }}
          >
            <div
              style={{
                fontSize: 12.5,
                fontWeight: 800,
                color: "var(--brand-navy)",
                marginBottom: 6,
              }}
            >
              What Flips Under Your Unsaved Changes ({preview.flippedOrders.length}):
            </div>
            <div
              style={{
                display: "flex",
                flexDirection: "column",
                gap: 4,
                maxHeight: 96,
                overflowY: "auto",
                fontSize: 13,
              }}
            >
              {preview.flippedOrders.map((f) => (
                <div key={f.key} style={{ color: "var(--text-main)" }}>
                  <strong>{f.summary}</strong>
                  {f.fromLabel && f.toLabel ? (
                    <>
                      : <span style={{ color: "var(--text-muted)" }}>{f.fromLabel}</span>{" "}
                      →{" "}
                      <strong
                        style={{
                          color:
                            f.toLabel === "Placed Automatically"
                              ? "var(--green-text)"
                              : f.toLabel === "Blocked for Safety"
                                ? "var(--red-text)"
                                : "var(--amber-text)",
                        }}
                      >
                        {f.toLabel}
                      </strong>
                    </>
                  ) : null}
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
        {/* Master Switch Card: Pause Automatic Ordering Anytime */}
        <div
          className="card"
          style={{
            background: isAutoActive ? "#ffffff" : "var(--bg-amber-soft)",
            borderColor: isAutoActive ? "var(--border-light)" : "var(--amber-border)",
          }}
        >
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
              gap: 16,
              flexWrap: "wrap",
            }}
          >
            <div style={{ flex: "1 1 320px" }}>
              <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 4 }}>
                <h2 style={{ margin: 0, fontSize: 18.5, fontWeight: 800 }}>
                  {isAutoActive
                    ? "⏸ Pause Automatic Ordering Anytime"
                    : "⏸ Automatic Ordering Is Paused"}
                </h2>
                <span className={`pill ${isAutoActive ? "green" : "amber"}`}>
                  {isAutoActive ? "Active" : "Paused — 100% Ask You"}
                </span>
              </div>
              <p style={{ margin: 0, fontSize: 14, color: "var(--text-muted)" }}>
                {isAutoActive
                  ? "Your assistant places routine orders within your limits below. Pause anytime so 100% of orders wait for your OK."
                  : "Every single order will wait in 'Needs Your OK' until you resume automatic ordering."}
              </p>
            </div>

            <button
              type="button"
              className={`btn ${isAutoActive ? "secondary" : "primary"}`}
              onClick={() =>
                updateDraft((prev) => ({
                  ...prev,
                  autoPurchaseIf: {
                    ...prev.autoPurchaseIf,
                    withinMaxOrderValue: !prev.autoPurchaseIf.withinMaxOrderValue,
                  },
                }))
              }
            >
              {isAutoActive ? "⏸ Pause Assistant" : "▶ Resume Automatic Ordering"}
            </button>
          </div>
        </div>

        {/* Automatic Inventory Sync & Low-Stock Protection Summary Card */}
        {autoBundle && (
          <div
            className="card"
            style={{
              padding: "18px 22px",
              background: autoBundle.policy.enabled ? "var(--bg-green-soft)" : "#ffffff",
              borderColor: autoBundle.policy.enabled ? "var(--green-border)" : "var(--border-light)",
            }}
          >
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                gap: 16,
                flexWrap: "wrap",
              }}
            >
              <div style={{ flex: "1 1 320px" }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", marginBottom: 4 }}>
                  <h2 style={{ margin: 0, fontSize: 18, fontWeight: 800 }}>
                    🔄 Auto-Restock Low Stock
                  </h2>
                  <span className={`pill ${autoBundle.policy.enabled ? "green" : "amber"}`}>
                    {autoBundle.policy.enabled ? "● Active" : "Paused"}
                  </span>
                  <span className="pill blue">
                    Synced {timeAgoShort(autoBundle.syncStatus?.lastSyncedAt)}
                  </span>
                </div>
                <p style={{ margin: 0, fontSize: 14, color: "var(--text-muted)" }}>
                  Auto-orders{" "}
                  <strong>
                    {autoBundle.policy.urgencies.includes("low") ? "Very Low & Low" : "Very Low"}
                  </strong>{" "}
                  pantry items within your spending &amp; allergen limits below, and sends{" "}
                  <strong>1 daily digest email</strong> summarizing every restock placed or planned,
                  your inventory history, and incoming deliveries to your workplace.
                </p>
              </div>

              <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                <button
                  type="button"
                  className="btn secondary"
                  style={{ minHeight: 42, padding: "8px 14px", fontSize: 13.5 }}
                  disabled={togglingSync}
                  onClick={() => void toggleRestockProtection()}
                >
                  {autoBundle.policy.enabled ? "Pause" : "Resume"}
                </button>
                {props.onOpenInventorySync && (
                  <button
                    type="button"
                    className="btn primary"
                    style={{ minHeight: 42, padding: "8px 16px", fontSize: 13.5 }}
                    onClick={props.onOpenInventorySync}
                  >
                    Stock Settings →
                  </button>
                )}
              </div>
            </div>
          </div>
        )}

        {/* Rule 1: Automatic Order Limit + Daily Cap & Price Drift */}
        <div className="card">
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              alignItems: "flex-start",
              gap: 16,
              marginBottom: 16,
            }}
          >
            <div>
              <h2 style={{ margin: "0 0 4px", fontSize: 19, fontWeight: 800 }}>
                1. Automatic Spending Limit (Per Order)
              </h2>
              <p style={{ margin: 0, fontSize: 14.5, color: "var(--text-muted)" }}>
                Orders up to this amount are placed right away. Larger orders wait for your OK.
              </p>
            </div>
            <div
              style={{
                fontSize: 30,
                fontWeight: 800,
                color: "var(--brand-blue)",
                whiteSpace: "nowrap",
              }}
            >
              {money(draft.maxOrderValueEur, 0)}
            </div>
          </div>

          <input
            type="range"
            min={50}
            max={2500}
            step={50}
            value={draft.maxOrderValueEur}
            onChange={(e) =>
              updateDraft((prev) => ({
                ...prev,
                maxOrderValueEur: Number(e.target.value),
              }))
            }
            className="range-slider"
            aria-label="Automatic Spending Limit"
          />
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              fontSize: 12.5,
              color: "var(--text-soft)",
              marginTop: 6,
            }}
          >
            <span>€50 (Ask almost always)</span>
            <span>€2,500 (Higher automation)</span>
          </div>

          {/* Compact Daily Spend Cap & Price Rise Tolerance Controls */}
          <div
            style={{
              marginTop: 20,
              paddingTop: 16,
              borderTop: "1px solid var(--border-light)",
              display: "grid",
              gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))",
              gap: 16,
            }}
          >
            <div className="card-subtle" style={{ padding: "12px 14px" }}>
              <div
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "center",
                  marginBottom: 6,
                }}
              >
                <span style={{ fontWeight: 700, fontSize: 13.5 }}>Daily Total Spend Cap</span>
                <strong style={{ color: "var(--brand-navy)", fontSize: 15 }}>
                  {draft.maxDailySpendEur !== undefined
                    ? money(draft.maxDailySpendEur, 0)
                    : "No daily cap"}
                </strong>
              </div>
              <input
                type="range"
                min={500}
                max={10000}
                step={250}
                value={dailySpendVal}
                onChange={(e) =>
                  updateDraft((prev) => ({
                    ...prev,
                    maxDailySpendEur: Number(e.target.value),
                  }))
                }
                className="range-slider"
                aria-label="Daily Total Spend Cap"
              />
              <div style={{ fontSize: 12, color: "var(--text-muted)", marginTop: 4 }}>
                Pauses automatic orders if total daily spend crosses this budget.
              </div>
            </div>

            <div className="card-subtle" style={{ padding: "12px 14px" }}>
              <div
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "center",
                  marginBottom: 6,
                }}
              >
                <span style={{ fontWeight: 700, fontSize: 13.5 }}>Price Rise Tolerance</span>
                <strong style={{ color: "var(--brand-navy)", fontSize: 15 }}>
                  {driftPctVal}%
                </strong>
              </div>
              <input
                type="range"
                min={0}
                max={10}
                step={0.5}
                value={driftPctVal}
                onChange={(e) =>
                  updateDraft((prev) => ({
                    ...prev,
                    priceDriftTolerancePct: Number(e.target.value),
                  }))
                }
                className="range-slider"
                aria-label="Price Rise Tolerance Percentage"
              />
              <div style={{ fontSize: 12, color: "var(--text-muted)", marginTop: 4 }}>
                Re-asks you if live supplier price rises more than {driftPctVal}% before placement.
              </div>
            </div>
          </div>
        </div>

        {/* Rule 2: Per-Unit Quantity Caps */}
        <div className="card">
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              alignItems: "flex-start",
              gap: 16,
              marginBottom: 14,
            }}
          >
            <div>
              <h2 style={{ margin: "0 0 4px", fontSize: 19, fontWeight: 800 }}>
                2. Maximum Amount per Automatic Order
              </h2>
              <p style={{ margin: 0, fontSize: 14.5, color: "var(--text-muted)" }}>
                Set automatic quantity limits for each kitchen unit so unusually large bulk orders ask you first.
              </p>
            </div>
            <div
              style={{
                fontSize: 26,
                fontWeight: 800,
                color: "var(--brand-navy)",
                whiteSpace: "nowrap",
              }}
            >
              {currentUnitCap.toLocaleString("en-GB")} {unitLabel(activeUnit)}
            </div>
          </div>

          {/* Per-Unit Selector Tabs */}
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 16 }}>
            {UNIT_TABS.map((tab) => {
              const capForTab = getUnitCap(draft, tab.unit);
              const isSelected = activeUnit === tab.unit;
              return (
                <button
                  key={tab.unit}
                  type="button"
                  className="chip-btn"
                  style={
                    isSelected
                      ? {
                          background: "var(--brand-blue)",
                          color: "#ffffff",
                          borderColor: "var(--brand-blue)",
                        }
                      : undefined
                  }
                  onClick={() => setActiveUnit(tab.unit)}
                >
                  {tab.label}: {capForTab.toLocaleString("en-GB")} {unitLabel(tab.unit)}
                </button>
              );
            })}
          </div>

          <input
            type="range"
            min={activeTabMeta.min}
            max={activeTabMeta.max}
            step={activeTabMeta.step}
            value={Math.min(activeTabMeta.max, Math.max(activeTabMeta.min, currentUnitCap))}
            onChange={(e) => {
              const v = Number(e.target.value);
              updateDraft((prev) => ({
                ...prev,
                maxQuantities: {
                  litre: getUnitCap(prev, "litre"),
                  kg: getUnitCap(prev, "kg"),
                  each: getUnitCap(prev, "each"),
                  pack: getUnitCap(prev, "pack"),
                  ...(prev.maxQuantities ?? {}),
                  [activeUnit]: v,
                },
                ...(prev.maxQuantity.unit === activeUnit
                  ? { maxQuantity: { ...prev.maxQuantity, value: v } }
                  : {}),
              }));
            }}
            className="range-slider"
            aria-label={`Maximum automatic order amount in ${activeTabMeta.label}`}
          />
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              fontSize: 12.5,
              color: "var(--text-soft)",
              marginTop: 6,
            }}
          >
            <span>
              {activeTabMeta.min} {unitLabel(activeUnit)}
            </span>
            <span>
              {activeTabMeta.max.toLocaleString("en-GB")} {unitLabel(activeUnit)}
            </span>
          </div>
        </div>

        {/* Rule 3: Out of Stock Substitutions */}
        <div className="card">
          <h2 style={{ margin: "0 0 4px", fontSize: 19, fontWeight: 800 }}>
            3. If an Item Runs Low in Stock
          </h2>
          <p style={{ margin: "0 0 16px", fontSize: 14.5, color: "var(--text-muted)" }}>
            Choose how your assistant should handle product swaps when your usual pack is out of stock.
          </p>

          <div className="radio-cards">
            <button
              type="button"
              className={`radio-card ${!draft.allowedSubstitutions ? "selected" : ""}`}
              onClick={() =>
                updateDraft((prev) => ({
                  ...prev,
                  allowedSubstitutions: false,
                  requireApprovalFor: Array.from(
                    new Set([...prev.requireApprovalFor, "substitution"]),
                  ),
                }))
              }
            >
              <div style={{ fontWeight: 800, fontSize: 15, marginBottom: 4 }}>
                {!draft.allowedSubstitutions ? "● " : "○ "}Always ask me before swapping
              </div>
              <div style={{ fontSize: 13, color: "var(--text-muted)" }}>
                Substitutes are prepared for you, but never ordered without your OK.
              </div>
            </button>

            <button
              type="button"
              className={`radio-card ${draft.allowedSubstitutions ? "selected" : ""}`}
              onClick={() =>
                updateDraft((prev) => ({
                  ...prev,
                  allowedSubstitutions: true,
                  requireApprovalFor: prev.requireApprovalFor.filter(
                    (r) => r !== "substitution",
                  ),
                }))
              }
            >
              <div style={{ fontWeight: 800, fontSize: 15, marginBottom: 4 }}>
                {draft.allowedSubstitutions ? "● " : "○ "}Allow matching Valio swaps
              </div>
              <div style={{ fontSize: 13, color: "var(--text-muted)" }}>
                Can substitute similar products automatically if within your spending limit &amp; safety rules.
              </div>
            </button>
          </div>
        </div>

        {/* Rule 4: Kitchen Allergen & Dairy Safety Switches */}
        <div className="card">
          <h2 style={{ margin: "0 0 4px", fontSize: 19, fontWeight: 800 }}>
            4. Kitchen Safety &amp; Allergen Blocks
          </h2>
          <p style={{ margin: "0 0 16px", fontSize: 14.5, color: "var(--text-muted)" }}>
            Enforce strict dietary rules across every search, substitute, and automatic order.
          </p>

          {/* Prominent Strict Lactose-Free Dairy Rule Switch */}
          <label
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              gap: 16,
              padding: "14px 16px",
              borderRadius: 14,
              background: strictLactoseFree ? "var(--bg-green-soft)" : "var(--bg-canvas)",
              border: strictLactoseFree
                ? "1.5px solid var(--green-border)"
                : "1px solid var(--border-light)",
              marginBottom: 18,
              cursor: "pointer",
            }}
          >
            <div>
              <div style={{ fontWeight: 800, fontSize: 15 }}>
                🥛 Strict Lactose-Free Dairy Rule
              </div>
              <div style={{ fontSize: 13.5, color: "var(--text-muted)", marginTop: 2 }}>
                Every milk, cream, butter, yogurt, or cheese item must be certified lactose-free (low-lactose is rejected).
              </div>
            </div>
            <input
              type="checkbox"
              checked={strictLactoseFree}
              onChange={() => toggleRestriction("must_be_lactose_free")}
              style={{ width: 22, height: 22, accentColor: "var(--green-main)", flexShrink: 0 }}
            />
          </label>

          <div style={{ fontWeight: 700, fontSize: 14, marginBottom: 10 }}>
            Block Allergens (Contains or May Contain Traces):
          </div>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 20 }}>
            {COMMON_ALLERGENS.map((al) => {
              const active = (draft.allergenRestrictions ?? []).includes(al.id);
              return (
                <button
                  key={al.id}
                  type="button"
                  className="chip-btn"
                  style={
                    active
                      ? {
                          background: "var(--bg-red-soft)",
                          borderColor: "var(--red-main)",
                          color: "var(--red-text)",
                          fontWeight: 800,
                        }
                      : undefined
                  }
                  onClick={() => toggleRestriction(al.id)}
                >
                  {active ? `Blocked: ${al.label} ✕` : `+ Block ${al.label}`}
                </button>
              );
            })}
          </div>

          <label
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              gap: 16,
              paddingTop: 16,
              borderTop: "1px solid var(--border-light)",
              cursor: "pointer",
            }}
          >
            <div>
              <div style={{ fontWeight: 700, fontSize: 15 }}>
                Allow automatic ordering when supplier reliability score is new
              </div>
              <div style={{ fontSize: 13.5, color: "var(--text-muted)" }}>
                Keep enabled so everyday items under your spending limit don&apos;t pause unnecessarily.
              </div>
            </div>
            <input
              type="checkbox"
              checked={draft.autoPurchaseIf.reliabilityUnknownOk}
              onChange={(e) =>
                updateDraft((prev) => ({
                  ...prev,
                  autoPurchaseIf: {
                    ...prev.autoPurchaseIf,
                    reliabilityUnknownOk: e.target.checked,
                  },
                }))
              }
              style={{ width: 22, height: 22, accentColor: "var(--green-main)", flexShrink: 0 }}
            />
          </label>
        </div>

        <div style={{ display: "flex", justifyContent: "flex-start", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
          <button
            type="button"
            className="btn primary"
            style={{ minWidth: 220 }}
            disabled={saving}
            onClick={() => void saveRules()}
          >
            {saving ? "Saving rules…" : dirty ? "Save My Rules (Apply Changes)" : "Save My Rules"}
          </button>

          {dirty && (
            <button
              type="button"
              className="btn secondary"
              disabled={saving}
              onClick={discardEdits}
            >
              Discard Unsaved Edits
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
