import { useCallback, useEffect, useState } from "react";
import { api } from "./api";
import { day, money, qty } from "./format";

export interface TradeReceiptArbitratorProps {
  orderId: string | null;
  intentId: string;
  defaultExpanded?: boolean;
  variant?: "embedded" | "standalone";
}

export type DisputePreset =
  | "price_hike_012"
  | "late_delivery"
  | "rogue_agent_chargeback"
  | "allergen_breach"
  | "tampered_receipt"
  | "clean_3way_match";

export type BuyerDisputeClaim =
  | "none"
  | "rogue_agent_hallucination"
  | "price_overcharge"
  | "late_delivery"
  | "allergen_breach";

export interface BuyerReceiptPayload {
  customerId: string;
  intentId: string;
  mandateId: string;
  mandateHash: string;
  quoteId: string | null;
  snapshotHash: string;
  authorizedMaxTotalEur: number;
  authorityMode:
    | "agent_autonomous"
    | "human_override_p256"
    | "human_override_webauthn"
    | "external_agent_signed";
  actingAgentId: string | null;
  signedAt: string;
}

export interface HumanOverrideBinding {
  mode: string;
  credentialId: string;
  signerLabel: string;
  signaturePrefix: string;
  verifiedAt: string;
  acknowledgedRules: string[];
  publicKeySpki?: string;
  signedChallenge?: string;
  signature?: string;
}

export interface BuyerSignatureEnvelope {
  payload: BuyerReceiptPayload;
  algorithm: "Ed25519" | "ECDSA-P256";
  keyId: string;
  publicKeyPem: string;
  signature: string;
  humanOverride?: HumanOverrideBinding;
}

export interface ReceiptHonouredLine {
  productId: string;
  productName: string;
  packs: number;
  packSize: number;
  packUnit: string;
  totalQuantity: number;
  quantityUnit: string;
  unitPriceEur: number;
  comparisonPricePerUnit: number | null;
  comparisonUnit: string | null;
  lineTotalEur: number;
}

export interface SupplierReceiptPayload {
  orderId: string;
  intentId: string;
  customerId: string;
  quoteId: string | null;
  quoteFirmUntil: string | null;
  honouredPrice: {
    currency: string;
    totalEur: number;
    priceBasis: "firm_quote" | "live_committed" | "fallback_cascade";
    lines: ReceiptHonouredLine[];
  };
  allergenClaim: {
    excludedAllergens: string[];
    lactoseFreeGuaranteed: boolean;
    lineAttestations: Array<{
      productId: string;
      productName: string;
      allergens: string[];
      mayContain: string[];
      lactoseFree: boolean;
      origin: string | null;
      certifications: string[];
    }>;
  };
  deliveryCommitment: {
    promisedDate: string;
    latestAcceptableDate: string;
    partialFulfilmentAllowed: boolean;
    cascadeApplied: boolean;
  };
  buyerSignatureHash: string;
  committedAt: string;
}

export interface SupplierSignatureEnvelope {
  payload: SupplierReceiptPayload;
  algorithm: "Ed25519";
  issuer: string;
  keyId: string;
  publicKeyPem: string;
  signature: string;
}

export interface TradeReceipt {
  format: "application/vnd.valio.trade-receipt+json";
  specVersion: "1.0";
  receiptId: string;
  fileName: string;
  orderId: string;
  intentId: string;
  runId: string;
  customerId: string;
  issuedAt: string;
  receiptHash: string;
  buyer: BuyerSignatureEnvelope;
  supplier: SupplierSignatureEnvelope;
  auditAnchor: {
    runId: string;
    headHash: string | null;
  };
}

export interface SimulatedInvoiceLine {
  productId: string;
  productName?: string;
  billedPacks?: number;
  deliveredPacks?: number;
  billedQuantity?: number;
  deliveredQuantity?: number;
  billedUnitPriceEur?: number;
  billedPricePerQtyUnitEur?: number;
  billedLineTotalEur: number;
  deliveredAllergens?: string[];
  deliveredLactoseFree?: boolean;
}

export interface SimulatedInvoiceDocument {
  documentId: string;
  documentType: "e_invoice" | "delivery_note" | "combined_3way";
  deliveredAt?: string;
  buyerDisputeClaim: BuyerDisputeClaim;
  buyerDisputeNote?: string;
  billedTotalEur: number;
  currency: string;
  lines: SimulatedInvoiceLine[];
}

export interface DisputeBreachItem {
  code: string;
  party: "supplier" | "buyer" | "tamper";
  clause: string;
  expected: string;
  actual: string;
  creditImpactEur: number;
}

export interface DisputeRuling {
  rulingId: string;
  evaluatedAt: string;
  latencyMs: number;
  ruling: "SUPPLIER_BREACH" | "BUYER_LIABLE" | "TAMPER_REJECTED";
  subVerdict:
    | "AUTO_CREDIT_ISSUED"
    | "CHARGEBACK_DENIED_BUYER_LIABLE"
    | "CLEAN_3WAY_SETTLEMENT"
    | "CRYPTO_SIGNATURE_INVALID";
  headline: string;
  summary: string;
  cryptographicProof: {
    receiptHashValid: boolean;
    buyerSignatureValid: boolean;
    supplierSignatureValid: boolean;
    bilateralBindingValid: boolean;
    humanOverrideVerified: boolean;
    mandateHash: string;
    quoteId: string | null;
    snapshotHash: string;
    orderId: string;
    reason?: string;
  };
  reconciliation: {
    contractedTotalEur: number;
    billedTotalEur: number;
    autoCreditEur: number;
    netPayableEur: number;
    currency: string;
  };
  breaches: DisputeBreachItem[];
  simulatedDocument: SimulatedInvoiceDocument;
}

type PresetSpec = {
  id: DisputePreset;
  label: string;
  hint: string;
};

const ARBITRATOR_PRESETS: PresetSpec[] = [
  {
    id: "price_hike_012",
    label: "💸 +€0.12/unit Price Hike",
    hint: "Inflated e-invoice above committed quote → SUPPLIER_BREACH auto-credit",
  },
  {
    id: "late_delivery",
    label: "🚚 Late Arrival (+2d)",
    hint: "Cold-chain SLA miss past latestAcceptableDate → 15% SLA auto-credit",
  },
  {
    id: "rogue_agent_chargeback",
    label: '🤖 "Rogue Agent Hallucinated!" Chargeback',
    hint: "CFO denies agent authority → BUYER_LIABLE via signed mandate + intent",
  },
  {
    id: "allergen_breach",
    label: "🥛 Allergen / Lactose Lot Breach",
    hint: "Wrong lot on delivery note → 100% line rejection auto-credit",
  },
  {
    id: "tampered_receipt",
    label: "🔓 Forged .vtr.json Tamper",
    hint: "Mutates receipt honouredPrice post-signing → TAMPER_REJECTED",
  },
  {
    id: "clean_3way_match",
    label: "✅ Clean 3-Way AP Match",
    hint: "Routine 3-way match across PO, delivery note & e-invoice → auto-settled",
  },
];

function canonSort(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonSort);
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, v]) => v !== undefined)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([k, v]) => [k, canonSort(v)]),
    );
  }
  return value;
}

function canonicalPrettyJson(value: unknown): string {
  return JSON.stringify(canonSort(value), null, 2);
}

function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

function round4(n: number): number {
  return Math.round((n + Number.EPSILON) * 10000) / 10000;
}

function shortHex(hash: string | null | undefined, head = 12, tail = 8): string {
  if (!hash) return "—";
  if (hash.length <= head + tail + 3) return hash;
  return `${hash.slice(0, head)}…${hash.slice(-tail)}`;
}

function pemFingerprint(pem: string | null | undefined): string {
  if (!pem) return "—";
  const body = pem
    .replace(/-----BEGIN [^-]+-----/g, "")
    .replace(/-----END [^-]+-----/g, "")
    .replace(/\s+/g, "");
  if (!body) return "—";
  if (body.length <= 24) return body;
  return `spki:${body.slice(0, 12)}…${body.slice(-10)}`;
}

function extractReceiptResponse(raw: unknown): TradeReceipt {
  if (raw && typeof raw === "object") {
    const obj = raw as Record<string, unknown>;
    if (obj.receipt && typeof obj.receipt === "object") {
      return obj.receipt as TradeReceipt;
    }
    if (typeof obj.receiptId === "string" && obj.buyer && obj.supplier) {
      return raw as TradeReceipt;
    }
  }
  throw new Error("Unexpected trade receipt payload returned by gateway.");
}

function extractArbitrateResponse(raw: unknown): {
  ruling: DisputeRuling;
  receipt?: TradeReceipt;
} {
  if (raw && typeof raw === "object") {
    const obj = raw as Record<string, unknown>;
    // Wrapped `{ ruling: DisputeRuling, receipt?: TradeReceipt }` vs direct `DisputeRuling` (where `obj.ruling` is a string enum)
    if (obj.ruling && typeof obj.ruling === "object") {
      return {
        ruling: obj.ruling as DisputeRuling,
        receipt:
          obj.receipt && typeof obj.receipt === "object"
            ? (obj.receipt as TradeReceipt)
            : undefined,
      };
    }
    if (typeof obj.rulingId === "string" && typeof obj.ruling === "string") {
      return { ruling: raw as DisputeRuling };
    }
  }
  throw new Error("Unexpected arbitration ruling payload returned by gateway.");
}

function buildCustomSimulationDocument(
  receipt: TradeReceipt | null,
  billedTotalEur: number,
  deliveredAt: string,
  buyerDisputeClaim: BuyerDisputeClaim,
): SimulatedInvoiceDocument {
  const cleanTotal = round2(Math.max(0, billedTotalEur));
  const tag = (receipt?.orderId || "ORD").replace(/^#/, "");

  if (!receipt) {
    return {
      documentId: `INV-${tag}-CUSTOM`,
      documentType: "combined_3way",
      ...(deliveredAt ? { deliveredAt } : {}),
      buyerDisputeClaim,
      buyerDisputeNote:
        buyerDisputeClaim !== "none"
          ? `Custom override simulation (${buyerDisputeClaim}) at €${cleanTotal.toFixed(2)}`
          : `Custom e-invoice override at €${cleanTotal.toFixed(2)}`,
      billedTotalEur: cleanTotal,
      currency: "EUR",
      lines: [],
    };
  }

  const sup = receipt.supplier.payload;
  const contractedTotal = sup.honouredPrice.totalEur;
  const ratio = contractedTotal > 0 ? cleanTotal / contractedTotal : 1;
  const attByProduct = new Map(
    sup.allergenClaim.lineAttestations.map((a) => [a.productId, a]),
  );

  let runningSum = 0;
  const sourceLines = sup.honouredPrice.lines;
  const lines: SimulatedInvoiceLine[] = sourceLines.map((line, idx) => {
    const att = attByProduct.get(line.productId);
    const isLast = idx === sourceLines.length - 1;
    const scaledLineTotal = isLast
      ? round2(Math.max(0, cleanTotal - runningSum))
      : round2(line.lineTotalEur * ratio);
    runningSum = round2(runningSum + scaledLineTotal);

    const billedUnitPriceEur =
      line.packs > 0 ? round4(scaledLineTotal / line.packs) : line.unitPriceEur;
    const billedPricePerQtyUnitEur =
      line.totalQuantity > 0
        ? round4(scaledLineTotal / line.totalQuantity)
        : line.comparisonPricePerUnit ?? line.unitPriceEur;

    const simulateAllergenFailure = buyerDisputeClaim === "allergen_breach";

    return {
      productId: line.productId,
      productName: line.productName,
      billedPacks: line.packs,
      deliveredPacks: line.packs,
      billedQuantity: line.totalQuantity,
      deliveredQuantity: line.totalQuantity,
      billedUnitPriceEur,
      billedPricePerQtyUnitEur,
      billedLineTotalEur: scaledLineTotal,
      deliveredAllergens: simulateAllergenFailure
        ? ["milk", "nuts", "gluten"]
        : att
          ? [...att.allergens]
          : [],
      deliveredLactoseFree: simulateAllergenFailure
        ? false
        : att
          ? att.lactoseFree
          : sup.allergenClaim.lactoseFreeGuaranteed,
    };
  });

  return {
    documentId: `INV-${tag}-CUSTOM`,
    documentType: "combined_3way",
    deliveredAt: deliveredAt || sup.deliveryCommitment.promisedDate,
    buyerDisputeClaim,
    buyerDisputeNote:
      buyerDisputeClaim === "rogue_agent_hallucination"
        ? "Buyer CFO claims autonomous agent hallucinated or exceeded authority."
        : buyerDisputeClaim === "allergen_breach"
          ? "Custom receiving dock override: allergen / lactose lot mismatch reported."
          : buyerDisputeClaim === "late_delivery"
            ? `Custom delivery override recorded on ${deliveredAt || sup.deliveryCommitment.promisedDate}.`
            : `Custom e-invoice override submitted for €${cleanTotal.toFixed(2)}.`,
    billedTotalEur: cleanTotal,
    currency: sup.honouredPrice.currency || "EUR",
    lines,
  };
}

export function TradeReceiptArbitratorCard(props: TradeReceiptArbitratorProps) {
  const {
    orderId,
    intentId,
    defaultExpanded = false,
    variant = "embedded",
  } = props;

  const autoOpen = Boolean(defaultExpanded || variant === "standalone");

  const [receipt, setReceipt] = useState<TradeReceipt | null>(null);
  const [loadingReceipt, setLoadingReceipt] = useState(false);
  const [showArbitrator, setShowArbitrator] = useState<boolean>(autoOpen);
  const [showDualSigs, setShowDualSigs] = useState<boolean>(variant === "standalone");
  const [showRawJson, setShowRawJson] = useState(false);
  const [showCustomOverride, setShowCustomOverride] = useState(false);

  const [copiedState, setCopiedState] = useState<"idle" | "copied">("idle");
  const [downloadedState, setDownloadedState] = useState<"idle" | "done">("idle");

  const [arbitrating, setArbitrating] = useState(false);
  const [activeSelection, setActiveSelection] = useState<DisputePreset | "custom" | null>(null);
  const [ruling, setRuling] = useState<DisputeRuling | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const [customBilledTotal, setCustomBilledTotal] = useState<string>("");
  const [customDeliveredAt, setCustomDeliveredAt] = useState<string>("");
  const [customDisputeClaim, setCustomDisputeClaim] =
    useState<BuyerDisputeClaim>("price_overcharge");

  const hydrateDefaultsFromReceipt = useCallback((loaded: TradeReceipt) => {
    setCustomBilledTotal((prev) =>
      prev
        ? prev
        : round2(loaded.supplier.payload.honouredPrice.totalEur + 36).toFixed(2),
    );
    setCustomDeliveredAt((prev) =>
      prev ? prev : loaded.supplier.payload.deliveryCommitment.promisedDate.slice(0, 10),
    );
  }, []);

  const ensureReceipt = useCallback(async (): Promise<TradeReceipt> => {
    if (receipt && receipt.intentId === intentId) {
      return receipt;
    }
    setLoadingReceipt(true);
    try {
      const raw = await api<unknown>(
        `/v1/orders/${encodeURIComponent(intentId)}/receipt`,
      );
      const parsed = extractReceiptResponse(raw);
      setReceipt(parsed);
      hydrateDefaultsFromReceipt(parsed);
      return parsed;
    } finally {
      setLoadingReceipt(false);
    }
  }, [receipt, intentId, hydrateDefaultsFromReceipt]);

  // Reset per-order state when intentId changes, and prefetch if expanded or standalone
  useEffect(() => {
    setReceipt(null);
    setRuling(null);
    setActiveSelection(null);
    setErrorMsg(null);
    setCustomBilledTotal("");
    setCustomDeliveredAt("");
    setCustomDisputeClaim("price_overcharge");
    setShowRawJson(false);

    if (defaultExpanded || variant === "standalone") {
      setShowArbitrator(true);
      let cancelled = false;
      setLoadingReceipt(true);
      api<unknown>(`/v1/orders/${encodeURIComponent(intentId)}/receipt`)
        .then((raw) => {
          if (cancelled) return;
          const parsed = extractReceiptResponse(raw);
          setReceipt(parsed);
          hydrateDefaultsFromReceipt(parsed);
        })
        .catch((err) => {
          if (cancelled) return;
          setErrorMsg(err instanceof Error ? err.message : String(err));
        })
        .finally(() => {
          if (!cancelled) setLoadingReceipt(false);
        });
      return () => {
        cancelled = true;
      };
    }
    return undefined;
  }, [intentId, defaultExpanded, variant, hydrateDefaultsFromReceipt]);

  const downloadFileName = `${(orderId || receipt?.orderId || intentId)
    .toLowerCase()
    .replace(/\.vtr\.json$/i, "")}.vtr.json`;

  async function handleDownloadVtr() {
    setErrorMsg(null);
    try {
      const loaded = await ensureReceipt();
      const canonicalText = canonicalPrettyJson(loaded);
      const blob = new Blob([canonicalText], {
        type: "application/vnd.valio.trade-receipt+json;charset=utf-8",
      });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `${(orderId || loaded.orderId || intentId)
        .toLowerCase()
        .replace(/\.vtr\.json$/i, "")}.vtr.json`;
      document.body.appendChild(anchor);
      anchor.click();
      document.body.removeChild(anchor);
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
      setDownloadedState("done");
      window.setTimeout(() => setDownloadedState("idle"), 2000);
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : String(err));
    }
  }

  async function handleCopyVtr() {
    setErrorMsg(null);
    try {
      const loaded = await ensureReceipt();
      const canonicalText = canonicalPrettyJson(loaded);
      await navigator.clipboard.writeText(canonicalText);
      setCopiedState("copied");
      window.setTimeout(() => setCopiedState("idle"), 2000);
    } catch (err) {
      setErrorMsg(
        err instanceof Error ? err.message : "Clipboard copy unavailable in this browser.",
      );
    }
  }

  async function handleToggleDualSigs() {
    const next = !showDualSigs;
    setShowDualSigs(next);
    if (next && !receipt) {
      setErrorMsg(null);
      try {
        await ensureReceipt();
      } catch (err) {
        setErrorMsg(err instanceof Error ? err.message : String(err));
      }
    }
  }

  async function handleToggleArbitrator() {
    const next = !showArbitrator;
    setShowArbitrator(next);
    if (next && !receipt) {
      setErrorMsg(null);
      try {
        await ensureReceipt();
      } catch (err) {
        setErrorMsg(err instanceof Error ? err.message : String(err));
      }
    }
  }

  async function handleRunPreset(preset: DisputePreset) {
    setShowArbitrator(true);
    setArbitrating(true);
    setActiveSelection(preset);
    setErrorMsg(null);

    try {
      const [arbRaw, maybeReceipt] = await Promise.all([
        api<unknown>(`/v1/orders/${encodeURIComponent(intentId)}/arbitrate`, {
          method: "POST",
          body: JSON.stringify({ preset }),
        }),
        receipt
          ? Promise.resolve(receipt)
          : api<unknown>(`/v1/orders/${encodeURIComponent(intentId)}/receipt`)
              .then(extractReceiptResponse)
              .catch(() => null),
      ]);

      const extracted = extractArbitrateResponse(arbRaw);
      setRuling(extracted.ruling);
      const resolvedReceipt = extracted.receipt ?? maybeReceipt;
      if (resolvedReceipt) {
        setReceipt(resolvedReceipt);
        hydrateDefaultsFromReceipt(resolvedReceipt);
      }
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : String(err));
    } finally {
      setArbitrating(false);
    }
  }

  async function handleRunCustomArbitration() {
    setShowArbitrator(true);
    setArbitrating(true);
    setActiveSelection("custom");
    setErrorMsg(null);

    try {
      let currentReceipt = receipt;
      if (!currentReceipt) {
        try {
          currentReceipt = await ensureReceipt();
        } catch {
          currentReceipt = null;
        }
      }

      const fallbackTotal = currentReceipt
        ? currentReceipt.supplier.payload.honouredPrice.totalEur
        : 0;
      const parsedBilled = Number(customBilledTotal);
      const billedTotalEur =
        customBilledTotal.trim() !== "" && Number.isFinite(parsedBilled) && parsedBilled >= 0
          ? round2(parsedBilled)
          : round2(fallbackTotal);

      const deliveredAt =
        customDeliveredAt.trim() ||
        currentReceipt?.supplier.payload.deliveryCommitment.promisedDate ||
        undefined;

      const document = buildCustomSimulationDocument(
        currentReceipt,
        billedTotalEur,
        deliveredAt ?? "",
        customDisputeClaim,
      );

      const arbRaw = await api<unknown>(
        `/v1/orders/${encodeURIComponent(intentId)}/arbitrate`,
        {
          method: "POST",
          body: JSON.stringify({
            billedTotalEur,
            ...(deliveredAt ? { deliveredAt } : {}),
            buyerDisputeClaim: customDisputeClaim,
            document,
          }),
        },
      );

      const extracted = extractArbitrateResponse(arbRaw);
      setRuling(extracted.ruling);
      if (extracted.receipt) {
        setReceipt(extracted.receipt);
        hydrateDefaultsFromReceipt(extracted.receipt);
      }
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : String(err));
    } finally {
      setArbitrating(false);
    }
  }

  const isCleanLiability = ruling?.ruling === "BUYER_LIABLE";
  const rulingCertClass = isCleanLiability ? "cert-box safe" : "cert-box poison";

  return (
    <div
      className={variant === "standalone" ? "card" : "card-subtle"}
      style={{
        padding: variant === "standalone" ? "20px 22px" : "16px 18px",
        borderRadius: variant === "standalone" ? 18 : 14,
        border:
          variant === "standalone"
            ? "1.5px solid var(--border-strong)"
            : "1.5px solid #cbd5e1",
        background: variant === "standalone" ? "var(--bg-card)" : "#f8fafc",
        color: "var(--text-main)",
        display: "flex",
        flexDirection: "column",
        gap: 14,
      }}
    >
      {/* 1. Header & Portable .vtr.json Export Strip */}
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          gap: 10,
        }}
      >
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            flexWrap: "wrap",
            gap: 8,
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
            <span style={{ fontWeight: 800, fontSize: 14.5, color: "var(--brand-navy)" }}>
              📜 Bilateral Liability Receipt &amp; 3-Way AP Arbitrator
            </span>
            <span className="pill gray mono" style={{ fontSize: 11.5, padding: "3px 9px" }}>
              {receipt?.receiptId ?? downloadFileName}
            </span>
          </div>
          {receipt && (
            <span
              className="mono"
              style={{ fontSize: 11.5, color: "var(--text-soft)" }}
              title={`SHA-256 receiptHash: ${receipt.receiptHash}`}
            >
              SHA-256 {shortHex(receipt.receiptHash, 10, 8)}
            </span>
          )}
        </div>

        {/* Bilateral Non-Repudiation Status Pills */}
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
          <span
            className="pill blue"
            style={{ fontSize: 12, whiteSpace: "normal", lineHeight: 1.35 }}
          >
            🔏 Buyer Signed (mandateHash + quoteId + snapshotHash)
          </span>
          <span
            className="pill green"
            style={{ fontSize: 12, whiteSpace: "normal", lineHeight: 1.35 }}
          >
            ✓ Valio Ed25519 Counter-Signed (orderId + honouredPrice + allergen + SLA)
          </span>
        </div>

        {/* Portable Export & Inspector Action Strip */}
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
          <button
            type="button"
            className="btn secondary"
            style={{ minHeight: 38, padding: "7px 13px", fontSize: 13 }}
            disabled={loadingReceipt}
            onClick={() => void handleDownloadVtr()}
          >
            {downloadedState === "done"
              ? `✓ Saved ${downloadFileName}`
              : "⬇ Download .vtr.json"}
          </button>

          <button
            type="button"
            className="btn secondary"
            style={{ minHeight: 38, padding: "7px 13px", fontSize: 13 }}
            disabled={loadingReceipt}
            onClick={() => void handleCopyVtr()}
          >
            {copiedState === "copied" ? "✓ Copied" : "Copy .vtr.json"}
          </button>

          <button
            type="button"
            className={showArbitrator ? "btn primary" : "btn secondary"}
            style={{ minHeight: 38, padding: "7px 14px", fontSize: 13 }}
            onClick={() => void handleToggleArbitrator()}
          >
            {showArbitrator
              ? "⚖️ 1-Click 3-Way Invoice Arbitrator ▴"
              : "⚖️ 1-Click 3-Way Invoice Arbitrator ▾"}
          </button>

          <button
            type="button"
            className="chip-btn"
            style={{
              minHeight: 38,
              padding: "7px 13px",
              fontSize: 12.5,
              borderColor: showDualSigs ? "var(--brand-blue)" : undefined,
              color: showDualSigs ? "var(--brand-blue)" : undefined,
              background: showDualSigs ? "var(--bg-blue-soft)" : undefined,
            }}
            onClick={() => void handleToggleDualSigs()}
          >
            {showDualSigs ? "Inspect Dual Signatures ▴" : "Inspect Dual Signatures ▾"}
          </button>
        </div>
      </div>

      {errorMsg && (
        <div className="banner error" style={{ padding: "10px 14px", fontSize: 13 }}>
          <div>
            <strong>Receipt / Arbitrator Error:</strong> {errorMsg}
          </div>
          <button
            type="button"
            className="link-quiet"
            style={{ color: "var(--red-text)", fontSize: 12 }}
            onClick={() => setErrorMsg(null)}
          >
            Dismiss
          </button>
        </div>
      )}

      {/* 2. Dual Cryptographic Signature Inspector (.arena-split) */}
      {showDualSigs && (
        <div
          style={{
            borderTop: "1px solid var(--border-light)",
            paddingTop: 12,
            display: "flex",
            flexDirection: "column",
            gap: 10,
          }}
        >
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
              flexWrap: "wrap",
              gap: 8,
            }}
          >
            <div style={{ fontWeight: 800, fontSize: 13, color: "var(--text-main)" }}>
              Dual-Envelope Non-Repudiation Proof (Offline-Verifiable `.vtr.json`)
            </div>
            {receipt && (
              <button
                type="button"
                className="link-quiet"
                style={{ fontSize: 12 }}
                onClick={() => setShowRawJson((prev) => !prev)}
              >
                {showRawJson ? "Hide Canonical .vtr.json" : "View Canonical .vtr.json"}
              </button>
            )}
          </div>

          {loadingReceipt && !receipt ? (
            <div
              className="cert-box"
              style={{ fontSize: 12.5, color: "#cbd5e1", textAlign: "center" }}
            >
              Loading dual-signed `.vtr.json` receipt envelope…
            </div>
          ) : receipt ? (
            <>
              <div className="arena-split">
                {/* Left: Buyer Signature Envelope */}
                <div className="cert-box" style={{ display: "flex", flexDirection: "column", gap: 7 }}>
                  <div
                    style={{
                      display: "flex",
                      justifyContent: "space-between",
                      alignItems: "center",
                      gap: 8,
                      flexWrap: "wrap",
                      borderBottom: "1px solid #334155",
                      paddingBottom: 6,
                    }}
                  >
                    <span style={{ fontWeight: 800, color: "#93c5fd", fontSize: 12.5 }}>
                      🔏 Buyer Signature Envelope
                    </span>
                    <span className="pill blue mono" style={{ fontSize: 11, padding: "2px 8px" }}>
                      {receipt.buyer.algorithm} · {receipt.buyer.keyId}
                    </span>
                  </div>

                  <div className="mono" style={{ fontSize: 11.5, display: "grid", gap: 4 }}>
                    <div>
                      <span style={{ color: "#94a3b8" }}>authorityMode: </span>
                      <span style={{ color: "#f8fafc", fontWeight: 700 }}>
                        {receipt.buyer.payload.authorityMode}
                      </span>{" "}
                      <span style={{ color: "#94a3b8" }}>
                        (max {money(receipt.buyer.payload.authorizedMaxTotalEur)})
                      </span>
                    </div>
                    <div title={receipt.buyer.payload.mandateHash}>
                      <span style={{ color: "#94a3b8" }}>mandateHash: </span>
                      <span style={{ color: "#e2e8f0" }}>
                        {shortHex(receipt.buyer.payload.mandateHash, 14, 10)}
                      </span>{" "}
                      <span style={{ color: "#64748b" }}>
                        ({receipt.buyer.payload.mandateId})
                      </span>
                    </div>
                    <div>
                      <span style={{ color: "#94a3b8" }}>quoteId: </span>
                      <span style={{ color: "#bae6fd" }}>
                        {receipt.buyer.payload.quoteId ?? "null (live_committed)"}
                      </span>
                    </div>
                    <div title={receipt.buyer.payload.snapshotHash}>
                      <span style={{ color: "#94a3b8" }}>snapshotHash: </span>
                      <span style={{ color: "#e2e8f0" }}>
                        {shortHex(receipt.buyer.payload.snapshotHash, 14, 10)}
                      </span>
                    </div>
                    <div title={receipt.buyer.publicKeyPem}>
                      <span style={{ color: "#94a3b8" }}>pubKeyFingerprint: </span>
                      <span style={{ color: "#cbd5e1" }}>
                        {pemFingerprint(receipt.buyer.publicKeyPem)}
                      </span>
                    </div>
                    <div title={receipt.buyer.signature}>
                      <span style={{ color: "#94a3b8" }}>signature: </span>
                      <span style={{ color: "#93c5fd" }}>
                        {shortHex(receipt.buyer.signature, 16, 12)}
                      </span>
                    </div>
                    {receipt.buyer.humanOverride && (
                      <div
                        style={{
                          marginTop: 4,
                          padding: "6px 8px",
                          borderRadius: 8,
                          background: "rgba(30, 58, 138, 0.38)",
                          border: "1px solid rgba(147, 197, 253, 0.35)",
                          color: "#dbeafe",
                        }}
                      >
                        🔐 Human Override Bound: {receipt.buyer.humanOverride.signerLabel} (
                        {receipt.buyer.humanOverride.mode} ·{" "}
                        {receipt.buyer.humanOverride.signaturePrefix}…)
                      </div>
                    )}
                  </div>
                </div>

                {/* Right: Valio Supplier Counter-Signature Envelope */}
                <div
                  className="cert-box safe"
                  style={{ display: "flex", flexDirection: "column", gap: 7 }}
                >
                  <div
                    style={{
                      display: "flex",
                      justifyContent: "space-between",
                      alignItems: "center",
                      gap: 8,
                      flexWrap: "wrap",
                      borderBottom: "1px solid rgba(167, 243, 208, 0.25)",
                      paddingBottom: 6,
                    }}
                  >
                    <span style={{ fontWeight: 800, color: "#6ee7b7", fontSize: 12.5 }}>
                      ✓ Valio Supplier Signature Envelope
                    </span>
                    <span className="pill green mono" style={{ fontSize: 11, padding: "2px 8px" }}>
                      {receipt.supplier.algorithm} · {receipt.supplier.keyId}
                    </span>
                  </div>

                  <div className="mono" style={{ fontSize: 11.5, display: "grid", gap: 4 }}>
                    <div>
                      <span style={{ color: "#a7f3d0" }}>orderId: </span>
                      <span style={{ color: "#ecfdf5", fontWeight: 700 }}>
                        {receipt.supplier.payload.orderId}
                      </span>{" "}
                      <span style={{ color: "#6ee7b7" }}>({receipt.supplier.issuer})</span>
                    </div>
                    <div>
                      <span style={{ color: "#a7f3d0" }}>honouredPrice: </span>
                      <span style={{ color: "#ecfdf5", fontWeight: 700 }}>
                        {money(receipt.supplier.payload.honouredPrice.totalEur)}
                      </span>{" "}
                      <span style={{ color: "#a7f3d0" }}>
                        [{receipt.supplier.payload.honouredPrice.priceBasis} ·{" "}
                        {receipt.supplier.payload.honouredPrice.lines
                          .map((l) => `${qty(l.totalQuantity, l.quantityUnit)} @ ${money(l.unitPriceEur)}/pk`)
                          .join(", ")}
                        ]
                      </span>
                    </div>
                    <div>
                      <span style={{ color: "#a7f3d0" }}>allergenClaim: </span>
                      <span style={{ color: "#ecfdf5" }}>
                        lactoseFree={String(receipt.supplier.payload.allergenClaim.lactoseFreeGuaranteed)}
                        {receipt.supplier.payload.allergenClaim.excludedAllergens.length > 0
                          ? ` · excluded=[${receipt.supplier.payload.allergenClaim.excludedAllergens.join(", ")}]`
                          : " · attested clean"}
                      </span>
                    </div>
                    <div>
                      <span style={{ color: "#a7f3d0" }}>deliveryCommitment: </span>
                      <span style={{ color: "#ecfdf5" }}>
                        promised {day(receipt.supplier.payload.deliveryCommitment.promisedDate)} ·
                        SLA ≤ {receipt.supplier.payload.deliveryCommitment.latestAcceptableDate}
                      </span>
                    </div>
                    <div title={receipt.supplier.payload.buyerSignatureHash}>
                      <span style={{ color: "#a7f3d0" }}>buyerSigHash: </span>
                      <span style={{ color: "#d1fae5" }}>
                        {shortHex(receipt.supplier.payload.buyerSignatureHash, 14, 10)}
                      </span>
                    </div>
                    <div title={receipt.supplier.publicKeyPem}>
                      <span style={{ color: "#a7f3d0" }}>pubKeyFingerprint: </span>
                      <span style={{ color: "#d1fae5" }}>
                        {pemFingerprint(receipt.supplier.publicKeyPem)}
                      </span>
                    </div>
                    <div title={receipt.receiptHash}>
                      <span style={{ color: "#a7f3d0" }}>receiptHash: </span>
                      <span style={{ color: "#6ee7b7", fontWeight: 700 }}>
                        {shortHex(receipt.receiptHash, 16, 12)}
                      </span>
                    </div>
                  </div>
                </div>
              </div>

              {showRawJson && (
                <div className="cert-box" style={{ maxHeight: 280, overflowY: "auto" }}>
                  <pre>{canonicalPrettyJson(receipt)}</pre>
                </div>
              )}
            </>
          ) : null}
        </div>
      )}

      {/* 3. Interactive 1-Click 3-Way Invoice Dispute Arbitrator Panel */}
      {showArbitrator && (
        <div
          style={{
            borderTop: "1px solid var(--border-light)",
            paddingTop: 12,
            display: "flex",
            flexDirection: "column",
            gap: 12,
          }}
        >
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
              flexWrap: "wrap",
              gap: 8,
            }}
          >
            <div>
              <div style={{ fontWeight: 800, fontSize: 13.5, color: "var(--text-main)" }}>
                ⚖️ 1-Click 3-Way Invoice Dispute Simulator
              </div>
              <div style={{ fontSize: 12.5, color: "var(--text-muted)" }}>
                Test any post-delivery e-invoice, receiving dock scan, or CFO chargeback against
                the counter-signed `.vtr.json` contract:
              </div>
            </div>

            <button
              type="button"
              className="link-quiet"
              style={{ fontSize: 12.5 }}
              onClick={() => setShowCustomOverride((prev) => !prev)}
            >
              {showCustomOverride
                ? "Hide Custom E-Invoice Override ▴"
                : "Custom E-Invoice / Delivery Note Override ▾"}
            </button>
          </div>

          {/* 6 Crisp 1-Click Simulation Preset Chips */}
          <div className="chips-row" style={{ marginTop: 0 }}>
            {ARBITRATOR_PRESETS.map((preset) => {
              const isSelected = activeSelection === preset.id;
              return (
                <button
                  key={preset.id}
                  type="button"
                  className="chip-btn"
                  title={preset.hint}
                  disabled={arbitrating}
                  onClick={() => void handleRunPreset(preset.id)}
                  style={{
                    fontWeight: 700,
                    fontSize: 12.5,
                    borderColor: isSelected ? "var(--brand-blue)" : "var(--border-strong)",
                    background: isSelected ? "var(--brand-navy)" : "#ffffff",
                    color: isSelected ? "#ffffff" : "var(--text-main)",
                  }}
                >
                  {arbitrating && isSelected ? `⏳ ${preset.label}` : preset.label}
                </button>
              );
            })}
          </div>

          {/* Optional Collapsible Custom E-Invoice / Delivery Note Override Mini-Row */}
          {showCustomOverride && (
            <div
              style={{
                background: "#ffffff",
                border: "1px solid var(--border-strong)",
                borderRadius: 12,
                padding: "12px 14px",
                display: "flex",
                flexWrap: "wrap",
                gap: 10,
                alignItems: "flex-end",
              }}
            >
              <label
                style={{
                  display: "flex",
                  flexDirection: "column",
                  gap: 4,
                  minWidth: 145,
                  flex: "1 1 145px",
                }}
              >
                <span style={{ fontSize: 11.5, fontWeight: 700, color: "var(--text-muted)" }}>
                  Billed E-Invoice Total (€)
                </span>
                <input
                  type="number"
                  step="0.01"
                  min="0"
                  placeholder="999.99"
                  className="field-input mono"
                  style={{ minHeight: 38, padding: "6px 10px", fontSize: 13.5 }}
                  value={customBilledTotal}
                  onChange={(e) => setCustomBilledTotal(e.target.value)}
                />
              </label>

              <label
                style={{
                  display: "flex",
                  flexDirection: "column",
                  gap: 4,
                  minWidth: 155,
                  flex: "1 1 155px",
                }}
              >
                <span style={{ fontSize: 11.5, fontWeight: 700, color: "var(--text-muted)" }}>
                  Actual Delivery Date
                </span>
                <input
                  type="date"
                  className="field-input mono"
                  style={{ minHeight: 38, padding: "6px 10px", fontSize: 13 }}
                  value={customDeliveredAt}
                  onChange={(e) => setCustomDeliveredAt(e.target.value)}
                />
              </label>

              <label
                style={{
                  display: "flex",
                  flexDirection: "column",
                  gap: 4,
                  minWidth: 220,
                  flex: "2 1 220px",
                }}
              >
                <span style={{ fontSize: 11.5, fontWeight: 700, color: "var(--text-muted)" }}>
                  Dispute / Receiving Claim Override
                </span>
                <select
                  className="field-select"
                  style={{ minHeight: 38, padding: "6px 10px", fontSize: 13 }}
                  value={customDisputeClaim}
                  onChange={(e) =>
                    setCustomDisputeClaim(e.target.value as BuyerDisputeClaim)
                  }
                >
                  <option value="price_overcharge">
                    Price Overcharge vs Committed Quote
                  </option>
                  <option value="late_delivery">
                    Late Cold-Chain Delivery Arrival
                  </option>
                  <option value="rogue_agent_hallucination">
                    CFO Chargeback: &quot;Rogue Agent Hallucinated!&quot;
                  </option>
                  <option value="allergen_breach">
                    Dock Scan: Allergen / Lactose Lot Breach
                  </option>
                  <option value="none">
                    None (Routine 3-Way AP Verification)
                  </option>
                </select>
              </label>

              <button
                type="button"
                className="btn primary"
                style={{ minHeight: 38, padding: "8px 16px", fontSize: 13 }}
                disabled={arbitrating}
                onClick={() => void handleRunCustomArbitration()}
              >
                {arbitrating && activeSelection === "custom"
                  ? "Arbitrating…"
                  : "Run Custom Arbitration"}
              </button>
            </div>
          )}

          {/* 4. Instant Cryptographic Ruling Display (<10 ms) */}
          {ruling && (
            <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
              <div
                className={rulingCertClass}
                style={{
                  display: "flex",
                  flexDirection: "column",
                  gap: 12,
                  padding: "16px 18px",
                }}
              >
                {/* Top Verdict & Speed Strip */}
                <div
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    alignItems: "center",
                    flexWrap: "wrap",
                    gap: 8,
                    borderBottom: isCleanLiability
                      ? "1px solid rgba(167, 243, 208, 0.25)"
                      : "1px solid rgba(252, 165, 165, 0.28)",
                    paddingBottom: 10,
                  }}
                >
                  <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                    <span
                      className={
                        ruling.ruling === "BUYER_LIABLE"
                          ? "pill green mono"
                          : ruling.ruling === "SUPPLIER_BREACH"
                            ? "pill amber mono"
                            : "pill red mono"
                      }
                      style={{ fontSize: 12, fontWeight: 800 }}
                    >
                      {ruling.ruling}
                    </span>
                    <span
                      className="pill gray mono"
                      style={{
                        fontSize: 11,
                        padding: "3px 9px",
                        background: "rgba(15, 23, 42, 0.55)",
                        color: "#e2e8f0",
                        borderColor: "rgba(148, 163, 184, 0.35)",
                      }}
                    >
                      {ruling.subVerdict}
                    </span>
                    <span className="mono" style={{ fontSize: 11.5, opacity: 0.85 }}>
                      {ruling.rulingId} · {ruling.simulatedDocument.documentId}
                    </span>
                  </div>

                  <span
                    className="pill blue mono"
                    style={{
                      fontSize: 12,
                      fontWeight: 800,
                      background: "rgba(30, 64, 175, 0.35)",
                      color: "#bfdbfe",
                      borderColor: "rgba(147, 197, 253, 0.45)",
                    }}
                  >
                    ⚡ Ruled in {ruling.latencyMs.toFixed(2)} ms
                  </span>
                </div>

                {/* Headline & Summary */}
                <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
                  <div
                    style={{
                      fontSize: 15.5,
                      fontWeight: 800,
                      color: isCleanLiability ? "#ecfdf5" : "#fef2f2",
                      lineHeight: 1.3,
                    }}
                  >
                    {ruling.headline}
                  </div>
                  <div
                    style={{
                      fontSize: 12.5,
                      color: isCleanLiability ? "#a7f3d0" : "#fecaca",
                      lineHeight: 1.45,
                    }}
                  >
                    {ruling.summary}
                  </div>
                </div>

                {/* 4-Figure AP Reconciliation Strip */}
                <div
                  style={{
                    display: "grid",
                    gridTemplateColumns: "repeat(auto-fit, minmax(130px, 1fr))",
                    gap: 8,
                    background: "rgba(15, 23, 42, 0.52)",
                    border: isCleanLiability
                      ? "1px solid rgba(167, 243, 208, 0.22)"
                      : "1px solid rgba(252, 165, 165, 0.28)",
                    borderRadius: 12,
                    padding: "10px 12px",
                  }}
                >
                  <div>
                    <div style={{ fontSize: 11, opacity: 0.8, fontWeight: 700 }}>
                      Contracted
                    </div>
                    <div className="mono" style={{ fontSize: 15, fontWeight: 800, color: "#f8fafc" }}>
                      {money(ruling.reconciliation.contractedTotalEur)}
                    </div>
                  </div>

                  <div>
                    <div style={{ fontSize: 11, opacity: 0.8, fontWeight: 700 }}>
                      Billed
                    </div>
                    <div className="mono" style={{ fontSize: 15, fontWeight: 800, color: "#f8fafc" }}>
                      {money(ruling.reconciliation.billedTotalEur)}
                    </div>
                  </div>

                  <div>
                    <div style={{ fontSize: 11, opacity: 0.8, fontWeight: 700 }}>
                      Auto-Credit
                    </div>
                    <div
                      className="mono"
                      style={{
                        fontSize: 15,
                        fontWeight: 800,
                        color:
                          ruling.reconciliation.autoCreditEur > 0 ? "#fde68a" : "#94a3b8",
                      }}
                    >
                      -{money(ruling.reconciliation.autoCreditEur)}
                    </div>
                  </div>

                  <div>
                    <div style={{ fontSize: 11, opacity: 0.8, fontWeight: 700 }}>
                      Net Payable
                    </div>
                    <div
                      className="mono"
                      style={{
                        fontSize: 15,
                        fontWeight: 800,
                        color: "#6ee7b7",
                      }}
                    >
                      {money(ruling.reconciliation.netPayableEur)}
                    </div>
                  </div>
                </div>

                {/* Cryptographic Verification Checklist */}
                <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
                  {(
                    [
                      ["Buyer Sig", ruling.cryptographicProof.buyerSignatureValid],
                      ["Valio Sig", ruling.cryptographicProof.supplierSignatureValid],
                      ["Bilateral Hash", ruling.cryptographicProof.bilateralBindingValid],
                      ["Receipt Hash", ruling.cryptographicProof.receiptHashValid],
                    ] as const
                  ).map(([label, ok]) => (
                    <span
                      key={label}
                      className={ok ? "pill green mono" : "pill red mono"}
                      style={{ fontSize: 11.5, padding: "3px 9px" }}
                    >
                      {label} {ok ? "✓" : "✗"}
                    </span>
                  ))}

                  {ruling.cryptographicProof.humanOverrideVerified && (
                    <span className="pill blue mono" style={{ fontSize: 11.5, padding: "3px 9px" }}>
                      Human Override Sig ✓
                    </span>
                  )}

                  {ruling.cryptographicProof.reason && (
                    <span className="mono" style={{ fontSize: 11.5, color: "#fca5a5" }}>
                      reason: {ruling.cryptographicProof.reason}
                    </span>
                  )}
                </div>
              </div>

              {/* Itemized Contractual Breach Clauses */}
              {ruling.breaches.length > 0 && (
                <div>
                  <div
                    style={{
                      fontWeight: 800,
                      fontSize: 12.5,
                      color: "var(--text-main)",
                      marginBottom: 6,
                    }}
                  >
                    Itemized Contractual Breach Clauses ({ruling.breaches.length})
                  </div>
                  <div className="timeline-steps">
                    {ruling.breaches.map((breach, idx) => (
                      <div
                        key={`${breach.code}-${idx}`}
                        className={`timeline-step ${
                          breach.party === "tamper" ? "bad" : "warn"
                        }`}
                      >
                        <div
                          style={{
                            display: "flex",
                            justifyContent: "space-between",
                            alignItems: "center",
                            flexWrap: "wrap",
                            gap: 8,
                            marginBottom: 4,
                          }}
                        >
                          <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
                            <span
                              className={
                                breach.party === "tamper"
                                  ? "pill red mono"
                                  : "pill amber mono"
                              }
                              style={{ fontSize: 11, padding: "2px 8px" }}
                            >
                              {breach.code}
                            </span>
                            <span style={{ fontWeight: 700, fontSize: 13, color: "var(--text-main)" }}>
                              {breach.clause}
                            </span>
                          </div>
                          <span className="pill red mono" style={{ fontSize: 11.5 }}>
                            Credit -{money(breach.creditImpactEur)}
                          </span>
                        </div>

                        <div
                          className="mono"
                          style={{
                            fontSize: 12,
                            color: "var(--text-muted)",
                            display: "grid",
                            gap: 2,
                          }}
                        >
                          <div>
                            <strong>Contracted:</strong> {breach.expected}
                          </div>
                          <div>
                            <strong>Observed:</strong> {breach.actual}
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export default TradeReceiptArbitratorCard;
