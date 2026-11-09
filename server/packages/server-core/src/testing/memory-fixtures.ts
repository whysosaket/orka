import { JevMemoryResolver } from "../jev.js";

// Existing sync fixtures deliberately accept incoming replacements; production
// callers use the real transport. Keep this injectable at the provider boundary.
export function acceptingMemoryResolver() {
  return new JevMemoryResolver(
    { enabled: true, apiKey: "fixture" },
    async (_url, request) => {
      const input = JSON.parse(request?.body as string) as {
        questions: Record<string, unknown>;
      };
      return Response.json({
        model: "jev-1.13.0",
        answers: Object.fromEntries(
          Object.keys(input.questions).map((id) => [
            id,
            {
              type: "choice",
              choice: "accept_incoming",
              confidence: 1,
              probabilities: {
                keep_current: 0,
                accept_incoming: 1,
                keep_both: 0,
              },
            },
          ]),
        ),
        usage: { input_tokens: 100, output_tokens: 20 },
      });
    },
  );
}
