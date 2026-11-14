import { useEffect, useRef, useState } from "react";
import {
  api,
  clearApiCache,
  type VoiceReadiness,
  type VoiceSimulateResponse,
  type VoiceTranscriptLine,
} from "./api";
import { day, money, qty, tidy } from "./format";

const FALLBACK_PHONE_DISPLAY = "+1 269 665 8009";

function formatPhoneDisplay(raw: string | null | undefined): string {
  const cleaned = (raw ?? "").trim();
  if (!cleaned) return FALLBACK_PHONE_DISPLAY;
  const digits = cleaned.replace(/[^\d+]/g, "");
  // Format US/E.164 +1XXXXXXXXXX nicely as +1 XXX XXX XXXX
  const usMatch = /^\+1(\d{3})(\d{3})(\d{4})$/.exec(digits);
  if (usMatch) return `+1 ${usMatch[1]} ${usMatch[2]} ${usMatch[3]}`;
  // Format +358... nicely if Finnish number configured
  const fiMatch = /^\+358(\d{2})(\d{3})(\d{3,4})$/.exec(digits);
  if (fiMatch) return `+358 ${fiMatch[1]} ${fiMatch[2]} ${fiMatch[3]}`;
  return cleaned;
}

function formatTelHref(raw: string | null | undefined): string {
  const digits = (raw || FALLBACK_PHONE_DISPLAY).replace(/[^\d+]/g, "");
  return `tel:${digits || "+12696658009"}`;
}

/**
 * Self-contained ISO/IEC 18004 QR Code matrix encoder (Byte mode, EC Level M, Versions 1..4).
 * Verified against Apple Vision VNDetectBarcodesRequest so phone cameras scan reliably.
 */
function encodeQrMatrix(text: string): boolean[][] | null {
  const bytes = Array.from(new TextEncoder().encode(text));
  const VERSIONS: Array<{
    v: number;
    size: number;
    total: number;
    ec: number;
    blocks: number;
    align: number[];
  } | null> = [
    null,
    { v: 1, size: 21, total: 26, ec: 10, blocks: 1, align: [] },
    { v: 2, size: 25, total: 44, ec: 16, blocks: 1, align: [6, 18] },
    { v: 3, size: 29, total: 70, ec: 26, blocks: 1, align: [6, 22] },
    { v: 4, size: 33, total: 100, ec: 18, blocks: 2, align: [6, 26] },
  ];

  const spec = VERSIONS.find((s) => s !== null && s.total - s.ec * s.blocks - 2 >= bytes.length);
  if (!spec) return null;

  const dataCodewords = spec.total - spec.ec * spec.blocks;
  const bits: number[] = [];
  const pushBits = (val: number, len: number) => {
    for (let i = len - 1; i >= 0; i--) bits.push((val >>> i) & 1);
  };

  // Byte mode indicator (0100) + 8-bit character count
  pushBits(0b0100, 4);
  pushBits(bytes.length, 8);
  for (const b of bytes) pushBits(b, 8);

  const maxBits = dataCodewords * 8;
  pushBits(0, Math.min(4, maxBits - bits.length));
  while (bits.length % 8 !== 0) bits.push(0);

  const data: number[] = [];
  for (let i = 0; i < bits.length; i += 8) {
    let b = 0;
    for (let j = 0; j < 8; j++) b = (b << 1) | bits[i + j];
    data.push(b);
  }
  let padToggle = true;
  while (data.length < dataCodewords) {
    data.push(padToggle ? 0xec : 0x11);
    padToggle = !padToggle;
  }

  // GF(256) log/antilog with primitive polynomial 0x11d
  const exp = new Uint8Array(512);
  const log = new Uint8Array(256);
  let x = 1;
  for (let i = 0; i < 255; i++) {
    exp[i] = x;
    exp[i + 255] = x;
    log[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  const gfMul = (a: number, b: number) => (a === 0 || b === 0 ? 0 : exp[log[a] + log[b]]);

  const rsEncode = (msg: number[], ecLen: number): number[] => {
    let gen = [1];
    for (let i = 0; i < ecLen; i++) {
      const next = new Array<number>(gen.length + 1).fill(0);
      for (let j = 0; j < gen.length; j++) {
        next[j] ^= gen[j];
        next[j + 1] ^= gfMul(gen[j], exp[i]);
      }
      gen = next;
    }
    const rem = new Array<number>(ecLen).fill(0);
    for (const b of msg) {
      const factor = b ^ rem[0];
      rem.shift();
      rem.push(0);
      for (let j = 0; j < ecLen; j++) {
        rem[j] ^= gfMul(gen[j + 1], factor);
      }
    }
    return rem;
  };

  const blockData: number[][] = [];
  const blockEc: number[][] = [];
  const baseLen = Math.floor(dataCodewords / spec.blocks);
  let offset = 0;
  for (let b = 0; b < spec.blocks; b++) {
    const chunk = data.slice(offset, offset + baseLen);
    offset += baseLen;
    blockData.push(chunk);
    blockEc.push(rsEncode(chunk, spec.ec));
  }

  const finalBytes: number[] = [];
  for (let i = 0; i < baseLen; i++) {
    for (let b = 0; b < spec.blocks; b++) finalBytes.push(blockData[b][i]);
  }
  for (let i = 0; i < spec.ec; i++) {
    for (let b = 0; b < spec.blocks; b++) finalBytes.push(blockEc[b][i]);
  }

  const n = spec.size;
  const grid = Array.from({ length: n }, () => new Array<boolean>(n).fill(false));
  const reserved = Array.from({ length: n }, () => new Array<boolean>(n).fill(false));

  const setMod = (r: number, c: number, dark: boolean) => {
    if (r < 0 || r >= n || c < 0 || c >= n) return;
    grid[r][c] = dark;
    reserved[r][c] = true;
  };

  const placeFinder = (tr: number, tc: number) => {
    for (let r = -1; r <= 7; r++) {
      for (let c = -1; c <= 7; c++) {
        const inOuter = r >= 0 && r <= 6 && c >= 0 && c <= 6;
        const onBorder = r === 0 || r === 6 || c === 0 || c === 6;
        const inInner = r >= 2 && r <= 4 && c >= 2 && c <= 4;
        setMod(tr + r, tc + c, inOuter && (onBorder || inInner));
      }
    }
  };
  placeFinder(0, 0);
  placeFinder(0, n - 7);
  placeFinder(n - 7, 0);

  for (const ar of spec.align) {
    for (const ac of spec.align) {
      if (reserved[ar][ac]) continue;
      for (let r = -2; r <= 2; r++) {
        for (let c = -2; c <= 2; c++) {
          setMod(ar + r, ac + c, Math.max(Math.abs(r), Math.abs(c)) !== 1);
        }
      }
    }
  }

  for (let i = 8; i < n - 8; i++) {
    if (!reserved[6][i]) setMod(6, i, i % 2 === 0);
    if (!reserved[i][6]) setMod(i, 6, i % 2 === 0);
  }

  setMod(n - 8, 8, true);
  for (let i = 0; i < 9; i++) {
    reserved[8][i] = true;
    reserved[i][8] = true;
  }
  for (let i = 0; i < 8; i++) {
    reserved[8][n - 1 - i] = true;
    reserved[n - 1 - i][8] = true;
  }

  const allBits: number[] = [];
  for (const b of finalBytes) {
    for (let i = 7; i >= 0; i--) allBits.push((b >>> i) & 1);
  }

  let bitIdx = 0;
  let upward = true;
  for (let right = n - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vert = 0; vert < n; vert++) {
      const r = upward ? n - 1 - vert : vert;
      for (let j = 0; j < 2; j++) {
        const c = right - j;
        if (!reserved[r][c]) {
          const bit = bitIdx < allBits.length ? allBits[bitIdx++] === 1 : false;
          grid[r][c] = (r + c) % 2 === 0 ? !bit : bit;
        }
      }
    }
    upward = !upward;
  }

  // Format bits for EC Level M (00) + Mask 0 (000) => 0x5412
  const formatBits = 0x5412;
  const fBits: boolean[] = [];
  for (let i = 0; i < 15; i++) fBits.push(((formatBits >>> i) & 1) === 1);

  const tlCoords: Array<[number, number]> = [
    [8, 0], [8, 1], [8, 2], [8, 3], [8, 4], [8, 5], [8, 7], [8, 8],
    [7, 8], [5, 8], [4, 8], [3, 8], [2, 8], [1, 8], [0, 8],
  ];
  for (let i = 0; i < 15; i++) {
    const [r, c] = tlCoords[i];
    grid[r][c] = fBits[14 - i];
  }
  for (let i = 0; i < 7; i++) {
    grid[n - 1 - i][8] = fBits[14 - i];
  }
  for (let i = 0; i < 8; i++) {
    grid[8][n - 8 + i] = fBits[7 - i];
  }

  return grid;
}

function QrSvg(props: { value: string; size?: number }) {
  const matrix = encodeQrMatrix(props.value);
  const px = props.size ?? 148;
  if (!matrix) return null;
  const quiet = 4;
  const total = matrix.length + quiet * 2;
  let pathD = "";
  for (let r = 0; r < matrix.length; r++) {
    for (let c = 0; c < matrix.length; c++) {
      if (matrix[r][c]) {
        pathD += `M${c + quiet},${r + quiet}h1v1h-1z`;
      }
    }
  }
  return (
    <svg
      width={px}
      height={px}
      viewBox={`0 0 ${total} ${total}`}
      shapeRendering="crispEdges"
      role="img"
      aria-label={`QR code for ${props.value}`}
      style={{
        display: "block",
        background: "#ffffff",
        borderRadius: 12,
        border: "1px solid var(--border-light)",
        boxShadow: "0 2px 8px rgba(15, 23, 42, 0.06)",
      }}
    >
      <rect width={total} height={total} fill="#ffffff" />
      <path d={pathD} fill="#0f172a" />
    </svg>
  );
}

type PresetId = "wedding" | "gala" | "sports";

const CALL_PRESETS: Array<{
  id: PresetId;
  label: string;
  fallbackTitle: string;
  fallbackGuests: number;
  fallbackLines: VoiceTranscriptLine[];
}> = [
  {
    id: "wedding",
    label: "🥞 Call in: 120-Guest Saturday Wedding Brunch",
    fallbackTitle: "Saturday Wedding Brunch",
    fallbackGuests: 120,
    fallbackLines: [
      {
        speaker: "Chef Matti",
        role: "caller",
        text: "Hi! I'm in the walk-in cooler — we just booked a 120-guest Saturday Wedding Brunch. Can you check our pantry and line up the pancake and smoothie ingredients?",
      },
      {
        speaker: "Valio Voice Assistant",
        role: "assistant",
        text: "Got it, Chef Matti! For 120 guests on Saturday Wedding Brunch, I checked your current fridge stock and prepared a purchase plan for the missing lactose-free milk, cooking cream, yogurt, eggs, and bananas.",
      },
      {
        speaker: "Chef Matti",
        role: "caller",
        text: "Perfect — save the proposal and text or email me the approval link so I can tap OK after prep.",
      },
      {
        speaker: "Valio Voice Assistant",
        role: "assistant",
        text: "Done! Saved as a non-ordering proposal — zero money spent on this call. Your one-tap mobile approval link is ready.",
      },
    ],
  },
  {
    id: "gala",
    label: "🥂 Call in: 320-Guest Tech Gala Dinner",
    fallbackTitle: "Tech Gala Dinner",
    fallbackGuests: 320,
    fallbackLines: [
      {
        speaker: "Chef Matti",
        role: "caller",
        text: "Hey assistant, hands are full on the prep line — put together a banquet plan for next week's 320-guest Tech Gala Dinner.",
      },
      {
        speaker: "Valio Voice Assistant",
        role: "assistant",
        text: "Right away! I scaled your banquet recipes to 320 guests, subtracted what's already in your pantry, and priced the Valio Aimo contract packs needed.",
      },
      {
        speaker: "Chef Matti",
        role: "caller",
        text: "Yes, confirm saving that plan and send the review link to my phone.",
      },
      {
        speaker: "Valio Voice Assistant",
        role: "assistant",
        text: "Proposal saved! Nothing has been ordered yet — tap your mobile approval link whenever you're ready to schedule purchasing.",
      },
    ],
  },
  {
    id: "sports",
    label: "🏃 Call in: 220-Student Sports Day",
    fallbackTitle: "Student Sports Day",
    fallbackGuests: 220,
    fallbackLines: [
      {
        speaker: "Chef Sari",
        role: "caller",
        text: "Calling from the school kitchen — we have 220 students for Sports Day next week. Please prepare the smoothie and porridge ingredient plan, lactose-free.",
      },
      {
        speaker: "Valio Voice Assistant",
        role: "assistant",
        text: "Checked your school pantry and allergen rules! I built a lactose-free plan for 220 portions and flagged any bulk items above your automatic limit.",
      },
      {
        speaker: "Chef Sari",
        role: "caller",
        text: "Confirmed — save the proposal and send over the mobile sign-off link.",
      },
      {
        speaker: "Valio Voice Assistant",
        role: "assistant",
        text: "Saved safely with zero spend on the call. Your one-tap approval link is on your phone!",
      },
    ],
  },
];

function extractRelativeApprovalPath(res: VoiceSimulateResponse | null): string | null {
  if (!res) return null;
  if (res.approvalToken) return `/approval/voice/${encodeURIComponent(res.approvalToken)}`;
  const raw = res.approvalUrl ?? res.mockApprovalUrl ?? res.voice?.approvalUrl ?? null;
  if (!raw) return null;
  const m = /\/approval\/voice\/([^/?#\s]+)/.exec(raw);
  if (m) return `/approval/voice/${m[1]}`;
  if (raw.startsWith("/")) return raw;
  return null;
}

function normalizeTranscript(
  res: VoiceSimulateResponse,
  preset: PresetId,
  spokenOverride?: string,
): VoiceTranscriptLine[] {
  const rawList = Array.isArray(res.transcript)
    ? res.transcript
    : Array.isArray(res.turns)
      ? res.turns
      : null;

  if (rawList && rawList.length > 0) {
    const mapped = rawList
      .map((item: any) => {
        const role =
          item.role ??
          (/assistant|valio|agent/i.test(String(item.speaker ?? "")) ? "assistant" : "caller");
        const speaker =
          item.speaker ?? (role === "assistant" ? "Valio Voice Assistant" : "Chef Matti");
        const text = String(item.text ?? item.message ?? item.content ?? "").trim();
        return { speaker, role, text };
      })
      .filter((t) => t.text.length > 0);
    if (mapped.length > 0) {
      if (spokenOverride) {
        mapped[0] = {
          ...mapped[0],
          text: spokenOverride,
        };
      }
      return mapped;
    }
  }

  const presetDef = CALL_PRESETS.find((p) => p.id === preset) ?? CALL_PRESETS[0];
  const lines = presetDef.fallbackLines.map((l) => ({ ...l }));
  if (spokenOverride && lines.length > 0) {
    lines[0] = { ...lines[0], text: spokenOverride };
  }
  return lines;
}

export function PhoneCallHero(props: {
  customerId?: string;
  onVoiceOrderPrompt?: (spokenText: string) => void;
  onMessage?: (msg: string, tone?: "success" | "warn" | "info") => void;
  onNavigateTab?: (
    tab: "order" | "kitchen" | "approval" | "rules" | "history" | "arena",
    subView?: string,
  ) => void;
}) {
  const [readiness, setReadiness] = useState<VoiceReadiness | null>(null);
  const [copied, setCopied] = useState(false);
  const [showQr, setShowQr] = useState(false);

  const [simBusy, setSimBusy] = useState<PresetId | null>(null);
  const [simError, setSimError] = useState<string | null>(null);
  const [simResult, setSimResult] = useState<VoiceSimulateResponse | null>(null);
  const [activePreset, setActivePreset] = useState<PresetId | null>(null);
  const [transcriptLines, setTranscriptLines] = useState<VoiceTranscriptLine[]>([]);
  const [visibleTurnCount, setVisibleTurnCount] = useState(0);

  // Browser SpeechRecognition state
  const [listening, setListening] = useState(false);
  const [micTranscript, setMicTranscript] = useState<string>("");
  const [micNote, setMicNote] = useState<string | null>(null);
  const recognitionRef = useRef<any>(null);

  // Mobile Phone Frame Modal state
  const [mobileModalOpen, setMobileModalOpen] = useState(false);
  const [mobileHtmlStatus, setMobileHtmlStatus] = useState<"idle" | "loading" | "ready" | "expired">("idle");
  const [mobileApproving, setMobileApproving] = useState(false);
  const [mobileApproved, setMobileApproved] = useState(false);
  const [mobileModalError, setMobileModalError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    api<VoiceReadiness>("/v1/voice/readiness")
      .then((r) => {
        if (!cancelled) setReadiness(r);
      })
      .catch(() => {
        // Graceful fallback to default number when unavailable
      });
    return () => {
      cancelled = true;
    };
  }, [props.customerId]);

  // Animate transcript lines smoothly so the call feels alive
  useEffect(() => {
    if (transcriptLines.length === 0) {
      setVisibleTurnCount(0);
      return;
    }
    if (visibleTurnCount >= transcriptLines.length) return;
    const t = setTimeout(() => {
      setVisibleTurnCount((c) => Math.min(transcriptLines.length, c + 1));
    }, 320);
    return () => clearTimeout(t);
  }, [transcriptLines, visibleTurnCount]);

  useEffect(() => {
    return () => {
      if (recognitionRef.current) {
        try {
          recognitionRef.current.stop();
        } catch {
          // ignore
        }
      }
    };
  }, []);

  const displayPhone = formatPhoneDisplay(readiness?.phoneNumber);
  const telHref = formatTelHref(readiness?.phoneNumber);

  async function handleCopyNumber() {
    try {
      await navigator.clipboard.writeText(displayPhone);
      setCopied(true);
      setTimeout(() => setCopied(false), 2500);
    } catch {
      props.onMessage?.(`Kitchen Voice Line: ${displayPhone}`, "info");
    }
  }

  async function runSimulatedCall(preset: PresetId, spokenOverride?: string) {
    setSimBusy(preset);
    setSimError(null);
    setMicNote(null);
    setMobileApproved(false);
    setMobileModalError(null);
    setActivePreset(preset);
    try {
      const res = await api<VoiceSimulateResponse>("/v1/voice/simulate", {
        method: "POST",
        body: JSON.stringify(
          spokenOverride ? { preset, utterance: spokenOverride, text: spokenOverride } : { preset },
        ),
      });
      let enriched: VoiceSimulateResponse = res;
      const targetEventId = res.event?.id ?? res.eventId ?? res.voice?.eventId;
      if (!res.event && targetEventId) {
        try {
          const evList = await api<{ events: NonNullable<VoiceSimulateResponse["event"]>[] }>("/v1/events");
          const matched = evList.events?.find((ev) => ev.id === targetEventId);
          if (matched) enriched = { ...res, event: matched };
        } catch {
          // Non-fatal if event enrichment fails
        }
      }
      setSimResult(enriched);
      const lines = normalizeTranscript(enriched, preset, spokenOverride);
      setTranscriptLines(lines);
      setVisibleTurnCount(1);
    } catch (e) {
      setSimError(e instanceof Error ? e.message : String(e));
    } finally {
      setSimBusy(null);
    }
  }

  function handleToggleMic() {
    setSimError(null);
    setMicNote(null);
    const SpeechRecognitionCtor =
      typeof window !== "undefined"
        ? (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition
        : null;

    if (!SpeechRecognitionCtor) {
      setMicNote(
        "Live microphone requires Chrome, Edge, or Safari — tap one of the 3 simulated kitchen calls to try the full hands-free flow right now!",
      );
      return;
    }

    if (listening && recognitionRef.current) {
      try {
        recognitionRef.current.stop();
      } catch {
        // ignore
      }
      setListening(false);
      return;
    }

    try {
      const rec = new SpeechRecognitionCtor();
      rec.lang = "en-US";
      rec.interimResults = true;
      rec.continuous = false;
      recognitionRef.current = rec;

      let latestText = "";
      rec.onstart = () => {
        setListening(true);
        setMicTranscript("");
      };
      rec.onresult = (event: any) => {
        let combined = "";
        for (let i = 0; i < event.results.length; i++) {
          combined += event.results[i][0]?.transcript ?? "";
        }
        latestText = combined.trim();
        setMicTranscript(latestText);
      };
      rec.onerror = (ev: any) => {
        setListening(false);
        if (ev?.error && ev.error !== "aborted") {
          setMicNote(
            ev.error === "not-allowed"
              ? "Microphone permission was declined — tap any simulated call preset to preview the phone experience."
              : `Could not capture audio (${ev.error}). Try again or tap a call preset.`,
          );
        }
      };
      rec.onend = () => {
        setListening(false);
        const finalSpoken = latestText.trim();
        if (!finalSpoken) return;
        const looksLikeEvent =
          /\b(wedding|gala|sport|student|banquet|event|party|guests?|people|brunch|dinner|conference|buffet)\b/i.test(
            finalSpoken,
          );
        if (looksLikeEvent) {
          const inferredPreset: PresetId = /gala|dinner|tech|300|320/i.test(finalSpoken)
            ? "gala"
            : /sport|student|school|200|220/i.test(finalSpoken)
              ? "sports"
              : "wedding";
          void runSimulatedCall(inferredPreset, finalSpoken);
        } else if (props.onVoiceOrderPrompt) {
          props.onVoiceOrderPrompt(finalSpoken);
          setMicNote(`Heard: "${finalSpoken}" — checking kitchen options below!`);
        } else {
          void runSimulatedCall("wedding", finalSpoken);
        }
      };
      rec.start();
    } catch (e) {
      setListening(false);
      setMicNote(e instanceof Error ? e.message : "Could not start browser microphone.");
    }
  }

  async function openMobilePreviewModal() {
    setMobileModalOpen(true);
    setMobileModalError(null);
    const relPath = extractRelativeApprovalPath(simResult);
    if (!relPath) {
      setMobileHtmlStatus("ready");
      return;
    }
    setMobileHtmlStatus("loading");
    try {
      const res = await fetch(relPath, { headers: { Accept: "text/html" } });
      const html = await res.text();
      if (res.status === 410 || /no longer available/i.test(html)) {
        setMobileHtmlStatus(mobileApproved ? "ready" : "expired");
      } else if (/Plan approved/i.test(html)) {
        setMobileApproved(true);
        setMobileHtmlStatus("ready");
      } else {
        setMobileHtmlStatus("ready");
      }
    } catch {
      setMobileHtmlStatus("ready");
    }
  }

  async function handleApproveOnPhone() {
    if (!simResult) return;
    setMobileApproving(true);
    setMobileModalError(null);
    const relPath = extractRelativeApprovalPath(simResult);
    const eventId = simResult.event?.id ?? simResult.eventId ?? simResult.voice?.eventId;

    try {
      let approvedOk = false;

      if (eventId) {
        try {
          await api(`/v1/events/${encodeURIComponent(eventId)}/voice-approve`, {
            method: "POST",
            body: JSON.stringify({}),
          });
          approvedOk = true;
        } catch {
          // Fall through to token POST endpoint if /voice-approve is unavailable or expects token route
        }
      }

      if (!approvedOk && relPath) {
        const r = await fetch(relPath, { method: "POST" });
        const html = await r.text();
        if (r.ok || /Plan approved/i.test(html)) {
          approvedOk = true;
          clearApiCache();
        }
      }

      if (!approvedOk) {
        throw new Error("Approval link was already used or could not be verified. Try running a fresh call.");
      }

      clearApiCache();
      setMobileApproved(true);
      props.onMessage?.(
        `Mobile event plan approved! Scheduled for live stock & mandate check.`,
        "success",
      );
    } catch (e) {
      setMobileModalError(e instanceof Error ? e.message : String(e));
    } finally {
      setMobileApproving(false);
    }
  }

  const relativeApprovalPath = extractRelativeApprovalPath(simResult);
  const simEvent = simResult?.event;
  const shortfallLines = (simEvent?.plan?.lines ?? []).filter((l) => l.shortfall > 0);
  const estTotal = simEvent?.plan?.estTotal;

  return (
    <>
      <section
        className="card"
        aria-label="Hands-Free Kitchen Phone Line"
        style={{
          marginBottom: 26,
          padding: "22px 24px",
          background: "linear-gradient(135deg, #ffffff 0%, #f0f7ff 58%, #ecfdf5 100%)",
          border: "1.5px solid #bfdbfe",
        }}
      >
        <div
          style={{
            display: "flex",
            flexWrap: "wrap",
            gap: 20,
            alignItems: "center",
            justifyContent: "space-between",
          }}
        >
          {/* Left Pitch Column */}
          <div style={{ flex: "1 1 430px", minWidth: 260 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", marginBottom: 10 }}>
              <span className="pill blue">📞 Zero-Portal Kitchen Line · Hands-Free</span>
              <span className="pill green">✓ Never spends money without your tap</span>
            </div>

            <h2
              style={{
                margin: "0 0 8px",
                fontSize: 22,
                fontWeight: 800,
                letterSpacing: "-0.02em",
                lineHeight: 1.25,
                color: "var(--text-main)",
              }}
            >
              Don't want to open this portal? Just call your assistant from any phone.
            </h2>

            <p style={{ margin: 0, fontSize: 14.5, color: "var(--text-muted)", lineHeight: 1.5 }}>
              In the walk-in fridge or busy on the prep line? Call from any mobile phone — tell the agent your
              event or kitchen need, and get a one-tap approval link on your phone. Zero typing required.
            </p>
          </div>

          {/* Right Phone Call Box + Optional Scannable QR */}
          <div
            style={{
              flex: "0 1 auto",
              display: "flex",
              alignItems: "center",
              gap: 14,
              flexWrap: "wrap",
              background: "#ffffff",
              border: "1px solid var(--border-light)",
              borderRadius: 16,
              padding: "14px 16px",
              boxShadow: "0 4px 14px rgba(0, 56, 130, 0.06)",
            }}
          >
            <div>
              <div
                style={{
                  fontSize: 11.5,
                  fontWeight: 700,
                  textTransform: "uppercase",
                  letterSpacing: "0.05em",
                  color: "var(--text-soft)",
                  marginBottom: 2,
                }}
              >
                24/7 Kitchen Voice Assistant
              </div>
              <div
                style={{
                  fontSize: 23,
                  fontWeight: 800,
                  letterSpacing: "-0.02em",
                  color: "var(--brand-navy)",
                  lineHeight: 1.2,
                  marginBottom: 10,
                }}
              >
                {displayPhone}
              </div>

              <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                <a
                  href={telHref}
                  className="btn primary"
                  style={{
                    textDecoration: "none",
                    minHeight: 42,
                    padding: "9px 16px",
                    fontSize: 13.5,
                  }}
                >
                  📞 Call {displayPhone}
                </a>
                <button
                  type="button"
                  className="btn secondary"
                  style={{ minHeight: 42, padding: "9px 13px", fontSize: 13 }}
                  onClick={() => void handleCopyNumber()}
                >
                  {copied ? "✓ Copied!" : "Copy Number"}
                </button>
                <button
                  type="button"
                  className="btn secondary"
                  style={{ minHeight: 42, padding: "9px 13px", fontSize: 13 }}
                  onClick={() => setShowQr((s) => !s)}
                >
                  {showQr ? "Hide QR" : "📱 Scan QR"}
                </button>
              </div>
            </div>

            {showQr && (
              <div
                style={{
                  display: "flex",
                  flexDirection: "column",
                  alignItems: "center",
                  gap: 5,
                  paddingLeft: 6,
                }}
              >
                <QrSvg value={telHref} size={118} />
                <span style={{ fontSize: 11, fontWeight: 700, color: "var(--text-soft)" }}>
                  Scan with phone camera
                </span>
              </div>
            )}
          </div>
        </div>

        {/* Interactive Simulated Kitchen Call + Browser Voice Mic Strip */}
        <div
          style={{
            marginTop: 18,
            paddingTop: 16,
            borderTop: "1px solid rgba(191, 219, 254, 0.8)",
          }}
        >
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              flexWrap: "wrap",
            }}
          >
            <span style={{ fontSize: 13, fontWeight: 700, color: "var(--brand-navy)" }}>
              🎙️ Try Simulated Kitchen Call:
            </span>

            {CALL_PRESETS.map((p) => {
              const isRunning = simBusy === p.id;
              const isSelected = activePreset === p.id && simResult !== null;
              return (
                <button
                  key={p.id}
                  type="button"
                  className="chip-btn"
                  disabled={simBusy !== null}
                  onClick={() => void runSimulatedCall(p.id)}
                  style={{
                    background: isSelected ? "var(--bg-blue-soft)" : "#ffffff",
                    borderColor: isSelected ? "var(--brand-blue)" : "var(--border-strong)",
                    color: isSelected ? "var(--brand-blue)" : "var(--text-main)",
                    opacity: simBusy !== null && !isRunning ? 0.6 : 1,
                    cursor: simBusy !== null ? "not-allowed" : "pointer",
                  }}
                >
                  {isRunning ? "📞 Calling kitchen line…" : p.label}
                </button>
              );
            })}

            <button
              type="button"
              className="chip-btn"
              onClick={handleToggleMic}
              style={{
                background: listening ? "var(--bg-red-soft)" : "#ffffff",
                borderColor: listening ? "var(--red-main)" : "var(--brand-blue)",
                color: listening ? "var(--red-text)" : "var(--brand-blue)",
                fontWeight: 700,
              }}
              title="Speak directly into your browser microphone"
            >
              {listening ? "⏹ Stop Listening…" : "🎤 Speak into Mic"}
            </button>
          </div>

          {listening && (
            <div
              className="banner info"
              style={{ marginTop: 12, padding: "11px 16px", alignItems: "center" }}
            >
              <div style={{ fontSize: 13.5, fontWeight: 600 }}>
                🔴 <strong>Listening now…</strong> Say an event or order (e.g.{" "}
                <em>“120-guest Saturday wedding brunch”</em> or{" "}
                <em>“100 litres of lactose-free milk by Monday”</em>)
                {micTranscript && (
                  <div style={{ marginTop: 4, color: "var(--brand-navy)", fontWeight: 700 }}>
                    “{micTranscript}”
                  </div>
                )}
              </div>
            </div>
          )}

          {micNote && !listening && (
            <div
              className="banner info"
              style={{ marginTop: 12, padding: "10px 16px", alignItems: "center" }}
            >
              <div style={{ fontSize: 13.5, fontWeight: 600 }}>{micNote}</div>
              <button type="button" className="link-quiet" onClick={() => setMicNote(null)}>
                Dismiss
              </button>
            </div>
          )}

          {simError && (
            <div className="banner error" style={{ marginTop: 12, padding: "12px 16px" }}>
              <div>{simError}</div>
              <button type="button" className="link-quiet" onClick={() => setSimError(null)}>
                Close
              </button>
            </div>
          )}

          {/* Live Transcript + One-Tap Mobile Approval Outcome */}
          {simResult && transcriptLines.length > 0 && (
            <div
              style={{
                marginTop: 16,
                background: "#ffffff",
                border: "1px solid var(--border-light)",
                borderRadius: 16,
                padding: "18px 20px",
                boxShadow: "var(--shadow-card)",
              }}
            >
              <div
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "center",
                  gap: 12,
                  flexWrap: "wrap",
                  marginBottom: 14,
                }}
              >
                <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                  <span className="pill blue">📞 Live Kitchen Call Transcript</span>
                  <span className="pill green">
                    ✓ No money spent on the call — saved as a non-ordering proposal
                  </span>
                  {mobileApproved && <span className="pill green">✓ Plan Approved on Phone</span>}
                </div>
                <button
                  type="button"
                  className="link-quiet"
                  onClick={() => {
                    setSimResult(null);
                    setTranscriptLines([]);
                    setActivePreset(null);
                  }}
                >
                  Close call preview
                </button>
              </div>

              <div style={{ display: "flex", flexDirection: "column", gap: 10, marginBottom: 16 }}>
                {transcriptLines.slice(0, visibleTurnCount).map((line, i) => {
                  const isAssistant =
                    line.role === "assistant" || /assistant|valio/i.test(line.speaker);
                  return (
                    <div
                      key={i}
                      style={{
                        display: "flex",
                        justifyContent: isAssistant ? "flex-end" : "flex-start",
                      }}
                    >
                      <div
                        style={{
                          maxWidth: "82%",
                          padding: "10px 14px",
                          borderRadius: 14,
                          background: isAssistant ? "var(--bg-blue-soft)" : "var(--bg-subtle)",
                          border: isAssistant
                            ? "1px solid #bfdbfe"
                            : "1px solid var(--border-light)",
                          fontSize: 13.5,
                          lineHeight: 1.45,
                        }}
                      >
                        <div
                          style={{
                            fontSize: 11.5,
                            fontWeight: 800,
                            color: isAssistant ? "var(--brand-blue)" : "var(--text-muted)",
                            marginBottom: 3,
                          }}
                        >
                          {isAssistant ? "🤖 " : "👨‍🍳 "}
                          {line.speaker}
                        </div>
                        <div style={{ color: "var(--text-main)", fontWeight: 500 }}>
                          {tidy(line.text)}
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>

              {simEvent && (
                <div
                  className="card-subtle"
                  style={{
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                    gap: 14,
                    flexWrap: "wrap",
                    marginBottom: 14,
                  }}
                >
                  <div>
                    <div style={{ fontWeight: 800, fontSize: 15 }}>
                      Proposal Saved: {simEvent.name} · {simEvent.guests} guests · {day(simEvent.date)}
                    </div>
                    <div style={{ fontSize: 13, color: "var(--text-muted)", marginTop: 2 }}>
                      {shortfallLines.length > 0
                        ? `${shortfallLines.length} pantry shortfalls priced (${estTotal != null ? money(estTotal) : "estimated"})`
                        : "Pantry stock & recipes checked"}{" "}
                      · Waiting for your mobile tap before scheduling orders
                    </div>
                  </div>
                  {estTotal != null && (
                    <div style={{ fontWeight: 800, fontSize: 18, color: "var(--brand-navy)" }}>
                      Est. {money(estTotal)}
                    </div>
                  )}
                </div>
              )}

              <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
                <button
                  type="button"
                  className="btn primary"
                  style={{ minHeight: 44, padding: "10px 18px" }}
                  onClick={() => void openMobilePreviewModal()}
                >
                  📱 Preview Mobile Approval Screen
                </button>

                {props.onNavigateTab && (
                  <button
                    type="button"
                    className="btn secondary"
                    style={{ minHeight: 44, padding: "10px 18px" }}
                    onClick={() => props.onNavigateTab?.("kitchen", "events")}
                  >
                    🎉 View in Events &amp; Banquets →
                  </button>
                )}

                {relativeApprovalPath && (
                  <a
                    href={relativeApprovalPath}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="link-quiet"
                    style={{ marginLeft: 4 }}
                  >
                    Open raw link in new tab ↗
                  </a>
                )}
              </div>
            </div>
          )}
        </div>
      </section>

      {/* Sleek Mobile Phone Frame Modal */}
      {mobileModalOpen && simResult && (
        <div
          className="modal-backdrop"
          onClick={(e) => {
            if (e.target === e.currentTarget) setMobileModalOpen(false);
          }}
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-label="Mobile Approval Screen Preview"
            style={{
              width: "100%",
              maxWidth: 416,
              background: "#0f172a",
              borderRadius: 38,
              padding: 12,
              boxShadow: "0 28px 60px rgba(15, 23, 42, 0.42)",
              border: "3px solid #334155",
            }}
          >
            {/* Phone Notch & Status Bar */}
            <div
              style={{
                background: "#f8fafc",
                borderRadius: 28,
                overflow: "hidden",
                maxHeight: "82vh",
                display: "flex",
                flexDirection: "column",
              }}
            >
              <div
                style={{
                  background: "#ffffff",
                  padding: "10px 18px 8px",
                  borderBottom: "1px solid var(--border-light)",
                }}
              >
                <div
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    alignItems: "center",
                    fontSize: 11.5,
                    fontWeight: 800,
                    color: "var(--text-main)",
                    marginBottom: 6,
                  }}
                >
                  <span>9:41</span>
                  <span
                    style={{
                      width: 68,
                      height: 16,
                      borderRadius: 99,
                      background: "#0f172a",
                      display: "inline-block",
                    }}
                  />
                  <span>5G · 100%</span>
                </div>
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                    gap: 8,
                    background: "var(--bg-subtle)",
                    borderRadius: 8,
                    padding: "5px 10px",
                    fontSize: 11.5,
                    color: "var(--text-muted)",
                  }}
                >
                  <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    🔒 valio-aimo.fi{relativeApprovalPath ?? "/approval/voice"}
                  </span>
                  {relativeApprovalPath && (
                    <a
                      href={relativeApprovalPath}
                      target="_blank"
                      rel="noopener noreferrer"
                      style={{
                        color: "var(--brand-blue)",
                        fontWeight: 700,
                        textDecoration: "none",
                        whiteSpace: "nowrap",
                      }}
                    >
                      Raw link ↗
                    </a>
                  )}
                </div>
              </div>

              {/* Scrollable Phone Screen Body */}
              <div style={{ padding: "18px 18px 20px", overflowY: "auto", flex: 1 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 14 }}>
                  <div
                    style={{
                      width: 30,
                      height: 30,
                      borderRadius: 8,
                      background: "var(--brand-navy)",
                      color: "#fff",
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      fontWeight: 800,
                      fontSize: 12,
                    }}
                  >
                    VA
                  </div>
                  <div style={{ fontSize: 13.5, fontWeight: 800, color: "var(--brand-navy)" }}>
                    Valio Aimo · Mobile Plan Sign-Off
                  </div>
                </div>

                {mobileHtmlStatus === "loading" ? (
                  <div className="card-subtle" style={{ textAlign: "center", padding: 28 }}>
                    Loading your one-tap mobile plan…
                  </div>
                ) : mobileApproved ? (
                  <div
                    className="banner success"
                    style={{ flexDirection: "column", gap: 8, padding: 18 }}
                  >
                    <div style={{ fontSize: 17, fontWeight: 800 }}>✓ Plan Approved!</div>
                    <div style={{ fontSize: 13.5, lineHeight: 1.5 }}>
                      This event is now scheduled for automatic ordering after a fresh live price and
                      stock check. Every order still stays inside your kitchen rules.
                    </div>
                  </div>
                ) : mobileHtmlStatus === "expired" ? (
                  <div className="banner warn" style={{ flexDirection: "column", gap: 8 }}>
                    <div style={{ fontWeight: 800 }}>This single-use link is no longer active</div>
                    <div style={{ fontSize: 13 }}>
                      It may have already been used or updated in Events &amp; Banquets.
                    </div>
                  </div>
                ) : (
                  <>
                    <h3 style={{ margin: "0 0 4px", fontSize: 18, fontWeight: 800 }}>
                      Review Event Purchase Plan
                    </h3>
                    <div style={{ fontSize: 13.5, color: "var(--text-muted)", marginBottom: 12 }}>
                      <strong>{simEvent?.name ?? "Kitchen Event Proposal"}</strong>
                      {simEvent?.date ? ` · ${day(simEvent.date)}` : ""}
                      {simEvent?.guests ? ` · ${simEvent.guests} guests` : ""}
                    </div>

                    <div
                      style={{
                        display: "grid",
                        gridTemplateColumns: "1fr 1fr",
                        gap: 8,
                        marginBottom: 14,
                      }}
                    >
                      <div className="card-subtle" style={{ padding: "9px 11px" }}>
                        <div style={{ fontSize: 11, fontWeight: 700, color: "var(--text-soft)" }}>
                          EST. ADDITIONAL SPEND
                        </div>
                        <div style={{ fontSize: 16, fontWeight: 800, color: "var(--text-main)" }}>
                          {estTotal != null ? money(estTotal) : "Checked live"}
                        </div>
                      </div>
                      <div className="card-subtle" style={{ padding: "9px 11px" }}>
                        <div style={{ fontSize: 11, fontWeight: 700, color: "var(--text-soft)" }}>
                          PLANNED DELIVERY
                        </div>
                        <div style={{ fontSize: 14.5, fontWeight: 800, color: "var(--green-text)" }}>
                          {simEvent?.deliverBy ? day(simEvent.deliverBy) : simEvent?.date ? day(simEvent.date) : "On schedule"}
                        </div>
                      </div>
                    </div>

                    {shortfallLines.length > 0 && (
                      <div style={{ marginBottom: 14 }}>
                        <div
                          style={{
                            fontSize: 11.5,
                            fontWeight: 800,
                            textTransform: "uppercase",
                            letterSpacing: "0.04em",
                            color: "var(--text-soft)",
                            marginBottom: 6,
                          }}
                        >
                          Items to Purchase
                        </div>
                        <div
                          className="card-subtle"
                          style={{
                            padding: "10px 12px",
                            display: "flex",
                            flexDirection: "column",
                            gap: 7,
                            fontSize: 12.5,
                          }}
                        >
                          {shortfallLines.slice(0, 6).map((line, i) => (
                            <div
                              key={i}
                              style={{
                                display: "flex",
                                justifyContent: "space-between",
                                gap: 8,
                                borderBottom:
                                  i < Math.min(shortfallLines.length, 6) - 1
                                    ? "1px solid var(--border-light)"
                                    : "none",
                                paddingBottom:
                                  i < Math.min(shortfallLines.length, 6) - 1 ? 6 : 0,
                              }}
                            >
                              <div>
                                <strong>{line.name}</strong> · {qty(line.shortfall, line.unit)}
                                {line.chosen && (
                                  <div style={{ color: "var(--text-muted)", fontSize: 11.5 }}>
                                    {line.chosen.productName}
                                  </div>
                                )}
                              </div>
                              <div style={{ fontWeight: 700, whiteSpace: "nowrap" }}>
                                {line.chosen ? money(line.chosen.totalPrice) : "—"}
                              </div>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}

                    {(simEvent?.plan?.flags?.length ?? 0) > 0 && (
                      <div
                        className="banner warn"
                        style={{ padding: "10px 12px", fontSize: 12.5, marginBottom: 12 }}
                      >
                        <div>
                          <strong>Heads-up:</strong> {tidy(simEvent!.plan!.flags!.join(" · "))}
                        </div>
                      </div>
                    )}

                    <div
                      style={{
                        background: "var(--bg-blue-soft)",
                        border: "1px solid #bfdbfe",
                        borderRadius: 10,
                        padding: "10px 12px",
                        fontSize: 12,
                        color: "#1e3a8a",
                        lineHeight: 1.45,
                        marginBottom: 14,
                      }}
                    >
                      Approving schedules purchasing after live price &amp; stock checks. Orders still
                      follow your kitchen rules — anything over your limit asks for separate OK.
                    </div>

                    {mobileModalError && (
                      <div
                        className="banner error"
                        style={{ padding: "10px 12px", fontSize: 12.5, marginBottom: 12 }}
                      >
                        <div>{mobileModalError}</div>
                      </div>
                    )}

                    <button
                      type="button"
                      className="btn primary full"
                      disabled={mobileApproving}
                      onClick={() => void handleApproveOnPhone()}
                    >
                      {mobileApproving
                        ? "Approving plan…"
                        : "✓ Approve Plan & Schedule Ordering"}
                    </button>
                  </>
                )}

                <div
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    alignItems: "center",
                    marginTop: 14,
                    paddingTop: 10,
                    borderTop: "1px solid var(--border-light)",
                  }}
                >
                  <button
                    type="button"
                    className="link-quiet"
                    onClick={() => setMobileModalOpen(false)}
                  >
                    Close phone preview
                  </button>
                  {props.onNavigateTab && (
                    <button
                      type="button"
                      className="link-quiet"
                      onClick={() => {
                        setMobileModalOpen(false);
                        props.onNavigateTab?.("kitchen", "events");
                      }}
                    >
                      Open Events &amp; Banquets →
                    </button>
                  )}
                </div>
              </div>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
