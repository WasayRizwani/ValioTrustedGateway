import { useCallback, useEffect, useState } from "react";
import { api } from "./api";
import { money, day, qty, unitLabel, tidy } from "./format";

type Unit = "kg" | "litre" | "each" | "pack";
type Ingredient = {
  ingredientId: string;
  name: string;
  onHand: number;
  onOrder?: number;
  unit: Unit;
  parLevel: number;
  lactoseFreePreferred?: boolean;
  excludeAllergens?: string[];
  unitWeightKg?: number;
  catalogHints: string[];
};
type Recipe = {
  recipeId: string;
  name: string;
  servingsPerBatch: number;
  batchesPerWeek: number;
  ingredients: Array<{ ingredientId: string; qtyPerBatch: number; unit: Unit }>;
};
type PastOrder = {
  orderId: string;
  orderedAt: string;
  status: string;
  lines: Array<{ productName: string; quantity: number; unit: string; ingredientId?: string }>;
};
type PlanLine = {
  ingredientId: string;
  name: string;
  unit: string;
  required: number;
  onHand: number;
  onOrder: number;
  shortfall: number;
  usedBy: string[];
  status: string;
  explanation: string;
  chosen?: { productName: string; totalPrice: number; availableDate: string | null; isSubstitution: boolean };
  substitutes: Array<{ label: string; productName: string; totalPrice: number; tradeOff: string }>;
  intent?: { id: string; status: string; reasons: string[] };
};
type Plan = { summary: string; flags: string[]; lines: PlanLine[]; affectedRecipes?: string[] };

const UNITS: Unit[] = ["kg", "litre", "each", "pack"];

function tomorrow(days = 1): string {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

const STATUS_TAG: Record<string, string> = {
  covered: "tag best",
  sourced: "tag best",
  substitute_proposed: "tag",
  partial: "tag warn",
  unsourceable: "tag warn",
};

export function KitchenTools(props: {
  section: "recipes" | "inbound" | "planner" | "data";
  onChanged: () => void;
  onError: (m: string | null) => void;
  onMessage: (m: string | null) => void;
}) {
  const { section, onChanged, onError, onMessage } = props;
  const [inv, setInv] = useState<Ingredient[]>([]);
  const [recipes, setRecipes] = useState<Recipe[]>([]);
  const [orders, setOrders] = useState<PastOrder[]>([]);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const [i, r, o] = await Promise.all([
        api<{ inventory: Ingredient[] }>("/v1/kitchen/inventory"),
        api<{ recipes: Recipe[] }>("/v1/kitchen/recipes"),
        api<{ orders: PastOrder[] }>("/v1/kitchen/order-history"),
      ]);
      setInv(i.inventory);
      setRecipes(r.recipes);
      setOrders(o.orders);
    } catch (e) {
      onError(e instanceof Error ? e.message : String(e));
    }
  }, [onError]);

  useEffect(() => {
    void load();
  }, [load]);

  async function act<T>(fn: () => Promise<T>, ok?: string) {
    setBusy(true);
    onError(null);
    try {
      const res = await fn();
      if (ok) onMessage(ok);
      await load();
      onChanged();
      return res;
    } catch (e) {
      onError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  // ── inventory ──
  const [newIng, setNewIng] = useState({ name: "", onHand: 0, parLevel: 0, unit: "kg" as Unit, hint: "", lf: false });
  const saveIngredient = (i: Partial<Ingredient> & { name: string }) =>
    act(
      () => api("/v1/kitchen/inventory", { method: "PUT", body: JSON.stringify({ items: [i] }) }),
      `Saved ${i.name}`,
    );

  // ── recipes ──
  const blankRecipe = (): Recipe => ({
    recipeId: "",
    name: "",
    servingsPerBatch: 20,
    batchesPerWeek: 3,
    ingredients: [],
  });
  const [draft, setDraft] = useState<Recipe | null>(null);

  // ── import ──
  const [importText, setImportText] = useState("");

  // ── planner ──
  const [neededBy, setNeededBy] = useState(tomorrow(1));
  const [selected, setSelected] = useState<Record<string, number>>({});
  const [plan, setPlan] = useState<Plan | null>(null);
  const [stockIng, setStockIng] = useState("");

  const runPlan = (createIntents: boolean) =>
    act(async () => {
      const picks = Object.entries(selected).filter(([, b]) => b > 0);
      const body = {
        neededBy,
        createIntents,
        recipes: picks.length ? picks.map(([recipeId, batches]) => ({ recipeId, batches })) : undefined,
      };
      setPlan(await api<Plan>("/v1/kitchen/plan", { method: "POST", body: JSON.stringify(body) }));
    }, createIntents ? "Order intents created — check Approval" : undefined);

  const runStockout = (createIntents: boolean) =>
    act(async () => {
      if (!stockIng) throw new Error("Pick the ingredient that ran out");
      setPlan(
        await api<Plan>("/v1/kitchen/stockout", {
          method: "POST",
          body: JSON.stringify({ ingredientId: stockIng, neededBy, createIntents }),
        }),
      );
    });

  const inbound = orders.filter((o) => o.status === "committed");

  return (
    <>
      {section === "recipes" && (
        <section className="panel">
          <div className="row-between">
            <h2>Recipes</h2>
            <button type="button" className="btn primary" onClick={() => setDraft(blankRecipe())}>
              New recipe
            </button>
          </div>
          <ul className="list">
            {recipes.map((r) => (
              <li key={r.recipeId}>
                <strong>{r.name}</strong>
                <div className="tiny muted">
                  {r.batchesPerWeek} batches/week · {r.servingsPerBatch} servings/batch
                </div>
                <div className="tiny">
                  {r.ingredients
                    .map((x) => `${inv.find((i) => i.ingredientId === x.ingredientId)?.name ?? x.ingredientId} ${qty(x.qtyPerBatch, x.unit)}`)
                    .join(" · ")}
                </div>
                <div className="actions" style={{ marginTop: "0.3rem" }}>
                  <button type="button" className="btn" onClick={() => setDraft(JSON.parse(JSON.stringify(r)))}>
                    Edit
                  </button>
                  <button
                    type="button"
                    className="btn"
                    disabled={busy}
                    title="Deducts the ingredients from on-hand stock"
                    onClick={() =>
                      void act(
                        () => api(`/v1/kitchen/recipes/${r.recipeId}/cook`, { method: "POST", body: JSON.stringify({ batches: 1 }) }),
                        `Cooked 1 batch of ${r.name} — stock updated`,
                      )
                    }
                  >
                    Cook 1 batch
                  </button>
                  <button
                    type="button"
                    className="btn"
                    disabled={busy}
                    onClick={() =>
                      void act(() => api(`/v1/kitchen/recipes/${r.recipeId}`, { method: "DELETE" }), `Deleted ${r.name}`)
                    }
                  >
                    Delete
                  </button>
                </div>
              </li>
            ))}
          </ul>

          {draft && (
            <div className="panel" style={{ marginTop: "0.8rem" }}>
              <h3>{draft.recipeId ? "Edit recipe" : "New recipe"}</h3>
              <div className="form-grid">
                <label className="full">
                  Name
                  <input value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
                </label>
                <label>
                  Servings / batch
                  <input type="number" value={draft.servingsPerBatch} onChange={(e) => setDraft({ ...draft, servingsPerBatch: Number(e.target.value) })} />
                </label>
                <label>
                  Batches / week
                  <input type="number" value={draft.batchesPerWeek} onChange={(e) => setDraft({ ...draft, batchesPerWeek: Number(e.target.value) })} />
                </label>
              </div>
              <h3 style={{ marginTop: "0.6rem" }}>Ingredients per batch</h3>
              {draft.ingredients.map((row, idx) => (
                <div key={idx} className="row-between" style={{ gap: "0.4rem", marginBottom: "0.3rem" }}>
                  <select
                    value={row.ingredientId}
                    onChange={(e) => {
                      const ing = inv.find((i) => i.ingredientId === e.target.value);
                      const next = [...draft.ingredients];
                      next[idx] = { ...row, ingredientId: e.target.value, unit: ing?.unit ?? row.unit };
                      setDraft({ ...draft, ingredients: next });
                    }}
                  >
                    <option value="">Select…</option>
                    {inv.map((i) => (
                      <option key={i.ingredientId} value={i.ingredientId}>
                        {i.name}
                      </option>
                    ))}
                  </select>
                  <input
                    type="number"
                    style={{ width: "5.5rem" }}
                    value={row.qtyPerBatch}
                    onChange={(e) => {
                      const next = [...draft.ingredients];
                      next[idx] = { ...row, qtyPerBatch: Number(e.target.value) };
                      setDraft({ ...draft, ingredients: next });
                    }}
                  />
                  <span className="tiny muted">{unitLabel(row.unit)}</span>
                  <button
                    type="button"
                    className="btn"
                    onClick={() => setDraft({ ...draft, ingredients: draft.ingredients.filter((_, k) => k !== idx) })}
                  >
                    ✕
                  </button>
                </div>
              ))}
              <div className="actions" style={{ marginTop: "0.5rem" }}>
                <button
                  type="button"
                  className="btn"
                  onClick={() =>
                    setDraft({
                      ...draft,
                      ingredients: [...draft.ingredients, { ingredientId: "", qtyPerBatch: 1, unit: "kg" }],
                    })
                  }
                >
                  + Ingredient
                </button>
                <button
                  type="button"
                  className="btn primary"
                  disabled={busy || !draft.name.trim() || !draft.ingredients.length}
                  onClick={async () => {
                    const body = { ...draft, recipeId: draft.recipeId || undefined };
                    await act(() => api("/v1/kitchen/recipes", { method: "POST", body: JSON.stringify(body) }), `Saved ${draft.name}`);
                    setDraft(null);
                  }}
                >
                  Save recipe
                </button>
                <button type="button" className="btn" onClick={() => setDraft(null)}>
                  Cancel
                </button>
              </div>
            </div>
          )}
        </section>
      )}

      {section === "inbound" && inbound.length > 0 && (
      <section className="panel">
        <div className="row-between">
          <div>
            <h2>Inbound orders</h2>
            <p className="muted">
              Committed Valio orders count as stock-on-order so the agent never double-orders. Mark received to add them to on-hand.
            </p>
          </div>
        </div>
        <ul className="list">
          {inbound.map((o) => (
            <li key={o.orderId}>
              <div className="row-between">
                <div>
                  <strong>
                    {o.orderId} · {day(o.orderedAt)}
                  </strong>
                  {o.lines.map((l, k) => (
                    <div key={k} className="tiny muted">
                      {l.productName}: {qty(l.quantity, l.unit)}
                      {l.ingredientId ? "" : " (not linked to an ingredient — stock won't update)"}
                    </div>
                  ))}
                </div>
                <button
                  type="button"
                  className="btn primary"
                  disabled={busy}
                  onClick={() =>
                    void act(
                      () => api("/v1/kitchen/deliveries", { method: "POST", body: JSON.stringify({ orderId: o.orderId }) }),
                      `Received ${o.orderId} — stock updated`,
                    )
                  }
                >
                  Mark received
                </button>
              </div>
            </li>
          ))}
        </ul>
      </section>
      )}

      {section === "planner" && (
      <section className="panel">
        <h2>Menu & event planner</h2>
        <p className="muted">
          Pick what you'll cook. The agent turns recipes into ingredient needs, subtracts stock and open orders, asks Valio only about the
          shortfall, and proposes recipe-compatible substitutes (lactose/allergen rules kept) when the exact item can't arrive in time.
        </p>
        <div className="form-grid">
          <label>
            Needed by
            <input type="date" value={neededBy} onChange={(e) => setNeededBy(e.target.value)} />
          </label>
        </div>
        <ul className="list">
          {recipes.map((r) => (
            <li key={r.recipeId}>
              <label style={{ display: "flex", gap: "0.5rem", alignItems: "center" }}>
                <input
                  type="checkbox"
                  checked={r.recipeId in selected}
                  onChange={(e) => {
                    const next = { ...selected };
                    if (e.target.checked) next[r.recipeId] = r.batchesPerWeek;
                    else delete next[r.recipeId];
                    setSelected(next);
                  }}
                />
                {r.name}
                {r.recipeId in selected && (
                  <>
                    <input
                      type="number"
                      min={1}
                      style={{ width: "4.5rem" }}
                      value={selected[r.recipeId]}
                      onChange={(e) => setSelected({ ...selected, [r.recipeId]: Number(e.target.value) })}
                    />
                    <span className="tiny muted">batches</span>
                  </>
                )}
              </label>
            </li>
          ))}
        </ul>
        <div className="actions" style={{ marginTop: "0.6rem" }}>
          <button type="button" className="btn primary" disabled={busy} onClick={() => void runPlan(false)}>
            Check sourcing
          </button>
          <button type="button" className="btn" disabled={busy || !plan} onClick={() => void runPlan(true)}>
            Create order intents
          </button>
        </div>

        <h3 style={{ marginTop: "1rem" }}>Supplier stock-out</h3>
        <div className="row-between" style={{ gap: "0.5rem" }}>
          <select value={stockIng} onChange={(e) => setStockIng(e.target.value)}>
            <option value="">Ingredient that ran out…</option>
            {inv.map((i) => (
              <option key={i.ingredientId} value={i.ingredientId}>
                {i.name}
              </option>
            ))}
          </select>
          <button type="button" className="btn" disabled={busy} onClick={() => void runStockout(false)}>
            Find compatible substitute
          </button>
        </div>

        {plan && (
          <div style={{ marginTop: "1rem" }}>
            <div className={plan.flags.length ? "banner error" : "banner ok"}>{plan.summary}</div>
            {plan.affectedRecipes && (
              <p className="tiny muted">Affected recipes: {plan.affectedRecipes.join(", ")}</p>
            )}
            <ul className="list">
              {plan.lines.map((l) => (
                <li key={l.ingredientId}>
                  <span className={STATUS_TAG[l.status] ?? "tag"}>{l.status.replace("_", " ")}</span> <strong>{l.name}</strong>{" "}
                  <span className="tiny muted">
                    need {l.required}
                    {unitLabel(l.unit)} · on hand {l.onHand} · on order {l.onOrder} · short {l.shortfall}
                  </span>
                  <div className="tiny">{tidy(l.explanation)}</div>
                  {l.chosen && (
                    <div className="tiny">
                      → {l.chosen.isSubstitution ? "Substitute: " : ""}
                      {l.chosen.productName} · {money(l.chosen.totalPrice)} · arrives {day(l.chosen.availableDate)}
                    </div>
                  )}
                  {l.substitutes.map((s) => (
                    <div key={s.productName + s.label} className="tiny muted">
                      {s.label}: {s.productName} · {money(s.totalPrice)} · {s.tradeOff}
                    </div>
                  ))}
                  {l.intent && (
                    <div className="tiny">
                      Intent {l.intent.id.slice(0, 8)} → <strong>{l.intent.status}</strong>
                      {l.intent.reasons.length ? ` (${l.intent.reasons.join("; ")})` : ""}
                    </div>
                  )}
                </li>
              ))}
            </ul>
          </div>
        )}
      </section>
      )}

      {section === "data" && (
      <section className="panel">
        <h2>Import / sync from your systems</h2>
        <p className="muted">
          Paste JSON exported from your inventory / recipe system. <code>{`{ "inventory": [...], "recipes": [...], "replace": false }`}</code> —
          same shape as <code>POST /v1/kitchen/import</code>, so a PMS or kitchen app can push updates on a schedule.
        </p>
        <textarea
          rows={6}
          style={{ width: "100%", fontFamily: "monospace" }}
          value={importText}
          onChange={(e) => setImportText(e.target.value)}
          placeholder={`{"inventory":[{"name":"Oat drink","unit":"litre","onHand":10,"parLevel":40,"catalogHints":["oat drink"]}],"recipes":[]}`}
        />
        <div className="actions" style={{ marginTop: "0.5rem" }}>
          <button
            type="button"
            className="btn primary"
            disabled={busy || !importText.trim()}
            onClick={async () => {
              let body: unknown;
              try {
                body = JSON.parse(importText);
              } catch {
                onError("Import is not valid JSON");
                return;
              }
              await act(() => api("/v1/kitchen/import", { method: "POST", body: JSON.stringify(body) }), "Imported");
              setImportText("");
            }}
          >
            Import
          </button>
          <button
            type="button"
            className="btn"
            disabled={busy}
            onClick={() => {
              if (!window.confirm("Reset kitchen, mandate and all order intents to the demo seed? (Audit log is kept.)")) return;
              void act(() => api("/v1/admin/demo-reset", { method: "POST", headers: { "X-Demo-Reset": "confirm", "X-Reset-Source": "Approval Desk button" } }), "Demo state reset");
            }}
          >
            Reset demo data
          </button>
        </div>
      </section>
      )}
    </>
  );
}
