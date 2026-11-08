# Orka plugin 0.2.0

Read shared project context and teammate sessions, prepare Claude Code handoffs, and explicitly share selected local snapshots from Codex or Claude Code.

The package has four workflow skills. Its remote MCP connection still has only the seven read-only tools and `orka.read` OAuth scope. The desktop package adds three local tools, implemented by the Orka app: `list_local_resources`, `preview_share`, and `share_selected`. Local discovery never uploads content. One-off publication uses the desktop's existing authenticated API client after checking that its account and service match the remote connection.

## Sharing modes

Each category has two choices in onboarding and project settings:

- **Share automatically:** normal scanning and synchronization for the category.
- **Only when asked:** local items stay private until an explicit plugin request shares one snapshot. Sharing once does not enable the category or authorize later edits and turns.

Newly connected projects default to automatic memories, instructions, skills, and plans; sessions default to Only when asked. Existing saved choices and legacy behavior are preserved. ENV sets retain their separate encryption and review workflow and cannot be published through these tools.

For example, ask “Share this session with the team” or “Update the shared deployment plan.” The assistant identifies the actual local item, previews a frozen snapshot, and sends that token. It asks for a selection if “this session” cannot be identified reliably. Complete skill directories and complete native session snapshots retain the existing packaging, lineage, and source-permission checks.

Publication returns `published`, `approval_required`, `queued`, or `conflict`. The plugin must report that exact outcome. Owner review stays in Orka's existing Requests workflow when permissions require it. Queued snapshots retry with the same request ID; later native edits never change their bytes.

## Build and connect

1. Use a compatible Orka API with MCP enabled, OAuth discovery, and migration `007_mcp_oauth.sql`. One-off sharing additionally requires `selectedSharing: 1` in `/v2/projects/capabilities` and `POST /v2/sharing/selected`.
2. Build the packages against a verified endpoint:

   ```sh
   node plugins/orka/scripts/package.mjs https://your-orka-service.example/mcp artifacts/orka-plugin-0.2.0.zip
   ```

   The packager verifies the seven remote read tools and OAuth discovery. It writes the portable ZIP and a companion `orka-plugin-0.2.0-desktop.zip`. This verifies discovery, not authenticated sharing or host acceptance.

3. Use the portable ZIP for the remote ChatGPT integration. Local publication requires the desktop package in Codex or Claude Code and an updated Orka app that supports `--orka-plugin`. A remote-only host cannot discover or share this Mac's private files.
4. The desktop package defaults to `/Applications/Orka.app/Contents/MacOS/portable-workspace-mac`. Supply a different absolute executable path as the fourth packager argument when testing an updated build or using another installation directory. The native command runs without opening the app UI and requires the app's existing signed-in account and connected project folders.
5. Install the desktop package through a local marketplace, then connect the remote Orka account through its browser consent page. The model's Codex/Claude account login is separate from the Orka connection. Credentials never appear in the package or tool results.

For Codex, register the local marketplace with `codex plugin marketplace add <marketplace-root>` and install `orka@<marketplace-name>`. See the [official local marketplace instructions](https://developers.openai.com/plugins/build/plugins#install-a-local-plugin-manually) for the catalog format.

For Claude Code:

```sh
unzip artifacts/orka-plugin-0.2.0-desktop.zip -d artifacts/orka-plugin
claude plugin validate artifacts/orka-plugin/orka --strict
claude --plugin-dir artifacts/orka-plugin/orka plugin details orka
claude --plugin-dir artifacts/orka-plugin/orka
```

The desktop inventory should show four skills and two MCP servers: seven remote read tools and three local sharing tools. Test project context, member/provider filters, source reading, and handoffs in both hosts. Use isolated fixtures to test explicit sharing with category automation off, exact retries, owner review, permission removal, and future-turn isolation. A production connection alone is not permission to publish unrelated personal sessions for testing.

## Handoffs

Handoffs contain selected shared excerpts, source revisions and URLs, explicitly supplied current-chat context, decisions, and next steps. They return Markdown and a starter prompt for a new Claude Code conversation. Saving or delivering a handoff does not publish it through Orka. Local code changes, credentials, executable agent state, and unseen account history are not transferred. One-off sharing is a separate explicit workflow.
