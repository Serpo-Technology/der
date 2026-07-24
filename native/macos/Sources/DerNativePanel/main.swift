// The panel process: reads runtime messages from stdin, keeps one NSWindow
// per open experience, and reports user actions back over stdout.

import AppKit
import SwiftUI

@MainActor
final class PanelWindows: NSObject, NSWindowDelegate {
    static let shared = PanelWindows()
    private var windows: [String: (window: NSWindow, model: TreeModel)] = [:]
    private var homeWindow: NSWindow?
    private let homeModel = HomeModel()

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
        case "home":
            homeModel.bookmarks = message.bookmarks ?? []
            showHome()
        case "operationFailed":
            NSSound.beep()
        default:
            Outbound.shared.send(["event": "log", "message": "unknown cmd \(message.cmd)"])
        }
    }

    private func showHome() {
        if let window = homeWindow {
            window.makeKeyAndOrderFront(nil)
            return
        }
        let window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 460, height: 420),
            styleMask: [.titled, .closable, .resizable, .miniaturizable],
            backing: .buffered,
            defer: false
        )
        window.title = "DER"
        window.isReleasedWhenClosed = false
        window.contentView = NSHostingView(rootView: HomeView(model: homeModel))
        window.center()
        homeWindow = window
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
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

/// Run directly (a TTY, a Finder launch), the panel is an entry point: it
/// starts DER in native mode and hands over; DER then runs its own panel.
func launchDerIfStandalone() -> Bool {
    let standalone = isatty(0) != 0 || CommandLine.arguments.contains("--standalone")
    guard standalone else { return false }

    var candidates: [String] = []
    if let fromEnv = ProcessInfo.processInfo.environment["DER_APP_BINARY"] {
        candidates.append(fromEnv)
    }
    let panelDir = URL(fileURLWithPath: CommandLine.arguments[0])
        .resolvingSymlinksInPath()
        .deletingLastPathComponent()
    for build in ["release", "debug"] {
        candidates.append(
            panelDir
                .appendingPathComponent("../../../../src-tauri/target/\(build)/dynamic-experience-runtime")
                .standardizedFileURL.path
        )
    }

    guard let binary = candidates.first(where: { FileManager.default.isExecutableFile(atPath: $0) }) else {
        FileHandle.standardError.write(Data(
            "DER binary not found; set DER_APP_BINARY or build the app first\n".utf8
        ))
        return true
    }
    let process = Process()
    process.executableURL = URL(fileURLWithPath: binary)
    process.environment = ProcessInfo.processInfo.environment.merging(["DER_NATIVE_MODE": "1"]) { _, new in new }
    do {
        try process.run()
    } catch {
        FileHandle.standardError.write(Data("Could not start DER: \(error)\n".utf8))
    }
    return true
}

if launchDerIfStandalone() {
    exit(0)
}

let app = NSApplication.shared
app.setActivationPolicy(.accessory)

pumpInbound { message in
    DispatchQueue.main.async {
        PanelWindows.shared.apply(message)
    }
}

app.run()
