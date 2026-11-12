# Orka plugin 0.3.0

## Local desktop operations

The desktop plugin additionally exposes local discovery, preview, and selected publication through the updated Orka executable. The remote server exposes 18 tools with separate `orka.read`, `orka.write` and `orka.manage` consent. The desktop adds local skill installation and sync status/recovery alongside selected sharing; see [MCP operations](mcp-operations.md). `get_profile` includes `serviceOrigin` so the local bridge can match both service and account before accessing private items.

The normal authenticated API advertises `selectedSharing: 1` and accepts existing v2 changes at `POST /v2/sharing/selected`. Publication reuses sync's authorization, provenance, conflict and receipt rules. A caller with suggestion access instead receives the existing owner-review request; read-only or hidden access does not become write permission. Retry IDs cannot be reused with different content. Both editions use the same endpoint and require no new environment settings or migration. Remote read tokens are not native API credentials.

The Orka plugin brings project context and shared teammate sessions into ChatGPT and Codex, and prepares a Markdown handoff for Claude Code. The plugin source and five workflow skills live in the client repository under `plugins/orka/`. This repository owns the MCP endpoint, browser sign-in and authorization, and source reading.

## Implemented tools

| Tool                     | Behavior                                                                                                                         |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------------- |
| `get_profile`            | Identifies the connected account.                                                                                                |
| `list_projects`          | Lists active projects the account belongs to.                                                                                    |
| `get_project_context`    | Reads accepted memories, instructions and plans, with folder scope, query and pagination. Excludes readable superseded memories. |
| `list_team_members`      | Resolves member IDs and names inside an accessible project.                                                                      |
| `list_sessions`          | Lists accessible shared session snapshots by author, provider, title query or snapshot date. Newest shared revision first.       |
| `fetch_resource`         | Reads memory, plan or readable session text in bounded pages, guarded by source revision.                                        |
| `prepare_claude_handoff` | Returns Markdown, selected source excerpts, citations and a starter prompt for a new Claude Code conversation.                   |

The seven context and handoff tools above are read-only. The eleven additional discovery, history, write and administration tools are documented in [MCP operations](mcp-operations.md). Handoff preparation returns text and creates no shared resource. Skills instruct the host to save that text as a local or downloadable Markdown artifact when file tools are available. No tool launches Claude Code or starts a model turn.

## Authentication and permissions

Enable the integration with `MCP_ENABLED=true` and an explicit `PUBLIC_URL`. It remains disabled by default. HTTPS is required except on local development loopback. The existing GoTrue service must support password or email-code sign-in. The plugin consent page supports those methods; GitHub-only browser sign-in is outside v0.1.

The Go server implements Streamable HTTP, OAuth discovery, dynamic client registration, authorization-code PKCE and protocol errors. SDK clients exercise that wire contract in integration tests. The browser signs in through Orka's existing GoTrue service. Native credentials are never copied from the desktop, stored in plugin files, or returned to the assistant. Browser credential submissions use a same-origin POST and a short-lived, HttpOnly, SameSite cookie bound to the connection transaction. No browser JavaScript or browser token storage is used.

Plugin email requests select a fixed service-origin `/mcp/connect` redirect marker. SMTP templates and the signed Resend hook send a code only for that marker. Desktop PKCE requests retain their scanner-safe, link-only email; the public desktop auth proxy cannot select the plugin marker.

The authorization server issues independent opaque tokens with the explicitly consented `orka.read`, `orka.write` and/or `orka.manage` scopes with a fixed MCP resource audience. Access tokens last one hour. Refresh tokens rotate and last 30 days; reuse of an old refresh token revokes its whole family. `/revoke` revokes the connection's token family. Refresh and revocation serialize by token family so a concurrent refresh cannot leave replacement tokens active after disconnect. Tokens and single-use authorization codes are stored as SHA-256 digests. DCR client metadata is persisted, including SDK-generated client secrets when a confidential client uses them. This metadata remains sensitive service data. Expired transactions, codes and token rows are cleaned during new authorization flows.

Plugin tokens are not valid credentials for ordinary `/v2` API operations. Each tool checks active project membership and current resource access. Known source restrictions on derived resources remain enforced. Project share locks keep permission and lifecycle changes consistent with a read. Hidden and deleted resources are unavailable by direct ID, enumeration and handoff generation. The remote plugin excludes ENV sets and private Mac-only content. Explicitly consented write/manage tools expose authorized proposals and project operations through the existing review and permission workflows. Skill installation and machine sync use the local desktop bridge.

The initial schema migration `001_initial.sql` includes the isolated OAuth tables; `004_mcp_operations.sql` persists grants and operation receipts, defaulting existing tokens to read-only. It does not alter existing project or policy data. Follow the [baseline adoption procedure](compatibility.md#initial-schema-baseline) when moving from a historical migration ledger. Existing deployments need an explicit API image update and `MCP_ENABLED=true` before the endpoint is available.

## Transcript and handoff behavior

Session reading supports Claude JSONL and Codex legacy/paginated JSONL. Paginated history resolves only the exact inherited file and byte/ordinal boundaries declared in the snapshot. Corrupt, missing, cyclic or unreferenced lineage fails visibly. Complete source blobs remain unchanged.

The readable conversation excludes setup, analysis, tool payloads and nontext blocks. Mirrored Codex message forms are deduplicated within turns, while repeated turns are retained. A session bundle must be at most 32 MB for plugin reading; larger bundles remain available through the desktop. Ordinary text sources are bounded by their existing 1 MB limit. Fetch results contain up to 40,000 UTF-16 code units per page. Continue with both `nextOffset` and `expectedRevision`; a changed source requires restarting the read.

Context and session lists scan bounded pages of 500 resources. Pass each returned `nextCursor` unchanged as the next request's `cursor` until it is null. Cursors include both revision and resource ID so sessions published under the same revision are not skipped. Earlier numeric revision cursors remain accepted. Context queries search titles and text; session queries search titles. Context returns up to 20 source excerpts per page. Folder-specific context requires a relative scope. Session authors and last-shared timestamps describe snapshots, not live presence or all work by a teammate.

Projects can contain multiple repository sources. `list_projects` returns their IDs and names; every returned source reference includes its repository `sourceId`, or `null` for unassigned project context. Context and session queries accept an exact `sourceId` filter. Folder guidance in projects with multiple repository sources requires that filter, preventing same-path guidance from another repository from being applied accidentally. A filtered query excludes unassigned context; query without the filter to read that project-wide material.

Handoffs accept up to five sessions and ten other sources. Each session contributes a clearly labeled excerpt from the end of its readable conversation, up to 16,000 characters; ordinary sources contribute up to 8,000 characters from the start. The assistant should read more context before preparing the handoff when omitted material could change the result. Current-chat context, decisions, next steps and repository details are caller supplied. Unseen ChatGPT history is never fetched automatically.

Source URLs open a public landing page that discloses no source content or title and links into Orka. The desktop requires sign-in and project access. Users must select the matching service for self-hosted sources.

The handoff is a new conversation. It transfers no local files, uncommitted changes, credentials or provider execution state. The returned artifact carries source references and instructions to retain their restrictions; manually delivered artifacts and the receiving session are not automatically registered as governed Orka derivatives in v0.1.

## Verification and connection

For a disposable browser preview, run `npx tsx tests/acceptance/mcp-preview.ts`. It starts isolated PostgreSQL, a synthetic sign-in service and the API on loopback port 8787, then prints a connection URL and fixture credentials. Complete that browser flow to save tool output and a sample handoff under `artifacts/plugin-review/`. Use `ORKA_PLUGIN_EVIDENCE_DIR` to select another output directory and `ORKA_PLUGIN_PREVIEW_PORT` for another port. Stop the process to clean up its temporary database and services. This preview does not use an installed Orka account or production data.

Run `npm run build`, `npm run typecheck`, `npm test`, `npm run test:integration`, `npm run lint`, `npm run licenses:check` and `npm run check:repository`. Integration tests provision an isolated PostgreSQL instance and synthetic identities. They exercise the real SDK client and HTTP transport, browser consent with a synthetic GoTrue boundary, PKCE, code replay, resource/redirect binding, hidden-source and derivative denials, membership removal, pagination, handoff preparation and refresh replay. Fixtures never use personal projects or real credentials.

Build the managed Docker target and run `npm run test:images -- managed <image>`. The disposable image stack runs actual GoTrue and PostgreSQL with captured fixture email through the managed signed email hook. It checks email-code plugin consent, the remote tool inventory and existing read workflows, a handoff, refresh/revocation, ordinary API token isolation and coordinated backup/restore. Captured local email does not prove production email delivery or host installation.

Then deploy the reviewed API, verify discovery and complete the browser sign-in with a real test account. In the client repository, run the plugin packager against that verified endpoint. It refuses an unavailable service or a missing tool/auth contract. Save that completed ZIP with Plugin Creator as a private plugin and verify the context, write, administration and local workflows in both ChatGPT and Codex.

Repository checks do not establish production rollout, actual GoTrue email delivery, successful ChatGPT/Codex installation, physical Mac behavior or Claude Code launch. Public directory submission is a separate scope.

The package uses the per-server `extensions.com.openai.auth` declaration documented by OpenAI. The generic Agent Plugins 1.0 MCP JSON schema currently omits server extensions; its transport can be validated separately, but the complete OpenAI connection declaration still requires host import acceptance. Do not remove OAuth configuration merely to make that generic schema pass.

Implementation follows the official [plugin authentication](https://developers.openai.com/plugins/build/auth), [MCP server](https://developers.openai.com/plugins/build/mcp-server) and [package](https://developers.openai.com/plugins/build/plugins) documentation.
