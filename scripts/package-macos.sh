#!/usr/bin/env bash
# Builds the installable macOS app: the Swift panel in release mode, staged
# as a bundled sidecar, then the Tauri production build. The packaged app is
# named DER and runs native-first because the panel ships inside it.
#
# Distribution steps run only when their credentials exist:
#   DER_SIGNING_IDENTITY   "Developer ID Application: ..." codesigns the app
#   DER_NOTARY_PROFILE     notarytool keychain profile; submits and staples
#   DER_MAKE_DMG=1         produces DER.dmg next to the bundle
set -euo pipefail
cd "$(dirname "$0")/.."

triple="$(rustc -vV | sed -n 's/^host: //p')"

echo "building the native panel (release)"
(cd platform/macos && swift build -c release)

mkdir -p platform/host/binaries
cp "platform/macos/.build/release/DerNativePanel" "platform/host/binaries/DerNativePanel-${triple}"

echo "building the app bundle"
npm run tauri build -- --config tauri.macos-app.conf.json

app="platform/host/target/release/bundle/macos/DER.app"

if [[ -n "${DER_SIGNING_IDENTITY:-}" ]]; then
  echo "codesigning with ${DER_SIGNING_IDENTITY}"
  codesign --force --deep --options runtime --timestamp \
    --sign "${DER_SIGNING_IDENTITY}" "${app}"
  codesign --verify --deep --strict "${app}"
fi

if [[ -n "${DER_NOTARY_PROFILE:-}" ]]; then
  echo "notarizing via profile ${DER_NOTARY_PROFILE}"
  ditto -c -k --keepParent "${app}" "${app%.app}.zip"
  xcrun notarytool submit "${app%.app}.zip" \
    --keychain-profile "${DER_NOTARY_PROFILE}" --wait
  xcrun stapler staple "${app}"
  rm -f "${app%.app}.zip"
fi

if [[ "${DER_MAKE_DMG:-}" == "1" ]]; then
  dmg="platform/host/target/release/bundle/macos/DER.dmg"
  echo "building ${dmg}"
  staging="$(mktemp -d)"
  cp -R "${app}" "${staging}/DER.app"
  ln -s /Applications "${staging}/Applications"
  hdiutil create -volname DER -srcfolder "${staging}" -ov -format UDZO "${dmg}" >/dev/null
  rm -rf "${staging}"
  if [[ -n "${DER_SIGNING_IDENTITY:-}" ]]; then
    codesign --sign "${DER_SIGNING_IDENTITY}" "${dmg}"
  fi
  echo "dmg: ${dmg}"
fi

echo
echo "bundle: ${app}"
