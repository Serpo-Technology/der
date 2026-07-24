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
