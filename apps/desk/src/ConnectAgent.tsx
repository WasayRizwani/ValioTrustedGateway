import { useCallback, useEffect, useMemo, useState } from "react";
import { api, nextMonday } from "./api";

type Identity = {
  id: string;
  name: string;
  side: "buyer" | "valio";
  job: string;
  capabilities: string[];
  cannot: string[];
  routes: string[];
  mcpTools: string[];
  apiKey: string;
  mcpEnv: Record<string, string>;
};
type Connect = {
  baseUrl: string;
  openapi: string;
  jwks: string;
  mcp: { command: string; transport: string; note: string };
  claimIssuer: string;
  identities: Identity[];
};
type Lang = "curl" | "typescript" | "python" | "mcp";

function copy(text: string, done: () => void) {
  void navigator.clipboard?.writeText(text).then(done, () => {});
}

function snippet(lang: Lang, who: Identity, base: string): string {
  const key = who.apiKey;
  const need = `{"productIntent":"lactose-free milk","quantity":1000,"unit":"litre","neededBy":"${nextMonday()}","constraints":{"lactoseFree":true}}`;
  const can = (r: string) => who.routes.includes(r) || who.routes[0]?.startsWith("All");
  if (lang === "mcp") {
    return JSON.stringify(
      {
        mcpServers: {
          "valio-aimo": {
            command: "npm",
            args: ["run", "mcp", "-w", "@tta/gateway"],
            cwd: "/path/to/this/repo",
            env: who.mcpEnv,
          },
        },
      },
      null,
      2,
    ) + `\n\n// Tools this key can see: ${who.mcpTools.join(", ")}`;
  }
  const steps: Array<{ title: string; method: string; path: string; body?: string }> = [];
  if (can("POST /v1/offers/rank")) steps.push({ title: "Compare live offers (price, delivery, allergens, signed origin)", method: "POST", path: "/v1/offers/rank", body: `{"need":${need}}` });
  if (can("POST /v1/quotes")) steps.push({ title: "Lock a firm price (valid ~30 min; availability is not held)", method: "POST", path: "/v1/quotes", body: `{"need":${need},"productIds":["<productId from the offers>"]}` });
  if (can("GET /v1/quotes/:id")) steps.push({ title: "Check a quote: status open | used | expired", method: "GET", path: "/v1/quotes/<quoteId>" });
  if (can("POST /v1/orders/intent")) steps.push({ title: "Propose an order from the quote — the mandate decides: auto_eligible or pending_approval", method: "POST", path: "/v1/orders/intent", body: `{"quoteId":"<quoteId>"}` });
  if (can("POST /v1/orders/:id/commit")) steps.push({ title: "Place it (only if auto_eligible, or a human approved)", method: "POST", path: "/v1/orders/<intentId>/commit", body: `{"idempotencyKey":"my-first-order"}` });
  if (can("GET /v1/kitchen/inventory")) steps.push({ title: "Read the kitchen's stock", method: "GET", path: "/v1/kitchen/inventory" });
  if (can("POST /v1/valio-agent/run")) steps.push({ title: "Run Valio's account check (files stock-out / price suggestions)", method: "POST", path: "/v1/valio-agent/run", body: "{}" });
  if (!steps.length) steps.push({ title: "Who am I, and what may I do?", method: "GET", path: "/v1/me" });

  if (lang === "curl")
    return steps
      .map((s) => `# ${s.title}\ncurl -s -X ${s.method} ${base}${s.path} \\\n  -H "X-API-Key: ${key}" -H "Content-Type: application/json"${s.body ? ` \\\n  -d '${s.body}'` : ""}`)
      .join("\n\n");
  if (lang === "typescript")
    return (
      `const BASE = "${base}";\nconst KEY = "${key}";\nconst call = async (method: string, path: string, body?: unknown) =>\n  (await fetch(BASE + path, { method, headers: { "X-API-Key": KEY, "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined })).json();\n\n` +
      steps.map((s) => `// ${s.title}\nawait call("${s.method}", "${s.path}"${s.body ? `, ${s.body}` : ""});`).join("\n\n")
    );
  return (
    `import requests\nBASE = "${base}"\nH = {"X-API-Key": "${key}"}\n\n` +
    steps.map((s) => `# ${s.title}\nrequests.${s.method.toLowerCase()}(BASE + "${s.path}", headers=H${s.body ? `, json=${s.body}` : ""}).json()`).join("\n\n")
  );
}

export function ConnectAgent() {
  const [data, setData] = useState<Connect | null>(null);
  const [sel, setSel] = useState("procurement");
  const [lang, setLang] = useState<Lang>("curl");
  const [reveal, setReveal] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);
  const [probe, setProbe] = useState<{ label: string; status: number; text: string; expectRefusal?: boolean } | null>(null);
  const [claim, setClaim] = useState<{ verify: { valid: boolean }; tampered: { valid: boolean }; attestation: Record<string, unknown> | null; product: string } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const next = await api<Connect>("/v1/connect");
      setData(next);
      setSel((cur) => {
        const current = next.identities.find((i) => i.id === cur);
        if (current && !current.apiKey.startsWith("<")) return cur;
        const preferred =
          next.identities.find((i) => i.id === "agent" && !i.apiKey.startsWith("<")) ??
          next.identities.find((i) => !i.apiKey.startsWith("<"));
        return preferred ? preferred.id : cur;
      });
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  const who = data?.identities.find((i) => i.id === sel) ?? null;
  const unconfiguredKey = Boolean(who?.apiKey.startsWith("<"));
  const code = useMemo(() => (data && who ? snippet(lang, who, data.baseUrl) : ""), [data, who, lang]);
  const masked = (k: string) => (reveal || k.startsWith("<") ? k : `${k.slice(0, 6)}••••••${k.slice(-3)}`);

  async function raw(key: string, method: string, path: string, body?: unknown) {
    const res = await fetch(path, { method, headers: { "X-API-Key": key, "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
    return { status: res.status, json: (await res.json().catch(() => ({}))) as Record<string, any> };
  }

  async function testKey() {
    if (!who || who.apiKey.startsWith("<")) return;
    setBusy("test");
    try {
      const r = await raw(who.apiKey, "GET", "/v1/me");
      setProbe({ label: "GET /v1/me", status: r.status, text: r.status === 200 ? `You are: ${r.json.agent?.name ?? "full buyer-side agent"} · role ${r.json.role} · can approve: ${r.json.canApprove}` : JSON.stringify(r.json) });
    } catch (e) {
      setProbe({ label: "GET /v1/me", status: 0, text: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(null);
    }
  }
  async function tryForbidden() {
    if (!who || who.apiKey.startsWith("<")) return;
    setBusy("forbidden");
    try {
      const r = await raw(who.apiKey, "POST", "/v1/orders/demo-order/approve", { snapshotHash: "x", authorizeMandateOverride: true });
      setProbe({ label: "Approve an order (buyer-only action)", status: r.status, text: String(r.json.message ?? JSON.stringify(r.json)).replace("/v1/orders/demo-order/approve", "/v1/orders/:id/approve"), expectRefusal: true });
    } catch (e) {
      setProbe({ label: "Approve an order (buyer-only action)", status: 0, text: e instanceof Error ? e.message : String(e), expectRefusal: true });
    } finally {
      setBusy(null);
    }
  }
  async function trustDemo() {
    if (!data) return;
    setBusy("claim");
    try {
      const src = data.identities.find((i) => i.id === "sourcing" && !i.apiKey.startsWith("<")) ?? data.identities.find((i) => !i.apiKey.startsWith("<"));
      if (!src) throw new Error("Sourcing identity not available");
      const ranked = await raw(src.apiKey, "POST", "/v1/offers/rank", {
        need: { productIntent: "lactose-free milk", quantity: 20, unit: "litre", neededBy: nextMonday(), constraints: { lactoseFree: true } },
      });
      const offer = ranked.json.offers?.[0];
      if (!offer?.priceClaim) throw new Error("no signed claim returned");
      const good = await raw(src.apiKey, "POST", "/v1/claims/verify", { claim: offer.priceClaim });
      const forged = structuredClone(offer.priceClaim);
      if (forged.claim.attestation) forged.claim.attestation.allergens = [];
      const bad = await raw(src.apiKey, "POST", "/v1/claims/verify", { claim: forged });
      setClaim({ verify: good.json as { valid: boolean }, tampered: bad.json as { valid: boolean }, attestation: offer.priceClaim.claim.attestation ?? null, product: offer.productName });
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }

  if (err && !data) return <div className="banner error">{err}</div>;
  if (!data || !who) return <p className="empty">Loading…</p>;

  return (
    <div className="home connect">
      <section className="panel">
        <span className="eyebrow">Least-Privilege Credentials &amp; Live Boundary Probes</span>
        <h2>1. Choose Who Your External Agent Acts As</h2>
        <p className="muted" style={{ margin: "0 0 0.5rem" }}>
          Each agent has a narrow API key enforced by the gateway on both REST and MCP. Select an identity below to inspect its capabilities and probe what happens when it tries to overstep its authority.
        </p>
        <div className="id-grid">
          {data.identities.map((i) => (
            <button key={i.id} type="button" className={`id-card ${i.side} ${i.id === sel ? "on" : ""}`} onClick={() => { setSel(i.id); setProbe(null); }}>
              <strong>{i.name.replace(" (all buyer-side powers, no approvals)", "")}</strong>
              <span>{i.side === "valio" ? "Valio's agent" : "Buyer side"}</span>
            </button>
          ))}
        </div>

        <div className="id-detail">
          <div className="row-between" style={{ flexWrap: "wrap", gap: "0.75rem", alignItems: "center", marginBottom: "0.65rem" }}>
            <p style={{ margin: 0, flex: "1 1 18rem" }}>{who.job}</p>
            <div className="actions" style={{ margin: 0 }}>
              <button
                type="button"
                className="btn primary"
                disabled={busy !== null || unconfiguredKey}
                title={unconfiguredKey ? "No demo key configured for this specialist identity on this customer account" : undefined}
                onClick={() => void testKey()}
              >
                ▶ Test key (GET /v1/me)
              </button>
              <button
                type="button"
                className="btn danger"
                disabled={busy !== null || unconfiguredKey}
                title={unconfiguredKey ? "No demo key configured for this specialist identity on this customer account" : undefined}
                onClick={() => void tryForbidden()}
              >
                ▶ Probe forbidden action (Approve → 403)
              </button>
            </div>
          </div>

          {unconfiguredKey && (
            <p className="tiny muted" style={{ margin: "0 0 0.55rem" }}>
              No specialist demo key is configured for this customer account — select an active identity (such as Your own agent) to run live API probes.
            </p>
          )}
          {probe && (
            <div className={`probe ${probe.expectRefusal ? (probe.status === 401 || probe.status === 403 ? "ok" : "refused") : probe.status < 300 ? "ok" : "refused"}`} style={{ marginBottom: "0.75rem", marginTop: 0 }}>
              {probe.expectRefusal ? (
                probe.status === 401 || probe.status === 403 ? (
                  <>
                    <strong>✓ Correctly refused by Gateway</strong> <span className="tiny">(HTTP {probe.status})</span> — {probe.label}
                    <div>{probe.text}</div>
                  </>
                ) : (
                  <>
                    <strong>✗ Not refused ({probe.status})</strong> — this key was allowed to {probe.label.toLowerCase()}, which it must not be.
                    <div>{probe.text}</div>
                  </>
                )
              ) : (
                <>
                  <code>{probe.label}</code> → <strong>HTTP {probe.status}</strong>
                  <div>{probe.text}</div>
                </>
              )}
            </div>
          )}

          <div className="two">
            <div>
              <h3>Can call ({who.routes.length})</h3>
              <ul className="routes">
                {who.routes.slice(0, 8).map((r) => (
                  <li key={r}><code>{r}</code></li>
                ))}
              </ul>
            </div>
            <div>
              <h3>Hard boundary (Cannot)</h3>
              <ul className="cannot">
                {who.cannot.map((c) => (
                  <li key={c}>{c}</li>
                ))}
              </ul>
              <h3>MCP tools exposed ({who.mcpTools.length})</h3>
              <div className="chips-inline">
                {who.mcpTools.slice(0, 10).map((t) => (
                  <span key={t} className="fact">{t}</span>
                ))}
              </div>
            </div>
          </div>

          <div className="keyrow">
            <span className="tiny muted">Scoped API key</span>
            <code>{masked(who.apiKey)}</code>
            <button type="button" className="link" onClick={() => setReveal(!reveal)}>{reveal ? "Hide" : "Reveal"}</button>
            <button type="button" className="link" onClick={() => copy(who.apiKey, () => { setCopied("key"); setTimeout(() => setCopied(null), 1200); })}>{copied === "key" ? "Copied ✓" : "Copy"}</button>
          </div>
        </div>
      </section>

      <div className="home-grid">
        <section className="panel">
          <span className="eyebrow">Ed25519 Signed Envelopes</span>
          <h2>2. Claim Verification &amp; Tamper Detection Lab</h2>
          <p className="muted" style={{ margin: "0 0 0.65rem" }}>
            Every price, availability, origin, and allergen response is wrapped in an Ed25519-signed claim envelope. Fetch a live signed claim and see what happens if its allergen list is tampered with.
          </p>
          <button type="button" className="btn primary" disabled={busy !== null} onClick={() => void trustDemo()}>
            {busy === "claim" ? "Fetching & verifying live claim…" : "▶ Fetch live signed claim & test tampering"}
          </button>
          {claim && (
            <div className="trust-demo">
              <div><strong>{claim.product.slice(0, 64)}</strong></div>
              <div className="tiny muted">Signed attestation: <code>{claim.attestation ? JSON.stringify(claim.attestation) : "—"}</code></div>
              <div className="verify-row ok">✓ Original Ed25519 claim → <strong>{claim.verify.valid ? "signature valid" : "INVALID"}</strong></div>
              <div className="verify-row bad">✗ Tampered claim (allergens stripped) → <strong>{claim.tampered.valid ? "valid?!" : "signature INVALID (tampering detected & rejected)"}</strong></div>
              <p className="tiny muted" style={{ margin: "0.2rem 0 0" }}>
                External agents can also verify offline using <code>/.well-known/jwks.json</code>.
              </p>
            </div>
          )}
        </section>

        <section className="panel">
          <span className="eyebrow">Open Interface Endpoints</span>
          <h2>3. OpenAPI, JWKS &amp; MCP Endpoints</h2>
          <p className="muted" style={{ margin: "0 0 0.65rem" }}>
            External agents connect via REST (OpenAPI) or Model Context Protocol (MCP).
          </p>
          <div className="endpoints">
            {[
              ["API base URL", data.baseUrl],
              ["OpenAPI spec", data.openapi],
              ["Signing keys (JWKS)", data.jwks],
              ["MCP server", data.mcp.command],
            ].map(([label, value]) => (
              <div key={label} className="ep">
                <span className="tiny muted">{label}</span>
                <code>{value}</code>
                <button type="button" className="link" onClick={() => copy(value, () => { setCopied(label); setTimeout(() => setCopied(null), 1200); })}>
                  {copied === label ? "Copied ✓" : "Copy"}
                </button>
              </div>
            ))}
          </div>
        </section>
      </div>

      <details className="panel">
        <summary style={{ cursor: "pointer", fontWeight: 600 }}>
          4. Ready-to-Run Client Code Samples for “{who.name.split(" (")[0]}” (curl / TypeScript / Python / MCP)
        </summary>
        <div className="row-between" style={{ flexWrap: "wrap", gap: "0.5rem", margin: "0.75rem 0 0.5rem" }}>
          <span className="tiny muted">Copy-pasteable requests scoped to this agent identity’s routes:</span>
          <div className="subtabs inline">
            {(["curl", "typescript", "python", "mcp"] as Lang[]).map((l) => (
              <button key={l} type="button" className={lang === l ? "active" : ""} onClick={() => setLang(l)}>
                {l === "mcp" ? "MCP (Claude Desktop)" : l}
              </button>
            ))}
          </div>
        </div>
        <pre className="code">{code}</pre>
        <button type="button" className="btn" style={{ marginTop: "0.6rem" }} onClick={() => copy(code, () => { setCopied("code"); setTimeout(() => setCopied(null), 1200); })}>
          {copied === "code" ? "Copied ✓" : "Copy sample"}
        </button>
      </details>
    </div>
  );
}
