import { useEffect, useState } from "react";
import { api } from "./api";

type ConnectIdentity = {
  id: string;
  name: string;
  job: string;
  mcpTools: string[];
  apiKey: string;
  mcpEnv: Record<string, string>;
};

type ConnectInfo = {
  baseUrl: string;
  mcp: { command: string; transport: string; note?: string };
  customerId: string;
  identities: ConnectIdentity[];
};

export function ConnectAgentModal(props: { open: boolean; onClose: () => void }) {
  const [info, setInfo] = useState<ConnectInfo | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string>("");
  const [copied, setCopied] = useState<"json" | "key" | null>(null);

  useEffect(() => {
    if (!props.open) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    setCopied(null);

    api<ConnectInfo>("/v1/connect")
      .then((res) => {
        if (cancelled) return;
        setInfo(res);
        if (res.identities.length > 0) {
          setSelectedId((prev) =>
            res.identities.some((i) => i.id === prev) ? prev : res.identities[0].id,
          );
        }
      })
      .catch((e) => {
        if (!cancelled) {
          setError(e instanceof Error ? e.message : "Could not load MCP connection details.");
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [props.open]);

  useEffect(() => {
    if (!props.open) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") props.onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [props.open, props.onClose]);

  if (!props.open) return null;

  const activeIdentity =
    info?.identities.find((i) => i.id === selectedId) ?? info?.identities[0] ?? null;

  const mcpConfig = {
    mcpServers: {
      "valio-aimo": {
        command: "npm",
        args: ["run", "mcp", "-w", "@tta/gateway"],
        env: activeIdentity?.mcpEnv ?? {
          VALIO_GATEWAY_API_KEY: activeIdentity?.apiKey ?? "hotel_sourcing_key_001",
        },
      },
    },
  };

  const mcpJson = JSON.stringify(mcpConfig, null, 2);

  async function copyText(kind: "json" | "key", text: string) {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(kind);
      window.setTimeout(() => setCopied((prev) => (prev === kind ? null : prev)), 2200);
    } catch {
      // Clipboard may be unavailable in restricted contexts
    }
  }

  return (
    <div className="modal-backdrop" onClick={props.onClose}>
      <div
        className="modal-card"
        role="dialog"
        aria-modal="true"
        aria-labelledby="connect-agent-modal-title"
        style={{ maxWidth: 680 }}
        onClick={(e) => e.stopPropagation()}
      >
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "flex-start",
            gap: 12,
            marginBottom: 16,
          }}
        >
          <div>
            <h2
              id="connect-agent-modal-title"
              style={{ margin: 0, fontSize: 20, fontWeight: 800 }}
            >
              Connect Your AI Agent
            </h2>
            <p style={{ margin: "4px 0 0", fontSize: 13.5, color: "var(--text-muted)" }}>
              Connect Claude Desktop, Cursor, or any MCP-compatible assistant to your kitchen&apos;s
              ordering gateway.
            </p>
          </div>
          <button
            type="button"
            className="btn secondary"
            style={{ minHeight: 38, padding: "6px 14px" }}
            onClick={props.onClose}
          >
            Close
          </button>
        </div>

        {loading && !info && (
          <div className="card-subtle" style={{ fontSize: 13.5, color: "var(--text-muted)" }}>
            Loading MCP configuration…
          </div>
        )}

        {error && (
          <div className="banner warn" style={{ marginBottom: 14, fontSize: 13.5 }}>
            <div>{error}</div>
          </div>
        )}

        {info && (
          <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
            {info.identities.length > 1 && (
              <div>
                <div style={{ fontWeight: 700, fontSize: 13, marginBottom: 6 }}>
                  Agent Role &amp; Permissions
                </div>
                <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                  {info.identities.map((ident) => {
                    const selected = ident.id === activeIdentity?.id;
                    return (
                      <button
                        key={ident.id}
                        type="button"
                        className={`chip-btn ${selected ? "selected" : ""}`}
                        style={
                          selected
                            ? {
                                background: "var(--bg-blue-soft)",
                                borderColor: "var(--brand-blue)",
                                color: "var(--brand-navy)",
                                fontWeight: 700,
                              }
                            : undefined
                        }
                        onClick={() => setSelectedId(ident.id)}
                      >
                        {ident.name}
                      </button>
                    );
                  })}
                </div>
                {activeIdentity?.job && (
                  <div style={{ fontSize: 12.5, color: "var(--text-muted)", marginTop: 6 }}>
                    {activeIdentity.job}
                  </div>
                )}
              </div>
            )}

            <div>
              <div
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "center",
                  marginBottom: 8,
                  gap: 8,
                }}
              >
                <span style={{ fontWeight: 700, fontSize: 13.5 }}>
                  MCP Configuration (<span className="mono">mcp.json</span>)
                </span>
                <button
                  type="button"
                  className="btn primary"
                  style={{ minHeight: 34, padding: "5px 14px", fontSize: 12.5 }}
                  onClick={() => void copyText("json", mcpJson)}
                >
                  {copied === "json" ? "✓ Copied mcp.json" : "Copy mcp.json"}
                </button>
              </div>
              <pre
                className="mono"
                style={{
                  margin: 0,
                  padding: "14px 16px",
                  borderRadius: 12,
                  background: "#0f172a",
                  color: "#e2e8f0",
                  fontSize: 12.5,
                  lineHeight: 1.55,
                  overflowX: "auto",
                }}
              >
                {mcpJson}
              </pre>
            </div>

            <div
              className="card-subtle"
              style={{
                display: "grid",
                gridTemplateColumns: "repeat(auto-fit, minmax(190px, 1fr))",
                gap: 10,
                fontSize: 12.5,
              }}
            >
              <div>
                <div style={{ color: "var(--text-muted)", fontWeight: 600 }}>Gateway URL</div>
                <div className="mono" style={{ fontWeight: 700, marginTop: 2 }}>
                  {info.baseUrl}
                </div>
              </div>
              <div>
                <div style={{ color: "var(--text-muted)", fontWeight: 600 }}>MCP Transport</div>
                <div className="mono" style={{ fontWeight: 700, marginTop: 2 }}>
                  {info.mcp.transport}
                </div>
              </div>
              {activeIdentity && (
                <div>
                  <div style={{ color: "var(--text-muted)", fontWeight: 600 }}>Scoped API Key</div>
                  <div
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 6,
                      marginTop: 2,
                    }}
                  >
                    <span className="mono" style={{ fontWeight: 700 }}>
                      {activeIdentity.apiKey.slice(0, 14)}…
                    </span>
                    <button
                      type="button"
                      className="link-quiet"
                      style={{ fontSize: 12 }}
                      onClick={() => void copyText("key", activeIdentity.apiKey)}
                    >
                      {copied === "key" ? "✓ Copied" : "Copy"}
                    </button>
                  </div>
                </div>
              )}
            </div>

            {activeIdentity && activeIdentity.mcpTools.length > 0 && (
              <div>
                <div style={{ fontWeight: 700, fontSize: 12.5, color: "var(--text-muted)", marginBottom: 6 }}>
                  Available MCP Tools ({activeIdentity.mcpTools.length})
                </div>
                <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                  {activeIdentity.mcpTools.map((tool) => (
                    <span key={tool} className="pill blue mono" style={{ fontSize: 11.5 }}>
                      {tool}
                    </span>
                  ))}
                </div>
              </div>
            )}

            <div style={{ fontSize: 12.5, color: "var(--text-muted)", lineHeight: 1.5 }}>
              Paste this into your AI client&apos;s <span className="mono">mcp.json</span> (e.g. Claude
              Desktop or Cursor) to let your agent search Valio Aimo® products, check stock, and
              submit orders governed by your kitchen&apos;s rules.
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
