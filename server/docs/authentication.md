# Authentication and deployment

New deployments can use one GitHub App for sign-in and repositories, with Email
addresses read and selected-repository Metadata/Contents read. Existing OAuth
registrations remain supported during the [explicit single-app migration](github-repositories.md);
verify existing-account continuity and native PKCE before switching credentials.

GoTrue owns accounts, password hashes, OAuth state, verification tokens and sessions. Orka's API exposes only the allowed authentication routes and checks project membership separately. Resend is a delivery adapter. The managed origin is `https://api.tryorka.ai`; DNS, TLS, OAuth registration and a verified sender must be provisioned before that origin is usable.

## Managed configuration

Create `deploy/ec2/.env` from its example, keep it private (0600), and fill the domain, separate random database passwords, JWT secret and these settings:

```dotenv
DOMAIN=api.tryorka.ai
COMPOSE_FILE=compose.yml:../cloud/compose.yml
ORKA_IMAGE=ghcr.io/whysosaket/orka-api:0.2.0
DEPLOYMENT_MODE=cloud
GITHUB_CLIENT_ID=<OAuth App ID>
GITHUB_CLIENT_SECRET=<OAuth App secret>
RESEND_API_KEY=<sending key>
RESEND_FROM=Orka <login@your-verified-domain.example>
SEND_EMAIL_HOOK_SECRET=<v1,whsec_ plus 32 random base64 bytes>
DISABLE_SIGNUP=true
PASSWORD_ENABLED=true
```

Use a GitHub App with callback `https://api.tryorka.ai/auth/callback` and Email addresses read; use a separate registration for staging. The same app handles repository access through selected-repository installation consent. Existing OAuth registrations remain during the documented migration. Verify the sender domain in Resend and disable link tracking for auth mail. Generate the shared hook secret with `printf 'v1,whsec_'; openssl rand -base64 32`. The overlay enables the signed hook at `https://<DOMAIN>/auth/hooks/send-email` and requires provider secrets. It preserves the same Compose project, persistent paths and migration lineage. Do not start two stacks against one PostgreSQL data directory.

Run `npm run deploy:check -- deploy/ec2/.env --cloud`, then the deployment runbook. `DISABLE_SIGNUP=true` requires operator-provisioned accounts; set it to false only when registration is intended. `PASSWORD_ENABLED=false` blocks password grants in the API and removes the advertised capability; refresh remains available to existing sessions.

## OSS providers

The OSS image needs no managed secrets. Password login is enabled by default with public signup disabled. Enable GitHub with `GITHUB_ENABLED=true` and its app credentials. Enable email with `MAGIC_LINK_ENABLED=true`; choose SMTP (`EMAIL_PROVIDER=smtp`, SMTP host/port/from/credentials) or Resend (`EMAIL_PROVIDER=resend`, `RESEND_ENABLED=true`, sending key/from/hook secret). Capabilities describe effective settings and provider endpoints enforce them.

## Link and code flow

Project invites also have a browser entry point, separate from authentication.
With `PUBLIC_URL` configured, `/v2/invites` retains `token` and adds
`url: <PUBLIC_URL>/join/<token>`. The anonymous GET/HEAD preview never consumes
the invite or creates membership; it displays an escaped project name and an
explicit **Open Orka** link carrying the configured service origin. No script,
third-party resource, caching, referrer, or indexing is allowed. Invalid links
return 400 and expired, consumed, or archived-project invites return 410.
Only authenticated `/v2/join` redeems an invite, with the existing single-use,
expiry, governance and membership rules. Both editions share the implementation.
Without `PUBLIC_URL`, responses remain token-only for desktop compatibility.
Deploy this backend with the updated desktop for service-bound browser handoff;
older desktops continue using `token`. No migration or provider changes are needed.

1. Native Orka generates a random verifier, retains it in the initiating profile's Keychain for ten minutes and sends only its S256 challenge with the email to `/auth/otp`.
2. GoTrue issues a short-lived token and delivers via SMTP or the timestamped, signed email hook. The API verifies the hook before calling Resend with an idempotency key.
3. Desktop email includes a link to `/auth/confirm` and a numeric code. GET renders the confirmation without consuming the token. **Continue to Orka** submits a same-origin form. The page uses no scripts, analytics or caching. Its origin-only referrer policy preserves the form's Origin without exposing the email URL. Older direct `/auth/verify` links remain supported.
4. The verified page offers **Open Orka** with an intermediate code on the fixed `orka://auth/callback` route and the validated originating profile, when present. Orka exchanges it with the stored verifier. If the browser blocks the handoff, the same page can open the app again.
5. Users can instead enter the numeric code from the email in the requesting desktop. The client shows this option when the API advertises `auth.emailCode`. GoTrue verifies the email and code independently of the PKCE exchange, and using either method consumes the email credential. For an expired, used or canceled attempt, request a new email. React never receives the verifier or session tokens.

GoTrue rotates refresh tokens. Back/cancel clears native pending authentication. Profiles remain internal and are not shown in product UI. GitHub returns through the same PKCE/session boundary. We retain GoTrue's verified-identity policy; the API never merges users by an email supplied by the client. Manual identity-link endpoints are not exposed. Verify real OAuth consent and same-email provider behavior in staging with the configured GitHub app before public signup.

Unknown/disabled-signup email requests have the same success response; delivery failures and throttling remain actionable. Per-email resend cooldown is 60 seconds and email volume is limited by GoTrue. `GOTRUE_RATE_LIMIT_HEADER=X-Orka-Client-IP` enables its per-client verification/OTP/refresh limits. The API always supplies this header from the socket, or the final forwarded address when `TRUST_PROXY=true`. Production Compose enables trust only because API ports are private behind Caddy, which sanitizes forwarding headers. Keep direct development/API listeners at `TRUST_PROXY=false`; do not expose a trusted API port publicly.

`RESEND_API_URL` is only an explicit test/provider endpoint override; production leaves it unset. Tests use a capture provider and a loopback hook bridge because GoTrue forbids non-local plain HTTP hooks. Production always uses the configured public HTTPS hook.

Sources: [GoTrue v2.196.0](https://github.com/supabase/auth/tree/v2.196.0), [PKCE](https://supabase.com/docs/guides/auth/sessions/pkce-flow), [send-email hook](https://supabase.com/docs/guides/auth/auth-hooks/send-email-hook).

## Project email invitations

The desktop prefers email when `/v2/instance` advertises `invites.email`.
`POST /v2/invites` accepts an optional `email` and returns `{ sent: true, email }`
after the provider accepts delivery. Omitting email retains `{ token, url? }` and
the existing single-use joining-link flow. Missing delivery configuration falls
back to joining links; delivery errors preserve that option.

The Go server reuses `EMAIL_PROVIDER`, `PUBLIC_URL`, and either
`RESEND_API_KEY`/`RESEND_FROM` or `SMTP_HOST`, `SMTP_PORT` (default 587), `SMTP_FROM`
and optional `SMTP_USER`/`SMTP_PASSWORD`. The shared Compose definition passes
SMTP settings to both GoTrue and the API. Port 465 uses implicit TLS; other ports
negotiate STARTTLS when available. No new provider keys or desktop secrets are
introduced, and project invitations do not require magic-link sign-in.

Migration `003_email_invitations.sql` adds a nullable recipient and delivery
cooldown records. Existing links keep a null recipient. Email invitations require
the matching confirmed account email from GoTrue, expire after 24 hours, and are
consumed only by authenticated joining after sharing review. Previewing an email
link does not accept it. Send limits are one per recipient/project per minute and
30 per project per hour; consumption does not reset them. Failed sends roll back
the token. Provider acceptance does not prove mailbox delivery.

Invitations retain the configured signup policy and do not provision or merge
accounts. With signup disabled, operators still create accounts. Deploy the Go
backend/migration before the desktop. Before downgrading to older joining code,
revoke outstanding email invitations so recipient restrictions cannot be bypassed.
