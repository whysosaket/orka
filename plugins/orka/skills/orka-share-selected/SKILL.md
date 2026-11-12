---
name: orka-share-selected
description: Share or update one explicitly selected local session, memory, plan, instruction file, or complete skill with an Orka team, even when automatic category sharing is off.
---

# Share a selected snapshot

Use this workflow only when the user asks to share or update particular content. Reading project context, finishing a turn, or preparing a handoff is not a sharing request. The remote sharing of existing local snapshots still uses the desktop tools; remote knowledge writes have a separate workflow. The local Orka sharing tools require the updated desktop app and a compatible service.

1. Resolve the account and `serviceOrigin` with `get_profile`, and project/repository IDs with `list_projects`. Pass that account ID and origin to every local tool; never switch accounts or services to make a request succeed.
2. Call `list_local_resources` for the requested category, project, and repository. Include the native session ID when the host provides it. Follow `nextOffset` using `offset` while locating the requested item. A title, active marker, or most-recent timestamp alone does not identify the current conversation. Ask the user to select an item if identity is ambiguous. Never silently publish another session, repository, or an entire category.
3. Call `preview_share` with the selected resource ID and kind. Explain the item, snapshot size and included files when useful. This freezes the exact snapshot through that moment; later edits and future conversation turns are excluded. ENV files and arbitrary paths cannot be shared through this workflow. Share complete skill packages, not just their entry file.
4. If the user's request already authorizes sharing that identified item, call `share_selected` with the returned preview token. Do not require a second confirmation merely because automatic sharing is off. Follow the host's actual permission prompts. If the user requested only a preview, stop at the preview. Never enable automatic category sharing.
5. Report the actual status. `published` means the service accepted the snapshot; `approval_required` means an existing project policy requires owner review; `queued` means the frozen snapshot is saved locally for retry; `conflict` requires resolution before claiming an update. A queued request is not a completed share. Keep the request ID for safe retries; repeating the same preview token must not create another publication.

For “update the shared session”, preview its current local snapshot again and submit that new token. Sharing once does not authorize future turns. Ordinary automatic sharing continues only for categories the user has enabled in the app. Existing permissions, source provenance, account isolation, and review requirements always apply. If local tools or the desktop app are unavailable, explain that this sharing action requires the desktop integration; do not claim remote tools uploaded this local snapshot.
