import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, "../../..");

function loadEnvFile() {
  const envPath = resolve(root, ".env");
  if (!existsSync(envPath)) return;
  for (const line of readFileSync(envPath, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq < 0) continue;
    const key = trimmed.slice(0, eq);
    const value = trimmed.slice(eq + 1);
    if (!(key in process.env)) process.env[key] = value;
  }
}

loadEnvFile();

export const config = {
  root,
  port: Number(process.env.GATEWAY_PORT ?? 8787),
  publicUrl: process.env.GATEWAY_PUBLIC_URL ?? "http://localhost:8787",
  valioBaseUrl: process.env.VALIO_BASE_URL ?? "https://junction26.valioaimo.fi",
  valioApiKey: process.env.VALIO_API_KEY ?? "",
  claimKeyId: process.env.CLAIM_KEY_ID ?? "demo-key-01",
  dataDir: resolve(root, "data"),
  keysDir: resolve(root, "keys"),
  dbPath: process.env.GATEWAY_DB_PATH ?? resolve(root, "data", "gateway.db"),
  /** Firm-price guarantee window of a quote, in minutes. */
  quoteTtlMinutes: Number(process.env.QUOTE_TTL_MINUTES ?? 30),
  openaiApiKey: process.env.OPENAI_API_KEY ?? "",
  openaiBaseUrl: process.env.OPENAI_BASE_URL ?? "https://api.openai.com/v1",
  llmModel: process.env.LLM_MODEL ?? "gpt-4o-mini",
  llmReasoningEffort: process.env.LLM_REASONING_EFFORT ?? "low",
  geminiApiKey: process.env.GEMINI_API_KEY ?? "",
  geminiModel: process.env.GEMINI_MODEL ?? "gemini-4-argon",
  geminiBaseUrl: process.env.GEMINI_BASE_URL ?? "https://generativelanguage.googleapis.com/v1beta/openai",
  vapiWebhookSecret: process.env.VAPI_WEBHOOK_SECRET ?? "",
  resendApiKey: process.env.RESEND_API_KEY ?? "",
  emailFrom: process.env.EMAIL_FROM ?? "",
  voicePublicNumber: process.env.VOICE_PUBLIC_NUMBER ?? "",
  voiceApprovalBaseUrl: process.env.VOICE_APPROVAL_BASE_URL ?? process.env.GATEWAY_PUBLIC_URL ?? "",
  voiceMockMode: process.env.VOICE_MOCK_MODE === "true",
  voiceCallerMap: (() => { try { return JSON.parse(process.env.VOICE_CALLER_MAP_JSON ?? "{}") as Record<string, { customerId: string; buyerEmail: string }>; } catch { return {}; } })(),
  anthropicApiKey: process.env.ANTHROPIC_API_KEY ?? "",
  anthropicModel: process.env.ANTHROPIC_MODEL ?? "claude-sonnet-4-5",
  apiKeys: {
    [process.env.DEMO_API_KEY_HOTEL ?? "hotel_demo_key_001"]: "HOTEL-001",
    [process.env.DEMO_API_KEY_SCHOOL ?? "school_demo_key_001"]: "SCHOOL-001",
  } as Record<string, string>,
};

export type Role = "agent" | "buyer" | "valio";
/**
 * Credentials carry a ROLE. An *agent* key can search, quote and place orders that sit inside the
 * mandate. Only a *buyer* key (a human or the buyer's own approval client) can approve, reject,
 * override policy or change the mandate / standing instructions. The agent can never self-escalate.
 */
export const credentials: Record<string, { customerId: string; role: Role; agentId?: string }> = {
  ...Object.fromEntries(
    Object.entries(config.apiKeys).map(([k, c]) => [k, { customerId: c, role: "agent" as Role }]),
  ),
  [process.env.DEMO_BUYER_KEY_HOTEL ?? "hotel_buyer_key_001"]: { customerId: "HOTEL-001", role: "buyer" },
  [process.env.DEMO_BUYER_KEY_SCHOOL ?? "school_buyer_key_001"]: { customerId: "SCHOOL-001", role: "buyer" },
  // The agent team — each key is scoped to ONE agent's capabilities (see agents/registry.ts).
  [process.env.DEMO_AGENT_KEY_SOURCING ?? "hotel_sourcing_key_001"]: { customerId: "HOTEL-001", role: "agent", agentId: "sourcing" },
  [process.env.DEMO_AGENT_KEY_PLANNER ?? "hotel_planner_key_001"]: { customerId: "HOTEL-001", role: "agent", agentId: "planner" },
  [process.env.DEMO_AGENT_KEY_PROCUREMENT ?? "hotel_procurement_key_001"]: { customerId: "HOTEL-001", role: "agent", agentId: "procurement" },
  // Valio's own agent, acting on the HOTEL-001 account relationship.
  [process.env.DEMO_AGENT_KEY_VALIO ?? "valio_account_key_001"]: { customerId: "HOTEL-001", role: "valio", agentId: "valio-account" },
};
