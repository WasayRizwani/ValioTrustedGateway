import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { config } from "../config.js";

async function download(path: string, outName: string) {
  const out = resolve(config.dataDir, outName);
  if (existsSync(out)) {
    console.log("Exists, skip:", outName);
    return;
  }
  const url = `${config.valioBaseUrl}${path}`;
  console.log("Fetching", url);
  const res = await fetch(url, {
    headers: { "X-API-Key": config.valioApiKey },
    redirect: "follow",
  });
  if (!res.ok) {
    throw new Error(`Failed ${path}: ${res.status} ${await res.text()}`);
  }
  const buf = Buffer.from(await res.arrayBuffer());
  writeFileSync(out, buf);
  console.log("Wrote", outName, buf.length, "bytes");
}

mkdirSync(config.dataDir, { recursive: true });

// Portal links may redirect; try API download endpoints first
const candidates: Array<[string, string]> = [
  ["/api/products/download", "products.json"],
  ["/api/delivery-reliability/download", "delivery-reliability.csv"],
  ["/api/carbon-footprint/download", "carbon-footprint.csv"],
];

for (const [path, name] of candidates) {
  await download(path, name);
}

// Ping
const ping = await fetch(`${config.valioBaseUrl}/api/ping`, {
  headers: { "X-API-Key": config.valioApiKey },
});
console.log("Ping:", ping.status, await ping.text());
