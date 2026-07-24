// The panel process: reads runtime messages from stdin, keeps one NSWindow
// per open experience, and reports user actions back over stdout.

import AppKit
import SwiftUI

@MainActor
final class PanelWindows: NSObject, NSWindowDelegate {
    static let shared = PanelWindows()
    private var windows: [String: (window: NSWindow, model: TreeModel)] = [:]

    func apply(_ message: InboundMessage) {
        switch message.cmd {
        case "open":
            guard let windowId = message.windowId else { return }
            open(windowId: windowId, title: message.title ?? "Experience",
                 theme: message.theme, tree: message.tree ?? [])
        case "update":
            guard let windowId = message.windowId, let tree = message.tree else { return }
            windows[windowId]?.model.tree = tree
        case "close":
            guard let windowId = message.windowId, let entry = windows.removeValue(forKey: windowId) else { return }
            entry.window.delegate = nil
            entry.window.close()
        case "operationFailed":
            NSSound.beep()
        default:
            Outbound.shared.send(["event": "log", "message": "unknown cmd \(message.cmd)"])
        }
    }

    private func open(windowId: String, title: String, theme: String?, tree: [ResolvedNode]) {
        let model = TreeModel(windowId: windowId, tree: tree)
        let window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 480, height: 620),
            styleMask: [.titled, .closable, .resizable, .miniaturizable],
            backing: .buffered,
            defer: false
        )
        window.title = title
        window.isReleasedWhenClosed = false
        if theme == "dark" || theme == "terminal" {
            window.appearance = NSAppearance(named: .darkAqua)
        }
        window.contentView = NSHostingView(rootView: RootView(model: model))
        window.center()
        window.identifier = NSUserInterfaceItemIdentifier(windowId)
        window.delegate = self
        windows[windowId] = (window, model)
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
    }

    nonisolated func windowWillClose(_ notification: Notification) {
        guard let window = notification.object as? NSWindow,
              let windowId = window.identifier?.rawValue else { return }
        Outbound.shared.windowClosed(windowId: windowId)
        Task { @MainActor in
            PanelWindows.shared.windows.removeValue(forKey: windowId)
        }
    }
}

let app = NSApplication.shared
app.setActivationPolicy(.accessory)

pumpInbound { message in
    DispatchQueue.main.async {
        PanelWindows.shared.apply(message)
    }
}

app.run()
