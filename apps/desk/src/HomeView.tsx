import { useState } from "react";
import type { TabId } from "./App";

export type DemoAccountKey = "hotel_buyer_key_001" | "school_buyer_key_001";
type KitchenSubView = "events" | "pantry" | "recipes" | "recurring";

type FeatureCard = {
  id: string;
  badge: string;
  badgeTone: "blue" | "green" | "amber";
  title: string;
  description: string;
  sampleHighlight: string;
  ctaLabel: string;
  targetTab: TabId;
  kitchenSubView?: KitchenSubView;
};

const FEATURES: FeatureCard[] = [
  {
    id: "voice-order",
    badge: "Voice & Chat",
    badgeTone: "blue",
    title: "Natural Language & Voice Ordering",
    description:
      "Type or speak what your kitchen needs in plain English. The assistant finds matching Valio Aimo® products, checks delivery dates, and prepares your basket.",
    sampleHighlight: "Try: “Order 60L lactose-free milk for Monday”",
    ctaLabel: "Test New Order",
    targetTab: "order",
  },
  {
    id: "kitchen-events",
    badge: "Pantry & Events",
    badgeTone: "green",
    title: "Smart Pantry, Recipes & Event Catering",
    description:
      "Track live stock health, expiry dates, and upcoming banquets. Missing ingredients for an event are calculated automatically so nothing is forgotten.",
    sampleHighlight: "Includes: 2 upcoming events, recipes & low-stock alerts",
    ctaLabel: "Test Stock & Events",
    targetTab: "kitchen",
    kitchenSubView: "events",
  },
  {
    id: "approvals",
    badge: "1-Click OK",
    badgeTone: "amber",
    title: "Needs Your OK (Spend & Substitution Guardrails)",
    description:
      "Orders within your budget go through automatically. Anything over your limit or requiring a product swap pauses for your 1-click approval.",
    sampleHighlight: "Includes: 2 sample orders waiting for your OK",
    ctaLabel: "Test Approvals",
    targetTab: "approval",
  },
  {
    id: "rules",
    badge: "Safety Locks",
    badgeTone: "green",
    title: "My Rules & Allergen Protection",
    description:
      "Set daily, weekly, and per-order spending caps, lock in lactose-free requirements, and pause autonomous ordering anytime with one switch.",
    sampleHighlight: "Includes: Hotel (€500) & School (€200) rule presets",
    ctaLabel: "Test My Rules",
    targetTab: "rules",
  },
  {
    id: "receipts",
    badge: "Verified Proof",
    badgeTone: "blue",
    title: "Past Orders & Digital Receipts",
    description:
      "Every placed order includes a tamper-proof digital receipt and delivery dispute protection so your kitchen always has clear records.",
    sampleHighlight: "Includes: Committed order with downloadable receipt",
    ctaLabel: "Test Past Orders",
    targetTab: "history",
  },
];

export function HomeView(props: {
  launching: boolean;
  onLaunchDemo: (
    accountKey: DemoAccountKey,
    targetTab?: TabId,
    kitchenSubView?: KitchenSubView,
  ) => Promise<void>;
  onEnterWithoutSeed: (targetTab: TabId) => void;
  onOpenConnectAgent: () => void;
}) {
  const [activeAction, setActiveAction] = useState<string | null>(null);

  async function triggerDemo(
    actionId: string,
    accountKey: DemoAccountKey,
    targetTab: TabId = "order",
    kitchenSubView?: KitchenSubView,
  ) {
    setActiveAction(actionId);
    try {
      await props.onLaunchDemo(accountKey, targetTab, kitchenSubView);
    } finally {
      setActiveAction(null);
    }
  }

  return (
    <div className="home-wrap">
      {/* Promotional Hero */}
      <section className="home-hero">
        <div className="home-eyebrow">Valio Aimo® · Autonomous Kitchen Ordering</div>
        <h1 className="home-title">
          Order kitchen supplies in seconds — by voice, recipe, or schedule.
        </h1>
        <p className="home-subtitle">
          Built for busy head chefs and kitchen leads. Tell the assistant what you need, keep your
          pantry and upcoming events stocked, and stay in control with automatic spending limits and
          verified digital receipts.
        </p>

        <div className="home-cta-row">
          <button
            type="button"
            className="btn primary home-cta-primary"
            disabled={props.launching}
            onClick={() => void triggerDemo("hero-hotel", "hotel_buyer_key_001", "order")}
          >
            {props.launching && activeAction === "hero-hotel"
              ? "Preparing Live Demo…"
              : "Test the App"}
          </button>

          <button
            type="button"
            className="link-quiet"
            disabled={props.launching}
            onClick={() => props.onEnterWithoutSeed("order")}
          >
            Go to App without resetting →
          </button>
        </div>

        <div className="home-sandbox-note">
          <span className="home-sandbox-dot" aria-hidden="true" />
          <span>
            <strong>Live Interactive Sandbox:</strong> Clicking <em>Test the App</em> loads fresh
            sample orders, events, pantry stock, and pending approvals into the database so
            multiple visitors can explore every feature right away.
          </span>
        </div>
      </section>

      {/* 3-Step Flow */}
      <section className="home-steps" aria-label="How it works">
        <div className="home-step-card">
          <div className="home-step-num">1</div>
          <div>
            <div className="home-step-title">Ask, Call, or Plan</div>
            <div className="home-step-desc">
              Type a plain request, call the AI kitchen phone line, or plan from an upcoming event.
            </div>
          </div>
        </div>
        <div className="home-step-card">
          <div className="home-step-num">2</div>
          <div>
            <div className="home-step-title">Automatic Safety Check</div>
            <div className="home-step-desc">
              Checks pantry levels, lactose-free rules, delivery dates, and your spending limits.
            </div>
          </div>
        </div>
        <div className="home-step-card">
          <div className="home-step-num">3</div>
          <div>
            <div className="home-step-title">Auto-Order or Quick OK</div>
            <div className="home-step-desc">
              Routine orders place themselves; anything unusual waits for your 1-click approval.
            </div>
          </div>
        </div>
      </section>

      {/* Feature Showcase Grid */}
      <section className="home-section">
        <div className="home-section-head">
          <h2>Explore Every Working Feature</h2>
          <p>
            Jump straight into any workflow below — we will load fresh sample data into the
            database for you automatically.
          </p>
        </div>

        <div className="home-feature-grid">
          {FEATURES.map((f) => (
            <article key={f.id} className="home-feature-card">
              <div>
                <span className={`home-badge ${f.badgeTone}`}>{f.badge}</span>
                <h3 className="home-feature-title">{f.title}</h3>
                <p className="home-feature-desc">{f.description}</p>
              </div>
              <div className="home-feature-footer">
                <div className="home-sample-chip">{f.sampleHighlight}</div>
                <button
                  type="button"
                  className="btn secondary home-feature-btn"
                  disabled={props.launching}
                  onClick={() =>
                    void triggerDemo(
                      `card-${f.id}`,
                      "hotel_buyer_key_001",
                      f.targetTab,
                      f.kitchenSubView,
                    )
                  }
                >
                  {props.launching && activeAction === `card-${f.id}`
                    ? "Loading Demo Data…"
                    : `${f.ctaLabel} →`}
                </button>
              </div>
            </article>
          ))}

          <article className="home-feature-card">
            <div>
              <span className="home-badge blue">External AI</span>
              <h3 className="home-feature-title">Connect Your Own AI Agent</h3>
              <p className="home-feature-desc">
                Connect Claude, Cursor, or a custom kitchen assistant directly to your Valio Aimo®
                ordering desk with scoped permissions and full audit trails.
              </p>
            </div>
            <div className="home-feature-footer">
              <div className="home-sample-chip">Instant setup instructions &amp; keys</div>
              <button
                type="button"
                className="btn secondary home-feature-btn"
                onClick={props.onOpenConnectAgent}
              >
                View Connection Guide →
              </button>
            </div>
          </article>
        </div>
      </section>
    </div>
  );
}
