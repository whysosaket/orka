import type { MemoryResolution } from "@portable/protocol";

export type MemoryState = {
  context: Record<string, unknown>;
  base: string;
  current: string;
  incoming: string;
  conflicts: {
    startLine: number;
    endLine: number;
    base: string;
    current: string;
    incoming: string;
  }[];
};
export interface MemoryResolver {
  resolve(
    state: MemoryState,
  ): Promise<
    Pick<
      MemoryResolution,
      "model" | "choice" | "confidence" | "probabilities"
    >[]
  >;
}

export function acceptingMemoryResolver(): MemoryResolver {
  return {
    resolve: async (state) =>
      state.conflicts.map(() => ({
        model: "jev-1.13.0",
        choice: "accept_incoming",
        confidence: 1,
        probabilities: { keep_current: 0, accept_incoming: 1, keep_both: 0 },
      })),
  };
}
