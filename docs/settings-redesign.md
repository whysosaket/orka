# Workspace Settings

Settings stays in the workspace and has six destinations: Profile, Devices, Sync & startup, General, Members, and Permissions. Account and Mac settings work without a selected project. Settings navigation and project/resource entry points share the Save, Discard, and Stay guard.

Settings uses the approved 20/30 title, 14/20 field labels, 16/20 item names, 12/20 metadata, and 15px list radius. Permissions keeps its heading outside the scrolling role tables. Member management actions appear on row hover or keyboard focus without moving role controls. General's Reset to default restores the saved shared name in the current draft and retains unrelated sharing edits.

Readable section labels, timestamps, and fixed-access text retain the muted text token rather than the design's disabled gray, which fails the existing contrast checks. Email remains read-only, job role remains descriptive text, Owner controls retain their authorization rules, and device rows show registered identity and Last seen without inferring live connectivity.

React renders drafts and invokes existing Tauri commands. Rust owns local preferences, Keychain state, files, folder validation, and sync. The interface does not introduce another sync loop or an offline profile/policy-save queue.

## Service compatibility

The authenticated `/v2/projects/capabilities` response advertises `rolePolicies: 1`, `policyOperations: 1`, and optional `deviceHardware: 1`. Without both policy capabilities, Permissions explains that the service needs an update and stays read-only. Existing projects keep legacy enforcement until an Owner confirms the exact migration diff.

A policy save includes all eight Admin/Member choices, the expected policy revision, and one logical operation UUID. Uncertain outcomes keep selectors locked and reconcile that UUID. Reconnection never applies a permission draft automatically. Conflicts require an explicit comparison and preserve unrelated newer values. Account, service, and project scopes bind drafts and responses; signing out clears draft and Skullet shape memory.

The desktop consumes role-policy types, categories, allowed access values, and defaults from the checksummed protocol 0.5.3 release in `vendor/`. API source remains canonical; the manifest pins the published release commit and package checksum.

The Owner can review all retained file/source restrictions. Admins and Members see only their own restriction records; a role does not grant access to someone else's restriction metadata. Legacy projects retain their existing Owner-only catalog boundary.

Profile edits require the existing version 2 profile contract and a confirmed service response. Job role is descriptive. Email stays read-only. Uploaded photos use the existing bounded canvas/PNG pipeline. Native validation also decodes the image before accepting it.

## Local versus shared changes

- Owner rename updates the shared name. Other members can set or remove a name override on this Mac.
- General saves name and sharing preferences together in the interface, acknowledging each confirmed step if another fails. It does not imply a cross-system transaction.
- Folder actions complete separately. Picker cancellation preserves drafts. Queued changes prevent disconnect; successful disconnect retains files and shared content.
- Source-folder rows show names, with the full stored path in a native hover tooltip. Native path/identity checks distinguish connected folders, saved mappings needing Reconnect, and sources needing Locate Folder. An unlocated source's disconnect control stays disabled. These transient states are not persisted or sent to the API.
- Sharing choices belong to this Mac/project. Turning one off retains shared history.
- Sync preferences belong to this Mac across projects. The interval offers 1, 5, and 15 minutes; legacy values remain until explicitly replaced. Background sync retains the combined login/closed-app behavior.

## Loading and verification

Skullet 0.0.3 uses the installed 150 ms smart-reveal threshold. Samples share the real presentation components, remain inert, and never fetch or mutate. Cached identities/local preferences remain readable during refresh. Regions expose Retry and quiet feedback after eight seconds. Permissions skeletons cover only unavailable editable values.

Behavior coverage lives in `tests/ui/settings.spec.ts`, existing review/navigation suites, and the native tests. Server authorization, transactions, migration, receipts, and actual native queue/file behavior are verified in the separate API repository. Browser fixtures establish UI behavior and rendering, not server or native-file effects.

Actual Tauri acceptance used a disposable named profile and local service. Physical two-Mac acceptance, real Login Items registration, and authenticated production Cloud role-policy checks remain separate release checks. The isolated debug harness deliberately rejects enabling background startup.
