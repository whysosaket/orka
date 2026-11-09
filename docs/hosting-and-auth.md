# Hosting and authentication

One desktop supports Orka Cloud and self-hosted services. Choose the service at sign-in and change it later in Settings. The managed origin is `https://api.tryorka.ai`; self-hosted services use the operator's HTTPS origin. Loopback HTTP is supported for development.

The selected service advertises its available authentication providers. GitHub and email sign-in appear when enabled; existing password access remains available when supported by the service. Magic-link requests are bound to the initiating native profile and its PKCE verifier. Session tokens and verifiers stay in native Keychain storage.

Switching services is not data migration. Memberships, invitations, remote-only content, and device trust do not transfer automatically. Connect projects and explicitly select the categories you want to share on the destination service.

The public repository includes the source-built [Docker Compose server](../server/README.md), migrations, account-provisioning and backup/restore tools. No private registry or managed account is required. The default deployment is password-only with signup disabled; operators provision approved accounts privately. GitHub and SMTP/Resend magic links are optional server-side settings. Building the desktop and running fixture-based checks still needs no service account.
