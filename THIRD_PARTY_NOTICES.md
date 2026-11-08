# Third-party notices

Orka's own source is offered under the [MIT license](LICENSE). Third-party dependencies and assets retain their own licenses; the project license does not replace them or grant rights to third-party trademarks.

## Included visual assets

- **Inter Variable:** the font distributed by `@fontsource-variable/inter`, including the font embedded in the generated component gallery, is under the SIL Open Font License 1.1. Its notice is preserved in [licenses/Inter-OFL.txt](licenses/Inter-OFL.txt).
- **Octicons:** GitHub's icons, rendered through `@primer/octicons-react`, are MIT licensed. The supplied notice is preserved in [licenses/Octicons-MIT.txt](licenses/Octicons-MIT.txt).
- **Provider marks:** the SVGs in `apps/mac/public/source-icons` identify Codex and Claude. Those product names and marks belong to their respective owners and are not licensed as Orka artwork. Distribution rights and brand-guideline compliance must be checked before a public release; retaining these files is not an assertion of ownership or endorsement.
- **Orka app artwork:** the supplied app-icon PNGs and their derived favicon/ICNS are project assets. Maintainers must confirm permission to distribute them under the project license before publication.

## Dependencies

- **Agentation:** development and explicit internal annotation builds use `agentation` under PolyForm Shield 1.0.0. Its upstream terms are linked from the [package](https://www.npmjs.com/package/agentation/v/3.1.2). Ordinary production builds omit it.
- **Skullet:** measured skeleton loading states are MIT licensed. Its notice is preserved in [licenses/Skullet-MIT.txt](licenses/Skullet-MIT.txt).

JavaScript dependencies are locked in `package-lock.json`; Rust dependencies are locked in `apps/mac/src-tauri/Cargo.lock`. Third-party dependencies are not vendored into the source repository. The first-party client protocol package is included under MIT with its provenance and checksums in `vendor/manifest.json`. The [dependency license inventory](docs/dependency-licenses.md) records declared licenses and upstream locations for the locked packages. Metadata is an inventory, not a substitute for a dependency's actual license terms.

The dependency graph includes permissive licenses, the SIL Open Font License, Unicode and data licenses, and MPL-2.0 components. Preserve upstream notices and review applicable source-distribution obligations when distributing compiled binaries or modified dependency code. Service deployments are maintained separately and are outside this desktop source release.

Before a binary release, refresh the inventory, collect the notices and corresponding-source information for the dependencies actually shipped, and include them with the distributable. Source release and binary release have separate checklists in [docs/release-checklist.md](docs/release-checklist.md).
