# Connect and clone GitHub repositories

When enabled by your service, use **Settings → General → Source Folder → GitHub
repositories**. Owners browse GitHub accounts/installations, select a repository
and add a source without locating a folder first. They can also link an existing
source; a connected folder must match the selected repository's Git remote.

**Connect GitHub** opens device authorization. Enter the code, confirm the account
and authorize Orka. **Configure GitHub access** installs the app on selected
repositories or requests organization approval. Email/password Orka accounts can
connect GitHub too. One GitHub App can serve sign-in and repositories, with
separate user consent and repository-installation steps.

Joining a project with linked repositories opens source setup. **Check access**,
then **Clone & connect**. Review the workspace location and checkout folder name
before starting; the default workspace is `~/Orka`. Each repository has independent
progress/cancellation. A completed checkout whose attachment failed offers
**Retry connect**. Existing checkouts retain **Locate folder**. First-run setup
also offers **Connect a GitHub repository** with create/join and sharing review;
you can continue to the workspace and finish connecting later.

**Request repository access** sends a reason and verified GitHub identity to
project owners. Follow it in **Settings → Members → Repository access requests**.
Owners coordinate a GitHub administrator's grant; Orka approval does not itself
grant code access. Accept invitations and check access again. **Request app
approval** uses GitHub's separate installation flow. SSO/policy restrictions may
need action on GitHub.

Cloning uses system Git, isolated configuration and temporary credentials. It
never overwrites an existing destination, changes global Git credentials or runs
dependency/setup scripts. Install Git or Apple's Command Line Tools if needed.
Submodules and Git LFS may need separate setup. Terminal/editor pushes use their
own Git credentials. Disconnecting preserves local checkouts; revocation cannot
remove downloaded code. Interrupted clones restart rather than claim resumability.

GitHub connection does not change Orka sharing, ENV trust or project membership.
Older/unconfigured services retain local folder setup. Operators should follow
the [shared server configuration and migration guide](../server/docs/github-repositories.md).
Both hosting modes share authorization, bindings and requests. Repository metadata
is shared with the Orka project; local paths remain on each Mac.
