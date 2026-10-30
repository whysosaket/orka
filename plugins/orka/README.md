# Orka plugin 0.1.0

Project context, shared teammate sessions, and handoffs to Claude Code for ChatGPT and Codex.

The plugin has three workflow skills and connects to the Orka API's read-only MCP server. The API owns authentication, resource permissions and transcript reading. The package contains no credentials, copied project data, local process, or automatic app launcher.

## Build and connect

1. Deploy the matching Orka API implementation, apply migration `007_mcp_oauth.sql`, set `PUBLIC_URL` to its HTTPS origin and `MCP_ENABLED=true`, and verify the service. Email-code or password sign-in must be enabled. A local HTTP server is supported for development.
2. Run `node plugins/orka/scripts/package.mjs <verified-https-origin>/mcp artifacts/orka-plugin-0.1.0.zip` from the Orka repository. The packager initializes the real endpoint, verifies all seven tools and OAuth discovery, and then writes `mcp.json` into the ZIP. It refuses an unavailable or incompatible endpoint.
3. Save the completed ZIP with Plugin Creator as a private plugin. This does not deploy the API or publish a public listing.
4. Enable Orka in ChatGPT or Codex. Connect through the browser consent page using an existing Orka account. The connection has `orka.read` scope and is independent of the desktop's credentials.
5. Test project context, member-session filtering, source reading and a handoff artifact in both hosts. Also verify an inaccessible source is denied. Tool discovery alone is not host acceptance.

The service implementation is maintained privately. Obtain a compatible MCP endpoint and account from your service operator; this repository contains only the client plugin.

## What v1 transfers

Handoffs contain selected shared source excerpts, source revisions and URLs, explicitly supplied current-chat context, decisions and next steps. They return Markdown and a starter prompt. Save the handoff and give it to Claude Code in the correct repository. Local file changes and executable agent state are not transferred. Private Mac-only memory, ENV sets, writes, skill installation, and direct app launching are outside this version.

Only the conversation context visible to the current assistant can be included from ChatGPT. Complete ChatGPT account history is not imported.
