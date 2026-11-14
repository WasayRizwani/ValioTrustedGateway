const GATEWAY = "http://localhost:8787";
const KEY = "hotel_buyer_key_001"; // approvals require a buyer credential

async function api(path: string, init?: RequestInit) {
  const res = await fetch(`${GATEWAY}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      "X-API-Key": KEY,
      ...(init?.headers ?? {}),
    },
  });
  const j = await res.json();
  if (!res.ok) {
    throw new Error(j.error || JSON.stringify(j));
  }
  return j;
}

function localDate(d: Date) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

const d = new Date();
let delta = (1 - d.getDay() + 7) % 7;
if (!delta) delta = 7;
d.setDate(d.getDate() + delta);
const neededBy = localDate(d);

const need = {
  productIntent: "lactose-free milk",
  quantity: 1000,
  unit: "litre",
  neededBy,
  constraints: { lactoseFree: true, keywords: ["lactose-free", "milk"] },
};

const { intent } = await api("/v1/orders/intent", {
  method: "POST",
  body: JSON.stringify({ need }),
});
console.log("status", intent.status, "failing", intent.policy.failingRules, "total", intent.totalPrice);

try {
  await api(`/v1/orders/${intent.id}/approve`, {
    method: "POST",
    body: JSON.stringify({ snapshotHash: intent.snapshotHash }),
  });
  console.log("SILENT APPROVE SHOULD HAVE FAILED");
} catch (e) {
  console.log("silent blocked OK:", e instanceof Error ? e.message.slice(0, 100) : e);
}

const approved = await api(`/v1/orders/${intent.id}/approve`, {
  method: "POST",
  body: JSON.stringify({
    snapshotHash: intent.snapshotHash,
    authorizeMandateOverride: true,
    acknowledgedRules: intent.policy.failingRules,
  }),
});
console.log("explicit override:", approved.status);

const commit = await api(`/v1/orders/${intent.id}/commit`, {
  method: "POST",
  body: JSON.stringify({ idempotencyKey: "ui-override-test-" + intent.id }),
});
console.log("committed", commit.confirmation.orderId);
