# Managed backend deployment

The release workflow verifies the shared backend, publishes both architectures of both images and the client packages, then calls **Deploy managed backend** when the repository variable `BACKEND_DEPLOY_ENABLED` is `true`. The same deployment can be run manually from Actions on `main`, selecting a published stable release tag. This direct workflow call also works for releases published with `GITHUB_TOKEN`.

Production deploys the managed image by digest from that release's `orka-api-image.json`. The tag, package version, release manifest and image revision must identify the same commit on `main`. Compose files come from that exact commit. The workflow never deploys a PR image or a mutable `latest` tag. OSS images continue to be built and tested from the same core; self-hosted operators control their own upgrades. This infrastructure change does not require a desktop package update.

## One-time host setup

Use the existing [EC2 bootstrap and storage setup](../deploy/ec2/README.md): Ubuntu 24.04, Docker Engine, Compose v2, and persistent EBS mounted at `/srv/orka`. Allow HTTPS and SSH from the deployment runner. GitHub-hosted runner addresses vary; use a runner with fixed egress if the SSH security group is restricted by source IP. CI requires the data mount to be present. Provisioning EC2, DNS/TLS, OAuth and Resend is separate from installing the workflow.

Create a dedicated SSH deployment account with Docker access. Docker access is equivalent to root access on the host. On the server, replace `deploy-user` with that account:

```sh
sudo install -d -m 700 -o deploy-user -g deploy-user /opt/orka-api /srv/orka/backups
sudo ln -s /srv/orka/backups /opt/orka-api/backups
sudo usermod -aG docker deploy-user
```

Install its public key in that account's `authorized_keys`, with the `restrict` option (no agent/port/X11 forwarding or PTY). Allow normal commands/SFTP for the deployment. Reconnect after adding the Docker group. Create `/opt/orka-api/.env`, owned by that account, with mode `600`, using [the EC2 example](../deploy/ec2/.env.example) and [managed auth settings](authentication.md). Set `DOMAIN=api.tryorka.ai` and `DATA_ROOT=/srv/orka`. Leave Compose project/file selection to CI; it overrides `ORKA_IMAGE` with the digest. Database and blob directories and UID 1000 blob ownership are prepared by bootstrap.

The CI stack is named `orka-managed`. Its first deployment requires an empty PostgreSQL directory and no existing containers with that project name. It refuses to adopt an existing manual stack automatically. For an existing production installation, plan a maintenance window and migration of its Compose state and data before enabling this workflow; never start two database containers against one data directory.

## GitHub configuration

Create the `production` environment in `whysosaket/orka-api`. Allow deployment from branch `main` and tags `v*`. Configure these **environment secrets**:

| Secret | Value |
| --- | --- |
| `DEPLOY_SSH_HOST` | Server IPv4 address or hostname reachable on port 22 |
| `DEPLOY_SSH_USER` | Dedicated deployment account |
| `DEPLOY_SSH_KEY` | Complete private SSH key for that account |
| `DEPLOY_KNOWN_HOSTS` | Verified OpenSSH known-hosts entry for that exact hostname/IP |

Verify the host key fingerprint through the EC2 console or another trusted channel before saving its known-hosts entry. The workflow requires strict host-key verification and does not trust a new key discovered during deployment. Store key values in GitHub secrets, not in source control or workflow inputs.

The workflow's short-lived `GITHUB_TOKEN` needs `contents: read` and `packages: read`, including access to the repository's private `orka-api` GHCR package. Images published by this repository's release job inherit its package access; check the package's Actions access if it was created elsewhere. The token is sent over SSH on stdin and is used in a temporary Docker configuration removed on exit. The host does not need a long-lived GitHub token or a source checkout. Application/database/OAuth/Resend secrets stay in the server's private `.env`.

### Temporary EC2 SSH access

For GitHub-hosted runners, configure these optional **production environment variables** together:

| Variable | Value |
| --- | --- |
| `DEPLOY_AWS_ROLE_ARN` | IAM role trusted by this repository's production workflow |
| `DEPLOY_AWS_REGION` | Region containing the instance's security group |
| `DEPLOY_SECURITY_GROUP_ID` | That security group's ID |

The workflow assumes the role using GitHub OIDC, opens TCP 22 only to the runner's public IPv4 `/32`, and removes its uniquely named rule in an `always()` cleanup step, including after deployment failure. Existing administrator rules are preserved. No AWS access keys belong in GitHub secrets. Without these variables, provide SSH reachability through the deployment runner's existing network configuration.

Trust only audience `sts.amazonaws.com` and this repository's exact `production` environment subject. Read `gh api repos/OWNER/REPO/actions/oidc/customization/sub` first: newer repositories use immutable owner/repository IDs in the subject prefix. Append `:environment:production` to the returned prefix. Retain the environment's `main`/`v*` deployment restrictions. Allow `ec2:AuthorizeSecurityGroupIngress` and `ec2:RevokeSecurityGroupIngress` only on the specific security-group ARN, plus `ec2:DescribeSecurityGroupRules` for cleanup. The reusable workflow caller must grant `id-token: write` as well.

A forcibly terminated runner or expired AWS session can prevent cleanup. Inspect rules with description `orka-api-ci-RUN_ID-ATTEMPT` and remove a stranded rule only after confirming that run has ended. A cleanup API failure fails the workflow rather than reporting success.

After the host, domain and providers are ready and GitHub Actions billing is unblocked:

1. Merge the workflow and scripts into `main`.
2. Publish a new immutable `vX.Y.Z` release with a matching version. Do not move the existing `v0.2.0` tag to add this workflow.
3. Run **Deploy managed backend** manually from `main` with that release tag; verify real GitHub sign-in, magic-link delivery and a project sync.
4. Set the **repository variable** `BACKEND_DEPLOY_ENABLED=true` for automatic deployment after future successful releases. Keep it unset or `false` to publish without automatically deploying. This switch does not disable an explicit manual run.

```sh
gh workflow run deploy.yml --repo whysosaket/orka-api --ref main -f release=vX.Y.Z
gh variable set BACKEND_DEPLOY_ENABLED --repo whysosaket/orka-api --body true
```

## Upgrade behavior and recovery

GitHub serializes deployments without cancelling an in-progress upgrade; a host `flock` also excludes overlapping deployments. The host first pulls the candidate and dependencies and validates configuration. Upgrades then run the existing coordinated database/blob backup and its isolated restore check. Backup pauses the API/auth writers briefly and restarts them. A failed pull, preflight, backup or restore check stops the upgrade before changing the active Compose configuration.

Release directories under `/opt/orka-api/releases` retain the image digest, source commit and exact Compose files. `active` records the configuration attempted on the host; `current` advances only after Compose reports every service healthy and public HTTPS `/health` and `/v2/instance` confirm cloud mode with GitHub and magic links. Public checks run from the host through the public hostname; external reachability and real provider sign-in remain acceptance checks. Migrations run through the API's normal startup path.

When returning from a manual root-owned release, the existing Docker deployment
operator takes ownership of that release's directory, image pointer, and Compose
bundle. File modes and symlinks are preserved; `.env` and persistent data are not
changed. The active release must remain inside `/opt/orka-api/releases`. Upgrades
also check free space for the database backup and temporary database restore before
pausing live writers; a failed space check leaves the running services untouched.
The reviewed workflow supplies current backup/restore helpers alongside the
immutable release's Compose files. Blob archives are compressed with a disk-space
limit and verified as a stream, so verification does not need a second full blob
copy. Python 3 is required on the host. Existing uncompressed archives remain
verifiable, and temporary restore database volumes are removed on exit.

An unhealthy deployment fails the job and leaves `active` pointing to the attempted release and `current` to the last successful release. The error names the release and backup directory. It does not claim an image rollback can undo a database migration. Inspect status using the attempted release's configuration:

```sh
export COMPOSE_PROJECT_NAME=orka-managed
export COMPOSE_ENV_FILES=/opt/orka-api/.env
export COMPOSE_FILE=/opt/orka-api/active/deploy/ec2/compose.yml:/opt/orka-api/active/deploy/cloud/compose.yml
export ORKA_IMAGE=$(cat /opt/orka-api/active/image)
docker compose ps
```

Correct the failure and redeploy. A manual older release is appropriate only after verifying database compatibility; destructive migrations require the [tested restore procedure](../deploy/ec2/README.md#backups-and-restore). CI keeps backups and release directories until an operator deliberately prunes them. Monitor disk capacity, encrypt/copy backups off the instance, and preserve `.env` and JWT secrets separately. CI performs health checks, not continuous availability monitoring or automatic disaster recovery.

Deployment tests cover provenance rejection, public-health failures, first deploy, successive upgrades, preflight/backup/restore failure, unhealthy releases, private configuration permissions and missing data mounts. The lifecycle test simulates Docker failures on Linux; the existing final-image tests cover the real database/auth/image and backup/restore behavior. A live SSH deployment requires the configured host and credentials.
