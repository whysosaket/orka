# GitHub sign-in and repository connections

One GitHub App can serve both GitHub sign-in and optional repository connections.
GoTrue owns Orka identity/sessions. Repository connections use GitHub's device
authorization flow and separately stored, expiring user tokens. App installation,
user authorization, Orka membership and GitHub repository membership are separate.

## App and server setup

Register a GitHub App with account **Email addresses: read** (GoTrue calls
`/user/emails`), repository **Contents: read** and **Metadata: read**. Enable
Device Flow and expiring user tokens. Install it on selected repositories. No
repository Administration/write permission is required. Use OAuth callback
`<PUBLIC_URL>/auth/callback` and webhook
`<PUBLIC_URL>/integrations/github/webhook`; enable webhook deliveries after its
HTTPS endpoint and shared secret have been verified. Other accounts can install
only a public app. Development and production use their own registrations;
each registration serves both features in its environment.

For loopback-only development, GitHub accepts a loopback OAuth callback but
rejects loopback webhook URLs even with deliveries disabled. Keep deliveries
inactive with a valid HTTPS hook URL, or configure an approved HTTPS development
endpoint. Live permission checks and explicit disconnect work without webhook
delivery; do not claim external revocation delivery was tested in that setup.

Configure the private server environment:

```dotenv
GITHUB_ENABLED=true
GITHUB_CLIENT_ID=Iv...
GITHUB_CLIENT_SECRET=...
GITHUB_REPOS_ENABLED=true
GITHUB_REPOS_APP_SLUG=your-orka-app
GITHUB_REPOS_TOKEN_KEY=64_hex_characters
GITHUB_REPOS_WEBHOOK_SECRET=at_least_32_characters
```

The existing `GITHUB_CLIENT_*` configure both GoTrue and repository access.
Email/password users can connect GitHub even with GitHub sign-in disabled.
`GITHUB_REPOS_ENABLED` defaults to false; unconfigured services remain usable.
Enabled settings require an `Iv...` GitHub App client ID, avoiding an OAuth App
with broad `repo` scope. No GitHub credential is compiled into the desktop.

Generate the token key once with `openssl rand -hex 32`, and preserve it in
protected configuration backups. Changing/losing it makes existing connections
unreadable. Tokens use AES-256-GCM with the Orka user ID as authenticated context.
They never reach React; native Git receives only the requesting user's token.
URLs, process arguments and persisted jobs contain no credentials. App private
keys and installation tokens are unnecessary for this user-token implementation.

## Existing OAuth registration migration

An OAuth App cannot be converted in place and consent does not transfer. Keep
the legacy registration while validating the new GitHub App. Temporary
`GITHUB_REPOS_CLIENT_ID` / `GITHUB_REPOS_CLIENT_SECRET` overrides let repository
acceptance run while GoTrue still uses the old `GITHUB_CLIENT_*`. These overrides
are not a second permanent production app. After account-continuity acceptance,
switch shared `GITHUB_CLIENT_*` to the GitHub App, remove overrides, and have
users authorize/install it. Retire the legacy registration only after verifying
the deployment's existing accounts. Never merge identities by supplied email.

Real local acceptance against GoTrue v2.196.0 verified two GitHub App sign-ins
against a seeded legacy GitHub identity with a different email. Both retained
the original Orka user ID, retrieved GitHub email, completed native PKCE, stripped
provider tokens from Keychain storage, refreshed the Orka session and signed out.
This does not switch production credentials or establish production migration.

## Sources and access requests

Migration `002_github_repositories.sql` adds optional source bindings, encrypted
connections, device authorizations, requests and audit events. Existing sources
retain their IDs. Bindings use immutable GitHub repository IDs and owner-controlled
expected revisions; unlink retains a tombstone. Rename/transfer metadata refresh
retains previously verified URLs for existing checkouts. Installation/repository
discovery is user-filtered and paginated. An installation never lends its rights
to a person. `/v2/instance.repositories.github` advertises effective support, and
disabled services reject actions server-side.

Requests start from a known project source and contain a verified GitHub identity
and reason. Owners can coordinate in GitHub, mark an invitation pending or reject;
requesters can cancel. Only a fresh requester's GitHub check marks access verified.
Repository/identity changes cancel stale requests; pending requests expire after
30 days. Owners and requesters see permission-filtered paginated records, with
revision checks, duplicate suppression and audit events. GitHub app-installation
requests differ from repository membership. A private-resource 404 remains
ambiguous; SSO and organization policies may require GitHub action. Direct grants
need additional administration rights and are outside this release.

Authorization-revocation webhooks are HMAC-verified and deduplicated. Access is
checked live before cloning and attachment. Orka context permissions remain
independent from GitHub code rights. Revocation cannot retract downloaded code.

## Verification

`npm run test:integration` covers real HTTP/PostgreSQL in both hosting modes with
a deterministic GitHub transport: denied access, encryption, concurrent refresh,
source revisions, request review/verification, signed webhook replay and revocation.
Credential-dependent acceptance uses private files, never token arguments:

```sh
npx tsx tests/acceptance/github-live-e2e.ts /private/development.env /absolute/native-binary owner/private-fixture
npx tsx tests/acceptance/github-auth-live-e2e.ts /private/development.env /absolute/native-binary github-login
```

The first uses isolated PostgreSQL and two native caches to verify real device
authorization, private discovery/cloning, stable source IDs, refresh and revocation.
The second uses isolated Docker PostgreSQL/GoTrue on loopback 57431–57433 and a
registered loopback callback. It intercepts the deep link in its test harness so
the user's normal Orka app cannot receive it. Both require browser consent and
clean temporary data. They do not deploy or alter production.

Desktop checks cover destination review, progress/cancel, requests, discovery,
pagination, fallback, accessibility and both window sizes. Native checks cover
actual Git transfer, unsafe URLs, exclusive moves, cancellation, stale context
and interrupted jobs. Two isolated caches on one Mac do not substitute for a
physical two-Mac signed release check.
