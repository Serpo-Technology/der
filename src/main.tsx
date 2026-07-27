import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { isTauriRuntime } from "./services/tauri/TauriCommandService";
import { installBrowserCore } from "./services/runtime-core/browser-core";

// Without a desktop core behind the window, the in-process kernel hosts the
// sessions and contract commands. Installed before the first render so no
// window can race it; the kernel binary itself loads behind the first call.
if (!isTauriRuntime()) {
  installBrowserCore();
}

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
