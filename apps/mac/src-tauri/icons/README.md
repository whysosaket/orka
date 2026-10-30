# Orka app icon

These PNGs are the supplied Orka app-icon source assets. The macOS packaging step applies the Dock-specific padding described below.

| Supplied file | Repository file | Pixels |
| --- | --- | --- |
| `32.png` | `32x32.png` | 32 × 32 |
| `128.png` | `128x128.png` | 128 × 128 |
| `256.png` | `128x128@2x.png` | 256 × 256 |
| `512.png` | `icon.png` | 512 × 512 |

The four PNGs are the source assets. The earlier green-arrow `apps/mac/icon.svg` was retired; there is no vector source for this textured artwork in the supplied set.

From the repository root, rebuild the macOS container and browser favicon:

```sh
sh scripts/package-app-icon.sh
```

`icon.icns` contains layers at 16, 32, 64, 128, 256, and 512 pixels. Each places the artwork within approximately 80% of its canvas, with symmetric transparent margins of 10% per edge, rounded to whole pixels. This matches the visual footprint of neighboring macOS Dock icons. At 512px, the artwork is 410px with 51px margins; at 256px, it is 204px with 26px margins.

The October 4, 2026 padding fix affects only macOS icon layers. The source PNGs and `apps/mac/public/favicon.png` remain unchanged. No 1024px export was supplied, so no upscaled 1024px layer is generated. Rerunning the packager always starts from the originals and cannot accumulate padding.

Packaging uses Swift/CoreGraphics in `scripts/render-app-icon.swift` and Python 3's standard library. Each ICNS layer stores the rendered PNG data directly, avoiding a legacy ARGB conversion. Validate the stored PNG payloads for alpha bounds; `iconutil -c iconset` also accepts the container, although its small-icon extraction can alter translucent RGB values.

The Tauri bundle configuration already references this icon set. Tauri also embeds the ICNS in development executables and sets it as the running app's Dock icon. After packaging an icon change, rebuild the native executable with `cargo build --manifest-path apps/mac/src-tauri/Cargo.toml`, quit Orka Development, and run `Open Orka.command` to copy the rebuilt executable and reopen it. Updating only the bundle's resource file does not replace the embedded icon. `build.rs` watches the icon directory so Cargo picks up regenerated assets. Installed release apps receive the icon through a rebuilt application bundle.
