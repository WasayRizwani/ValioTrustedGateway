import { AsyncLocalStorage } from "node:async_hooks";

export type AgentId = "sourcing" | "planner" | "procurement" | "valio-account";

const store = new AsyncLocalStorage<{ agent: AgentId }>();

/** Everything done inside `fn` (including audit events) is attributed to this agent. */
export function withAgent<T>(agent: AgentId, fn: () => T): T {
  return store.run({ agent }, fn);
}

export function currentAgent(): AgentId | undefined {
  return store.getStore()?.agent;
}
