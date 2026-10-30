# Browser project join

## Plan and implemented flow

1. Owners create invites through the existing authenticated `/v2/invites` endpoint. With `PUBLIC_URL` configured, it returns an additional `url` pointing to `/join/<token>` on that service. The desktop copies it; older servers keep the `orka://join/<token>` fallback.
2. The shared backend serves an anonymous browser preview with the project name, **Open Orka**, installation guidance, and a selectable invite link. Opening, scanning, or refreshing the preview never joins the project or consumes the invite. Invalid links return 400; expired, consumed, and archived-project invites return 410. Other methods return 405.
3. **Open Orka** uses `orka://join/<token>?server=<encoded-service-origin>`. The desktop retains the full link during sign-in. The login screen identifies the service and lets the user explicitly select it or dismiss the invite. A signed-in user on another service must explicitly switch and sign in.
4. After sign-in, Join project opens with every sharing category unchecked. The user reviews and confirms the choices. The native command checks the invite service against the selected connection while holding the project/service lock, removes local service metadata, and sends the existing `{ token }` request to `/v2/join`.
5. Only authenticated redemption creates membership, retaining expiry, single-use, governance, and project lifecycle checks. Sharing consent is saved locally before syncing or opening the folder picker. Canceling the picker leaves a joined project available for later connection.

## Boundaries and compatibility

The implementation spans `orka` (React, native validation, client tests) and `orka-api` (browser page, additive invite response, backend tests). Both deployment modes use the same server core. It needs no migration, new provider, or new environment variable. `PUBLIC_URL` must be the externally reachable HTTPS origin; localhost HTTP remains available for development. Servers without it continue issuing desktop-only invites.

Browser links accept HTTPS and local development HTTP origins. Legacy desktop links and raw 48-character invite tokens remain accepted. Service-bound invites cannot be redeemed against another selected service. The preview uses no scripts, external resources, referrers, indexing, or caching. Generated links use configured `PUBLIC_URL`, never the request Host header or caller-supplied redirect destinations.

Pending invites live in the current app session across login and service switching. After quitting, reopen the original browser invite. Named profile routing remains internal; project links go to the app instance receiving the protocol event.

No shared protocol schema or packaged backend dependency changed. The canonical browser implementation lives in `orka-api`; existing desktop candidate tarballs are unchanged. Release the backend and updated desktop together for the complete flow. Older desktops still receive `token` and can use their original join flow.

## Verification

Client unit tests cover link formats, normalization, malformed links, and service boundaries. A native unit test checks the service comparison. UI tests cover link paste, private defaults, sign-in continuation, explicit switching, dismissal, copying browser/legacy invites, errors, and accessibility at 1160×800 and 900×640.

HTTP/PostgreSQL tests run the same scenarios in Cloud and Self-hosted mode: repeated GET/HEAD, no anonymous membership mutation, owner-only creation, escaped names, configured-origin links, unsupported methods, invalid/expired/used/archived invites, governed-client requirements, and concurrent single-use redemption.

Signed-app protocol registration, the external browser permission prompt, and a physical two-Mac join remain release acceptance checks. Local fixtures and backend tests do not establish those results.
