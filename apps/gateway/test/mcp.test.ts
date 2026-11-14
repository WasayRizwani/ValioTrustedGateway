import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const here = dirname(fileURLToPath(import.meta.url));
const db = join(mkdtempSync(join(tmpdir(), "gw-mcp-")), "t.db");
const clients: Client[] = [];

async function connect(apiKey: string) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["--import", "tsx", resolve(here, "../src/mcp/stdio.ts")],
    env: { ...(process.env as Record<string, string>), VALIO_GATEWAY_API_KEY: apiKey, GATEWAY_DB_PATH: db },
    stderr: "ignore",
  });
  const client = new Client({ name: "test", version: "0" });
  await client.connect(transport);
  clients.push(client);
  const { tools } = await client.listTools();
  return { client, names: new Set(tools.map((t) => t.name)) };
}
after(async () => {
  await Promise.all(clients.map((c) => c.close().catch(() => undefined)));
});

test("MCP: tool list is filtered by the credential's scope", async () => {
  const [src, proc, valio, buyer] = await Promise.all([
    connect("hotel_sourcing_key_001"),
    connect("hotel_procurement_key_001"),
    connect("valio_account_key_001"),
    connect("hotel_buyer_key_001"),
  ]);

  // Sourcing: compare only
  assert.ok(src.names.has("rank_offers") && src.names.has("search_products"));
  for (const t of ["create_order_intent", "commit_order", "approve_order", "get_inventory", "get_recipes"]) assert.ok(!src.names.has(t), `sourcing must not see ${t}`);

  // Procurement: orders yes, kitchen + approval no
  assert.ok(proc.names.has("create_order_intent") && proc.names.has("commit_order"));
  for (const t of ["approve_order", "reject_order", "get_inventory", "get_recipes", "recommend_restock"]) assert.ok(!proc.names.has(t), `procurement must not see ${t}`);

  // Valio's agent: suggestions + catalog, never the buyer's kitchen or orders
  assert.ok(valio.names.has("run_account_check") && valio.names.has("list_suggestions"));
  for (const t of ["get_inventory", "get_recipes", "create_order_intent", "commit_order", "approve_order", "accept_suggestion"]) assert.ok(!valio.names.has(t), `valio must not see ${t}`);

  // Buyer sees everything, including the human-only tools
  for (const t of ["approve_order", "reject_order", "create_order_intent", "get_inventory", "run_account_check"]) assert.ok(buyer.names.has(t), `buyer should see ${t}`);
});

test("MCP: calling a tool outside the scope is refused even if you know its name", async () => {
  const src = await connect("hotel_sourcing_key_001");
  const r1 = (await src.client.callTool({ name: "create_order_intent", arguments: {} })) as { isError?: boolean; content: Array<{ text: string }> };
  assert.equal(r1.isError, true);
  assert.match(r1.content[0].text, /forbidden/);

  const valio = await connect("valio_account_key_001");
  const r2 = (await valio.client.callTool({ name: "get_inventory", arguments: {} })) as { isError?: boolean; content: Array<{ text: string }> };
  assert.equal(r2.isError, true);
  assert.match(r2.content[0].text, /forbidden/);
  const r3 = (await valio.client.callTool({ name: "approve_order", arguments: { intentId: "x", snapshotHash: "x" } })) as { isError?: boolean };
  assert.equal(r3.isError, true);
});

test("MCP: an allowed read works and returns data", async () => {
  const planner = await connect("hotel_planner_key_001");
  assert.ok(planner.names.has("get_inventory"));
  const r = (await planner.client.callTool({ name: "get_inventory", arguments: {} })) as { isError?: boolean; content: Array<{ text: string }> };
  assert.notEqual(r.isError, true);
  assert.ok(JSON.parse(r.content[0].text).inventory.length > 0);
});
