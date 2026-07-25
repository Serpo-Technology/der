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
    private var settingsWindow: NSWindow?
    private let settingsModel = SettingsModel()
    private var partsWindow: NSWindow?
    private let partsModel = PartsModel()
    private var editorWindows: [String: (window: NSWindow, model: EditorModel)] = [:]

    func apply(_ message: InboundMessage) {
        switch message.cmd {
        case "open":
            guard let windowId = message.windowId else { return }
            open(windowId: windowId, title: message.title ?? "Experience",
                 theme: message.theme, accent: message.accent, tree: message.tree ?? [],
                 assembling: message.assembling ?? false)
        case "update":
            guard let windowId = message.windowId, let tree = message.tree,
                  let entry = windows[windowId] else { return }
            entry.model.tree = tree
            entry.model.assembling = message.assembling ?? false
            // Edits can change the look mid-flight; restyle with the tree.
            entry.model.theme = message.theme
            entry.model.accent = message.accent
            applyAppearance(entry.window, theme: message.theme)
        case "close":
            guard let windowId = message.windowId, let entry = windows.removeValue(forKey: windowId) else { return }
            entry.window.delegate = nil
            entry.window.close()
        case "home":
            homeModel.bookmarks = message.bookmarks ?? []
            homeModel.recipes = message.recipes ?? []
            homeModel.recents = message.recents ?? []
            // Refreshes update in place; only explicit opens front the home.
            if message.raise ?? true {
                showHome()
            }
        case "generationStatus":
            homeModel.applyGenerationStatus(message.status ?? "", message: message.message)
        case "settings":
            settingsModel.apply(message)
            showSettings()
        case "parts":
            partsModel.apply(message)
            showParts()
        case "editStatus":
            guard let windowId = message.windowId else { return }
            windows[windowId]?.model.applyEditStatus(message.status ?? "", note: message.message)
        case "editor":
            guard let windowId = message.windowId else { return }
            showEditor(windowId: windowId, message: message)
        case "editorVerdict":
            guard let windowId = message.windowId else { return }
            editorWindows[windowId]?.model.applyVerdict(message)
        case "editorStatus":
            guard let windowId = message.windowId else { return }
            editorWindows[windowId]?.model.applyStatus(message.status ?? "", message: message.message)
        case "operationFailed":
            NSSound.beep()
        default:
            Outbound.shared.send(["event": "log", "message": "unknown cmd \(message.cmd)"])
        }
    }

    private func showAuxiliary(
        window: inout NSWindow?,
        title: String,
        size: NSSize,
        content: some View
    ) {
        if let existing = window {
            existing.makeKeyAndOrderFront(nil)
            return
        }
        let created = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: size.width, height: size.height),
            styleMask: [.titled, .closable, .resizable, .miniaturizable],
            backing: .buffered,
            defer: false
        )
        created.title = title
        created.isReleasedWhenClosed = false
        created.contentView = NSHostingView(rootView: content)
        created.center()
        window = created
        created.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
    }

    private func showSettings() {
        showAuxiliary(
            window: &settingsWindow,
            title: "DER Settings",
            size: NSSize(width: 520, height: 560),
            content: SettingsView(model: settingsModel)
        )
    }

    private func showParts() {
        showAuxiliary(
            window: &partsWindow,
            title: "DER Parts",
            size: NSSize(width: 560, height: 600),
            content: PartsView(model: partsModel)
        )
    }

    private func showEditor(windowId: String, message: InboundMessage) {
        if let existing = editorWindows[windowId] {
            existing.model.apply(message)
            existing.window.makeKeyAndOrderFront(nil)
            return
        }
        let model = EditorModel(windowId: windowId)
        model.apply(message)
        let window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 560, height: 520),
            styleMask: [.titled, .closable, .resizable, .miniaturizable],
            backing: .buffered,
            defer: false
        )
        window.title = "Editor: \(message.name ?? "App")"
        window.isReleasedWhenClosed = false
        window.contentView = NSHostingView(rootView: EditorView(model: model))
        window.center()
        editorWindows[windowId] = (window, model)
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
    }

    private func showHome() {
        if let window = homeWindow {
            window.makeKeyAndOrderFront(nil)
            return
        }
        let window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 520, height: 600),
            styleMask: [.titled, .closable, .resizable, .miniaturizable],
            backing: .buffered,
            defer: false
        )
        window.title = "DER"
        window.minSize = NSSize(width: 460, height: 480)
        window.isReleasedWhenClosed = false
        window.contentView = NSHostingView(rootView: HomeView(model: homeModel))
        window.center()
        homeWindow = window
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
    }

    private func applyAppearance(_ window: NSWindow, theme: String?) {
        if theme == "dark" || theme == "terminal" {
            window.appearance = NSAppearance(named: .darkAqua)
        } else {
            window.appearance = nil
        }
    }

    private func open(windowId: String, title: String, theme: String?, accent: String?,
                      tree: [ResolvedNode], assembling: Bool) {
        let model = TreeModel(windowId: windowId, tree: tree, assembling: assembling)
        model.theme = theme
        model.accent = accent
        let window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 480, height: 620),
            styleMask: [.titled, .closable, .resizable, .miniaturizable],
            backing: .buffered,
            defer: false
        )
        window.title = title
        window.isReleasedWhenClosed = false
        applyAppearance(window, theme: theme)
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

/// Without a main menu macOS dispatches no key equivalents, so Cmd+V and
/// friends do nothing; the standard App/Edit/Window menus restore them.
@MainActor
func installMainMenu() {
    let main = NSMenu()

    let appItem = NSMenuItem()
    let appMenu = NSMenu()
    appMenu.addItem(withTitle: "Hide DER", action: #selector(NSApplication.hide(_:)), keyEquivalent: "h")
    appMenu.addItem(NSMenuItem.separator())
    appMenu.addItem(withTitle: "Quit DER", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
    appItem.submenu = appMenu
    main.addItem(appItem)

    let editItem = NSMenuItem()
    let editMenu = NSMenu(title: "Edit")
    editMenu.addItem(withTitle: "Undo", action: Selector(("undo:")), keyEquivalent: "z")
    editMenu.addItem(withTitle: "Redo", action: Selector(("redo:")), keyEquivalent: "Z")
    editMenu.addItem(NSMenuItem.separator())
    editMenu.addItem(withTitle: "Cut", action: #selector(NSText.cut(_:)), keyEquivalent: "x")
    editMenu.addItem(withTitle: "Copy", action: #selector(NSText.copy(_:)), keyEquivalent: "c")
    editMenu.addItem(withTitle: "Paste", action: #selector(NSText.paste(_:)), keyEquivalent: "v")
    editMenu.addItem(
        withTitle: "Select All",
        action: #selector(NSText.selectAll(_:)),
        keyEquivalent: "a"
    )
    editItem.submenu = editMenu
    main.addItem(editItem)

    let windowItem = NSMenuItem()
    let windowMenu = NSMenu(title: "Window")
    windowMenu.addItem(
        withTitle: "Close Window",
        action: #selector(NSWindow.performClose(_:)),
        keyEquivalent: "w"
    )
    windowMenu.addItem(
        withTitle: "Minimize",
        action: #selector(NSWindow.performMiniaturize(_:)),
        keyEquivalent: "m"
    )
    windowItem.submenu = windowMenu
    main.addItem(windowItem)
    NSApp.windowsMenu = windowMenu

    NSApp.mainMenu = main
}

let app = NSApplication.shared
app.setActivationPolicy(.accessory)
MainActor.assumeIsolated {
    installMainMenu()
}

pumpInbound { message in
    DispatchQueue.main.async {
        PanelWindows.shared.apply(message)
    }
}

app.run()
