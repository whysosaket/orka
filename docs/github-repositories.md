# Connect GitHub repositories

Choose **GitHub repository** when creating a project. After the project is
created, select a GitHub account and repository, then choose **Connect repository**.
Orka adds the source and clones it on this Mac in the same flow. First-run setup
uses the same picker. You can also add a repository later from **Settings → General
→ Source Folder → Connect repository**.

If GitHub is not connected, Orka asks you to authorize it first. Enter the code
on GitHub and confirm the account. Email/password Orka accounts can connect GitHub
too. Each environment uses one GitHub App for sign-in and repository access, with
separate user consent and repository-installation steps.

The picker normally asks only for the account and repository. It shows the clone
destination, defaulting to `~/Orka/<repository>`. Open **Change location** only if
you want another directory or checkout name. A folder already connected on this
Mac stays connected and has no clone action. Existing local source folders can
use **⋯ → Link GitHub repository** without cloning again. **Use a local folder
instead** keeps ordinary folder setup available.

Source rows check GitHub access automatically and show a status icon. Checks run
in the background when the app opens and daily while it remains open. Results are
stored in the account/service-specific native cache and are invalidated when the
GitHub connection or repository binding changes. Returning from GitHub rechecks
unavailable access. **Refresh access** in a row's menu can recheck explicitly.
A cached status is informational: cloning and attachment always verify current
permissions with the service. A failed refresh does not restore an older green
status. Service failures show a retry icon instead of a verified indicator.

A row needing a checkout offers **Connect**. Clone progress replaces the normal
row status; the close icon cancels the transfer. If a completed checkout could not
be attached, **Finish connecting** retries attachment without another clone.
**⋯** contains existing-folder, unlink and local-disconnect actions. Unlinking
GitHub does not remove local files.

When access is missing, the row offers **Request access**. Add a reason and send
it to project Owners; follow the request in **Settings → Members → Repository
access requests**. Owner review coordinates a GitHub administrator's grant and
never grants code access itself. Returning to Orka checks access again. If you
already have repository membership, expand **Already have repository access?** to
manage the App's permission or request organization approval. In the picker,
**Can’t find a repository?** provides the same help. Account switching and GitHub
disconnection live in the picker's account menu rather than the General screen.

Cloning uses system Git, isolated configuration and temporary credentials. It
never overwrites an existing destination, changes global Git credentials or runs
dependency/setup scripts. Install Git or Apple's Command Line Tools if needed.
Submodules and Git LFS may need separate setup. Terminal/editor pushes use their
own Git credentials. Disconnecting preserves local checkouts; revocation cannot
remove downloaded code. Interrupted transfers restart rather than resume.

GitHub connection does not change Orka sharing, ENV trust or project membership.
Older/unconfigured services retain local folder setup. Operators should follow
the [shared server configuration and migration guide](../server/docs/github-repositories.md).
Both hosting modes share authorization, bindings and requests. Repository metadata
is shared with the Orka project; local paths remain on each Mac.
