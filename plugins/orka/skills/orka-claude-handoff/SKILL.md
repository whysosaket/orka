---
name: orka-claude-handoff
description: Prepare work from a ChatGPT or Codex conversation and selected shared Orka sessions for continuation in a new Claude Code session.
---

# Prepare a Claude Code handoff

The user requests context transfer to Claude Code. The plugin prepares a reviewable Markdown document and starter prompt. It does not launch Claude Code, publish project knowledge or transfer executable session state.

1. Resolve the Orka project. Use `get_project_context`, `list_team_members`, `list_sessions` and `fetch_resource` as needed to understand the selected shared work. Fetch all relevant pages before drawing conclusions. Use explicitly relevant sources, not a bulk export of unrelated conversations.
2. Summarize the CURRENT conversation available to you: goal, actual progress, decisions, approaches tried, results, constraints, open questions and next actions. Do not imply access to unseen ChatGPT history. If context was compacted or missing, state that in the summary.
3. In a local Codex environment, inspect the project branch, commit and working tree when file tools are available and relevant. Label these as inspected. Record uncommitted work accurately, but do not imply those files will be transferred. Otherwise omit repository details or label any supplied details as unverified.
4. Call `prepare_claude_handoff` with the goal, selected `sessionIds` and `resourceIds`, faithful `currentContext`, decisions and next steps. Supply only source IDs returned for this project. The tool returns source revisions and labels partial excerpts. Retrieve additional source pages if an omitted section could change the handoff.
5. Deliver the actual returned Markdown as a `.md` artifact when file tools are available. In a local project, save it under `.orka/handoffs/` using the returned basename, preserving any existing file with a new suffix. Create a downloadable Markdown file in a cloud environment when supported. If neither is possible, present the complete handoff in a copyable block. Do not claim a file was saved unless a tool saved it.
6. Provide the starter prompt and tell the user to give Claude Code the handoff in the correct local project. Claude Code must inspect its actual repository state. Starting a model turn or opening a local application requires the relevant user request and an available desktop integration; this plugin exposes no launch tool.

The handoff retains source references and their access restrictions. Review content in the current conversation before sharing it further. It is a new conversation in Claude Code; agent-specific execution state, credentials, local files and uncommitted edits remain outside the transfer.
