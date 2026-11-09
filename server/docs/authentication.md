# Authentication and deployment

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

Use a GitHub OAuth App with callback `https://api.tryorka.ai/auth/callback`, and a separate app for staging. Orka asks for identity, not repository access. Verify the sender domain in Resend and disable link tracking for auth mail. Generate the shared hook secret with `printf 'v1,whsec_'; openssl rand -base64 32`. The overlay enables the signed hook at `https://<DOMAIN>/auth/hooks/send-email` and requires provider secrets. It preserves the same Compose project, persistent paths and migration lineage. Do not start two stacks against one PostgreSQL data directory.

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
3. The email contains a sign-in link to `/auth/confirm`. GET renders a page without verifying or consuming the token. The user clicks **Open Orka**, submitting a same-origin form. No scripts, analytics, caching or referrers are allowed on this page. Older direct `/auth/verify` links remain supported.
4. Verification returns an intermediate code to the fixed `orka://auth/callback` route, optionally with the validated originating profile. Orka exchanges it with the stored verifier. Intercepted codes cannot establish a session, and codes/links cannot be reused.
5. If the browser does not open the app, reopen the link on the requesting Mac or request a new link. Expired, used or canceled attempts require a new request. The app has no code-entry step; React never receives the verifier or session tokens.

GoTrue rotates refresh tokens. Back/cancel clears native pending authentication. Profiles remain internal and are not shown in product UI. GitHub returns through the same PKCE/session boundary. We retain GoTrue's verified-identity policy; the API never merges users by an email supplied by the client. Manual identity-link endpoints are not exposed. Verify real OAuth consent and same-email provider behavior in staging with the configured GitHub app before public signup.

Unknown/disabled-signup email requests have the same success response; delivery failures and throttling remain actionable. Per-email resend cooldown is 60 seconds and email volume is limited by GoTrue. `GOTRUE_RATE_LIMIT_HEADER=X-Orka-Client-IP` enables its per-client verification/OTP/refresh limits. The API always supplies this header from the socket, or the final forwarded address when `TRUST_PROXY=true`. Production Compose enables trust only because API ports are private behind Caddy, which sanitizes forwarding headers. Keep direct development/API listeners at `TRUST_PROXY=false`; do not expose a trusted API port publicly.

`RESEND_API_URL` is only an explicit test/provider endpoint override; production leaves it unset. Tests use a capture provider and a loopback hook bridge because GoTrue forbids non-local plain HTTP hooks. Production always uses the configured public HTTPS hook.

Sources: [GoTrue v2.196.0](https://github.com/supabase/auth/tree/v2.196.0), [PKCE](https://supabase.com/docs/guides/auth/sessions/pkce-flow), [send-email hook](https://supabase.com/docs/guides/auth/auth-hooks/send-email-hook).
