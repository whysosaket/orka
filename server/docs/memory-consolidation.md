# Memory consolidation with JEV

## Plan and implemented flow

1. Keep the existing versioned snapshots and project transaction lock as the three-way merge foundation. Compare the client's base, currently accepted memory and proposed text using the shared line-diff implementation.
2. Apply additions (`+`) and uncontested deletions (`-`) directly. Retain independent edits from both clients. Concurrent additions at the same position preserve both; identical edits are not duplicated.
3. Send replacements (`-+`), even on a fresh base, and overlapping edits to JEV. Group multiline overlapping hunks, batch all questions for one memory into one request, and provide the full three documents, title, logical path, source, revisions and authors as context. Context is limited to this memory resource in its authorized project.
4. Let JEV choose the exact supplied current text, incoming text or both. Intentional corrections and refinements of the same subject can update the memory; complementary scopes and conditions can coexist. Explicit speculation can be rejected. JEV is a decision model and cannot write a novel synthesis: updated text comes from the incoming edit, including its qualifications. Keeping both concatenates the existing and proposed spans without inserting Git conflict markers.
5. Validate the model, question IDs, answer types, complete probability distribution and confidence. Require a winning probability of at least 0.65 with a margin of 0.15 over the next option. An uncertain result, oversized context or provider failure returns HTTP 503; the transaction rolls back, and the native client retains the existing outbox request and local file for retry. No acceptance-order fallback discards memory.
6. Persist the resolved content as a verified blob and snapshot. Record the model, choice, probabilities and base line span in optional `event.memoryResolutions`, stored with the event and idempotent receipt. Line numbers are one-based, with an exclusive end. Replaying an accepted request returns the same receipt without another JEV call. Failed requests create no receipt, revision or event.

The canonical implementation is `packages/server-core/src/memory.ts`, with the provider boundary in `jev.ts` and integration in `store.ts`. Both OSS and managed servers use this same path. Existing plan/skill merges and session resolution retain their contracts. Explicit whole-resource tombstones remain direct deletions. Semantic contradictions in pure additions or across separate files are outside this line-edit consolidation step.

## JEV contract and configuration

The implementation follows [TypeSafe's API reference](https://docs.typesafe.ai/api) and the ACL project's typed JEV transport. It pins `jev-1.13.0` and posts `state` plus named `choice` questions to `https://api.typesafe.ai/v1/systemone`. There are three options: `keep_current`, `accept_incoming` and `keep_both`. Embedded memory instructions are treated as evidence rather than evaluator instructions.

Server environment variables, shared by local, OSS and managed composition:

- `JEV_API_KEY`: server-side credential. Required to resolve replacements; never include it in desktop builds, packages or tracked files.
- `TYPESAFE_API_KEY`: compatibility alias used when `JEV_API_KEY` is blank.
- `MEMORY_JEV_ENABLED`: `true` by default; accepts only `true` or `false`. Setting it to `false` defers replacements; it does not restore acceptance-order resolution. Additions, uncontested deletions and tombstones still work.

The server can start without a JEV key so existing self-hosted installations remain usable. Deployment validation requires a key or explicit disabling. An enabled server without a key reports `Memory consolidation pending: jev_missing_key` on a replacement. Configure the deployment's private secret store and recreate the API container before using this release for memory edits. Local Compose reads these variables from its private `.env.local` or the invoking environment. No secret is needed in GoTrue or the desktop.

Each inference has a five-second total deadline and at most one retry on a network/transient HTTP failure. Long Retry-After values defer to a later sync. Inputs exceeding 24,000 UTF-8 bytes of serialized state or 128 conflicts are deferred intact rather than truncated. This is a conservative context bound; large memories should be split into smaller files before replacing them. Provider response bodies, requests and credentials never appear in errors.

## Verification

`npm test` covers deterministic edits, multiline overlaps, batched conflicts, all three resolutions, boundary insertions, provider contract validation, malformed probabilities, missing keys, uncertainty and bounded retries. `npm run test:integration` covers actual HTTP upload/push/pull, PostgreSQL transactions, blobs, snapshots, concurrent additions, receipt replay, all memory sources and outage rollback.

Live acceptance uses synthetic memory only. Provide a private JEV environment file and run:

```sh
ORKA_TEST_LIVE_JEV=true node --env-file=.runtime/jev.env --import tsx scripts/integration.ts
```

The live cases exercise a runtime correction, retaining different service scopes, rejecting an explicit unverified guess, and an update that preserves a development exception. Ordinary CI uses an injected JEV transport and does not require a paid credential. The desktop repository has a two-native-client integration test verifying consolidation, materialized files, retained outbox requests on HTTP 503, recovery and no repeated inference on settled syncs.

Protocol/core 0.3.0 is a release candidate for this change. The v2 request/resource formats and native commands remain compatible; decision metadata is additive JSON. No database migration is needed. The desktop pins generated packages with the actual backend commit and checksums. Branch packages do not imply that production images have been published or deployed.
