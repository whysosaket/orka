# Session translation and compatibility

## Problem and implementation plan

Orka previously treated CLI patch versions as file formats. It rejected usable Codex `0.155.0-alpha.9.2` and Claude `2.1.277`, `2.1.278`, and `2.1.284` transcripts found on the development machine. Native writes also required exact CLI and app-server versions, and the importer assumed every Codex server exposed pagination, project registration, naming, and unsubscribe methods. Separate title, conversation, and handoff readers disagreed about message shapes.

The implementation follows four boundaries:

1. **Decode by structure.** `session_translation.rs` identifies Claude JSONL and Codex legacy/paginated JSONL from their metadata and validates identity and framing. Producer version strings remain provenance; they are not compatibility gates. Unknown history modes, corrupt records, mixed Claude identities, and invalid lineage still fail visibly.
2. **Normalize for reading.** Shared message adapters feed titles, paged conversations, exports, and cross-tool handoffs. They accept Claude messages with inferred roles, Codex response items, completed message items, and legacy message events. Mirrored representations are deduplicated within turn boundaries; repeated turns remain. Tools, agent-to-agent records, and unknown content blocks remain in the full transcript. The readable conversation omits those records and setup/analysis context.
3. **Translate on native import.** Source snapshots remain unchanged. Known execution coordinates are remapped in the receiving copy. Claude keeps message UUIDs, parent links, tool IDs, content, and version provenance. Codex keeps its validated inherited prefix, response payloads, compaction, and retained metadata while remapping session references and execution folders.
4. **Negotiate the receiving server.** Codex initialization establishes the configured native home, rather than matching a user-agent version. A direct child explicitly receives `CODEX_HOME`; an older direct server may omit the home response, but a proxy must prove its home. Standard `app-server` stdio startup works without the newer `--stdio` flag. Version commands are bounded to ten seconds.

## Native import strategies

| Source | Receiver | Translation |
| --- | --- | --- |
| Claude JSONL | Claude CLI | New session identity in the native project directory; message graph and content retained. |
| Codex legacy | Codex app server | Remap execution coordinates, then native fork and registration. |
| Codex paginated | Server with `thread/turns/list` | Flatten the exact inherited prefix into an independent paginated rollout, rebuild ordinals, and register without starting a turn. |
| Codex paginated | Server explicitly lacking `thread/turns/list` | Flatten into independent legacy framing and use the native fork path. Source pagination and metadata remain in the shared snapshot. |
| Claude ↔ Codex | Other provider | Export a normalized Markdown transcript and open the existing new-session composer workflow. This transfers context, not provider-internal executable state. |

Pagination detection makes a read-only request for an absent thread. Only an explicit unsupported-method response selects the legacy adapter. Recognized missing-thread responses establish method support; other failures remain errors. Unsupported project registration, metadata updates, naming, or unsubscribe methods are optional enhancements. Permission errors, invalid parameters, timeouts, and malformed RPC responses are never treated as missing capabilities.

Both importers persist identities before writing. Retrying reuses the same identity; edited or active partial imports are preserved and block replacement. Codex persists its import strategy so a CLI change cannot reinterpret files already staged by a previous attempt. Imported native history is validated before replacing the old binding. No import submits a model turn.

## Preservation and scope

- Complete JSONL records are the lossless snapshot representation. There is no cloud protocol or database schema migration. Existing resources and bundles remain readable.
- Indexing never rewrites native source files. Incomplete live tails wait for a later scan.
- Snapshot ancestry still enforces byte/ordinal boundaries, project scope, cycle detection, file limits, and complete inherited history. Unknown nested ordinal references prevent unsafe rebasing.
- Execution-folder changes apply to metadata, turn contexts, thread settings, and known world-state cwd fields. Paths inside historical messages and tool input/output are unchanged.
- Unknown content remains raw JSON in the full handoff transcript. A native receiver may not understand a future provider feature; format-based acceptance is not a promise of universal forward compatibility.
- Claude Desktop automatic sidebar registration and physical two-Mac UI behavior remain release checks. Claude's existing desktop resume command still requires a CLI with desktop support.

## Open session destinations

The session reader uses an **Open in Codex** or **Open in Claude Desktop** split button. Codex sessions default to Codex Desktop; Claude sessions default to Claude Desktop's Code tab. The dropdown offers installed supported terminals, cross-provider continuation, and Download session (.zip). AppKit resolves icons from each locally installed application's bundle; icon lookup failures use a source or terminal fallback without blocking launch. Selecting another destination does not change the source-based default.

`resume_session` accepts the optional `destination` enum: `desktop` (the existing default), `terminal`, `warp`, or `iterm2`. All same-provider destinations use the existing native ID, source-specific repository validation, and teammate-copy marker. Terminal destinations reject a session that may already be open. Unsupported tools/destinations, deleted resources, and unavailable projects fail before launch. Read-only `session_launch_options` uses macOS Launch Services through NSWorkspace, without AppleScript discovery or a cloud API. Missing apps, CLI prerequisites, and disconnected repositories have disabled options with a reason.

Terminal runs a private generated command file. Warp uses its supported launch-configuration format for compatibility with versions before Tab Configs. Both receive the exact CLI path, native ID, working directory, and configured native home without a prompt argument. Startup files delete themselves when consumed; errors and bounded startup timeouts remove this attempt's files. If Warp does not confirm startup, Orka offers an explicit copyable resume command and does not claim the session opened. Check for an already-open session before running that command. iTerm2 uses its documented command-review URL, where the user chooses a new tab or window; it needs no AppleScript automation grant. An unconsumed iTerm2 review can retain its private launcher until it runs.

Cross-provider continuation remains a new desktop composer referencing the normalized transcript. It never submits the prompt. Download retains the existing ZIP format: manifest, hashed original blobs, and complete readable transcript. It works from accessible cached snapshots without the repository connected. Native import/export formats, sync protocols, server packages, and database schemas are unchanged in both hosting modes.

### Launcher verification

Native fixtures verify exact-session routing and retries, copy safeguards, active-session errors, repository selection, missing CLI support, invalid native bindings, account/service changes during validation, failed launches, and manual fallback. Download checks inspect the real ZIP manifest, original blobs, and complete transcript from cached history with the repository absent. Process checks cover literal shell arguments, large stdout/stderr, failed exit codes, and inherited pipes that must not bypass timeouts. These fixtures never open personal sessions.

Browser checks cover command payloads, source-based defaults, refreshed app availability, local icons and fallback, disabled-menu keyboard navigation, pending-action guards, ZIP saving/cancel/failure, disconnected folders, stale responses, and cleared state across profile/user/service changes. Focus, reduced motion, long titles, and both provider buttons are checked at both window sizes.

An opt-in smoke script uses isolated synthetic resources and fake CLIs, so it cannot submit model work or change personal session history:

```sh
cargo build --manifest-path apps/mac/src-tauri/Cargo.toml
npx tsx scripts/session-launcher-smoke.ts discover
npx tsx scripts/session-launcher-smoke.ts terminal
npx tsx scripts/session-launcher-smoke.ts warp
```

The destination commands open the named real terminal. Their JSON reports under ignored `artifacts/` distinguish automatic startup from a verified manual fallback command. For iTerm2, use `iterm2` as the argument and approve its command-review dialog; it must already be installed. The script requires the repository's Node 24+ runtime.

On October 26, 2026, automatic startup in Terminal was verified for both fake CLIs with exact IDs, special-character paths, and native homes. Warp `0.2026.10.14.08.27.01` accepted its launch URI but did not confirm CLI startup; the manual fallback command was verified for both providers. Warp visual inspection was unavailable through the computer-use tool. iTerm2 was absent, so its real command-review flow remains an acceptance check. These checks do not establish signed-installed-app behavior, desktop sidebar registration, other architectures/macOS versions, or physical two-Mac continuation.

Final local validation passed 165 standard native tests (seven optional checks excluded from that run), all four selected installed-Codex import integrations, the opt-in AppKit icon check, 15 TypeScript unit tests, and the full browser suite of 251 tests with two workers (25 disabled-ENV cases skipped). This includes all 60 resource-detail checks. Typecheck, lint, formatting, native/frontend builds, strict Clippy, repository boundaries, and the dependency-license inventory also passed. A fresh synthetic smoke run verified automatic Terminal startup and Warp's manual fallback for both providers.

Layout and accessibility were checked at 1160×800 and 900×640, including a long session title. Local Codex, Claude Desktop, Terminal, and Warp icons were confirmed as small PNGs, and previews using those returned icons passed at both window sizes. Run the installed-app icon check with `cargo test --manifest-path apps/mac/src-tauri/Cargo.toml installed_app_icons_are_small_pngs -- --ignored`; it only reads local app icons.

Integration references: [Warp launch configurations](https://docs.warp.dev/terminal/sessions/launch-configurations/), [Warp URI limitations](https://docs.warp.dev/terminal/more-features/uri-scheme), and [iTerm2 command-review URLs](https://iterm2.com/documentation-url-scheme.html).

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
