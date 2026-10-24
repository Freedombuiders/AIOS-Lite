/** Per-account fairness hook for the worker loop. */

export interface FairnessAccount {
  id: string;
  channel: string;
  ownerEpoch: number;
}

export interface FairnessState {
  nowMs: number;
  /** Last time each account was served by this worker (absent = never). */
  lastServedAtMs: ReadonlyMap<string, number>;
  /** Jobs completed per account since the worker started. */
  servedCount: ReadonlyMap<string, number>;
}

export interface FairnessPolicy {
  /** Order in which accounts are offered a lane this tick. May drop accounts (e.g. a budget), never add. */
  order(accounts: FairnessAccount[], state: FairnessState): string[];
}

/** Least-recently-served first, ties by id: a busy account cannot starve a quiet one. */
export const leastRecentlyServedFairness: FairnessPolicy = {
  order(accounts, state) {
    return [...accounts]
      .sort((a, b) => {
        const la = state.lastServedAtMs.get(a.id) ?? -1;
        const lb = state.lastServedAtMs.get(b.id) ?? -1;
        return la - lb || a.id.localeCompare(b.id);
      })
      .map((a) => a.id);
  },
};
