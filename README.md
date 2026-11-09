# GitHub integration UI review

Synthetic fixture screenshots for [Orka draft PR #12](https://github.com/whysosaket/orka/pull/12), captured from implementation commit `137caa2e16fbc7094c598c76651883dd5c0a0a1a` on 2026-11-09. The only subsequent checkout change before this commit was rebasing the same feature onto the merged self-hosting base; the UI is unchanged.

These screenshots establish UI rendering and interactions. Backend authorization, native clone behavior, and live development consent have separate tests described in the PR. No real credentials or private repository content appear here.

- `01-connect`: first-run setup, Settings source connection, repository discovery.
- `02-clone`: reviewed destination and progress/cancellation at 1160×800 and 900×640.
- `03-access`: requester flow and owner coordination in Settings Members.

This branch holds review images only; it is not intended to merge into the product branch.
