# Release checklist

## Public source release

- [ ] Confirm project code and artwork ownership, the selected license, and third-party asset permissions.
- [ ] Review the exact source commit/archive, all included Git history and refs, and any GitHub content that would become public.
- [ ] Resolve credential findings and rotate exposed credentials before publishing. Review internal metadata separately from secret scanning.
- [ ] Run `npm run check:repository`, the secret scan, dependency audits, and contributor checks.
- [ ] Refresh `npm run licenses` and review the dependency and asset inventory.
- [ ] Enable private vulnerability reporting and protect the public default branch after creating the public repository.
- [ ] Label the release alpha and document known limits. Publish only the reviewed candidate.

## Stable binary release

- [ ] Collect and distribute upstream license notices and applicable corresponding-source information for the dependencies actually shipped.
- [ ] Verify Apple signing/notarization and signing-environment access. Keep signing secrets unavailable to pull-request code.

Do not label the build release-ready until these checks have evidence from two physical Macs and the deployed EC2 service.

- [ ] Install permanently, sign in with separate provisioned email/password accounts, and add/join one project with different local folder paths.
- [ ] Claude learned memory appears in Codex hook context; attributable Codex learned entries appear in Claude context. Other project/global memory stays excluded and untouched.
- [ ] A complete skill package propagates to both native locations on both Macs; run its scripts and inspect binary assets/modes.
- [ ] Independent additions/deletions merge; overlapping lines follow server acceptance order with deliberately incorrect device clocks.
- [ ] Work offline, restart the app and daemon, reconnect, and verify no duplicate uploads or replayed obsolete events.
- [ ] Synced Codex sessions appear in Orka without adding conversations to native CLI history or the Codex desktop sidebar. Explicit Open creates one local copy; reopening reuses it, including when newer forks arrive from another Mac. Incoming revisions preserve existing native history. Record exact Desktop/CLI versions. Verify Claude's native history separately; its automatic sidebar insertion/removal is currently unresolved.
- [ ] Resume a native conversation on the second Mac. Cross-tool continuation opens a new conversation referencing the export.
- [ ] Leave a session open between turns. Incoming updates and deletions never touch its native files/history until it closes.
- [ ] Both users see conflicts; Keep, Override, and Create copy behave correctly. Simultaneous resolution attempts force a refresh for the losing request.
- [ ] Continue a teammate's session through Orka and through native history; each creates a copy and an owner notice.
- [ ] ZIP round-trip preserves a session and a complete skill, rejects unsafe paths, symlinks, corrupt hashes, and oversized inputs.
- [ ] Close Orka and verify background sync; verify login startup and one process; change the interval and observe the new schedule.
- [ ] Validate EC2 HTTPS/authentication, token refresh, membership isolation, service restart recovery, and a coordinated backup/restore drill.
- [ ] Sign and notarize the Mac build, verify its signature and repeat native hooks/history checks after installation.

Development tests use fresh storage and preserve existing development caches. Repository code and working-tree changes remain outside Orka; transfer those with Git.
