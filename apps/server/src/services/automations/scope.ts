// Which automation run is acting right now. Events emitted while one of its steps runs carry that scope
// (through async context), so automations that trigger each other stop after a few links instead of looping.
import { AsyncLocalStorage } from "node:async_hooks";

export interface AutomationScope {
  runId: string;
  workflowId: string;
  /** Depth that runs started from events inside this scope get. */
  depth: number;
  /** Messages for the run's log from code that reacted to the step (the engine copies them over). */
  notes: string[];
  /** Work the step set off (automations starting from its events); the step finishes once it's done. */
  pending: Array<Promise<unknown>>;
}

export const automationScope = new AsyncLocalStorage<AutomationScope>();

/** How many automations may set each other off in a row. */
export const MAX_CHAIN_DEPTH = 3;

/** Depth for a run started by an event emitted right now (0 when no automation is acting). */
export const currentChainDepth = () => automationScope.getStore()?.depth ?? 0;
