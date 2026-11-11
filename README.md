# PR #18 native Mac app evidence

Tested commit `77c4c2cd1bc032717930d243f24d60a0be97e2da` in a packaged Tauri macOS app using WKWebView, real native IPC, and isolated synthetic data. The source snapshot was unchanged. Test-only overrides set the app identity, window size, and ad-hoc signing.

Native windows: **1160 × 800** and **900 × 640** points. Screenshots are original 2× captures, stored as JPEG with accurate extensions. SHA-256 hashes, pixel dimensions, and build provenance are in [manifest.json](manifest.json).

## Verification

| Check | Result | Evidence |
| --- | --- | --- |
| Toast focus | Pass | Escape and pointer dismissal restore the launch action; Space requests another launch. Native accessibility snapshots and launch records were checked. |
| Diff and roles | Pass | Green additions, red deletions, syntax colors, and expandable context. Correct action for each access state. |
| Keep edits and install | Pass | Both copies match Version 3 across four file hashes, sizes, and executable bits. Prior edits remain byte-for-byte in a private draft. |
| Session continuation | Pass | Seven launches reused one native fork; native files and SQLite records exist. External CLI is a harmless fixture. |
| Compact layout | Pass | Reader and scrolled overlay checked at 900 × 640. Header/footer persist. Escape restores Review local edits focus. |
| File previews | Observed | Formatted Markdown, plain monospace script, raw CSV, and PDF fallback. |
| Remote work | Not tested | One session upload remains queued locally. No skill publication is queued; background sync is disabled. |

## Session toast and focus

**Native session toast after requesting a Terminal launch.**

![Native session toast after requesting a Terminal launch.](screenshots/02-native-toast.jpg)

**Session reader after dismissing the toast; focus restoration was checked through native accessibility state and keyboard interaction.**

![Session reader after dismissing the toast; focus restoration was checked through native accessibility state and keyboard interaction.](screenshots/03-native-focus-returned.jpg)

## Skill reader and change history

**Formatted Markdown with skill metadata, file list, and reader actions.**

![Formatted Markdown with skill metadata, file list, and reader actions.](screenshots/05-native-skill-reader.jpg)

**View changes with red deletions, green additions, inline emphasis, and changed-line headers.**

![View changes with red deletions, green additions, inline emphasis, and changed-line headers.](screenshots/06-native-view-changes.jpg)

## Review local edits by access

**Can edit overlay with multiple changed files and Publish update.**

![Can edit overlay with multiple changed files and Publish update.](screenshots/07-native-can-edit.jpg)

**Suggest changes overlay with multiple changed files and Send for approval.**

![Suggest changes overlay with multiple changed files and Send for approval.](screenshots/12-native-suggest-changes.jpg)

**View only overlay with access pill and diff, without a publication action.**

![View only overlay with access pill and diff, without a publication action.](screenshots/13-native-view-only.jpg)

## File types

**Shell script shown as plain monospace text.**

![Shell script shown as plain monospace text.](screenshots/09-native-script.jpg)

**CSV shown as raw comma-separated text.**

![CSV shown as raw comma-separated text.](screenshots/10-native-csv.jpg)

**PDF fallback with Preview unavailable and Open in editor; View changes is disabled.**

![PDF fallback with Preview unavailable and Open in editor; View changes is disabled.](screenshots/11-native-pdf-fallback.jpg)

## Installed update

**Installed skill shows Version 3 after Keep edits and install.**

![Installed skill shows Version 3 after Keep edits and install.](screenshots/15-native-update-installed.jpg)

## Compact window

**Compact 900 × 640 reader with collapsed file list and document scrolling.**

![Compact 900 × 640 reader with collapsed file list and document scrolling.](screenshots/16-native-compact-reader.jpg)

**Compact review overlay with change colors, bottom fade, and fixed Publish update action.**

![Compact review overlay with change colors, bottom fade, and fixed Publish update action.](screenshots/17-native-compact-overlay.jpg)

**Scrolled compact review overlay with shell syntax colors and persistent header and footer.**

![Scrolled compact review overlay with shell syntax colors and persistent header and footer.](screenshots/18-native-compact-scrolled.jpg)

## Limitations

- Synthetic data in an isolated local profile. This is native app evidence, not live account or server verification.
- The external Claude CLI is a harmless fixture that records launch arguments. No model call or real Claude client continuation was exercised.
- Live API sync, teammate approval, Publish update, Send for approval, and external editor launch were not exercised.
- Script reader is plain monospace and CSV reader is raw text. Syntax highlighting is demonstrated in the diff views, not the script reader.
- The PDF capture verifies the fallback state, not PDF document rendering.
- Still images support visual review. Focus and installation claims also rely on native accessibility, keyboard interactions, SQLite, and file-hash checks.
- Debug, ad-hoc-signed test bundles were used. This is not a signed production release or exhaustive coverage of every application state.
