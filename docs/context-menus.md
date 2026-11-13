# Item actions

Right-click a memory, skill, plan or session to see its available actions. The
same actions are available from its **…** button in a collection and from the
detail view. Recent Updates on Home uses right-click or **Shift+F10** on an item
without a separate **…** button. The menu uses the item you clicked, without
opening it first. Text fields, selected text and links keep their normal editing
and copy menus. Empty application chrome does not show the webview's Reload menu.

Use **Open in editor**, **Copy content**, **Copy link**, **Show in Finder** or
**Copy local path** when those actions are available. Skills and plans can be
exported as ZIP packages. Sessions offer a continuation/fork chooser, a copyable
prompt, a shared copy and a session download. Review actions reuse the existing
local-update and local-edit previews. A link does not grant its recipient access.

## Share one snapshot

A local item or your local changes can offer **Share snapshot with project…**.
Review the project, service, exact file list and snapshot before confirming.
Preparation shows file-checking activity while the snapshot is read, with a
progress bar and current stage. File totals appear only when known. Files are
listed with their individual sizes and the snapshot total.
Sharing keeps the local original and does not change automatic category sharing.
Later edits or future conversation turns are not included in that snapshot.

The result can be shared, queued, awaiting approval or in conflict. A queued or
approval-required result is not a completed publication. Reopening and retrying
an uncertain publication keeps the reviewed request identity. Your service must
support selected snapshot sharing; an older service leaves the snapshot queued
until that capability is available.

## Delete shared content

Available deletion actions open a review before changing shared history. The
review explains the scope and any local paths. Shared skill deletion can remove
installed project skill folders on Macs that sync skills; the original global
skill stays. Shared plan deletion can remove materialized plan files, while an
extracted plan's original session stays. Session removal may archive a Codex
thread or remove a Claude history copy. Local edits, pending conflicts and active
native sessions retain their existing safeguards.

Shared memory deletion is limited to accepted governed shared knowledge. Personal
learned memory and project instruction files are not deleted through this menu.
No generic local/global Delete, source-preserving Unshare or cross-project Move
is implied. Previously exported copies cannot be recalled.

Deletion needs a service response and never claims an offline operation was
queued. If a request's response is uncertain, retry the same reviewed deletion.
A changed item, source, permission or expired review requires another review.
Older services must be updated before deleting content whose reviewed revision
they cannot safely verify. The shared API advertises `resourceDeletion: 1` for
atomic non-session deletion; sessions retain their existing conflict behavior.

## Projects, members and source folders

Right-click a project option to copy its link or open its settings, name, members,
permissions or source folders. Settings target that project without changing the
background project. Existing unsaved-change guards still apply. Owners rename the
shared project; other members rename it only on this Mac.

Member and source-folder menus reuse the visible **…** actions and existing
confirmation dialogs. Folder disconnect/removal is distinct from deleting a Git
repository, and pending changes retain their existing guards. Finder/path actions
refer only to validated locations on this Mac.

## Keyboard access

Focus an item and press **Shift+F10** or the context-menu key, or focus its **…**
button and press Enter. Use arrow keys and typeahead in menus, and Escape to
close the menu and return to the item. Nested project menus close before their
parent picker. Actions that open a dialog move focus into that dialog.
