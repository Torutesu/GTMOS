import type { Stage } from "@sdv/core";

export interface RunEvent {
  stage: Stage | "run";
  status: string;
  message: string;
  at: string;
}

type Listener = (e: RunEvent) => void;

const HISTORY_LIMIT = 200;

/**
 * Run progress, in memory.
 *
 * Every event is kept as well as broadcast, because a browser almost always
 * opens the stream after the run has already started — replaying the history
 * on subscribe is what makes the progress list correct instead of merely
 * live. History is bounded; a run that emitted 200 events has long since told
 * the viewer what they needed.
 */
export class EventBus {
  private history = new Map<string, RunEvent[]>();
  private listeners = new Map<string, Set<Listener>>();

  emit(runId: string, e: Omit<RunEvent, "at">): void {
    const event: RunEvent = { ...e, at: new Date().toISOString() };
    const log = this.history.get(runId) ?? [];
    log.push(event);
    if (log.length > HISTORY_LIMIT) log.splice(0, log.length - HISTORY_LIMIT);
    this.history.set(runId, log);
    for (const fn of this.listeners.get(runId) ?? []) fn(event);
  }

  replay(runId: string): RunEvent[] {
    return [...(this.history.get(runId) ?? [])];
  }

  subscribe(runId: string, fn: Listener): () => void {
    const set = this.listeners.get(runId) ?? new Set<Listener>();
    set.add(fn);
    this.listeners.set(runId, set);
    return () => {
      set.delete(fn);
      if (set.size === 0) this.listeners.delete(runId);
    };
  }

  forget(runId: string): void {
    this.history.delete(runId);
    this.listeners.delete(runId);
  }
}
