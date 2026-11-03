# Session translation and compatibility

## Problem and implementation plan

Orka previously treated CLI patch versions as file formats. It rejected usable Codex `0.155.0-alpha.9.2` and Claude `2.1.277`, `2.1.278`, and `2.1.284` transcripts found on the development machine. Native writes also required exact CLI and app-server versions, and the importer assumed every Codex server exposed pagination, project registration, naming, and unsubscribe methods. Separate title, conversation, and handoff readers disagreed about message shapes.

The implementation follows four boundaries:

1. **Decode by structure.** `session_translation.rs` identifies Claude JSONL and Codex legacy/paginated JSONL from their metadata and validates identity and framing. Producer version strings remain provenance; they are not compatibility gates. Unknown history modes, corrupt records, mixed Claude identities, and invalid lineage still fail visibly.
2. **Normalize for reading.** Shared message adapters feed titles, paged conversations, exports, and cross-tool handoffs. They accept Claude messages with inferred roles, Codex response items, completed message items, and legacy message events. Mirrored representations are deduplicated within turn boundaries; repeated turns remain. Tools, agent-to-agent records, and unknown content blocks remain in the full transcript. The readable conversation omits those records and setup/analysis context.
3. **Translate on native import.** Source snapshots remain unchanged. Known execution coordinates are remapped in the receiving copy. Claude keeps message UUIDs, parent links, tool IDs, content, and version provenance. Codex keeps its validated inherited prefix, response payloads, compaction, and retained metadata while remapping session references and execution folders.
4. **Negotiate the receiving server.** Codex initialization establishes the configured native home, rather than matching a user-agent version. A direct child explicitly receives `CODEX_HOME`; an older direct server may omit the home response, but a proxy must prove its home. Standard `app-server` stdio startup works without the newer `--stdio` flag. Version commands are bounded to ten seconds.

## Native import strategies

| Source          | Receiver                                      | Translation                                                                                                                                                  |
| --------------- | --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Claude JSONL    | Claude CLI                                    | New session identity in the native project directory; message graph and content retained.                                                                    |
| Codex legacy    | Codex app server                              | Remap execution coordinates, then native fork and registration.                                                                                              |
| Codex paginated | Server with `thread/turns/list`               | Flatten the exact inherited prefix into an independent paginated rollout, rebuild ordinals, and register without starting a turn.                            |
| Codex paginated | Server explicitly lacking `thread/turns/list` | Flatten into independent legacy framing and use the native fork path. Source pagination and metadata remain in the shared snapshot.                          |
| Claude ↔ Codex  | Other provider                                | Export a normalized Markdown transcript and open the existing new-session composer workflow. This transfers context, not provider-internal executable state. |

Pagination detection makes a read-only request for an absent thread. Only an explicit unsupported-method response selects the legacy adapter. Recognized missing-thread responses establish method support; other failures remain errors. Unsupported project registration, metadata updates, naming, or unsubscribe methods are optional enhancements. Permission errors, invalid parameters, timeouts, and malformed RPC responses are never treated as missing capabilities.

Both importers persist identities before writing. Retrying reuses the same identity; edited or active partial imports are preserved and block replacement. Codex persists its import strategy so a CLI change cannot reinterpret files already staged by a previous attempt. Imported native history is validated before replacing the old binding. No import submits a model turn.

## Preservation and scope

- Complete JSONL records are the lossless snapshot representation. There is no cloud protocol or database schema migration. Existing resources and bundles remain readable.
- Indexing never rewrites native source files. Incomplete live tails wait for a later scan.
- Snapshot ancestry still enforces byte/ordinal boundaries, project scope, cycle detection, file limits, and complete inherited history. Unknown nested ordinal references prevent unsafe rebasing.
- Execution-folder changes apply to metadata, turn contexts, thread settings, and known world-state cwd fields. Paths inside historical messages and tool input/output are unchanged.
- Unknown content remains raw JSON in the full exported transcript. A native receiver may not understand a future provider feature; format-based acceptance is not a promise of universal forward compatibility.
- Claude Desktop automatic sidebar registration and physical two-Mac UI behavior remain release checks. Claude's existing desktop resume command still requires a CLI with desktop support.

## Open session destinations

The session reader has one split button and four destination choices: Codex Desktop, Claude Desktop's Code tab, Codex CLI, and Claude Code CLI. A shared terminal selector offers installed Terminal, Warp, and iTerm2 hosts in that priority order. Uninstalled apps and CLIs are hidden; installed destinations with missing prerequisites remain disabled with a reason. Local AppKit icons have source/terminal fallbacks.

Read-only `session_launch_options` returns `isDefault` and `mode` (`resume` or `handoff`) alongside the existing tool/destination fields. The native layer reads original surface metadata from the shared snapshot rather than the imported native copy. Codex desktop originators take precedence over generic `source` values; CLI source metadata and Claude's `cli`/`local-agent` entrypoints distinguish the original surface. Unknown origins prefer the provider's desktop. Fallback order is original surface, same provider's other surface, other provider's equivalent surface, then its remaining surface. Explicit choices do not persist a new default.

`resume_session` retains its optional `destination` enum (`desktop`, `terminal`, `warp`, `iterm2`) and legacy desktop default. Every same-provider open now creates a fresh local native session from the complete cached snapshot, using the existing lossless import adapters, and resumes that new ID. It never resumes or replaces the source binding, even for the current owner's sessions or an active source. A missing native source installation does not require sync first. New forks retain source attribution; ordinary indexing and sharing can publish them later under the existing permissions.

Launching uses a separate session-launch lock for duplicate protection and never acquires the workspace sync lock or waits for the Orka service. Failed/offline sync and queued changes do not block a cached launch. Account, service, resource revision, repository access, and destination prerequisites are revalidated before opening. Missing/corrupt cached history and unavailable local prerequisites remain explicit errors. A prepared copy is preserved if validation or launching fails; uncertain attempts are never automatically resubmitted.

Claude Desktop additionally requires supported CLI flags, a Claude subscription login verified through `claude auth status`, an inactive target copy, and an explicit exact-session confirmation from the CLI. A successful app launch alone is insufficient. Native desktop continuation is disabled for custom native homes that the independently running GUI app cannot be proven to use. CLI discovery handles executable symlinks, PATH, native/Homebrew/npm-user and version-manager locations, and bundled Codex binaries without executing shell startup files.

Terminal runs a private generated command file. Warp uses its supported launch-configuration format; when startup is unconfirmed, Orka offers a manual command without claiming the session opened. iTerm2 opens its documented command-review URL and asks the user to run the command in a tab/window. Launchers preserve literal arguments, the resolved executable, working directory, PATH, and configured native home. Consumed startup files remove themselves; failures clean up this attempt's files. An unconsumed iTerm2 review can retain its private launcher. There is no automatic retry or destination switch after a launch request.

Cross-provider launches create a new conversation using an immutable, private context file per source revision. Desktop opens a prefilled composer without sending. CLI starts a fresh interactive process with the continuation instruction as its initial prompt, immediately beginning model work once the destination's own sign-in/trust requirements allow it. Cross-provider commands never receive the source native ID or a resume flag. Existing handoff attribution remains attached to every retained context file.

`session_handoff_prompt` returns a self-contained continuation instruction plus the complete readable conversation and its revision. Copy session prompt works from cached snapshots without an app or repository connection, confirms clipboard success inline, and reports errors inside the menu. It includes inherited Codex history and meaningful repeated turns while omitting injected setup, analysis, and raw tool records. Empty/corrupt history fails visibly; there is no model summary or silent truncation. Async copy/launch responses are discarded when the selection or account/service scope changes.

Download retains the existing ZIP format with original blobs and the full transcript. Native import formats, sync protocols, server packages, and database schemas are unchanged in both hosting modes.

### Launcher verification

Native fixtures verify fresh identities for every provider/surface/terminal combination while the sync lock is held, source immutability, cached launches without native bindings, active originals, repository selection, missing CLI support, duplicate launches, account/service/revision changes during preparation, failed launches, and manual fallback. Adapter fixtures verify complete inherited Codex history and Claude message/tool graphs across independent copies. Download checks inspect the real ZIP manifest, original blobs, and complete transcript from cached history with the repository absent. Process checks cover literal shell arguments, large stdout/stderr, failed exit codes, and inherited pipes that must not bypass timeouts. These fixtures never open personal sessions.

Browser checks cover command payloads, source-based defaults, refreshed app availability, local icons and fallback, disabled-menu keyboard navigation, pending-action guards, ZIP saving/cancel/failure, disconnected folders, stale responses, and cleared state across profile/user/service changes. Focus, reduced motion, long titles, and both provider buttons are checked at both window sizes.

An opt-in smoke script uses isolated synthetic resources and fake CLIs, so it cannot submit model work or change personal session history:

```sh
cargo build --manifest-path apps/mac/src-tauri/Cargo.toml
npx tsx scripts/session-launcher-smoke.ts discover
npx tsx scripts/session-launcher-smoke.ts terminal
npx tsx scripts/session-launcher-smoke.ts terminal --handoff
npx tsx scripts/session-launcher-smoke.ts warp
```

The destination commands open the named real terminal. Their JSON reports under ignored `artifacts/` distinguish automatic startup from a verified manual fallback command. For iTerm2, use `iterm2` as the argument and approve its command-review dialog; it must already be installed. The script requires the repository's Node 24+ runtime.

On October 26, 2026, automatic startup in Terminal was verified for both fake CLIs with exact IDs, special-character paths, and native homes. Warp `0.2026.10.14.08.27.01` accepted its launch URI but did not confirm CLI startup; the manual fallback command was verified for both providers. Warp visual inspection was unavailable through the computer-use tool. iTerm2 was absent, so its real command-review flow remains an acceptance check. These checks do not establish signed-installed-app behavior, desktop sidebar registration, other architectures/macOS versions, or physical two-Mac continuation.

Earlier local validation passed 165 standard native tests (seven optional checks excluded from that run), all four selected installed-Codex import integrations, the opt-in AppKit icon check, 15 TypeScript unit tests, and the full browser suite of 251 tests with two workers (25 disabled-ENV cases skipped). This includes all 60 resource-detail checks. Typecheck, lint, formatting, native/frontend builds, strict Clippy, repository boundaries, and the dependency-license inventory also passed. A fresh synthetic smoke run verified automatic Terminal startup and Warp's manual fallback for both providers.

Layout and accessibility were checked at 1160×800 and 900×640, including a long session title. Local Codex, Claude Desktop, Terminal, and Warp icons were confirmed as small PNGs, and previews using those returned icons passed at both window sizes. Run the installed-app icon check with `cargo test --manifest-path apps/mac/src-tauri/Cargo.toml installed_app_icons_are_small_pngs -- --ignored`; it only reads local app icons.

Integration references: [Warp launch configurations](https://docs.warp.dev/terminal/sessions/launch-configurations/), [Warp URI limitations](https://docs.warp.dev/terminal/more-features/uri-scheme), and [iTerm2 command-review URLs](https://iterm2.com/documentation-url-scheme.html).

### Cross-app launcher validation — 1 November 2026

The cross-app launcher passed 173 standard native tests, four installed-Codex import integrations, the read-only installed-app icon check, 15 TypeScript unit tests, and all 258 enabled browser tests (25 disabled-ENV tests skipped). The browser run includes 67 resource-detail checks, with keyboard, accessibility, long-title, clipboard, scope-change, and layout coverage at 1160×800 and 900×640. Typecheck, lint, formatting, repository boundaries, frontend/native builds, and strict Clippy passed.

Real Terminal startup was verified with isolated fake Codex and Claude executables for both exact-session resume and immediate cross-provider initial-prompt delivery. All four checks preserved literal arguments, special-character repository paths, and configured native homes. No model work was submitted or personal session history changed. Warp and iTerm2 were absent on this Mac, so their real-app checks were unavailable; their command construction, review/fallback behavior, and UI wiring remain covered by fixtures. Real Codex/Claude Desktop transfer and real-provider model execution remain release acceptance checks.

### Local fork launch validation — 2 November 2026

The updated launcher passed 175 standard native tests (eight opt-in checks skipped)
and all 68 resource-detail UI checks, including offline launches, duplicate clicks,
stale preparation, keyboard access, reduced motion, and both window sizes. The
installed Codex acceptance check created two independent, readable native forks
from complete cached inherited history while the workspace sync lock was held;
the source files remained byte-for-byte unchanged and no model turn was started.
Real Terminal startup with synthetic Codex/Claude CLIs verified the new fork IDs
and unchanged source bindings, plus both cross-provider initial prompts. Typecheck,
lint, formatting, repository boundaries, strict Clippy, and the bundled debug app
build passed. Desktop GUI transfer and real-provider inference remain separate
acceptance checks.

## Validation — 6 October 2026

The app-server transport follows the [official protocol reference](https://learn.chatgpt.com/docs/app-server); compatibility decisions are verified against the receiving executable.

- Reader/index/export fixtures cover Codex `0.155.0-alpha.9.2`, `0.155.0-alpha.16.3`, `0.159.2`, `0.159.3`, and `0.160.0`; Claude `2.1.277`, `2.1.278`, `2.1.283`, `2.1.284`, `2.1.285`, and `2.1.286`. Structural tests also verify that missing or unfamiliar version strings do not reject a recognized layout.
- Real isolated Codex imports on `0.159.2`, `0.159.3`, and `0.160.0` cover legacy, paginated lineage, segmented history, restart, listing, and resume without inference. Original native homes are removed from the fixtures before import.
- An older-server protocol fixture covers missing `codexHome`, unavailable proxy/pagination/project methods, paginated-to-legacy translation, preserved tools/compaction, permission-error propagation, and retry without a duplicate fork.
- An attempted real `0.90.0` test could not start its downloaded executable on this Mac; it stalled before CLI entry. Do not count the older-server fixture as verification of that native release.
- Claude native-copy tests cover mixed producer versions, graph/tool preservation, identity reuse, source immutability, and protection of local edits. They do not claim native Desktop sidebar verification.

Run the standard native suite with `npm run native:test`. To include native integrations with an installed Codex, run:

```sh
cargo test --manifest-path apps/mac/src-tauri/Cargo.toml -- --include-ignored
```

To check another receiving Codex without replacing the installation:

```sh
ORKA_TEST_CODEX_BINARY=/absolute/path/to/codex \
  cargo test --manifest-path apps/mac/src-tauri/Cargo.toml native_import -- --include-ignored
```

For a legacy-only receiver, select `compatibility_native_import_and_read` instead of the pagination-specific tests. Keep compatibility fixtures in `session_compatibility_tests.rs` and decoder cases in `session_translation.rs` whenever adding a new format or native fallback.
