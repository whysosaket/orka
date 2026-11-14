#!/bin/bash
set -euo pipefail

app=${1:?Expected a bundled Orka.app}
output=${2:?Expected an output directory}
root=$(cd "$(dirname "$0")/.." && pwd)
launcher="$app/Contents/MacOS/portable-workspace-mac"
payload="$app/Contents/MacOS/orka-desktop"
plist="$app/Contents/Info.plist"
identity=${APPLE_SIGNING_IDENTITY:--}
team=${APPLE_TEAM_ID:-}
feed=${ORKA_UPDATE_FEED_URL:-}
key=${ORKA_UPDATE_PUBLIC_KEY:-}
if [[ "$identity" != - ]]; then
  [[ "$team" =~ ^[A-Z0-9]{10}$ && "$feed" == https://* && "$key" =~ ^[A-Za-z0-9+/]{43}=$ ]] || {
    echo 'Set APPLE_TEAM_ID, ORKA_UPDATE_FEED_URL, and the raw base64 Ed25519 ORKA_UPDATE_PUBLIC_KEY.' >&2
    exit 1
  }
fi
version=$(plutil -extract CFBundleShortVersionString raw "$plist")
[[ "$version" =~ ^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$ ]]
# An incompatible local-data or backend migration requires a higher epoch.
data_epoch=$(cat "$root/apps/mac/recovery/data-epoch")
[[ "$data_epoch" =~ ^[1-9][0-9]*$ ]]
mkdir -p "$output"
stage=$(mktemp -d "${TMPDIR:-/tmp}/orka-recovery.XXXXXXXX")
trap 'rm -rf "$stage"' EXIT

binaries=()
for arch in $(lipo -archs "$launcher"); do
  xcrun swiftc -O -target "$arch-apple-macosx12.0" "$root"/apps/mac/recovery/*.swift -o "$stage/$arch"
  binaries+=("$stage/$arch")
done
lipo -create "${binaries[@]}" -output "$stage/launcher"
mv "$launcher" "$payload"
cp "$stage/launcher" "$launcher"
# LaunchServices must start the native desktop without replacing its process image.
plutil -replace CFBundleExecutable -string orka-desktop "$plist"

updater="$app/Contents/Helpers/Orka Updater.app"
mkdir -p "$updater/Contents/MacOS" "$updater/Contents/Resources"
cp "$stage/launcher" "$updater/Contents/MacOS/orka-updater"
cp "$root/apps/mac/src-tauri/icons/icon.icns" "$updater/Contents/Resources/icon.icns"
updater_plist="$updater/Contents/Info.plist"
plutil -create xml1 "$updater_plist"
plutil -insert CFBundleIdentifier -string com.relay.portable-workspace.recovery "$updater_plist"
plutil -insert CFBundleName -string 'Orka Updater' "$updater_plist"
plutil -insert CFBundleExecutable -string orka-updater "$updater_plist"
plutil -insert LSUIElement -bool YES "$updater_plist"
plutil -insert CFBundlePackageType -string APPL "$updater_plist"
plutil -insert CFBundleIconFile -string icon.icns "$updater_plist"
plutil -insert CFBundleVersion -string "$version" "$updater_plist"
plutil -insert CFBundleShortVersionString -string "$version" "$updater_plist"
plutil -insert LSMinimumSystemVersion -string 12.0 "$updater_plist"
plutil -insert OrkaUpdateDataEpoch -integer "$data_epoch" "$plist"
for metadata in "$plist" "$updater_plist"; do
  plutil -insert OrkaUpdateTeam -string "$team" "$metadata"
  plutil -insert OrkaUpdateFeed -string "$feed" "$metadata"
  plutil -insert OrkaUpdatePublicKey -string "$key" "$metadata"
done

signing=(--force --sign "$identity")
if [[ "$identity" != - ]]; then
  signing+=(--timestamp --options runtime)
fi
if [[ -n ${ORKA_SIGNING_KEYCHAIN:-} ]]; then
  signing+=(--keychain "$ORKA_SIGNING_KEYCHAIN")
fi
codesign "${signing[@]}" --identifier com.relay.portable-workspace "$payload"
codesign "${signing[@]}" --identifier com.relay.portable-workspace.launcher "$launcher"
codesign "${signing[@]}" "$updater"
codesign "${signing[@]}" "$app"
codesign --verify --deep --strict "$app"
codesign --verify --deep --strict "$updater"

mkdir "$stage/installer"
ditto "$app" "$stage/installer/Orka.app"
ln -s /Applications "$stage/installer/Applications"
printf '%s\n' 'Quit Orka, then drag Orka to Applications. If you cannot write to Applications, install Orka in the Applications folder in your home directory.' > "$stage/installer/Install Orka.txt"
installer="$output/Orka_${version}_$(lipo -archs "$launcher" | tr ' ' '_').dmg"
hdiutil create -ov -volname Orka -srcfolder "$stage/installer" -format UDZO "$installer"
codesign "${signing[@]}" "$installer"
