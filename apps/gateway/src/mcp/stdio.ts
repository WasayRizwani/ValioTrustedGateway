import { startMcpServer } from "./server.js";
import { config } from "../config.js";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { generateKeyPairSync } from "node:crypto";
import { getDb } from "../audit/chain.js";
import { loadCatalog } from "../catalog/index.js";

function ensureKeys() {
  mkdirSync(config.keysDir, { recursive: true });
  const privPath = resolve(config.keysDir, "claim-ed25519-private.pem");
  const pubPath = resolve(config.keysDir, "claim-ed25519-public.pem");
  if (!existsSync(privPath) || !existsSync(pubPath)) {
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    writeFileSync(privPath, privateKey.export({ type: "pkcs8", format: "pem" }));
    writeFileSync(pubPath, publicKey.export({ type: "spki", format: "pem" }));
  }
}

ensureKeys();
getDb();
loadCatalog();
await startMcpServer();
