# Orka plugin 0.3.0

Search Orka context, inspect resource history, save memories and plans, review requests and permissions, install complete skills, and inspect local synchronization from your coding agent.

The package includes five workflow skills. Its remote MCP server exposes 18 tools through OAuth. The desktop package also connects to the installed Orka app for private local discovery, selected sharing, skill installation and sync recovery. Remote-only hosts and cloud agents can operate shared resources; operations on a Mac require its local desktop connection.

## New tools

| Tool | Availability | Behavior |
| --- | --- | --- |
| `search_resources` | Remote | Search accessible memories, instructions, plans, skills and session snapshots across projects and repositories. |
| `get_resource_history` | Remote | Inspect revisions with authors and timestamps. |
| `compare_revisions` | Remote | Compare two revisions of an accessible resource. |
| `list_skills` | Remote and desktop | Discover accepted shared skills; the desktop also discovers local skills. |
| `install_skill` | Desktop | Install a complete local, global or accepted shared skill package into a connected project or supported agent. |
| `create_memory` | Remote | Save knowledge to a selected project or repository through existing publish/review policy. |
| `update_plan` | Remote | Update an existing plan with revision protection. |
| `get_sync_status` | Desktop | Inspect this Mac's project progress, queue, conflicts and errors. |
| `retry_sync` | Desktop | Schedule pending or failed work for retry while retaining request identities. |
| `repair_sync` | Desktop | Repair recoverable local sync state while preserving pending changes. |
| `get_permissions` | Remote | Inspect effective project, member or resource access. |
| `update_permissions` | Remote | Change permissions within the caller's existing authority. |
| `list_requests` | Remote | List accessible requests and proposals awaiting review. |
| `review_request` | Remote | Inspect and approve or reject a selected request through Orka's workflow. |
| `resolve_conflict` | Remote | Inspect a sync conflict and apply the selected revision-protected resolution. |

Existing project-context, teammate-session, handoff and selected-sharing tools remain available. Resource access, source audiences, authorship and owner-review requirements are enforced by Orka. ENV content is excluded.

## Consent and outcomes

`orka.read` permits reads. `orka.write` additionally permits memory/plan writes and conflict resolutions; `orka.manage` permits permission changes and request reviews. Mutation tools require read access plus their specific scope and the requesting user's project authority. The consent screen describes the requested scopes. Existing read-only grants stay read-only, including after refresh; reconnect and explicitly consent to enable new operations.

Use exact project/repository IDs and current resource or policy revisions. Retain an operation ID when retrying an uncertain write. A stale revision requires rereading and reconciling the newer state. Report the returned result accurately: queued, conflicted or awaiting approval does not mean published or completed.

## Local skills and sync

Local calls require the remote account ID, service origin and project ID to match the signed-in desktop. Skill discovery returns an origin (`local`, `global` or `shared`), `skillId`, and `snapshotHash`. Pass those exact values to `install_skill` with `target` set to `project`, `codex` or `claude`; shared skills additionally require their `expectedRevision`. Project installs populate both `.agents/skills` and `.claude/skills`; agent targets use their configured homes. Installation preserves the complete package and executable flags and refuses divergent destination files. Installing a skill does not execute its scripts or enable sharing.

Sync status describes the connected Mac, not every device in the project. Retry processes existing queued work without scanning new local edits. Account-wide permission refresh retains Orka’s normal revocation cleanup; it may update access state outside the selected project. Retry preserves queued payloads and operation IDs. Repair skips unsafe recovery and preserves pending writes and conflicts. Check status after a retry; scheduling work is not proof of completed synchronization. A cloud-only connection cannot inspect a Mac's private files or recover its local queue.

## Selected sharing

Each category's automatic-sharing preference remains unchanged. **Only when asked** keeps local items private until an explicit request publishes one frozen snapshot. Sharing once does not authorize later edits or conversation turns. Sessions default to this mode for newly connected projects; existing preferences are preserved. ENV sets retain their separate workflow and cannot be published by this plugin.

Use `list_local_resources`, `preview_share` and `share_selected` for an existing local item. Identify the actual item; recency alone cannot establish the current conversation. The preview freezes exact bytes. Publication returns `published`, `approval_required`, `queued` or `conflict`, and safe retries retain the same request ID.

## Build and connect

1. Update the API and apply its migrations, including MCP scope and operation-receipt storage. For the managed service, update the Dashboard consent implementation before enabling write/manage connections. Existing read-only clients continue to work. Selected sharing additionally requires `selectedSharing: 1` in `/v2/projects/capabilities`.
2. Build against the updated endpoint:

   ```sh
   node plugins/orka/scripts/package.mjs https://your-orka-service.example/mcp artifacts/orka-plugin-0.3.0.zip
   ```

   The packager validates the 18 required remote tools, their read/write annotations, required scopes and OAuth discovery. It creates the portable ZIP and `orka-plugin-0.3.0-desktop.zip`. Discovery verification does not establish authenticated host acceptance.

3. Use the portable ZIP for remote integrations. Codex and Claude Code on a Mac use the desktop ZIP and an updated Orka app supporting `--orka-plugin`. The default executable is `/Applications/Orka.app/Contents/MacOS/portable-workspace-mac`; pass another absolute path as the fourth argument for a development build. The process reuses Orka's signed-in account without opening its UI.
4. Install through the host's local plugin support, then connect the remote Orka account using browser consent. Agent-account login is separate from Orka login. Packages and tool results never contain credentials.

For Claude Code:

```sh
unzip artifacts/orka-plugin-0.3.0-desktop.zip -d artifacts/orka-plugin
claude plugin validate artifacts/orka-plugin/orka --strict
claude --plugin-dir artifacts/orka-plugin/orka plugin details orka
claude --plugin-dir artifacts/orka-plugin/orka
```

Use isolated accounts, project folders and agent homes to validate writes, review policy, stale revisions, permission removal, complete skill installation and pending-preserving sync recovery. Signed app distribution, plugin publication and service deployment are separate release steps.

## Handoffs

`prepare_claude_handoff` returns selected shared excerpts, source revisions and URLs, supplied current-chat context, decisions and next steps as Markdown plus a starter prompt. Saving or delivering it does not publish it through Orka. Local code changes, credentials, executable agent state and unseen conversation history are outside the transfer.
