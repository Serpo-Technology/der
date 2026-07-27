// The panel process: reads runtime messages from stdin, keeps one NSWindow
// per open experience, and reports user actions back over stdout.

import AppKit
import SwiftUI
import UniformTypeIdentifiers

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
                 theme: message.theme, accent: message.accent,
                 background: message.background, tree: message.tree ?? [],
                 assembling: message.assembling ?? false)
        case "update":
            guard let windowId = message.windowId, let tree = message.tree,
                  let entry = windows[windowId] else { return }
            entry.model.tree = tree
            entry.model.assembling = message.assembling ?? false
            // Edits can change the look mid-flight; restyle with the tree.
            entry.model.theme = message.theme
            entry.model.accent = message.accent
            entry.model.background = message.background
            applyAppearance(entry.window, dark: entry.model.backgroundIsDark)
        case "close":
            guard let windowId = message.windowId, let entry = windows.removeValue(forKey: windowId) else { return }
            entry.window.delegate = nil
            entry.window.close()
        case "home":
            homeModel.bookmarks = message.bookmarks ?? []
            homeModel.recipes = message.recipes ?? []
            homeModel.recents = message.recents ?? []
            homeModel.llmReady = message.llmReady ?? true
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
        case "pickFile":
            guard let requestId = message.requestId else { return }
            presentOpenDialog(requestId: requestId, kind: message.kind ?? "")
        case "saveFile":
            guard let requestId = message.requestId else { return }
            presentSaveDialog(requestId: requestId, name: message.name ?? "")
        case "mailAccount":
            guard let requestId = message.requestId else { return }
            presentMailAccountSheet(requestId: requestId, prefill: message.account)
        case "operationFailed":
            guard let windowId = message.windowId else { return }
            windows[windowId]?.model.applyOperationFailure(
                message.message ?? "An operation failed"
            )
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

    /// The panel presents the core's file dialogs: as the active app they
    /// front properly instead of hiding behind windows.
    private func contentTypes(for kind: String) -> [UTType]? {
        switch kind {
        case "pdf": return [.pdf]
        case "image": return [.image]
        case "video": return [.movie, .video]
        case "markdown":
            return [UTType(filenameExtension: "md"), UTType(filenameExtension: "markdown"), .plainText]
                .compactMap { $0 }
        case "text": return [.plainText, .json, .commaSeparatedText, .html]
        default: return nil
        }
    }

    private func presentOpenDialog(requestId: String, kind: String) {
        NSApp.activate(ignoringOtherApps: true)
        let panel = NSOpenPanel()
        panel.canChooseDirectories = false
        panel.allowsMultipleSelection = false
        if let types = contentTypes(for: kind) {
            panel.allowedContentTypes = types
        }
        let picked = panel.runModal() == .OK ? panel.url?.path : nil
        var reply: [String: Any] = ["event": "fileDialog", "requestId": requestId]
        if let picked { reply["path"] = picked }
        Outbound.shared.send(reply)
    }

    private func presentSaveDialog(requestId: String, name: String) {
        NSApp.activate(ignoringOtherApps: true)
        let panel = NSSavePanel()
        if !name.isEmpty {
            panel.nameFieldStringValue = name
        }
        let target = panel.runModal() == .OK ? panel.url?.path : nil
        var reply: [String: Any] = ["event": "fileDialog", "requestId": requestId]
        if let target { reply["path"] = target }
        Outbound.shared.send(reply)
    }

    /// An app's first send with no account configured lands here: the sheet
    /// blocks like the file dialogs, and the account goes straight into the
    /// host's credential store.
    private func presentMailAccountSheet(requestId: String, prefill: SmtpShape?) {
        NSApp.activate(ignoringOtherApps: true)
        let window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 460, height: 300),
            styleMask: [.titled],
            backing: .buffered,
            defer: false
        )
        window.title = "Mail account"
        window.isReleasedWhenClosed = false
        var answered = false
        let finish: ([String: Any]?) -> Void = { account in
            guard !answered else { return }
            answered = true
            var reply: [String: Any] = ["event": "mailAccount", "requestId": requestId]
            if let account { reply["account"] = account }
            Outbound.shared.send(reply)
            NSApp.stopModal()
            window.orderOut(nil)
        }
        let form = MailAccountForm(
            draft: MailAccountDraft(prefill: prefill),
            title: "Set up the mail account this app sends with",
            onSave: { draft in finish(draft.payload) },
            onCancel: { finish(nil) }
        )
        window.contentView = NSHostingView(rootView: form)
        window.center()
        window.makeKeyAndOrderFront(nil)
        NSApp.runModal(for: window)
        finish(nil)
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

    private func applyAppearance(_ window: NSWindow, dark: Bool) {
        window.appearance = dark ? NSAppearance(named: .darkAqua) : nil
    }

    private func open(windowId: String, title: String, theme: String?, accent: String?,
                      background: String?, tree: [ResolvedNode], assembling: Bool) {
        let model = TreeModel(windowId: windowId, tree: tree, assembling: assembling)
        model.theme = theme
        model.accent = accent
        model.background = background
        let window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 480, height: 620),
            styleMask: [.titled, .closable, .resizable, .miniaturizable],
            backing: .buffered,
            defer: false
        )
        window.title = title
        window.isReleasedWhenClosed = false
        applyAppearance(window, dark: model.backgroundIsDark)
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

/// Menu targets and the app delegate: menu picks become bridge events, the
/// Dock reopen shows the home, and quitting tells the core so both
/// processes leave together.
@MainActor
final class AppController: NSObject, NSApplicationDelegate {
    static let shared = AppController()

    @objc func openHome(_ sender: Any?) {
        Outbound.shared.send(["event": "openHome"])
    }

    @objc func openSettings(_ sender: Any?) {
        Outbound.shared.send(["event": "openSettings"])
    }

    @objc func openParts(_ sender: Any?) {
        Outbound.shared.send(["event": "openParts"])
    }

    @objc func quitDer(_ sender: Any?) {
        // The core exits and this process follows on stdin EOF; the timer is
        // the fallback if the pipe lingers.
        Outbound.shared.send(["event": "quitApp"])
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) {
            NSApp.terminate(nil)
        }
    }

    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows: Bool) -> Bool {
        if !hasVisibleWindows {
            Outbound.shared.send(["event": "openHome"])
        }
        return true
    }
}

/// The full DER menu bar: every screen reachable from it, and the standard
/// Edit/Window items so system shortcuts work.
@MainActor
func installMainMenu() {
    let main = NSMenu()
    let controller = AppController.shared

    let appItem = NSMenuItem()
    let appMenu = NSMenu()
    let settingsItem = NSMenuItem(
        title: "Settings...",
        action: #selector(AppController.openSettings(_:)),
        keyEquivalent: ","
    )
    settingsItem.target = controller
    appMenu.addItem(settingsItem)
    let partsItem = NSMenuItem(
        title: "Parts...",
        action: #selector(AppController.openParts(_:)),
        keyEquivalent: "P"
    )
    partsItem.target = controller
    appMenu.addItem(partsItem)
    appMenu.addItem(NSMenuItem.separator())
    appMenu.addItem(withTitle: "Hide DER", action: #selector(NSApplication.hide(_:)), keyEquivalent: "h")
    appMenu.addItem(NSMenuItem.separator())
    let quitItem = NSMenuItem(
        title: "Quit DER",
        action: #selector(AppController.quitDer(_:)),
        keyEquivalent: "q"
    )
    quitItem.target = controller
    appMenu.addItem(quitItem)
    appItem.submenu = appMenu
    main.addItem(appItem)

    let fileItem = NSMenuItem()
    let fileMenu = NSMenu(title: "File")
    let newItem = NSMenuItem(
        title: "New App...",
        action: #selector(AppController.openHome(_:)),
        keyEquivalent: "n"
    )
    newItem.target = controller
    fileMenu.addItem(newItem)
    let homeItem = NSMenuItem(
        title: "Home",
        action: #selector(AppController.openHome(_:)),
        keyEquivalent: "0"
    )
    homeItem.target = controller
    fileMenu.addItem(homeItem)
    fileItem.submenu = fileMenu
    main.addItem(fileItem)

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
// The panel is DER's face: Dock presence, menu bar, and dialogs. Inside the
// packaged DER.app bundle it inherits the app's name and icon.
app.setActivationPolicy(.regular)
MainActor.assumeIsolated {
    app.delegate = AppController.shared
    installMainMenu()
}

pumpInbound { message in
    DispatchQueue.main.async {
        PanelWindows.shared.apply(message)
    }
}

app.run()
