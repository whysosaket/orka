---
name: orka-team-sessions
description: Find and explain a teammate’s accessible shared Orka sessions, decisions, work history, or context before collaborating or continuing their work.
---

# Read teammate session context

1. Resolve the project with `list_projects` and the teammate with `list_team_members`. Use returned IDs. If names are ambiguous, ask which member the user means.
2. Call `list_sessions` with that `memberId` and optional provider, title query or `since` filter. If the request concerns one repository in a project with multiple repositories, select its `sourceId` from `list_projects.sources`. Follow pagination. A query searches session titles, so broaden it if a narrow query finds nothing.
3. Read the relevant sessions with `fetch_resource`. Continue character pagination using both `nextOffset` and `expectedRevision`. The readable view excludes setup, tool payloads, analysis and nontext content. Do not claim to have inspected those records.
4. Explain the goal, decisions, attempted approaches, unresolved questions and likely next steps supported by the retrieved conversations. Keep completed actions distinct from suggestions, plans or claims made by an agent.
5. Cite each session URL, attribute it to the returned owner, and mention the last shared snapshot date when relevant. A shared snapshot does not establish what the teammate is doing now. No visible session means no accessible shared evidence, not that the person did no work.

Read only the context needed for the request. Resource permissions are enforced by Orka. If a source becomes unavailable, stop using it and refresh the relevant results. Do not infer hidden titles or bypass a denial by requesting a derived handoff.
