import path from "node:path";
import type { ExecutionMode } from "./policy";

type Listener = (mode: ExecutionMode) => void;
const state = globalThis as typeof globalThis & {
  __workAgentPolicyListeners?: Map<string, Set<Listener>>;
};
function key(agentDir: string) {
  const resolved = path.resolve(agentDir);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

/** Shared across Next hot reloads; each live session removes its subscription on shutdown. */
export function subscribePolicyMode(agentDir: string, listener: Listener): () => void {
  const listeners = state.__workAgentPolicyListeners ??= new Map();
  const id = key(agentDir);
  const group = listeners.get(id) ?? new Set<Listener>();
  group.add(listener);
  listeners.set(id, group);
  return () => {
    group.delete(listener);
    if (group.size === 0) listeners.delete(id);
  };
}

/** Notify synchronously so switching to plan stops schedulers before the API returns. */
export function emitPolicyMode(agentDir: string, mode: ExecutionMode): void {
  for (const listener of [...(state.__workAgentPolicyListeners?.get(key(agentDir)) ?? [])]) {
    // Continue notifying every owner if one session's lifecycle handler fails.
    try { listener(mode); }
    catch { console.error("[WorkAgent] A session could not apply the execution mode change"); }
  }
}
