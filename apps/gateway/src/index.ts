import { startStandingScheduler } from "./hotel/standing.js";
import { startEventScheduler } from "./hotel/events.js";
import { serve } from "@hono/node-server";
import { createApi } from "./routes/api.js";
import { config } from "./config.js";
import { loadCatalog } from "./catalog/index.js";
import { initDb, closeDb } from "./audit/chain.js";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { generateKeyPairSync } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { startRestockScheduler } from "./hotel/restock-automation.js";

function ensureKeys() {
  mkdirSync(config.keysDir, { recursive: true });
  const privPath = resolve(config.keysDir, "claim-ed25519-private.pem");
  const pubPath = resolve(config.keysDir, "claim-ed25519-public.pem");
  if (!existsSync(privPath) || !existsSync(pubPath)) {
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    writeFileSync(privPath, privateKey.export({ type: "pkcs8", format: "pem" }));
    writeFileSync(pubPath, publicKey.export({ type: "spki", format: "pem" }));
    console.log("Generated claim signing keys");
  }
}

ensureKeys();
await initDb();
loadCatalog();

const app = createApi();

console.log(`Valio Aimo Agent Gateway listening on http://0.0.0.0:${config.port}`);
console.log(`OpenAPI: http://localhost:${config.port}/openapi.json`);
console.log(`JWKS:    http://localhost:${config.port}/.well-known/jwks.json`);

const scheduledCustomers = [...new Set(Object.values(config.apiKeys))];
startRestockScheduler(scheduledCustomers);
startStandingScheduler(scheduledCustomers);
startEventScheduler(scheduledCustomers);

const server = serve({ fetch: app.fetch, port: config.port, hostname: "0.0.0.0" });

let shuttingDown = false;
async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  server.close();
  await closeDb().catch(() => {});
  process.exit(0);
}
process.once("SIGINT", () => void shutdown());
process.once("SIGTERM", () => void shutdown());
