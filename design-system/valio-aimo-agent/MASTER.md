# Valio Aimo® Kitchen Assistant — Simple UX & Design System (`MASTER.md`)

> **Target Users**: Busy Head Chefs, Restaurant Managers, School/Hospital Kitchen Leads — **NOT tech-savvy developers**.
> **Core UX Rule**: *If a chef with flour on their hands at 6:00 AM can't understand the screen in 3 seconds, simplify it.*

---

## 1. UX Simplicity Principles (Non-Technical Users First)

1. **Zero Technical Jargon**: Never show `JSON`, `API`, `MCP`, `SHA-256`, `GTIN`, `SLA`, or `Guardrail ID` in the interface.
   - Say **"Price & stock held for 15 min"** instead of *"Quote Lock TTL + SHA-256 Attestation"*.
   - Say **"Needs your quick OK"** instead of *"Guardrail Escalation"*.
   - Say **"My Rules"** instead of *"Autonomy Governance Matrix"*.
2. **One Clear Job Per Screen** (`Density: 2/10 — Spacious`):
   - Centered `880px–960px` workspace inside `1440×900` frames with generous whitespace (`24px–32px` padding).
   - Maximum **4 top navigation tabs**: `New Order`, `Needs Your OK`, `My Rules`, `Past Orders`.
3. **Grocery-Receipt Clarity**: Every order or substitution reads like a friendly receipt — product name, pack count, delivery time, plain-English reason, and total euro amount.
4. **Big, Forgiving Controls**: Minimum `48px` button height, `15px–16px` body text (`Plus Jakarta Sans`), and an obvious **"Pause Assistant"** switch so non-technical users always feel 100% in control.

---

## 2. Color & Typography Tokens

| Role | Token | Value | Usage |
|------|-------|-------|-------|
| **Canvas** | `--surface-canvas` | `#F8FAFC` | Calm, airy Nordic Milk page background |
| **Card** | `--surface-card` | `#FFFFFF` | Clean rounded cards (`16px` radius, soft shadow) |
| **Primary Action** | `--color-primary` | `#0052CC` | Valio Blue primary buttons & active states |
| **Auto / Verified** | `--color-success` | `#059669` | "Placed Automatically", "In Stock", "Lactose-Free Verified" |
| **Needs OK** | `--color-warning` | `#D97706` | "Needs Your OK" gentle highlight |
| **Safety Lock** | `--color-danger` | `#DC2626` | Allergen safety block / Cancel |
| **Font Family** | `--font-sans` | `Plus Jakarta Sans` | Used everywhere (`16px` body, `24px–28px` friendly headings) |
