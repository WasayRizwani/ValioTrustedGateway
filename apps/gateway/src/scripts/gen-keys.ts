import { generateKeyPairSync } from "node:crypto";
import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { config } from "../config.js";

mkdirSync(config.keysDir, { recursive: true });
const privPath = resolve(config.keysDir, "claim-ed25519-private.pem");
const pubPath = resolve(config.keysDir, "claim-ed25519-public.pem");

if (existsSync(privPath) && existsSync(pubPath)) {
  console.log("Keys already exist:", config.keysDir);
  process.exit(0);
}

const { publicKey, privateKey } = generateKeyPairSync("ed25519");
writeFileSync(privPath, privateKey.export({ type: "pkcs8", format: "pem" }));
writeFileSync(pubPath, publicKey.export({ type: "spki", format: "pem" }));
console.log("Generated Ed25519 claim keys in", config.keysDir);
