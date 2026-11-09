# Self-host Orka with Docker Compose

Run your own Orka service from this public source tree. The server needs Docker,
a shell and OpenSSL. Backups and upgrades also need Bash and Python 3. You do **not** need Node.js, Rust, a Supabase project, an
Orka Cloud account, private registry access, or email/OAuth keys for the default setup.

## Operator releases

An operator archive contains only the deployment configuration, one `orka-server`
interface and backup/recovery tools. It has no npm workspace, tests, source tree or
managed AWS/SSH automation. Install Docker Compose **2.24 or later**, a shell and
OpenSSL; backups/recovery also require Bash and Python 3.

Extract a reviewed archive and run the setup commands below directly in its
`orka-server/` directory. Its image is pinned by the release. No Git or source build
is needed. A source checkout can use the same path explicitly:

```sh
sh ./orka-server setup --local --email you@example.com --image registry.example/orka:version
```

Use the image reference from the reviewed release. This change does not assume an
unpublished image is available. Maintainers generate an archive from the selected
image using `npm run package:operator -- registry.example/orka:version` and publish
it with the matching image digest. Image updates use
`sh ./orka-server upgrade --image registry.example/orka:new-version`; the helper
verifies a backup before changing the installed image.

## Quick start: try it on your computer

Install [Docker Desktop](https://docs.docker.com/desktop/) on macOS, or
[Docker Engine and its Compose plugin](https://docs.docker.com/engine/install/)
on Linux. On Windows, run these commands in WSL2 with Docker integration enabled.
Start Docker before continuing. Install Git and OpenSSL if they are missing.

From a fresh terminal:

```sh
git clone https://github.com/whysosaket/orka.git
cd orka/server
sh ./orka-server setup --local --email you@example.com
sh ./orka-server credentials
```

Replace `you@example.com` with your sign-in email. No email is sent. The first
command builds the server, starts its database/authentication services, creates
your account, checks health, and prints the connection address. The first build
can take several minutes. The credentials command deliberately displays your
saved login in your local terminal so you can copy it into Orka.

On your Mac, download the universal DMG from [Orka releases](https://github.com/whysosaket/orka/releases),
open it and drag Orka into Applications. The installer supports Apple Silicon
and Intel Macs with macOS 12 or later. Open Orka, choose **Connect to your server**, enter
`http://127.0.0.1:8080`, and sign in with that email and the generated password.
Create/connect a project and choose what to share as usual.

Local mode is available only on this computer. To use the server from other Macs,
follow the public HTTPS setup below. If port 8080 is busy, use:

```sh
sh ./orka-server setup --local --port 8181 --email you@example.com
```

The helper prints the new address and updates your saved connection details.
Re-running setup preserves the database, account password and server secrets.
Running `sh ./orka-server setup` without flags also offers guided setup in a terminal.

## Run a server for your team

Use a Linux server you administer with Docker Engine, Compose, Git and OpenSSL.
Point a domain's DNS records at that host and allow inbound TCP 80 and 443.
If you publish an AAAA record, IPv6 must reach the same host. Keep database/auth
ports private. No Node.js or npm installation is needed.

```sh
git clone https://github.com/whysosaket/orka.git
cd orka/server
sh ./orka-server setup --domain sync.example.com --email you@example.com
sh ./orka-server credentials
```

Replace `sync.example.com` with your real hostname. The helper starts Caddy,
waits for service health, and checks public HTTPS. In the desktop app, choose
**Connect to your server**, enter `https://sync.example.com`, and sign in.

The server runs PostgreSQL, GoTrue, the Orka API and Caddy through Docker Compose.
Only Caddy publishes ports in public mode. Caddy obtains and renews TLS
certificates. Named volumes persist the database, blobs and certificates.

Each new installation gets its own saved Compose project name and image tag.
Reuse its directory and private `.env` when restarting or upgrading. Do not run
setup in a new checkout to upgrade an existing server. Existing bind-mounted
deployments keep their original configuration until explicitly migrated.

## Everyday commands

Run from `orka/server`; the helper remembers the mode, project name and port:

```sh
sh ./orka-server status
sh ./orka-server doctor
sh ./orka-server logs
sh ./orka-server stop
sh ./orka-server start
```

Stopping removes containers and keeps your data. Starting reuses installed images and restores the saved installation without a build. To add a teammate:

```sh
sh ./orka-server user teammate@example.com
```

This writes that user's generated login to the private file named in the output.
Read it locally and deliver it through your usual secure channel. Then invite
the account to a project from Orka. Server accounts and project membership are
separate; public registration is disabled by default.

Your owner login is saved in `.runtime/accounts/owner.json` with mode 0600.
Store the password securely. You can remove the local login file after saving it;
the account continues to work. If removed, use `start` for ordinary restarts.
Setup will never reset an existing account's password to replace a missing file.

## Back up and upgrade

```sh
sh ./orka-server backup
```

This briefly pauses writers, backs up the database, roles, blobs and private
server configuration, restarts the services, and verifies an isolated restore.
It prints the private backup directory. Keep encrypted off-host copies:
**these backups include server credentials**. An optional path chooses the destination:

```sh
sh ./orka-server backup /absolute/private/backups/orka
sh ./orka-server verify-backup /absolute/private/backups/orka
```

To upgrade, keep this installation's directory, `.env` and named volumes. Read
[compatibility](docs/compatibility.md) and any [data migration requirements](docs/project-sources.md),
then select the new reviewed source revision:

```sh
git pull --ff-only
sh ./orka-server upgrade
```

Upgrade takes and verifies a backup before rebuilding/restarting. A failed backup
blocks the upgrade. It does not fetch source or rotate credentials automatically.
Check sign-in and sync afterwards. An image rollback alone cannot reverse a
destructive database migration.

### Move an existing migration ledger to the baseline

Fresh installations already use one `001_initial.sql` migration and need no reset.
For an existing server that completed all eleven historical Orka migrations:

```sh
sh ./orka-server upgrade --reset-ledger
```

This takes and verifies a backup, replaces only the completed Orka migration
ledger with its one baseline entry, and restarts. It preserves accounts, projects,
resources and blobs. Incomplete or unknown histories are rejected unchanged.
GoTrue's separate authentication migrations are unaffected. See
[baseline compatibility](docs/compatibility.md#initial-schema-baseline).
After adoption, keep using baseline-based images. Restoring the pre-upgrade backup
is required to return to an historical server version.

## Recover onto a clean host

Use a fresh Docker host with no existing Orka volumes for this installation.
Clone the source revision recorded in the backup's `source-revision.txt` and
verify the backup first. `source-manifest.json` also records the server snapshot;
a backup of an uncommitted candidate needs that candidate's source files.
Run recovery in the fresh release/source directory:

```sh
sh ./orka-server restore /absolute/private/backups/orka
```

The command verifies the archive and database restore, restores the original private
configuration, and refuses to reuse existing containers or volumes. It requires
no existing `.env`. For a recovery drill on the same Docker host, choose a fresh
`--project orka-recovery`; local backups also accept `--port 8181`. Never restore
over a live installation. Bind-mounted legacy installations retain their separate
migration procedure.

Keep the original database passwords and JWT secret from the backup. If the
operator's numeric UID/GID changed, update `ORKA_OPERATOR_UID/GID` in `.env`
to match `id -u` and `id -g` before provisioning more accounts. Point the
original domain at the new host and verify sign-in/project sync before reopening
access. Original account passwords still work; saved plaintext login files are
not required for recovery. Never restore these commands over a live installation.

## Optional providers and configuration

Edit the private `.env`, then run `sh ./orka-server start` to apply changes.
Password login works without provider keys. To enable GitHub, set
`GITHUB_ENABLED=true`, its client ID/secret, and register
`https://<domain>/auth/callback`. To enable email magic links, set
`MAGIC_LINK_ENABLED=true` and configure SMTP, or select Resend and its signed
email hook. See [authentication](docs/authentication.md) for exact settings.

No inference provider is required for sharing instructions, skills, plans,
sessions or ordinary memory additions/deletions. Memory replacements and
conflicting edits remain queued until optional JEV is enabled and configured;
disabling JEV does not silently discard conflicts.
See [memory consolidation](docs/memory-consolidation.md).

## Troubleshooting

- **Docker unavailable:** start Docker Desktop, or check the Docker daemon and
  your Docker Engine permissions, then repeat the same setup command.
- **Port already in use:** repeat local setup with `--port 8181`. Public servers
  need ports 80/443 available for Caddy.
- **Public HTTPS check failed:** check A/AAAA records, firewall/router rules and
  `sh ./orka-server logs caddy`. After correcting them, run
  `sh ./orka-server doctor`; keep the existing `.env`.
- **Cannot sign in:** run `doctor`, use the exact printed service address, and
  retrieve the owner login with `credentials`. For a teammate, use their
  account file. Provisioning an account does not automatically join a project.
- **Setup interrupted:** run the same setup command again. Configuration,
  passwords and volumes are preserved. An uncertain account-creation response
  retains its credential file for recovery.
- **Data seems missing:** use the original directory and saved
  `COMPOSE_PROJECT_NAME`. Starting another project creates different volumes.
  `docker compose down --volumes` permanently deletes that project's volumes.

## Source updates

The canonical backend owns the server schema and implementation. Maintainers
export reviewed source into the public repository with:

```sh
node scripts/export-public-server.mjs <public-checkout>/server
```

The exporter records the committed source revision and per-file hashes, excludes
private configuration/history, and refuses to overwrite local source edits.
Use `--candidate` only for explicit local validation of uncommitted work. Public
users build entirely from the checked-in snapshot; no private access is needed.
Implementation plans are local notes and are not included in source releases.

## Direct Compose and development

The helper is a small shell wrapper over the checked-in Compose files. Generated
`.env` saves `COMPOSE_FILE` and `COMPOSE_PROJECT_NAME`, so direct commands work too:

```sh
docker compose ps
docker compose logs --tail 100 api
```

For source development, `sh ./orka-server build` builds the image without starting services.
The helper builds during setup/upgrade; ordinary `start` uses the installed image.

Contributors need Go 1.27.3, Node.js 24+ and PostgreSQL binaries for integration tests.
The server has its own dependency graph:

```sh
npm ci
npm run build
npm run test:go
npm run contracts:check
npm run typecheck
npm run lint
npm run format:check
npm test
npm run test:integration
npm run licenses:check
npm run test:self-hosted
```

The README test uses only an isolated public snapshot. It executes setup,
repeated setup, account provisioning, real governed sharing, cold restart,
backup/upgrade and full recovery into new volumes. Other final-image tests cover
real GoTrue/PKCE and captured SMTP/Resend. They do not establish real email/OAuth
delivery, public DNS/TLS for your domain, or signed macOS/two-Mac handoff.

`source-manifest.json` records the canonical backend commit, candidate status
and per-file hashes. Public builds need no access to that repository.
Preserve the [MIT license](LICENSE), [third-party notices](THIRD_PARTY_NOTICES.md)
and [dependency inventory](docs/dependency-licenses.md).

## Contributor layout

Native server source lives in `internal/server/` and the single executable entry
point in `cmd/orka-server/`. The unchanged SQL baseline stays in
`packages/server-core/migrations/`; shared desktop contracts stay in
`packages/protocol/`. Generated contracts are embedded in Go and checked for drift.

`tests/acceptance/` runs Docker and operator drills. PostgreSQL integration tests
call Go through a test-only bridge. `tests/reference/` is the frozen TypeScript
compatibility oracle and is excluded from runtime images and operator releases.
`scripts/managed/` and `scripts/release/` are maintainer tools.

Production images contain a native Go executable and no Node/npm runtime. The
same HTTP contracts, hashes, database schema, blob storage and operator commands
are preserved. Upgrading a current baseline requires no database conversion.
Preserve [Go dependency notices](GO_THIRD_PARTY_NOTICES.md) when distributing it.
