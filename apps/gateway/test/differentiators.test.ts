import "./setup-db.js";
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { config } from "../src/config.js";

let app: { request: (path: string, init?: RequestInit) => Promise<Response> };

before(async () => {
  app = (await import("../src/routes/api.js")).createApi() as typeof app;
});

const buyerHeaders = {
  "content-type": "application/json",
  "x-api-key": "hotel_buyer_key_001",
  host: "localhost:8787",
};

test("voice simulate works even when voiceMockMode=false, serves read-only HTML preview, and unlocks on buyer voice-approve", async () => {
  const prevMock = config.voiceMockMode;
  config.voiceMockMode = false;
  try {
    const simRes = await app.request("/v1/voice/simulate", {
      method: "POST",
      headers: buyerHeaders,
      body: JSON.stringify({ preset: "wedding" }),
    });
    assert.equal(simRes.status, 200);
    const sim = (await simRes.json()) as {
      eventId: string;
      approvalUrl: string;
      transcript: Array<{ speaker: string; text: string }>;
      event: { autoOrder: boolean; voice?: { approval: string } };
    };
    assert.ok(sim.eventId);
    assert.equal(sim.event.autoOrder, false);
    assert.equal(sim.event.voice?.approval, "pending");
    assert.ok(sim.transcript.length >= 4);
    assert.ok(sim.approvalUrl.includes("/approval/voice/"));

    const pathOnly = new URL(sim.approvalUrl, "http://localhost:8787").pathname;
    const previewRes = await app.request(pathOnly, { headers: { host: "con-notebooks-tab-quiz.trycloudflare.com" } });
    assert.equal(previewRes.status, 200);
    const html = await previewRes.text();
    assert.ok(html.includes("Review event purchase plan"));

    const approveRes = await app.request(`/v1/events/${sim.eventId}/voice-approve`, {
      method: "POST",
      headers: buyerHeaders,
      body: "{}",
    });
    assert.equal(approveRes.status, 200);
    const approved = (await approveRes.json()) as {
      ok: boolean;
      event: { autoOrder: boolean; voice?: { approval: string } };
    };
    assert.equal(approved.ok, true);
    assert.equal(approved.event.autoOrder, true);
    assert.equal(approved.event.voice?.approval, "approved");
  } finally {
    config.voiceMockMode = prevMock;
  }
});

test("mandate Time-Machine simulator returns counterfactual flipped orders and safety blocks", async () => {
  const curRes = await app.request("/v1/mandate", { headers: buyerHeaders });
  assert.equal(curRes.status, 200);
  const current = (await curRes.json()) as Record<string, unknown>;

  const stricterDraft = {
    ...current,
    maxOrderValueEur: 80,
    allergenRestrictions: ["must_be_lactose_free", "nuts", "peanut"],
  };
  const simRes = await app.request("/v1/mandate/simulate", {
    method: "POST",
    headers: buyerHeaders,
    body: JSON.stringify(stricterDraft),
  });
  assert.equal(simRes.status, 200);
  const sim = (await simRes.json()) as {
    totalSimulated: number;
    autoCommitCount: number;
    pendingApprovalCount: number;
    blockedCount: number;
    flippedOrders: unknown[];
  };
  assert.ok(sim.totalSimulated >= 14);
  assert.ok(sim.blockedCount >= 2);
  assert.ok(sim.flippedOrders.length >= 1);
});

test("Security Arena runs all 5 scenarios and audit tamper X-ray never mutates SQLite", async () => {
  const allRes = await app.request("/v1/arena/run", {
    method: "POST",
    headers: buyerHeaders,
    body: JSON.stringify({ scenario: "all" }),
  });
  assert.equal(allRes.status, 200);
  const allBody = (await allRes.json()) as {
    passed: boolean;
    results: Array<{ scenario: string; passed: boolean }>;
  };
  assert.equal(allBody.passed, true);
  assert.equal(allBody.results.length, 5);

  const singleRes = await app.request("/v1/arena/run", {
    method: "POST",
    headers: buyerHeaders,
    body: JSON.stringify({ scenario: "claim_tamper" }),
  });
  assert.equal(singleRes.status, 200);
  const single = (await singleRes.json()) as { runId: string; passed: boolean };
  assert.equal(single.passed, true);

  const tamperRes = await app.request(`/v1/audit/${single.runId}/simulate-tamper`, {
    method: "POST",
    headers: buyerHeaders,
    body: "{}",
  });
  assert.equal(tamperRes.status, 200);
  const tamper = (await tamperRes.json()) as {
    originalValid: boolean;
    tamperedValid: boolean;
    restoredClean: boolean;
  };
  assert.equal(tamper.originalValid, true);
  assert.equal(tamper.tamperedValid, false);
  assert.equal(tamper.restoredClean, true);

  // Verify underlying SQLite chain is still 100% valid
  const verifyRes = await app.request(`/v1/audit/${single.runId}/verify`, {
    method: "POST",
    headers: buyerHeaders,
    body: "{}",
  });
  const ver = (await verifyRes.json()) as { valid: boolean };
  assert.equal(ver.valid, true);
});

test("P-256 cryptographic buyer signature proof and pre-authorized cold-chain stock-out cascade execute cleanly", async () => {
  const neededBy = new Date(Date.now() + 4 * 86400_000).toISOString().slice(0, 10);
  const rankRes = await app.request("/v1/offers/rank", {
    method: "POST",
    headers: buyerHeaders,
    body: JSON.stringify({
      need: {
        productIntent: "lactose-free milk",
        quantity: 600,
        unit: "litre",
        neededBy,
        constraints: { lactoseFree: true },
      },
    }),
  });
  assert.equal(rankRes.status, 200);
  const ranked = (await rankRes.json()) as {
    offers: Array<{ productId: string; productName: string; totalPrice: number; canFulfil: boolean }>;
  };
  const deliverable = ranked.offers.filter((o) => o.canFulfil);
  assert.ok(deliverable.length >= 2);
  const primary = deliverable[0]!;
  const backup = deliverable[1]!;

  const intentRes = await app.request("/v1/orders/intent", {
    method: "POST",
    headers: buyerHeaders,
    body: JSON.stringify({
      need: {
        productIntent: "lactose-free milk",
        quantity: 600,
        unit: "litre",
        neededBy,
        constraints: { lactoseFree: true },
      },
      offerProductId: primary.productId,
    }),
  });
  assert.equal(intentRes.status, 200);
  const created = (await intentRes.json()) as {
    intent: { id: string; snapshotHash: string; status: string; policy: { failingRules: string[] } };
  };
  assert.equal(created.intent.status, "pending_approval");

  const chalRes = await app.request(`/v1/orders/${created.intent.id}/approve-challenge`, {
    method: "POST",
    headers: buyerHeaders,
    body: "{}",
  });
  assert.equal(chalRes.status, 200);
  const { challenge } = (await chalRes.json()) as { challenge: string };

  // Sign challenge with an ephemeral ECDSA P-256 keypair (IEEE-P1363 raw r||s, matching WebCrypto)
  const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const publicKeySpki = (publicKey.export({ type: "spki", format: "der" }) as Buffer).toString("base64");
  const signedMessage = JSON.stringify({ intentId: created.intent.id, challenge });
  const rawP1363 = sign("sha256", Buffer.from(signedMessage, "utf8"), {
    key: privateKey,
    dsaEncoding: "ieee-p1363",
  }).toString("base64");

  const approveRes = await app.request(`/v1/orders/${created.intent.id}/approve`, {
    method: "POST",
    headers: buyerHeaders,
    body: JSON.stringify({
      snapshotHash: created.intent.snapshotHash,
      authorizeMandateOverride: true,
      acknowledgedRules: created.intent.policy.failingRules,
      humanSignature: {
        mode: "webcrypto_p256",
        credentialId: "p256-test-cred",
        publicKeySpki,
        signedMessage,
        signature: rawP1363,
        signerLabel: "Buyer P-256 Hardware Test Key",
      },
      authorizedFallback: {
        productId: backup.productId,
        productName: backup.productName,
        maxTotalPrice: Math.max(primary.totalPrice, backup.totalPrice) * 1.25 + 50,
      },
    }),
  });
  assert.equal(approveRes.status, 200);
  const approvedIntent = (await approveRes.json()) as {
    status: string;
    meta?: { humanSignatureProof?: { verified: boolean } };
  };
  assert.equal(approvedIntent.status, "approved");
  assert.equal(approvedIntent.meta?.humanSignatureProof?.verified, true);

  // Trigger simulated warehouse stock-out on primary SKU right before commit
  await app.request("/v1/admin/simulate-stockout", {
    method: "POST",
    headers: buyerHeaders,
    body: JSON.stringify({ productId: primary.productId, active: true }),
  });

  try {
    const commitRes = await app.request(`/v1/orders/${created.intent.id}/commit`, {
      method: "POST",
      headers: buyerHeaders,
      body: JSON.stringify({ idempotencyKey: `cascade-test-${created.intent.id}` }),
    });
    assert.equal(commitRes.status, 200);
    const committed = (await commitRes.json()) as {
      intent: {
        status: string;
        basket: Array<{ productId: string }>;
        meta?: { cascadeExecuted?: { backupProductId: string; droppedProductId: string } };
      };
    };
    assert.equal(committed.intent.status, "committed");
    assert.equal(committed.intent.basket[0]?.productId, backup.productId);
    assert.equal(committed.intent.meta?.cascadeExecuted?.droppedProductId, primary.productId);
    assert.equal(committed.intent.meta?.cascadeExecuted?.backupProductId, backup.productId);
  } finally {
    await app.request("/v1/admin/simulate-stockout", {
      method: "POST",
      headers: buyerHeaders,
      body: JSON.stringify({ productId: primary.productId, active: false }),
    });
  }
});

test("scoped agent keys are blocked 403 from arena, mandate simulator, and voice simulator", async () => {
  const agentHeaders = {
    "content-type": "application/json",
    "x-api-key": "hotel_demo_key_001",
    host: "localhost:8787",
  };
  for (const path of ["/v1/arena/run", "/v1/mandate/simulate", "/v1/voice/simulate"]) {
    const res = await app.request(path, { method: "POST", headers: agentHeaders, body: "{}" });
    assert.equal(res.status, 403, `Expected 403 on ${path} for agent credential`);
  }
});
