# EC2 deployment

Use a Linux EC2 instance with Docker Engine and Compose v2, a domain pointing to it, and encrypted persistent EBS mounted at `/srv/orka`. Open inbound TCP 80/443 (UDP 443 optional), and restrict SSH to administrators. No database, auth, or blob service ports are public.

For the small Ubuntu 24.04 Graviton deployment, `sudo bash bootstrap.sh vol-<data-volume-id>` mounts the dedicated data volume, installs Docker/Compose, adds 1 GB of swap, and makes Docker require the data mount. It only formats a blank volume whose EBS serial matches the supplied ID; it refuses the operating-system disk and existing unfamiliar data.

From `deploy/ec2`:

```sh
cp .env.example .env
chmod 600 .env
# Generate separate secrets with: openssl rand -hex 32
sudo mkdir -p /srv/orka/postgres /srv/orka/blobs /srv/orka/caddy
sudo chown 1000:1000 /srv/orka/blobs
sudo chmod 700 /srv/orka/blobs
# Edit .env with the real domain and random passwords.
docker compose config --quiet
docker compose pull
docker compose up -d
docker compose ps
```

Passwords embedded in connection URLs must be random hex or properly percent-escaped. The init script creates `orka_api` and `supabase_auth_admin` with separate schemas and passwords. GoTrue runs its own auth migrations; the API runs the idempotent Orka migration. The fresh `orka` schema does not reuse old development `workspace` data.

Use `https://<domain>` as the client's only service URL. Caddy obtains HTTPS certificates. The app supports passwords, GitHub OAuth, and email magic links/codes. Password-only deployment remains the default. Public signup is disabled; provision approved accounts through GoTrue's internal [admin create-user API](https://supabase.com/docs/reference/javascript/auth-admin-createuser), setting a separate strong password and `email_confirm: true`. This provisions access explicitly without sending confirmation mail. Authenticate administrative requests with a short-lived `service_role` JWT signed using the private JWT secret; keep that operation on the server's private Compose network. The exchange proxy does not expose signup or admin routes. Never ship an admin token or JWT secret to a client.

GoTrue handles password hashing, refresh, and rate limiting; the app stores only session tokens in macOS Keychain. The exchange API validates bearer tokens against GoTrue's `/user` endpoint. Project membership is checked separately for every metadata/blob operation. SMTP settings are optional for this password-only setup. Enable magic-link/code login using Resend or SMTP and GitHub OAuth using the [authentication guide](../../docs/authentication.md). That guide also documents the Cloud overlay, in-app service selection, signup policy, and preflight checks. Password recovery and email-change UI are not part of this release. Auth is self-hosted; no Supabase project, inference API, Railway service, or hosted storage bucket is needed.

An Elastic IP can be used before choosing a domain: set `DOMAIN` to that address and `CADDY_CONFIG=Caddyfile.ip`. This configuration explicitly requests Let's Encrypt's `shortlived` profile and supplies a default certificate name for clients that omit SNI for IP addresses. Caddy renews the approximately six-day certificate automatically; keep ports 80/443 reachable and the Caddy data directory persistent. No private CA installation is required. For a domain later, switch back to `CADDY_CONFIG=Caddyfile`, set `DOMAIN`, and recreate auth/Caddy so their public URLs match.

Health checks cover PostgreSQL, GoTrue, API, and Caddy. `/health` verifies database connectivity; Compose separately checks auth health. API operational errors contain method and status without request bodies, file contents, or credentials. Access logging is disabled at the reverse proxy. Review GoTrue error logs and SMTP operations under your deployment's data policy. Keep `.env`, JWT secrets, EBS contents, and backups private.

## Backups and restore

```sh
sudo ./backup.sh /srv/backups/orka-$(date -u +%Y%m%dT%H%M%SZ)
sudo ./restore-check.sh /srv/backups/<backup>
```

Backup pauses both API and auth writers, dumps the database and roles, compresses blobs into `blobs.tar.gz`, computes checksums, and restarts both writers even after a failure. Compressed output is capped below available disk space, reserving 1 GiB. Expect a maintenance window while the archive is created. Store an encrypted copy off the instance. Back up `.env` and the JWT secret separately in your secret store; a database dump alone cannot restore sign-in credentials/configuration.

The restore check requires Python 3 (installed by bootstrap), uses a disposable database container, restores schema/data, and streams every cataloged blob through SHA-256 and size checks without extracting the archive. Both compressed and older `blobs.tar` backups are supported. The temporary database and its volume are removed afterward; the live database is never targeted. Run this check after backups and before relying on an upgrade. PostgreSQL 17 is pinned for dump/restore compatibility.

To restore production after a tested failure: stop API/auth, restore roles (skip the already existing `postgres` role), create a fresh `orka` database with the original role ownership, restore `database.dump` using `pg_restore --exit-on-error`, extract the verified `blobs.tar.gz` (or older `blobs.tar`) into the persistent data directory, restore the original private `.env`, fix blob ownership to UID 1000, then start auth/API. Verify health, password sign-in, and a project pull before reopening access. Do not restore over a running database.

## Upgrade

Take and verify a coordinated backup first. Change pinned image versions or digests intentionally, run `docker compose pull`, and restart. Check restart recovery, auth refresh, project isolation, and the physical two-Mac acceptance checklist. Native adapter versions and desktop sidebar behavior are separate release gates from server health.

After migration 011, populate dormant project members' emails from the local
GoTrue database with the following operator command. Managed deployment runs it
automatically. It is safe to repeat, preserves existing identity labels and
populated emails, and logs counts only. The API role retains no access to the
auth schema; ordinary authenticated requests keep emails current afterward.

```sh
docker compose exec -T db psql -X -U postgres -d orka -v ON_ERROR_STOP=1 < backfill-member-emails.sql
```
