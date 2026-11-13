# Orka v1

Add or join a project, choose what to share from this Mac, map it to a local folder, and inspect **Memories, Skills, Sessions, Plans**. Sharing choices control automatic synchronization independently of local visibility. Editing opens your existing editor. Settings contain project sharing, the sync interval, background service, and connected devices.

Governed projects add resource permissions, private memory candidates and reviewed
publication. See [sharing and private memory](governed-sharing.md) for setup,
agent operations and migration. There is no background conversation extraction or
private memory sync.

## Develop

Requires macOS 12+, Node 24+, Rust, and Apple's Command Line Tools.

```sh
npm ci
npm run dev:profile
```

Double-click `Open Orka.command` in the repository root to start the worktree-aware development launcher. It selects a stable profile for the checkout and a free frontend port. Keep its Terminal window open while developing. The installed release app does not show frontend development changes. See [multiple profiles and worktrees](development.md#multiple-profiles-and-worktrees) for concurrent test clients.

Choose Orka Cloud or Self-hosted, configure its HTTPS service URL, sign in with a supported method, create a project or join using an owner's invite, then choose this Mac's folder. Install the app in its permanent location before connecting folders: native hooks and the login agent refer to that executable. Enable the installed project hooks through each tool's native trust UI. Orka preserves other hook entries and makes a first-install backup.

Storage starts fresh at `~/Library/Application Support/com.orka.v1/`. Older development caches and the old `workspace` database schema remain untouched. Accounts have separate SQLite caches; credentials live in macOS Keychain. Do not run the previous development sync agent alongside v1.

Developer worktrees can use isolated local state through the CLI. This is not exposed in the app. See [development setup](development.md#multiple-profiles-and-worktrees).

## Project names

**Settings → General** has one **Project name** field. For the owner, editing it
updates the shared project name. Members who still use that name see the update
after syncing.

For a member, the same field saves a personal name on this Mac. It works offline,
stays private to the current account, service, and Mac, and survives owner renames.
Choose **Use shared name** and save to follow the owner's latest name and future
changes again. The owner always sees and edits the shared name. Renaming leaves
connected folders, repository names, project IDs, and links intact.
Shared renaming requires backend 0.5.1 with the `rename` project capability;
personal names also work with earlier compatible services. No data migration is
required. The desktop pins the matching versioned 0.5.1 backend packages.

## Native resources

Sessions, Memories, and Plans open on **All**. Choose **Mine** to see your local
and shared items, or **Shared with me** for authorized items owned by other project
members. Ownership stays with the original owner when someone else edits an item.
Repository, provider, search, and sort controls apply within the selected view.

Local items remain visible when automatic sharing is off. **On this Mac** means
an item has not been published; viewing or opening it does not share it. A shared
session can have newer private turns on this Mac without updating its published
snapshot. Unshared items from another Mac are available only on that Mac. The
local list refreshes independently of synchronization and remains usable offline.
Use **Refresh local items** to check for changes without uploading anything.

- Instructions: `AGENTS.md`, `AGENTS.override.md`, and `CLAUDE.md`, including nested project instructions. `CLAUDE.local.md` is excluded.
- Claude auto-memory: the project's native memory directory, respecting `autoMemoryDirectory`.
- Codex learned memory: rollout summaries with a project `cwd`, and durable entries whose referenced summaries all belong to that project. Mixed, global, or unattributable memory is excluded. Orka never overwrites Codex's generated global memory store.
- Shared memory is cached under `<project>/.orka/memory/` with a Markdown index. Local hooks expose it to both tools without network calls or inference.

Automatic context uses the current prompt to retrieve up to four relevant memory
excerpts. Session start supplies the local agent bridge without injecting a recent
history bundle. Unchanged excerpts are delivered once per native session; changed
facts can be delivered again. Both legacy and governed projects use this path.
The bridge's `context` action accepts a `query` for explicit task-specific retrieval.
Matching is conservative lexical retrieval, so a task with no clear match receives
no automatic memory excerpts.

Codex summaries use their source thread identity, and summaries already represented
by accepted consolidated entries remain supporting evidence rather than separate
context. Existing source files and shared history are preserved. The generated
index contains a compact catalog instead of long rollout prefixes. Instruction
discovery excludes generated, runtime, backup and vendor folders and honors Git
ignore rules. Local instruction candidates from excluded sources are dismissed
with their contents retained; submitted requests are not changed.

- Skills include `SKILL.md`, scripts, references, binary assets, and executable flags. Orka materializes both `.agents/skills/<name>` and `.claude/skills/<name>`, tracks both copies, and merges changes from either. Package limits are 200 files, 1 MB per file, and 4 MB total. Symlinks and unsafe paths are rejected.
- In Skills, the floating **Add Global Skills** button opens **Add global skills**. It scans Codex's configured home (`CODEX_HOME`, otherwise `~/.codex`) under `skills`, `~/.agents/skills`, and Claude's configured home (`CLAUDE_CONFIG_DIR`, otherwise `~/.claude`) under `skills`, including nested skill folders. Search by name, description, source, or path, then choose **Add to project**, or select several checkboxes and choose **Add selected**. **Select all visible** applies to the current search; selections survive filtering. Installed or unsafe skills cannot be selected. A batch scans once, waits for one workspace lock, and reports each result independently. Successful skills remain installed; failed skills stay selected for retry. Changing the destination repository clears selection. Complete packages are copied into both project skill folders; global originals and existing project skills are preserved. If sync or another project operation is active, adding requests priority and waits up to five minutes instead of immediately failing. Sync yields between completed project scans, uploads, and resource updates, so the import can proceed without interrupting a write. A yielded sync resumes later and keeps its previous completed-sync status. Account, folder, and sharing settings are rechecked before copying; a wait timeout leaves files unchanged and can be retried. A connected project folder is required. With Skills sharing enabled, imports queue automatically for project sync, including projects with resource permissions. The server publishes directly when the user has permission; otherwise it creates an approval request only when suggestion permission allows it. The current server permissions are checked on upload, so cached publishing rights cannot bypass a later permission change. Offline work retries with the same saved request after restart. Disabling Skills sharing pauses queued imports. A confirmed upload marks the exact unchanged package as installed on its author’s Mac in the selected repository, including projects containing multiple repositories. After imports and incoming skill changes, Orka refreshes Codex’s skill catalogue using its app-server with `forceReload`. Refresh requests persist across restarts and failures appear in the project’s sync issues until a later retry succeeds; a refresh failure does not undo installation or repeat the cloud upload. Older Codex versions without this method retain filesystem discovery. Existing installed skills receive a one-time catalogue refresh after upgrading Orka. On updated teammates’ Macs, enabling Skills sharing automatically installs authorized shared skills and clean updates into both project skill folders during sync. A connected folder is required. Existing local edits, conflicting copies, unsafe paths, and incomplete installations remain protected and appear as sync issues for resolution. Queued sharing does not appear as a manual candidate review. Permission and conflict failures stay visible in sync issues. Legacy projects continue to queue normal sync. With sharing off, additions stay on this Mac. Local additions appear immediately in the main Skills tab with **On this Mac**, usage counts, and readable package files. Imported global skills also show a **Global** origin badge on the card and in the reader. This local origin marker remains after sharing; earlier imports are recognized once by matching their package contents against a global skill, then cached without reading chat history. A fresh import of a previously deleted shared skill appears locally while the old shared deletion stays unchanged. They contribute to the sidebar count and are replaced by one shared card after publication. Cards and reader details distinguish **Sharing queued**, **Awaiting approval**, **Sharing paused**, and **Sharing blocked** from **On this Mac**. Sharing review remains separate from browsing.
- The main Skills tab also defaults to **Most used** and shows **Detected in N chats** on each card. It counts recorded `SKILL.md` loads from both local project copies once per chat, without attributing same-named global skills or other projects to this project. Name-only Claude invocations cannot be attributed to a project and are excluded from these project counts. Choose **Title**, **Recently updated**, or **Author** in the existing sort menu, or **Refresh skill usage** to check new entries. Search, source filters, and opening a skill remain available while counts load; usage errors can be retried independently. Counts come from this Mac’s available history and stay local.
- The picker defaults to **Most used**, with **Name** available in a custom sort menu matching its search and refresh controls. Use the arrow keys to choose a sort and Escape to close the menu. **Detected in N chats** counts recorded skill loads in local Codex and Claude histories once per chat, excluding failed loads and duplicate recorded events. Codex skill attachments and successful `SKILL.md` reads match exact package paths; Claude Skill invocations match an unambiguous global skill name. Automatic usage without a recorded load is unavailable, so this is a history-based estimate rather than an exact execution counter. Usage loads separately from skill discovery and import. After the initial index, unchanged logs require no content reads; appended logs resume from saved complete-entry offsets, with small prefix and boundary checks. Pending tool calls survive refreshes and restarts, and incomplete entries are retried when completed. Replaced, truncated, or rewritten logs rebuild their counts when file identity, size, or validation checks change. Upgrading from the earlier cache performs one full index to establish these checkpoints. Usage tracking does not upload transcript text or usage counts.
- Plans include project Markdown files under `.codex/plans/` and `.claude/plans/`, plus Claude's project-relative `plansDirectory` from user, project, and local settings. Global native plan files are included only when a project session references them through provider metadata or tool inputs. Unreferenced global plans remain private. Codex proposals (`<proposed_plan>` and completed `Plan` events) and `update_plan` progress lists are extracted from complete session history, including paginated history. Claude `ExitPlanMode` inline plans are used when no referenced plan file is available. Each session keeps its latest proposal and progress list; prior revisions remain in shared snapshots.
- The Plans tab supports provider filters, search, formatted Markdown, revision diffs, editor access, links, and ZIP import/export. Plans are bounded to one non-executable UTF-8 Markdown file of at most 1 MB. Project plan files sync into the receiving Mac's project plan directory. Referenced global plans and session-derived plans sync into `.orka/plans/`, without changing native session history. Existing native plan files remain bound to their original paths on the source Mac. Edits to cached plans sync as ordinary text changes; unchanged session history does not revert those edits. A new native proposal or progress update produces a new revision. Rebuild the native app and deploy the updated API before using plans across Macs; older API versions reject the new resource kind visibly.
- Sessions use complete JSONL snapshots and local native-ID mappings. Incomplete tails wait for a later scan. The translation layer recognizes Claude and Codex legacy/paginated structures independently of producer patch versions. One shared reader normalizes titles, conversations, and handoff transcripts while preserving original records, tool data, and metadata. See [session compatibility](session-compatibility.md) for the design, version matrix, native import strategies, and limits.

Synced Codex sessions stay in Orka's cache and do not appear in Codex's history or sidebar until you explicitly open them. Incoming revisions do not replace existing native conversations. Copies imported by earlier Orka versions remain in place.

When you open a Codex session, imports use the receiving app server's capabilities. Paginated receivers get an independent paginated copy with complete inherited history; older servers that explicitly lack pagination use a legacy copy. Optional project/naming methods do not block import when absent. Claude files are installed with durable retry identities in its project history, and Resume opens them with `claude --desktop --resume`. Unknown formats and unsafe lineage remain preserved and visibly blocked. Native Desktop sidebar behavior and physical two-Mac verification remain release checks.

Use **Open in Codex** or **Open in Claude Desktop** in a session's reader to resume in its source desktop app. The arrow offers Terminal and installed supported alternatives, **Continue in** the other provider, and **Download session (.zip)**. App icons come from the applications installed on this Mac. Terminal choices keep the original provider and exact session. An alternative selection does not change the default. iTerm2 asks you to review the command; if Warp cannot confirm startup, Orka shows the exact command to copy and run there. Check that the session is not already open before running a fallback command. Download works from an accessible cached session even when its repository folder is disconnected.

Same-tool resume uses native history. A cross-tool handoff exports a Markdown transcript and opens the target app's new-session composer with the prompt and project folder: `codex://threads/new` for Codex and the documented `claude://code/new` link for Claude. Confirm the folder and send the prefilled prompt to start the new conversation. Orka does not create or name an empty Codex rollout before the first message, or convert internal conversation state. A teammate's continuation is promoted durably to a new Orka identity with an owner activity notice. Hooks detect continuation immediately; scans also catch modified teammate snapshots.

Project/resource links require project membership after sign-in. Invites are owner-issued, single-use, and expire after 24 hours. ZIP bundles contain a manifest, hashed file blobs, and an exported transcript for sessions. Import verifies paths, hashes, sizes, and modes before queuing changes.

On an upgraded server with a public service URL, **Invite member** copies a browser link. Open it and click **Open Orka**, or paste it into **Join project** in the app. The app keeps the invite through sign-in and asks you to review sharing before joining. If it belongs to another service, explicitly switch and sign in there first. Previewing the link does not consume it. Older servers retain desktop links and raw tokens. See [browser project join](browser-project-join.md) for implementation and release checks.

## Sync

Open the sync status in the workspace header to see current activity at the bottom
of the Sync panel. Local checks show the project and file being checked without
estimating a percentage. Upload and apply batches show a progress bar and completed
item count when their total is known; counts apply to the current phase. Connecting,
pulling updates, and other work without a known total show activity text instead.
The footer updates while the panel is open, stays visible below scrolling issues,
and clears when the pass finishes or fails. The header shows **Syncing…** during
active work, so you can close and reopen the panel without losing progress.

The attention count belongs to the selected project. A resource with a failed
upload, local edits, and an incoming update appears once, with its related details
kept together. Requests awaiting your decision contribute to attention; your own
submissions waiting for another reviewer do not. Completed request decisions and
session-copy notices remain available in history without keeping the sync warning
active. Retrying a project's uploads leaves other projects' failed operations
unchanged. A version conflict still needs review against the current shared
version.

Older local draft snapshots move to history only when the accepted revision and
the current local files establish that the installed version is current, with no
pending operation or conflict requiring those drafts. Their content is retained
for inspection. Differing files, queued changes, incomplete installations, and
unresolved session branches stay preserved for review. A matching existing
instruction file can establish its installation baseline without being rewritten;
an incoming instruction change still requires local review.

### Opt-in project sharing

Create and Join offer independent **Share automatically** and **Only when asked**
choices for Memories, Sessions, Plans, and Skills. New projects default to automatic
Memories, Plans, and Skills, with Sessions shared only when asked. Choices are saved
per project, per account, on this Mac. Existing choices are preserved and can be
changed in **Settings → Sharing**. Local Sessions, Memories, and Plans remain visible
under either choice.

Automatic publication indexes only selected ordinary categories. Browsing Sessions,
Memories, and Plans also discovers local content in a separate private catalog,
without enabling sharing, queuing uploads, or creating review requests.
In governed projects, automatic
memory and skill sharing publishes discovered changes for owners and publishers,
or submits them for approval for suggesters. Read-only content remains local.
Shared skills install automatically into
both project skill folders when Skills sharing is enabled and the member has
access. Clean skill updates apply automatically; conflicting local edits are
preserved for resolution. Shared instructions still require explicit local
installation review. Other authorized ordinary resources sync.
Disabling a category pauses its queued uploads, automatic local writes and
deletions, preserving files and previously published content. Re-enabling resumes
authorized work. Plans can be shared without full sessions: the scanner reads
relevant history locally, without queuing those transcripts. Selecting Sessions
shares complete conversations, including any plans or context in the transcript.

ENVs remain a separate encrypted, manual workflow. Checking ENVs allows the project’s ENV tools; it does not scan dotenv files, publish a set, choose recipients, or approve a device. Review keys and recipients in the ENVs tab before publishing. Turning ENVs off also blocks native publication retries. Rebuild the native app and restart its background agent to apply these checks; no cloud migration is required.

A single launchd agent runs at login and after the window closes. The UI communicates through SQLite commands/status; it never starts its own sync loop. A file lock prevents a second daemon.

Default interval: 15 minutes, adjustable from 1 to 1440 minutes. Startup, Sync now, and retries after reconnect also trigger checks. The daemon scans and persists local changes before contacting the service, uploads immutable retry IDs, pulls a project cursor feed, and atomically materializes accepted revisions. Failures use bounded retry backoff; terminal rejections remain visible. Missing or replaced roots, unreadable directories, and incomplete scans cannot cause deletions.

Memory uses three-way line diffs: additions and uncontested deletions apply directly, while replacements and overlapping edits use JEV with the existing, proposed and base text as context. JEV can retain the current text, accept the update or keep both. Missing keys, provider outages and uncertain decisions preserve the local edit, cached content and original queued request for retry. A recognized memory-consolidation failure pauses that resource while independent uploads and downloads continue. The app stays connected and shows the pending request under Failed uploads; the background agent retries it with bounded backoff. Upload batches rotate through the queue so a backlog of more than 100 pending memories cannot permanently block later changes. General service, authentication and network failures still stop the pass. The service needs a server-side `JEV_API_KEY`; the desktop never receives it.

Legacy projects retain three-way line merging for plans and skill files. Governed
instructions, skills and plans reject stale publication bases. Authorized shared
skills install and update automatically when Skills sharing is enabled;
changed instructions require explicit local installation review. Snapshots and tombstones
remain available for history and retries; no Git commits are created.

File errors are isolated to the affected item. Unreadable or unsafe skills, stale bindings, missing or corrupt cached uploads, failed downloads, and invalid memory entries remain visible for retry while independent work continues. An unavailable or replaced project folder pauses that project's filesystem work without stopping other projects. Download metadata is saved before blobs are fetched, so missing blobs retry after a restart even when the feed cursor has advanced. Verified source or downloaded bytes repair corrupt cache entries. Queued edits, local files, installation recovery records, and existing path and permission checks are preserved.

The repair engine runs before connecting to the service. It reconnects verified completed imports to native histories that moved into the archive, acknowledges deletions that are already complete, and preserves archived status. Archiving or unarchiving an unchanged teammate session does not publish a new owned copy. Changed local history, active edits, conflicts, queued requests, incomplete installs, and changed project roots retain their protections. Missing upload-cache bytes are fetched from an authorized cloud copy and verified before the original request is retried; unavailable bytes are never replaced with empty or newer content. For a single foreground repair-and-sync pass, run the app executable with `--orka-sync`; it uses the selected account/service and the same workspace lock as the daemon.

Sessions never line-merge. Incoming updates/deletions stay staged while a session is open. Stop is a turn boundary, not a close signal. Conflicts are visible to members; the session owner can choose Keep or Override, and a candidate owner can preserve their candidate as a copy. Resolution checks the current revision; simultaneous choices receive a refresh error instead of silently overwriting each other.

## Services and verification

Use Orka Cloud or your own [Docker Compose server](../server/README.md). The public repository includes the server source and deployment tools; see [hosting and authentication](hosting-and-auth.md).

Follow [CONTRIBUTING.md](../CONTRIBUTING.md) for desktop checks. The browser suite uses fixtures. Native service integration and two-Mac acceptance remain separate release checks.

### Project ENVs

ENV sharing is currently disabled in the desktop UI. Native encryption and compatibility code remains in place, but the current app does not expose the ENV workflow. Native tests use synthetic data and isolated storage.

### Email invitations

In **Settings → Members → Add Member**, enter a teammate's email and select
**Send invitation**. Onboarding's **Invite teammate** action opens the same form.
The teammate must sign in with the verified email address that received the
invitation. It works once and expires after 24 hours.

On an updated service, Owners and Admins can see active email invitations under
**Settings → Members → Pending invitations**, with the recipient and expiry.
Close **Add Member** after sending to refresh the list. Invitations disappear
after acceptance or expiry when the list refreshes; joining links do not name a
recipient and are not listed. Invited teammates receive Member access only after
accepting.

Choose **Link** in the invitation method control to create a joining link. Servers without email
delivery open directly on **Copy joining link**. Delivery errors preserve the
entered email and allow switching to a link. Invites retain your service's signup
policy; an instance with signup disabled still needs operator-provisioned accounts.
