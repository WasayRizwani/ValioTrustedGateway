import { getDb } from "../audit/chain.js";

export type SpendSummary = {
  /** EUR spent in the current UTC day / ISO week (Mon start) / month. */
  day: number;
  week: number;
  month: number;
  ordersToday: number;
  /** Totals of orders created in the last 24h (for order-splitting detection). */
  recent24h: number[];
};

/** Committed plus approved / auto_eligible-not-yet-committed (and unexpired) intents. */
export async function computeSpend(customerId: string, now: Date = new Date()): Promise<SpendSummary> {
  const dayStart = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const weekStart = dayStart - ((now.getUTCDay() + 6) % 7) * 86_400_000;
  const monthStart = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1);
  const rows = await getDb().query<{
    total_price: number;
    created_at: string;
  }>(
    `SELECT total_price, created_at FROM order_intents
     WHERE customer_id = $1 AND created_at >= $2
       AND (status = 'committed' OR (status IN ('approved','auto_eligible') AND expires_at > $3))`,
    [
      customerId,
      new Date(Math.min(monthStart, weekStart, now.getTime() - 86_400_000)).toISOString(),
      now.toISOString(),
    ],
  );
  const out: SpendSummary = { day: 0, week: 0, month: 0, ordersToday: 0, recent24h: [] };
  for (const r of rows) {
    const t = new Date(r.created_at).getTime();
    const v = Number(r.total_price);
    if (t > now.getTime()) continue;
    if (t >= monthStart) out.month += v;
    if (t >= weekStart) out.week += v;
    if (t >= dayStart) {
      out.day += v;
      out.ordersToday += 1;
    }
    if (t >= now.getTime() - 86_400_000) out.recent24h.push(v);
  }
  return out;
}
