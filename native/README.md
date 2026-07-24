# Native renderer panels

Renderer processes that display experiences in real OS windows. A panel is a
pure view: the runtime core resolves every tree, executes every operation,
and holds every secret; the panel maps resolved nodes onto native controls
and reports user actions back. The wire protocol is newline-delimited JSON
over the panel's stdio, spoken by `src-tauri/src/runtime/sidecar.rs`:
`open`/`update`/`close`/`operationFailed` inbound to the panel,
`setElement`/`dispatch`/`windowClosed` outbound.

## macos/

A SwiftUI panel (SwiftPM executable, macOS 13+). Build it once:

```
cd native/macos
swift build
```

The app finds the built binary at `native/macos/.build/{debug,release}/DerNativePanel`
(or wherever `DER_NATIVE_RENDERER` points) and starts it on demand. Every
open experience window shows a "Native window" button on macOS; clicking it
opens the same app as an NSWindow with native controls, running against the
same runtime core, parts, and credentials as the webview.

`swift test` decodes the committed view vectors in `runtime-conformance/`,
so the panel's protocol types are held to the same trees as the Rust and
TypeScript resolvers.

## Native mode

With `--native` (or `DER_NATIVE_MODE=1`), DER runs native-first: the panel
shows DER's home (describe an app to create it, open a bookmarked one), and
every experience opens as a native window by default, tray launches and
generated apps included, with per-app state saved and restored like webview
windows. Generation still runs in the hidden main window's pipeline; the
finished contract opens natively, and later edits land in the open native
window with its state kept.

Running `DerNativePanel` directly (from a terminal or Finder) starts DER in
native mode: it finds the app binary via `DER_APP_BINARY` or the dev build
path and hands over.
