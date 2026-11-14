import { useState } from "react";

export type LastReset = { id: number; at: string; removedIntents: number; source: string | null };

const KEY = "tta_dismissed_reset";
const readDismissed = () => {
  try {
    return Number(localStorage.getItem(KEY) ?? 0);
  } catch {
    return 0;
  }
};

/**
 * Shown on Overview/Orders after a demo reset so an empty list isn't a mystery.
 * Dismissible (remembered per reset id) and hidden automatically once new orders exist after the reset.
 */
export function ResetNotice({ reset, hasOrders }: { reset: LastReset | null | undefined; hasOrders?: boolean }) {
  const [dismissed, setDismissed] = useState(readDismissed);
  if (!reset || hasOrders || dismissed >= reset.id) return null;
  const when = new Date(reset.at).toLocaleString(undefined, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", second: "2-digit" });
  return (
    <div className="banner warn" role="status" style={{ display: "flex", gap: "0.75rem", justifyContent: "space-between", alignItems: "flex-start" }}>
      <span>
        Demo data was reset on {when}
        {reset.source ? ` (by ${reset.source})` : ""} — {reset.removedIntents} order{reset.removedIntents === 1 ? "" : "s"} removed. Orders placed before then are no longer listed here; the audit trail keeps their history.
      </span>
      <button
        type="button"
        className="link"
        onClick={() => {
          try {
            localStorage.setItem(KEY, String(reset.id));
          } catch {
            /* ignore */
          }
          setDismissed(reset.id);
        }}
      >
        Dismiss
      </button>
    </div>
  );
}
