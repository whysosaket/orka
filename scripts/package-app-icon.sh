#!/bin/sh
# Package macOS-padded icon layers while preserving the original PNG exports.
set -eu

orka_workspace=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
orka_icons="$orka_workspace/apps/mac/src-tauri/icons"
orka_stage=$(mktemp -d "${TMPDIR:-/tmp}/orka-icon.XXXXXX")
trap 'rm -rf "$orka_stage"' EXIT HUP INT TERM
orka_iconset="$orka_stage/Orka.iconset"
mkdir -p "$orka_iconset"

# Add 10% transparent margins per edge only to the macOS container layers.
# Always render from originals, so rerunning never adds another round of padding.
/usr/bin/swift "$orka_workspace/scripts/render-app-icon.swift" "$orka_icons" "$orka_iconset"
cp "$orka_iconset/icon_32x32.png" "$orka_iconset/icon_16x16@2x.png"
cp "$orka_iconset/icon_256x256.png" "$orka_iconset/icon_128x128@2x.png"
cp "$orka_iconset/icon_512x512.png" "$orka_iconset/icon_256x256@2x.png"
# Store PNG payloads directly. iconutil can convert the small 1x layers to
# legacy ARGB and alter translucent edge colors in the supplied artwork.
python3 - "$orka_iconset" "$orka_icons/icon.icns" <<'PY'
from pathlib import Path
import struct
import sys

iconset, destination = map(Path, sys.argv[1:])
layers = [
    (b"icp4", "icon_16x16.png"),
    (b"ic11", "icon_16x16@2x.png"),
    (b"icp5", "icon_32x32.png"),
    (b"ic12", "icon_32x32@2x.png"),
    (b"ic07", "icon_128x128.png"),
    (b"ic13", "icon_128x128@2x.png"),
    (b"ic08", "icon_256x256.png"),
    (b"ic14", "icon_256x256@2x.png"),
    (b"ic09", "icon_512x512.png"),
]
chunks = []
for tag, filename in layers:
    png = (iconset / filename).read_bytes()
    if not png.startswith(b"\x89PNG\r\n\x1a\n"):
        raise ValueError(f"Expected a PNG icon layer: {filename}")
    chunks.append(tag + struct.pack(">I", len(png) + 8) + png)
payload = b"".join(chunks)
destination.write_bytes(b"icns" + struct.pack(">I", len(payload) + 8) + payload)
PY

mkdir -p "$orka_workspace/apps/mac/public"
cp "$orka_icons/32x32.png" "$orka_workspace/apps/mac/public/favicon.png"
printf '%s\n' 'Packaged padded macOS icon through 512 pixels and the original browser favicon.'
