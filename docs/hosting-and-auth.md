# Hosting and authentication

One desktop supports Orka Cloud and existing compatible self-hosted services. Choose the service at sign-in and change it later in Settings. The managed origin is `https://api.tryorka.ai`; self-hosted services use the operator's HTTPS origin. Loopback HTTP is supported for development.

The selected service advertises its available authentication providers. GitHub and email sign-in appear when enabled; existing password access remains available when supported by the service. Magic-link requests are bound to the initiating native profile and its PKCE verifier. Session tokens and verifiers stay in native Keychain storage.

Switching services is not data migration. Memberships, invitations, remote-only content, and device trust do not transfer automatically. Connect projects and explicitly select the categories you want to share on the destination service.

The public repository contains the desktop only. It does not include the backend, server container images, deployment instructions, provider secrets, or local account-provisioning tools. Obtain a compatible service and account from its operator. Building the desktop and running its fixture-based checks needs no service account.
