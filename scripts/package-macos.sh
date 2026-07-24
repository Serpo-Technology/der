#!/usr/bin/env bash
# Builds the installable macOS app: the Swift panel in release mode, staged
# as a bundled sidecar, then the Tauri production build. The packaged app is
# named DER and runs native-first because the panel ships inside it.
set -euo pipefail
cd "$(dirname "$0")/.."

triple="$(rustc -vV | sed -n 's/^host: //p')"

echo "building the native panel (release)"
(cd native/macos && swift build -c release)

mkdir -p src-tauri/binaries
cp "native/macos/.build/release/DerNativePanel" "src-tauri/binaries/DerNativePanel-${triple}"

echo "building the app bundle"
npm run tauri build -- --config src-tauri/tauri.macos-app.conf.json

echo
echo "bundle: src-tauri/target/release/bundle/macos/DER.app"
