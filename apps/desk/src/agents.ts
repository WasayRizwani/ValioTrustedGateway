export type AgentId = "sourcing" | "planner" | "procurement" | "valio-account";
export const AGENT_SHORT: Record<AgentId, string> = {
  sourcing: "Sourcing",
  planner: "Planner",
  procurement: "Procurement",
  "valio-account": "Valio",
};
export const ACTOR_LABEL = { agent: "Agent", human: "Human", system: "Gateway", valio: "Valio" } as const;
export function whoLabel(actor: keyof typeof ACTOR_LABEL, agent?: string): string {
  return agent && agent in AGENT_SHORT ? AGENT_SHORT[agent as AgentId] : ACTOR_LABEL[actor];
}
