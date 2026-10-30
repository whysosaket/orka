# Local development

Run commands from the repository root. Install Node.js 24+, Rust, and Apple's Command Line Tools on macOS, then run `npm ci`. Desktop builds and fixture-based checks require no private repository, database, or server package.

## Start the desktop app

```sh
npm run dev:profile
```

The launcher derives a stable profile from this worktree's canonical path, chooses a free loopback frontend port, and builds into this worktree's own target directory. Each worktree gets independent app settings, service URLs, logins, device identities, SQLite caches, blobs, ENV keys, locks and sync agents. Profile names and controls are not shown in the window title, onboarding, or Settings. Profiles use the same app binary; no separate edition build is required.

Choose Orka Cloud or enter an existing compatible self-hosted service, then sign in with an account provisioned by its operator. A browser-only preview can be used to develop the UI without an account. New named profiles start with background sync off. Enable **Settings → Run at login and after the window closes** when testing sync; its LaunchAgent is specific to that profile. Disable it before removing a worktree. The existing `default` profile keeps its original app data, Keychain and background-service identity.

Double-clicking `Open Orka.command` starts the same worktree-aware launcher. Keep its Terminal window open while developing; Ctrl-C stops the development process. A browser-only preview (`npm run dev`) cannot exercise native commands. The raw `tauri dev` command still uses `default` unless `ORKA_PROFILE` is set.

## Multiple profiles and worktrees

Run `npm ci` and `npm run dev:profile` from each worktree to develop concurrently. Two folders with the same basename still get different profile IDs. The chosen port and profile are printed on launch; `--port 5200` pins a port and fails clearly if occupied. `--dry-run` prints the resolved launch configuration without opening the app.

To select a stable test identity explicitly:

```sh
npm run dev:profile -- --profile alice
# In another worktree / Terminal:
npm run dev:profile -- --profile bob
```

Use the development launcher or the command below to open an isolated window with its own session. A profile already running is focused instead of opening a second writer. Use the launcher in another worktree to test that worktree's code.

Installed builds also accept `--profile <name>` or `ORKA_PROFILE=<name>`; the explicit argument takes precedence. For example:

```sh
open -na /Applications/Orka.app --args --profile alice
open -na /Applications/Orka.app --args --profile bob
```

Names use 1–48 lowercase letters, digits or hyphens, starting with a letter. Named profile data lives under `~/Library/Application Support/com.orka.v1/profiles/<name>/`; `default` continues using the existing parent directory. A profile name selects local Orka state, not a separate server database: use separate service accounts or deployments to isolate remote data.

Use distinct worktree folders and synthetic content for manual tests. Profiles do not sandbox the filesystem or create separate Codex/Claude Desktop accounts; the external tools retain their configured homes and native session workflows. Avoid connecting the same physical folder to two profiles: they would edit the same files and replace that folder's Orka hooks. Installed hooks carry the profile argument so a worktree's events reach the right client.

GitHub and magic links include a validated profile name in the callback. A callback received by another Orka window is delivered to the originating profile, which alone can exchange its PKCE verifier. Upgrade the service with the current auth proxy and GoTrue allowlist before testing browser sign-in in named profiles; password login remains compatible with older services. Different profiles may sign in independently, but browser provider sessions still belong to the system browser.

## Tests

Follow [CONTRIBUTING.md](../CONTRIBUTING.md). Unit and browser tests use synthetic fixtures. Native tests and `npm run test:profiles` exercise local desktop behavior without private backend packages. Live authentication and sync need a compatible running service; backend integration suites are maintained privately.

## Updating the shared protocol

The public checkout contains only the checksummed client protocol package recorded in `vendor/manifest.json`. Maintainers with access to backend release artifacts can run `npm run backend:update -- vX.Y.Z [release-directory]`. The updater verifies SHA-256 and npm integrity and imports only `@portable/protocol`; it excludes the server implementation and its tools. Consumers building the desktop need no access to that private release source.
