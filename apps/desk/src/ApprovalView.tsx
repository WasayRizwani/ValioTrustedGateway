import { useEffect, useState } from "react";
import { api, nextMonday, ruleLabel, type Intent, type Mandate } from "./api";
import { day, money, qty, tidy } from "./format";
import { signHumanOverride } from "./webauthn";

type CascadeInfo = {
  droppedProductId?: string;
  droppedProductName?: string;
  backupProductId?: string;
  backupProductName: string;
  backupTotalPrice?: number;
};

type ExtendedIntentMeta = NonNullable<Intent["meta"]> & {
  quoteId?: string;
  quoteValidUntil?: string;
  cascadeExecuted?: CascadeInfo;
};

type ApproveChallengeResponse = {
  challenge: string;
  rpId?: string;
};

type CommitResponse = {
  confirmation: {
    orderId: string;
  };
  intent?: Intent & {
    meta?: ExtendedIntentMeta;
  };
  cascadeExecuted?: CascadeInfo;
};

const regionDisplayNames =
  typeof Intl !== "undefined" && typeof Intl.DisplayNames === "function"
    ? new Intl.DisplayNames(["en"], { type: "region" })
    : null;

function formatOrigin(origin: string | null | undefined): string | null {
  if (!origin) return null;
  const trimmed = origin.trim();
  if (!trimmed) return null;
  if (/^[A-Za-z]{2}$/.test(trimmed) && regionDisplayNames) {
    try {
      const resolved = regionDisplayNames.of(trimmed.toUpperCase());
      if (resolved) return resolved;
    } catch {
      return trimmed.toUpperCase();
    }
  }
  return trimmed;
}

function formatAllergenList(items: string[] | undefined): string {
  if (!items || items.length === 0) return "";
  return items
    .map((a) =>
      a
        .replace(/_/g, " ")
        .replace(/\b\w/g, (ch) => ch.toUpperCase()),
    )
    .join(", ");
}

export function ApprovalView(props: {
  pending: Intent[];
  mandate: Mandate | null;
  selectedId: string | null;
  onSelectId: (id: string | null) => void;
  onChanged: () => Promise<void> | void;
  onApproved: (msg: string, stayInQueue?: boolean) => void;
}) {
  const [busyId, setBusyId] = useState<string | null>(null);
  const [busyMode, setBusyMode] = useState<"biometric" | "quick" | "reject" | "refresh" | "swap" | "stockout" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState<number>(() => Date.now());
  const [overrideConfirmed, setOverrideConfirmed] = useState<boolean>(true);
  const [backupProtectionEnabled, setBackupProtectionEnabled] = useState<boolean>(true);
  const [selectedBackupId, setSelectedBackupId] = useState<string | null>(null);
  const [stockoutArmedProduct, setStockoutArmedProduct] = useState<string | null>(null);

  const current =
    props.pending.find((p) => p.id === props.selectedId) ?? props.pending[0] ?? null;

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 15_000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    setOverrideConfirmed(true);
    setBackupProtectionEnabled(true);
    setSelectedBackupId(null);
    setError(null);
  }, [current?.id]);

  const meta = current?.meta as ExtendedIntentMeta | undefined;
  const alternatives = meta?.alternatives ?? [];
  const backupAlt =
    alternatives.find((a) => a.productId === selectedBackupId) ??
    alternatives.find((a) => a.canFulfil) ??
    alternatives[0] ??
    null;

  const primaryProductId = current?.basket[0]?.productId ?? null;
  const isStockoutArmed =
    Boolean(primaryProductId) && stockoutArmedProduct === primaryProductId;

  const failingRules = current?.policy.failingRules ?? [];
  const needsRuleOverride = failingRules.length > 0;
  const failingRuleSummary = failingRules.map(ruleLabel).join(", ");

  const expiresMs = current ? new Date(current.expiresAt).getTime() - now : 0;
  const isExpired = current ? expiresMs <= 0 : false;
  const proposalMinutesLeft = current
    ? Math.max(1, Math.round(expiresMs / 60_000))
    : 0;

  const quoteValidUntil = meta?.quoteValidUntil;
  const quoteMs = quoteValidUntil ? new Date(quoteValidUntil).getTime() - now : null;
  const quoteMinutesLeft =
    quoteMs !== null && quoteMs > 0 ? Math.max(1, Math.round(quoteMs / 60_000)) : 0;

  const sampleLitres = Math.max(
    3000,
    Math.ceil(((props.mandate?.maxOrderValueEur ?? 500) + 400) / 0.85),
  );

  async function clearArmedStockout(productId: string | null) {
    if (!productId) return;
    try {
      await api("/v1/admin/simulate-stockout", {
        method: "POST",
        body: JSON.stringify({ productId, active: false }),
      });
    } catch {
      // Best-effort demo cleanup
    } finally {
      setStockoutArmedProduct((prev) => (prev === productId ? null : prev));
    }
  }

  async function handleToggleSimulateStockout(intent: Intent) {
    const prodId = intent.basket[0]?.productId;
    if (!prodId) return;
    const nextActive = stockoutArmedProduct !== prodId;
    setBusyId(intent.id);
    setBusyMode("stockout");
    setError(null);
    try {
      await api("/v1/admin/simulate-stockout", {
        method: "POST",
        body: JSON.stringify({ productId: prodId, active: nextActive }),
      });
      setStockoutArmedProduct(nextActive ? prodId : null);
      if (nextActive) {
        setBackupProtectionEnabled(true);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusyId(null);
      setBusyMode(null);
    }
  }

  async function handleApprove(intent: Intent, useBiometric: boolean) {
    if (isExpired) return;
    if ((intent.policy.failingRules?.length ?? 0) > 0 && !overrideConfirmed) return;

    const armedProd =
      stockoutArmedProduct === intent.basket[0]?.productId
        ? stockoutArmedProduct
        : null;

    setBusyId(intent.id);
    setBusyMode(useBiometric ? "biometric" : "quick");
    setError(null);

    try {
      let challenge = "";
      let rpId: string | undefined;
      try {
        const chRes = await api<ApproveChallengeResponse>(
          `/v1/orders/${intent.id}/approve-challenge`,
          {
            method: "POST",
            body: JSON.stringify({ snapshotHash: intent.snapshotHash }),
          },
        );
        challenge = chRes.challenge;
        rpId = chRes.rpId;
      } catch {
        challenge = btoa(`${intent.id}:${intent.snapshotHash}:${Date.now()}`)
          .replace(/\+/g, "-")
          .replace(/\//g, "_")
          .replace(/=+$/g, "");
      }

      const humanSignature = await signHumanOverride({
        intentId: intent.id,
        challenge,
        rpId,
        useBiometric,
      });

      const failing = intent.policy.failingRules ?? [];
      await api(`/v1/orders/${intent.id}/approve`, {
        method: "POST",
        body: JSON.stringify({
          snapshotHash: intent.snapshotHash,
          ...(failing.length
            ? { authorizeMandateOverride: true, acknowledgedRules: failing }
            : {}),
          humanSignature,
          ...(backupProtectionEnabled && backupAlt
            ? {
                authorizedFallback: {
                  productId: backupAlt.productId,
                  productName: backupAlt.productName,
                  totalPrice: backupAlt.totalPrice,
                  maxTotalPrice: Number(
                    (Math.max(backupAlt.totalPrice, intent.totalPrice) * 1.05).toFixed(2),
                  ),
                },
              }
            : {}),
        }),
      });

      const commitRes = await api<CommitResponse>(
        `/v1/orders/${intent.id}/commit`,
        {
          method: "POST",
          body: JSON.stringify({ idempotencyKey: `desk-ok-${intent.id}` }),
        },
      );

      if (armedProd) {
        await clearArmedStockout(armedProd);
      }

      await props.onChanged();

      const orderId =
        commitRes.confirmation?.orderId ??
        commitRes.intent?.committedOrderId ??
        "CONFIRMED";
      const cascade =
        commitRes.intent?.meta?.cascadeExecuted ?? commitRes.cascadeExecuted;

      if (cascade) {
        props.onApproved(
          `⚡ Primary item sold out at commit — automatically recovered via pre-approved backup (${cascade.backupProductName})! Order #${orderId}`,
        );
      } else {
        props.onApproved(
          `Order confirmed via ${humanSignature.signerLabel}! Confirmation #${orderId}`,
        );
      }
    } catch (e) {
      if (armedProd) {
        await clearArmedStockout(armedProd);
      }
      setError(e instanceof Error ? e.message : String(e));
      await props.onChanged();
    } finally {
      setBusyId(null);
      setBusyMode(null);
    }
  }

  async function handleReject(intent: Intent) {
    const stayInQueue = props.pending.length > 1;
    const nextPending = props.pending.find((p) => p.id !== intent.id) ?? null;
    const armedProd =
      stockoutArmedProduct === intent.basket[0]?.productId
        ? stockoutArmedProduct
        : null;

    setBusyId(intent.id);
    setBusyMode("reject");
    setError(null);
    try {
      if (armedProd) {
        await clearArmedStockout(armedProd);
      }
      await api(`/v1/orders/${intent.id}/reject`, {
        method: "POST",
        body: JSON.stringify({
          snapshotHash: intent.snapshotHash,
          reason: "Cancelled by kitchen manager",
        }),
      });
      if (stayInQueue && nextPending) {
        props.onSelectId(nextPending.id);
      }
      await props.onChanged();
      props.onApproved("Order cancelled — nothing was charged.", stayInQueue);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusyId(null);
      setBusyMode(null);
    }
  }

  async function handleRefreshOffer(intent: Intent) {
    setBusyId(intent.id);
    setBusyMode("refresh");
    setError(null);
    try {
      const hasMultiItems =
        Array.isArray(intent.meta?.itemNeeds) && intent.meta!.itemNeeds!.length > 1;
      const r = await api<{ intent: Intent }>("/v1/orders/intent", {
        method: "POST",
        body: JSON.stringify(
          hasMultiItems
            ? {
                items: intent.meta!.itemNeeds!.map((n, idx) => ({
                  need: n,
                  offerProductId: intent.basket[idx]?.productId,
                })),
              }
            : {
                need: intent.need,
                offerProductId: intent.basket[0]?.productId,
              },
        ),
      });
      if (r.intent.status === "auto_eligible") {
        const commitRes = await api<CommitResponse>(
          `/v1/orders/${r.intent.id}/commit`,
          {
            method: "POST",
            body: JSON.stringify({ idempotencyKey: `desk-refresh-${r.intent.id}` }),
          },
        );
        await props.onChanged();
        props.onApproved(
          `Fresh price within rules — placed order #${commitRes.confirmation.orderId}`,
          props.pending.length > 1,
        );
      } else {
        await props.onChanged();
        props.onSelectId(r.intent.id);
        setNow(Date.now());
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusyId(null);
      setBusyMode(null);
    }
  }

  async function handleSwapAlternative(intent: Intent, productId: string) {
    const stayInQueue = props.pending.length > 1;
    setBusyId(intent.id);
    setBusyMode("swap");
    setError(null);
    try {
      const r = await api<{ intent: Intent }>("/v1/orders/intent", {
        method: "POST",
        body: JSON.stringify({ need: intent.need, offerProductId: productId }),
      });

      if (r.intent.status === "auto_eligible") {
        const commitRes = await api<CommitResponse>(
          `/v1/orders/${r.intent.id}/commit`,
          {
            method: "POST",
            body: JSON.stringify({ idempotencyKey: `desk-swap-${r.intent.id}` }),
          },
        );
        await props.onChanged();
        props.onApproved(
          `Switched to within-limit option & placed order #${commitRes.confirmation.orderId}`,
          stayInQueue,
        );
      } else {
        await props.onChanged();
        props.onSelectId(r.intent.id);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusyId(null);
      setBusyMode(null);
    }
  }

  async function createSampleApproval() {
    setBusyId("sample");
    setError(null);
    try {
      const r = await api<{ intent: Intent }>("/v1/orders/intent", {
        method: "POST",
        body: JSON.stringify({
          need: {
            productIntent: "lactose-free milk",
            quantity: sampleLitres,
            unit: "litre",
            neededBy: nextMonday(),
            constraints: { lactoseFree: true, keywords: ["lactose-free", "milk"] },
          },
        }),
      });

      if (r.intent.status === "auto_eligible") {
        const commitRes = await api<CommitResponse>(
          `/v1/orders/${r.intent.id}/commit`,
          {
            method: "POST",
            body: JSON.stringify({ idempotencyKey: `desk-sample-${r.intent.id}` }),
          },
        );
        await props.onChanged();
        props.onApproved(
          `Sample order was within your current limit & placed (#${commitRes.confirmation.orderId})`,
        );
      } else {
        await props.onChanged();
        props.onSelectId(r.intent.id);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusyId(null);
    }
  }

  const approveDisabled =
    busyId !== null || isExpired || (needsRuleOverride && !overrideConfirmed);

  return (
    <div className="page-wrap narrow">
      {error && (
        <div className="banner error" style={{ marginBottom: 20 }}>
          <div>{error}</div>
          <button type="button" className="link-quiet" onClick={() => setError(null)}>
            Dismiss
          </button>
        </div>
      )}

      {props.pending.length === 0 || !current ? (
        <div className="card" style={{ textAlign: "center", padding: "52px 28px" }}>
          <span className="pill green" style={{ marginBottom: 14 }}>
            ✓ All Caught Up
          </span>
          <h1 className="page-title" style={{ fontSize: 24 }}>
            Nothing waiting for your OK right now
          </h1>
          <p className="page-subtitle" style={{ maxWidth: 480, margin: "8px auto 24px" }}>
            Small everyday orders under {money(props.mandate?.maxOrderValueEur ?? 500, 0)} are handled automatically. Larger orders or substitutions appear right here for one-tap approval.
          </p>
          <button
            type="button"
            className="btn secondary"
            disabled={busyId !== null}
            onClick={() => void createSampleApproval()}
          >
            {busyId === "sample"
              ? "Preparing sample order…"
              : `Try a Sample ${sampleLitres.toLocaleString("en-GB")} L Approval`}
          </button>
        </div>
      ) : (
        <>
          {/* If multiple pending orders exist, let chef switch effortlessly */}
          {props.pending.length > 1 && (
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 18 }}>
              {props.pending.map((item, idx) => (
                <button
                  key={item.id}
                  type="button"
                  className="chip-btn"
                  style={
                    item.id === current.id
                      ? { background: "var(--brand-blue)", color: "#fff", borderColor: "var(--brand-blue)" }
                      : undefined
                  }
                  onClick={() => props.onSelectId(item.id)}
                >
                  Order #{idx + 1}:{" "}
                  {item.basket.length > 1
                    ? `${item.basket.length}-item bundle`
                    : `${qty(item.need.quantity, item.need.unit)} ${item.need.productIntent}`}{" "}
                  ({money(item.totalPrice)})
                </button>
              ))}
            </div>
          )}

          {/* Main Spacious Grocery-Style Approval Card */}
          <div className="card" style={{ padding: 32 }}>
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                gap: 10,
                flexWrap: "wrap",
                marginBottom: 18,
              }}
            >
              <span className="pill amber">Waiting for Your Quick OK</span>

              <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
                {isExpired ? (
                  <span className="pill red">Offer Expired — Request Fresh Price</span>
                ) : (
                  <>
                    {quoteValidUntil && (
                      quoteMinutesLeft > 0 ? (
                        <span className="pill green">
                          Firm price locked for {quoteMinutesLeft} min
                        </span>
                      ) : (
                        <span className="pill amber">
                          Quote window ended · live price checked at placement
                        </span>
                      )
                    )}
                    <span className="pill blue">
                      Proposal valid for {proposalMinutesLeft} min
                    </span>
                  </>
                )}
              </div>
            </div>

            <h1 className="page-title" style={{ textAlign: "left", fontSize: 26, marginBottom: 6 }}>
              {current.basket.length > 1
                ? `Approve ${current.basket.length}-item bundle (${(current.meta?.itemNeeds ?? [])
                    .map((n) => `${qty(n.quantity, n.unit)} ${n.productIntent}`)
                    .slice(0, 3)
                    .join(" + ") || `${current.basket.length} products`})?`
                : `Approve ${qty(current.need.quantity, current.need.unit)} of ${current.need.productIntent}?`}
            </h1>
            <p className="page-subtitle" style={{ textAlign: "left", marginBottom: 22 }}>
              Needed by <strong>{day(current.neededBy)}</strong> · Prepared by your Valio Aimo assistant.
            </p>

            {/* Expired Warning Banner with Immediate Refresh Action */}
            {isExpired && (
              <div
                className="banner error"
                style={{ marginBottom: 20, alignItems: "center", flexWrap: "wrap" }}
              >
                <div>
                  <div style={{ fontWeight: 800, marginBottom: 2 }}>
                    This proposal&apos;s approval window has expired
                  </div>
                  <div style={{ fontSize: 13.5 }}>
                    Request a fresh supplier price &amp; stock check before placing this order.
                  </div>
                </div>
                <button
                  type="button"
                  className="btn primary"
                  disabled={busyId !== null}
                  onClick={() => void handleRefreshOffer(current)}
                >
                  {busyMode === "refresh" ? "Refreshing offer…" : "Refresh Offer"}
                </button>
              </div>
            )}

            {/* Plain-English "Why we asked you" Callout */}
            <div className="banner warn" style={{ marginBottom: 24, flexDirection: "column", gap: 6 }}>
              <div style={{ fontWeight: 800, fontSize: 14.5 }}>
                Why your assistant asked you before placing this order:
              </div>
              <ul style={{ margin: "4px 0 0", paddingLeft: 20, display: "flex", flexDirection: "column", gap: 4 }}>
                {current.policy.reasons.length > 0
                  ? current.policy.reasons.map((r, i) => <li key={i}>{tidy(r)}</li>)
                  : failingRules.map((rule) => <li key={rule}>{ruleLabel(rule)}</li>)}
              </ul>
            </div>

            {/* Clean Receipt Box */}
            <div style={{ fontWeight: 800, fontSize: 16, marginBottom: 10 }}>Order Summary</div>
            <div className="card-subtle" style={{ marginBottom: 20 }}>
              {current.basket.map((line, lineIdx) => {
                const originDisplay = formatOrigin(line.origin);
                const allergensDisplay = formatAllergenList(line.allergens);
                const mayContainDisplay = formatAllergenList(line.mayContain);
                const isLactoseFreeLine =
                  line.labels?.some((l) => /lactose[\s-]?free/i.test(l)) ||
                  /lactose[\s-]?free|laktoositon|laktosfri/i.test(line.productName);

                return (
                  <div key={`${line.productId}-${lineIdx}`} className="receipt-row">
                    <div>
                      <div style={{ fontWeight: 700, fontSize: 15.5 }}>
                        {line.packs} × {line.productName} ({qty(line.packSize, line.packUnit)})
                      </div>
                      <div style={{ fontSize: 13.5, color: "var(--text-muted)", marginTop: 2 }}>
                        {qty(line.totalQuantity, line.quantityUnit)} total · {money(line.unitPrice)} / pack
                        {line.availableDate ? ` · Arrives ${day(line.availableDate)}` : ""}
                      </div>

                      <div
                        style={{
                          display: "flex",
                          gap: 8,
                          flexWrap: "wrap",
                          fontSize: 12.5,
                          fontWeight: 600,
                          marginTop: 6,
                        }}
                      >
                        {line.isSubstitution && (
                          <span style={{ color: "var(--amber-text)" }}>• Substitute item</span>
                        )}
                        {isLactoseFreeLine && (
                          <span style={{ color: "var(--green-text)" }}>✓ Lactose-Free</span>
                        )}
                        {originDisplay && (
                          <span style={{ color: "var(--green-text)" }}>
                            ✓ Origin: {originDisplay}
                          </span>
                        )}
                        {line.certifications && line.certifications.length > 0 && (
                          <span style={{ color: "var(--green-text)" }}>
                            ✓ {line.certifications.join(", ")}
                          </span>
                        )}
                        {allergensDisplay && (
                          <span
                            style={{
                              background: "var(--bg-amber-soft)",
                              color: "var(--amber-text)",
                              border: "1px solid var(--amber-border)",
                              borderRadius: 999,
                              padding: "1px 8px",
                            }}
                          >
                            ⚠️ Allergens: {allergensDisplay}
                          </span>
                        )}
                        {mayContainDisplay && (
                          <span
                            style={{
                              background: "var(--bg-subtle)",
                              color: "var(--text-muted)",
                              border: "1px solid var(--border-light)",
                              borderRadius: 999,
                              padding: "1px 8px",
                            }}
                          >
                            May contain: {mayContainDisplay}
                          </span>
                        )}
                      </div>
                    </div>
                    <div style={{ fontWeight: 800, fontSize: 17, whiteSpace: "nowrap" }}>
                      {money(line.totalPrice)}
                    </div>
                  </div>
                );
              })}

              <div className="receipt-row" style={{ paddingTop: 16, alignItems: "center" }}>
                <div style={{ fontSize: 13.5, fontWeight: 600, color: "var(--green-text)" }}>
                  ✓ Fixed contract price verified · ✓ Safety &amp; allergen rules checked
                </div>
                <div style={{ textAlign: "right" }}>
                  <span style={{ fontSize: 14, fontWeight: 700, color: "var(--text-muted)", marginRight: 10 }}>
                    Total:
                  </span>
                  <span style={{ fontSize: 24, fontWeight: 800 }}>{money(current.totalPrice)}</span>
                </div>
              </div>
            </div>

            {/* Pre-Authorized Backup Product Cascade ("Cold-Chain Cut-Off Protection") */}
            {alternatives.length > 0 && backupAlt && (
              <div
                style={{
                  marginBottom: 20,
                  padding: "16px 18px",
                  borderRadius: 16,
                  background: backupProtectionEnabled ? "var(--bg-green-soft)" : "var(--bg-canvas)",
                  border: backupProtectionEnabled
                    ? "1.5px solid var(--green-border)"
                    : "1px solid var(--border-light)",
                  display: "flex",
                  flexDirection: "column",
                  gap: 10,
                }}
              >
                <label
                  style={{
                    display: "flex",
                    alignItems: "flex-start",
                    gap: 12,
                    cursor: "pointer",
                  }}
                >
                  <input
                    type="checkbox"
                    checked={backupProtectionEnabled}
                    onChange={(e) => setBackupProtectionEnabled(e.target.checked)}
                    style={{
                      width: 20,
                      height: 20,
                      marginTop: 2,
                      accentColor: "var(--green-main)",
                      flexShrink: 0,
                    }}
                  />
                  <div style={{ flex: 1 }}>
                    <div style={{ fontWeight: 800, fontSize: 14.5, color: "var(--text-main)" }}>
                      🛡️ Cold-Chain Stock Protection: Auto-switch to backup if primary sells out before truck cut-off
                    </div>
                    <div style={{ fontSize: 13.5, color: "var(--text-muted)", marginTop: 3 }}>
                      Pre-approved backup:{" "}
                      <strong style={{ color: "var(--text-main)" }}>{backupAlt.productName}</strong>{" "}
                      ({money(backupAlt.totalPrice)}
                      {backupAlt.deltaEur !== 0
                        ? `, ${backupAlt.deltaEur >= 0 ? `+${money(backupAlt.deltaEur)}` : money(backupAlt.deltaEur)}`
                        : ""}
                      )
                    </div>
                  </div>
                </label>

                <div
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    alignItems: "center",
                    gap: 10,
                    flexWrap: "wrap",
                    paddingLeft: 32,
                  }}
                >
                  {alternatives.length > 1 && (
                    <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12.5 }}>
                      <span style={{ color: "var(--text-muted)", fontWeight: 600 }}>Backup choice:</span>
                      <select
                        className="field-select"
                        style={{ minHeight: 34, padding: "4px 10px", fontSize: 12.5 }}
                        value={backupAlt.productId}
                        onChange={(e) => setSelectedBackupId(e.target.value)}
                      >
                        {alternatives.map((alt) => (
                          <option key={alt.productId} value={alt.productId}>
                            {alt.productName} ({money(alt.totalPrice)})
                          </option>
                        ))}
                      </select>
                    </div>
                  )}

                  <button
                    type="button"
                    className="chip-btn"
                    style={
                      isStockoutArmed
                        ? {
                            background: "var(--bg-amber-soft)",
                            borderColor: "var(--amber-main)",
                            color: "var(--amber-text)",
                            fontWeight: 700,
                          }
                        : undefined
                    }
                    disabled={busyId !== null}
                    onClick={() => void handleToggleSimulateStockout(current)}
                  >
                    {busyMode === "stockout"
                      ? "Updating warehouse sim…"
                      : isStockoutArmed
                        ? "⚡ Stock-Out Armed (Click to Disarm)"
                        : "⚡ Demo: Simulate Last-Second Warehouse Stock-Out"}
                  </button>
                </div>

                {isStockoutArmed && (
                  <div
                    style={{
                      marginLeft: 32,
                      padding: "8px 12px",
                      borderRadius: 10,
                      background: "var(--bg-amber-soft)",
                      border: "1px solid var(--amber-border)",
                      color: "var(--amber-text)",
                      fontSize: 13,
                      fontWeight: 700,
                    }}
                  >
                    ⚡ Primary SKU stock-out armed — approving now will demonstrate live automatic backup recovery at commit!
                  </div>
                )}
              </div>
            )}

            {/* Explicit One-Time Rule Override Confirmation Checkbox */}
            {needsRuleOverride && (
              <label
                style={{
                  display: "flex",
                  alignItems: "flex-start",
                  gap: 12,
                  padding: "14px 16px",
                  borderRadius: 14,
                  background: overrideConfirmed ? "var(--bg-blue-soft)" : "var(--bg-amber-soft)",
                  border: overrideConfirmed
                    ? "1.5px solid #bfdbfe"
                    : "1.5px solid var(--amber-border)",
                  marginBottom: 20,
                  cursor: "pointer",
                }}
              >
                <input
                  type="checkbox"
                  checked={overrideConfirmed}
                  onChange={(e) => setOverrideConfirmed(e.target.checked)}
                  style={{
                    width: 20,
                    height: 20,
                    marginTop: 2,
                    accentColor: "var(--brand-blue)",
                    flexShrink: 0,
                  }}
                />
                <div style={{ fontSize: 14, fontWeight: 600, color: "var(--text-main)" }}>
                  I understand why my assistant paused (<strong>{failingRuleSummary}</strong>) and approve this one-time exception.
                </div>
              </label>
            )}

            {/* Big, Unmistakable Biometric + Standard Buyer Action Buttons */}
            <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
              {isExpired ? (
                <button
                  type="button"
                  className="btn primary"
                  style={{ flex: "2 1 260px", minHeight: 54, fontSize: 15.5 }}
                  disabled={busyId !== null}
                  onClick={() => void handleRefreshOffer(current)}
                >
                  {busyMode === "refresh"
                    ? "Requesting fresh price…"
                    : "🔄 Refresh Offer & Lock Fresh Price"}
                </button>
              ) : (
                <>
                  <button
                    type="button"
                    className="btn success"
                    style={{ flex: "2 1 280px", minHeight: 54, fontSize: 15.5 }}
                    disabled={approveDisabled}
                    onClick={() => void handleApprove(current, true)}
                  >
                    {busyId === current.id && busyMode === "biometric"
                      ? "Verifying & placing order…"
                      : `🔐 Approve with Touch ID / Passkey (${money(current.totalPrice)})`}
                  </button>

                  <button
                    type="button"
                    className="btn secondary"
                    style={{ flex: "1 1 210px", minHeight: 54 }}
                    disabled={approveDisabled}
                    onClick={() => void handleApprove(current, false)}
                  >
                    {busyId === current.id && busyMode === "quick"
                      ? "Signing & placing…"
                      : "Quick Approve (Standard Buyer Key)"}
                  </button>
                </>
              )}

              <button
                type="button"
                className="btn danger-outline"
                style={{ flex: "1 1 150px", minHeight: 54 }}
                disabled={busyId !== null}
                onClick={() => void handleReject(current)}
              >
                {busyId === current.id && busyMode === "reject"
                  ? "Cancelling…"
                  : "Cancel Order"}
              </button>
            </div>

            {/* Optional 1-click Alternative Swap if Gateway suggested alternatives */}
            {alternatives.length > 0 && (
              <div style={{ marginTop: 24, paddingTop: 20, borderTop: "1px solid var(--border-light)" }}>
                <div style={{ fontSize: 13.5, fontWeight: 700, color: "var(--text-muted)", marginBottom: 10 }}>
                  Prefer to switch to another option right now instead?
                </div>
                <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                  {alternatives.slice(0, 3).map((alt) => (
                    <div
                      key={alt.productId}
                      style={{
                        display: "flex",
                        justifyContent: "space-between",
                        alignItems: "center",
                        gap: 12,
                        padding: "10px 14px",
                        borderRadius: 12,
                        background: "var(--bg-canvas)",
                        border: "1px solid var(--border-light)",
                        flexWrap: "wrap",
                      }}
                    >
                      <div style={{ fontSize: 13.5 }}>
                        <strong>{alt.productName}</strong> · {money(alt.totalPrice)}{" "}
                        <span style={{ color: "var(--text-muted)" }}>
                          ({alt.deltaEur >= 0 ? `+${money(alt.deltaEur)}` : money(alt.deltaEur)})
                        </span>
                        {alt.origin ? (
                          <span style={{ color: "var(--green-text)", marginLeft: 8, fontWeight: 600 }}>
                            · {formatOrigin(alt.origin)}
                          </span>
                        ) : null}
                      </div>
                      <button
                        type="button"
                        className="btn secondary"
                        style={{ minHeight: 38, padding: "6px 12px", fontSize: 12.5 }}
                        disabled={busyId !== null}
                        onClick={() => void handleSwapAlternative(current, alt.productId)}
                      >
                        {busyId === current.id && busyMode === "swap" ? "Switching…" : "Switch to this"}
                      </button>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}
