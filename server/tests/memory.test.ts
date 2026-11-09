import test from "node:test";
import assert from "node:assert/strict";
import {
  consolidateMemory,
  MemoryUnavailable,
  type MemoryContext,
  type MemoryResolver,
  type MemoryState,
} from "./reference/memory.js";
import { JevMemoryResolver, memorySettings } from "./reference/jev.js";
import type { MemoryChoice } from "@portable/protocol";

const context: MemoryContext = {
  logicalPath: "claude/MEMORY.md",
  title: "Project memory",
  source: "claude",
  baseRevision: 1,
  currentRevision: 2,
  incomingAuthor: "teammate",
  currentAuthor: "owner",
};
const forbidden: MemoryResolver = {
  resolve: async () => {
    throw new Error("Deterministic edits must not use JEV");
  },
};
function answer(choice: MemoryChoice) {
  return {
    model: "jev-1.13.0",
    choice,
    confidence: 0.9,
    probabilities: {
      keep_current: choice === "keep_current" ? 0.9 : 0.05,
      accept_incoming: choice === "accept_incoming" ? 0.9 : 0.05,
      keep_both: choice === "keep_both" ? 0.9 : 0.05,
    },
  };
}
const resolve = (choice: MemoryChoice): MemoryResolver => ({
  resolve: async (state) => state.conflicts.map(() => answer(choice)),
});
async function merge(
  base: string,
  current: string,
  incoming: string,
  resolver: MemoryResolver = forbidden,
) {
  return consolidateMemory(base, current, incoming, context, resolver);
}

await test("additions, deletions and unchanged memory bypass inference", async () => {
  for (const [base, current, incoming, expected] of [
    ["", "", "new\n", "new\n"],
    ["a\nb\n", "a\nb\n", "a\nb\nc\n", "a\nb\nc\n"],
    ["a\nb\nc\n", "a\nb\nc\n", "a\nc\n", "a\nc\n"],
    ["a\nb\nc\n", "a\nb\nc\nd\n", "a\nc\n", "a\nc\nd\n"],
    ["a\nb\n", "A\nb\n", "a\nb\n", "A\nb\n"],
    ["a\nb\n", "A\nb\n", "A\nb\n", "A\nb\n"],
    ["a\nb\nc\n", "a\nc\n", "a\nc\n", "a\nc\n"],
    ["", "current\n", "incoming\n", "current\nincoming\n"],
    ["a\nb\n", "a\nfirst\nb\n", "a\nsecond\nb\n", "a\nfirst\nsecond\nb\n"],
    ["a\nb\n", "a\nnew\nb\n", "a\nnew\nb\n", "a\nnew\nb\n"],
  ]) {
    const result = await merge(base, current, incoming);
    assert.equal(result.text, expected);
    assert.deepEqual(result.resolutions, []);
  }
});

await test("every replacement uses context-aware JEV, including a fresh base", async () => {
  let seen: MemoryState | undefined;
  const result = await merge(
    "# Deploy\nUse Node 22.\nRun npm test.\n",
    "# Deploy\nUse Node 22.\nRun npm test.\n",
    "# Deploy\nUse Node 24 for the backend.\nRun npm test.\n",
    {
      resolve: async (state) => {
        seen = state;
        return [answer("accept_incoming")];
      },
    },
  );
  assert.equal(
    result.text,
    "# Deploy\nUse Node 24 for the backend.\nRun npm test.\n",
  );
  assert.equal(seen?.base, "# Deploy\nUse Node 22.\nRun npm test.\n");
  assert.deepEqual(seen?.context, context);
  assert.deepEqual(seen?.conflicts, [
    {
      startLine: 2,
      endLine: 3,
      base: "Use Node 22.\n",
      current: "Use Node 22.\n",
      incoming: "Use Node 24 for the backend.\n",
    },
  ]);
  assert.equal(result.resolutions[0].path, context.logicalPath);
  assert.equal(result.resolutions[0].choice, "accept_incoming");
});

await test("JEV keeps, updates or retains both exact supplied versions", async () => {
  for (const [choice, expected] of [
    ["keep_current", "a\ncurrent\nc\n"],
    ["accept_incoming", "a\nincoming\nc\n"],
    ["keep_both", "a\ncurrent\nincoming\nc\n"],
  ] as const) {
    const result = await merge(
      "a\nb\nc\n",
      "a\ncurrent\nc\n",
      "a\nincoming\nc\n",
      resolve(choice),
    );
    assert.equal(result.text, expected);
    assert.equal(result.resolutions.length, 1);
  }
  assert.equal(
    (await merge("old", "current", "incoming", resolve("keep_both"))).text,
    "current\nincoming",
  );
});

await test("delete versus update requires JEV; unrelated edits survive", async () => {
  assert.equal(
    (await merge("a\nb\nc\n", "a\nB\nc\n", "a\nc\n", resolve("keep_current")))
      .text,
    "a\nB\nc\n",
  );
  assert.equal(
    (
      await merge(
        "a\nb\nc\n",
        "a\nB\nc\n",
        "a\nc\n",
        resolve("accept_incoming"),
      )
    ).text,
    "a\nc\n",
  );
  assert.equal(
    (
      await merge(
        "a\nb\nc\n",
        "a\nc\n",
        "a\nB\nc\n",
        resolve("accept_incoming"),
      )
    ).text,
    "a\nB\nc\n",
  );
  assert.equal(
    (
      await merge(
        "a\nb\nc\n",
        "A\nb\nc\n",
        "a\nb\nC\n",
        resolve("accept_incoming"),
      )
    ).text,
    "A\nb\nC\n",
  );
  assert.equal(
    (
      await merge(
        "a\nb\nc\n",
        "a\ninserted\nb\nc\n",
        "a\nB\nc\n",
        resolve("accept_incoming"),
      )
    ).text,
    "a\ninserted\nB\nc\n",
  );
});

await test("multiline overlapping edits form one conflict; multiple conflicts batch once", async () => {
  let calls = 0;
  const resolver: MemoryResolver = {
    resolve: async (state) => {
      calls++;
      return state.conflicts.map((_, i) =>
        answer(i === 0 ? "keep_both" : "accept_incoming"),
      );
    },
  };
  const result = await merge(
    "a\nb\nc\nd\ne\n",
    "a\nB\nc\nd\ne\n",
    "a\nnew B\nc\nd\nnew E\n",
    resolver,
  );
  assert.equal(calls, 1);
  assert.equal(result.text, "a\nB\nnew B\nc\nd\nnew E\n");
  const span = await merge(
    "a\nb\nc\nd\n",
    "a\nB\nC\nd\n",
    "a\nb\nnew C\nd\n",
    resolve("keep_current"),
  );
  assert.equal(span.text, "a\nB\nC\nd\n");
  assert.equal(span.resolutions.length, 1);
  const incoming = await merge(
    "a\nb\nc\nd\n",
    "a\nB\nC\nd\n",
    "a\nb\nnew C\nd\n",
    resolve("accept_incoming"),
  );
  assert.equal(incoming.text, "a\nB\nnew C\nd\n");
  const multiline = await merge(
    "a\nb\nc\nd\n",
    "a\nb\nc\nd\n",
    "a\nB\nC\nextra\nd\n",
    resolve("keep_current"),
  );
  assert.equal(multiline.text, "a\nb\nc\nextra\nd\n");
  assert.equal(multiline.resolutions.length, 1);
});

const state: MemoryState = {
  context,
  base: "old\n",
  current: "current\n",
  incoming: "new\n",
  conflicts: [
    {
      startLine: 1,
      endLine: 2,
      base: "old\n",
      current: "current\n",
      incoming: "new\n",
    },
  ],
};
function body(choice: MemoryChoice = "accept_incoming") {
  return {
    model: "jev-1.13.0",
    answers: { conflict_0: { type: "choice", ...answer(choice) } },
    usage: { input_tokens: 100, output_tokens: 20 },
  };
}

await test("JEV request uses the pinned TypeSafe contract and validates answers", async () => {
  const client = new JevMemoryResolver(
    { enabled: true, apiKey: "test-key" },
    async (url, init) => {
      assert.equal(url, "https://api.typesafe.ai/v1/systemone");
      assert.equal(
        (init?.headers as Record<string, string>).Authorization,
        "Bearer test-key",
      );
      assert.equal(init?.redirect, "error");
      assert.ok(init?.signal);
      const request = JSON.parse(init?.body as string);
      assert.equal(request.model, "jev-1.13.0");
      assert.deepEqual(request.state, state);
      assert.deepEqual(Object.keys(request.questions), ["conflict_0"]);
      assert.match(request.questions.conflict_0.instructions, /conflicts\[0\]/);
      return Response.json(body());
    },
  );
  assert.equal((await client.resolve(state))[0].choice, "accept_incoming");
});

await test("missing/disabled key, large state and uncertain results defer without inference fallback", async () => {
  assert.deepEqual(memorySettings({ TYPESAFE_API_KEY: "alias" }), {
    enabled: true,
    apiKey: "alias",
  });
  assert.equal(
    memorySettings({ JEV_API_KEY: "primary", TYPESAFE_API_KEY: "alias" })
      .apiKey,
    "primary",
  );
  assert.throws(
    () => memorySettings({ MEMORY_JEV_ENABLED: "yes" }),
    /true or false/,
  );
  await assert.rejects(
    new JevMemoryResolver({ enabled: true, apiKey: "" }).resolve(state),
    /missing_key/,
  );
  await assert.rejects(
    new JevMemoryResolver({ enabled: false, apiKey: "x" }).resolve(state),
    /disabled/,
  );
  await assert.rejects(
    new JevMemoryResolver({ enabled: true, apiKey: "x" }).resolve({
      ...state,
      base: "x".repeat(24_001),
    }),
    /context_limit/,
  );
  const uncertain = body();
  uncertain.answers.conflict_0.probabilities = {
    keep_current: 0.3,
    accept_incoming: 0.4,
    keep_both: 0.3,
  };
  await assert.rejects(
    new JevMemoryResolver({ enabled: true, apiKey: "x" }, async () =>
      Response.json(uncertain),
    ).resolve(state),
    /uncertain/,
  );
  await assert.rejects(
    merge("old\n", "old\n", "new\n", { resolve: async () => [] }),
    MemoryUnavailable,
  );
});

await test("malformed, mismatched and private provider responses never become a resolution", async () => {
  for (const data of [
    {},
    { ...body(), model: "jev-latest" },
    { ...body(), answers: {} },
    { ...body(), answers: { wrong_id: body().answers.conflict_0 } },
    {
      ...body(),
      answers: { conflict_0: { ...body().answers.conflict_0, confidence: 2 } },
    },
    {
      ...body(),
      answers: {
        conflict_0: {
          ...body().answers.conflict_0,
          probabilities: {
            keep_current: 0.9,
            accept_incoming: 0.9,
            keep_both: 0.9,
          },
        },
      },
    },
    {
      ...body(),
      answers: {
        conflict_0: { ...body().answers.conflict_0, choice: "keep_current" },
      },
    },
  ]) {
    await assert.rejects(
      new JevMemoryResolver({ enabled: true, apiKey: "x" }, async () =>
        Response.json(data),
      ).resolve(state),
      MemoryUnavailable,
    );
  }
  for (const status of [401, 422, 429, 529, 503]) {
    let attempts = 0;
    const client = new JevMemoryResolver(
      { enabled: true, apiKey: "x" },
      async () => {
        attempts++;
        return new Response("PRIVATE", {
          status,
          headers: { "retry-after": "0" },
        });
      },
    );
    await assert.rejects(
      client.resolve(state),
      (e: Error) =>
        e instanceof MemoryUnavailable && !e.message.includes("PRIVATE"),
    );
    assert.equal(attempts, [401, 422].includes(status) ? 1 : 2);
  }
});

await test("transient HTTP/network errors retry within the bounded request", async () => {
  for (const network of [false, true]) {
    let attempts = 0;
    const client = new JevMemoryResolver(
      { enabled: true, apiKey: "x" },
      async () => {
        if (++attempts === 1) {
          if (network) throw new Error("PRIVATE network failure");
          return new Response("", {
            status: 529,
            headers: { "retry-after": "0" },
          });
        }
        return Response.json(body());
      },
    );
    assert.equal((await client.resolve(state))[0].choice, "accept_incoming");
    assert.equal(attempts, 2);
  }
});

await test(
  "an unresponsive provider respects the total five-second deadline",
  { timeout: 7_000 },
  async () => {
    let attempts = 0;
    const client = new JevMemoryResolver(
      { enabled: true, apiKey: "x" },
      async (_url, init) => {
        attempts++;
        return new Promise<Response>((_resolve, reject) => {
          const timer = setTimeout(
            () => reject(new Error("PRIVATE timeout")),
            10_000,
          );
          init!.signal!.addEventListener(
            "abort",
            () => {
              clearTimeout(timer);
              reject(new Error("PRIVATE timeout"));
            },
            { once: true },
          );
        });
      },
    );
    const start = Date.now();
    await assert.rejects(client.resolve(state), /jev_network/);
    assert.ok(Date.now() - start < 6_500);
    assert.equal(attempts, 1);
  },
);
