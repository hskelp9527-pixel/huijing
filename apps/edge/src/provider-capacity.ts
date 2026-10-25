export type ImageCapacity = { limit: number; limited: number; successes: number; recoverAt: number };
export function imageCapacity(max: number): ImageCapacity { return { limit: max, limited: 0, successes: 0, recoverAt: 0 }; }
export function updateCapacity(state: ImageCapacity, max: number, outcome: "rate_limited" | "success" | "other", timestamp: number) {
  state.limit = Math.min(max, state.limit);
  if (outcome === "rate_limited") {
    state.limited++;
    state.successes = 0;
    state.recoverAt = timestamp + 30000;
    if (state.limited >= 2) state.limit = 1;
  } else if (outcome === "success") {
    state.limited = 0;
    state.successes++;
    if (state.successes >= 2 && timestamp >= state.recoverAt) {
      state.limit = Math.min(max, state.limit + 1);
      state.successes = 0;
    }
  } else { state.limited = 0; state.successes = 0; }
  return state;
}
