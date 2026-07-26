// DER's native home: describe an app to create it, watch it assemble in its
// own window, or open one you kept. Creation runs in the runtime core; the
// finished app opens live.

import SwiftUI

@MainActor
final class HomeModel: ObservableObject {
    @Published var bookmarks: [HomeBookmark] = []
    @Published var recipes: [HomeRecipe] = []
    @Published var recents: [HomeRecent] = []
    @Published var prompt = ""
    @Published var note: String?
    @Published var isBuilding = false
    @Published var buildFailed = false

    func create() {
        let trimmed = prompt.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        Outbound.shared.send(["event": "create", "prompt": trimmed])
        prompt = ""
        buildFailed = false
        isBuilding = true
        note = "Building your app"
    }

    func applyGenerationStatus(_ status: String, message: String?) {
        switch status {
        case "started":
            isBuilding = true
            buildFailed = false
            note = "Building your app"
        case "done":
            isBuilding = false
            buildFailed = false
            note = nil
        case "failed":
            isBuilding = false
            buildFailed = true
            note = message ?? "The app could not be created"
        default:
            break
        }
    }

    func open(_ bookmark: HomeBookmark) {
        Outbound.shared.send(["event": "openBookmark", "id": bookmark.id])
    }

    func open(_ recipe: HomeRecipe) {
        Outbound.shared.send(["event": "openRecipe", "name": recipe.name])
    }

    func open(_ recent: HomeRecent) {
        Outbound.shared.send(["event": "openRecent", "id": recent.id])
    }

    func removeBookmark(_ bookmark: HomeBookmark) {
        Outbound.shared.send(["event": "bookmarkRemove", "id": bookmark.id])
    }

    func deleteRecent(_ recent: HomeRecent) {
        Outbound.shared.send(["event": "recentDelete", "id": recent.id])
    }

    func openSettings() {
        Outbound.shared.send(["event": "openSettings"])
    }

    func openParts() {
        Outbound.shared.send(["event": "openParts"])
    }

    static let suggestions = [
        "A grocery list with quantities, a running total, and a bought checkbox per item",
        "An expense tracker with categories, a filter dropdown, and a monthly total",
        "A workout log: exercise, sets, reps, and a summary of total sets today",
        "A reading tracker with a timer, pages read, and pace per session",
    ]
}

struct HomeView: View {
    @ObservedObject var model: HomeModel
    @FocusState private var promptFocused: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            header
            Divider()
            ScrollView {
                VStack(alignment: .leading, spacing: 20) {
                    if !model.bookmarks.isEmpty {
                        section("Your apps") {
                            ForEach(model.bookmarks) { bookmark in
                                HomeRow(
                                    title: bookmark.name,
                                    subtitle: nil,
                                    open: { model.open(bookmark) },
                                    remove: { model.removeBookmark(bookmark) },
                                    removeLabel: "Remove from Your apps"
                                )
                                .contextMenu {
                                    Button("Remove from Your apps") {
                                        model.removeBookmark(bookmark)
                                    }
                                }
                            }
                        }
                    }
                    if !model.recents.isEmpty {
                        section("Recent") {
                            ForEach(model.recents) { recent in
                                HomeRow(
                                    title: recent.name,
                                    subtitle: recent.description,
                                    open: { model.open(recent) },
                                    remove: { model.deleteRecent(recent) },
                                    removeLabel: "Delete this app"
                                )
                                .contextMenu {
                                    Button("Delete this app") {
                                        model.deleteRecent(recent)
                                    }
                                }
                            }
                        }
                    }
                    if !model.recipes.isEmpty {
                        section("Ready-made apps") {
                            ForEach(model.recipes) { recipe in
                                HomeRow(title: recipe.title, subtitle: recipe.description) {
                                    model.open(recipe)
                                }
                            }
                        }
                    }
                    if model.bookmarks.isEmpty && model.recents.isEmpty && model.recipes.isEmpty {
                        VStack(spacing: 6) {
                            Text("Nothing here yet")
                                .font(.headline)
                            Text("Describe an app above and it appears in its own window.")
                                .font(.caption)
                                .foregroundStyle(.secondary)
                        }
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 32)
                    }
                }
                .padding(20)
                .frame(maxWidth: .infinity, alignment: .leading)
            }
            Divider()
            footer
        }
        .frame(minWidth: 460, minHeight: 480)
        .onAppear { promptFocused = true }
    }

    private var header: some View {
        VStack(alignment: .leading, spacing: 12) {
            VStack(alignment: .leading, spacing: 2) {
                Text("DER")
                    .font(.system(size: 22, weight: .bold, design: .rounded))
                Text("Describe an app. Watch it assemble.")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
            }
            VStack(alignment: .leading, spacing: 8) {
                ZStack(alignment: .topLeading) {
                    TextEditor(text: $model.prompt)
                        .font(.body)
                        .scrollContentBackground(.hidden)
                        .padding(8)
                        .frame(minHeight: 84, maxHeight: 150)
                        .background(
                            RoundedRectangle(cornerRadius: 8)
                                .fill(Color(nsColor: .textBackgroundColor))
                                .overlay(
                                    RoundedRectangle(cornerRadius: 8)
                                        .stroke(Color(nsColor: .separatorColor))
                                )
                        )
                        .focused($promptFocused)
                    if model.prompt.isEmpty {
                        Text("Describe the app you want: what it shows, what you enter, what it computes...")
                            .foregroundStyle(.secondary)
                            .padding(.horizontal, 13)
                            .padding(.vertical, 16)
                            .allowsHitTesting(false)
                    }
                }
                .onKeyPress(.return, phases: .down) { press in
                    // Cmd+Return creates; plain Return stays a newline.
                    if press.modifiers.contains(.command) {
                        model.create()
                        return .handled
                    }
                    return .ignored
                }
                HStack {
                    Text("Cmd+Return to create")
                        .font(.caption2)
                        .foregroundStyle(.tertiary)
                    Spacer()
                    Button("Create") { model.create() }
                        .buttonStyle(.borderedProminent)
                        .controlSize(.large)
                        .disabled(
                            model.prompt.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                                || model.isBuilding
                        )
                }
            }
            if let note = model.note {
                HStack(spacing: 6) {
                    if model.isBuilding {
                        ProgressView().controlSize(.small)
                    }
                    Text(note)
                        .font(.caption)
                        .foregroundStyle(
                            model.buildFailed ? AnyShapeStyle(.red) : AnyShapeStyle(.secondary)
                        )
                        .lineLimit(3)
                }
            } else if model.prompt.isEmpty {
                FlowChips(suggestions: HomeModel.suggestions) { suggestion in
                    model.prompt = suggestion
                }
            }
        }
        .padding(20)
    }

    private var footer: some View {
        HStack {
            Text("Model, credentials, and installed parts")
                .font(.caption)
                .foregroundStyle(.secondary)
            Spacer()
            Button("Settings") { model.openSettings() }
            Button("Parts") { model.openParts() }
        }
        .padding(.horizontal, 20)
        .padding(.vertical, 12)
    }

    @ViewBuilder
    private func section(_ title: String, @ViewBuilder content: () -> some View) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(title)
                .font(.headline)
            VStack(spacing: 6) {
                content()
            }
        }
    }
}

/// Clickable example prompts under the create field.
private struct FlowChips: View {
    let suggestions: [String]
    let pick: (String) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("Try one of these")
                .font(.caption)
                .foregroundStyle(.secondary)
            ForEach(suggestions, id: \.self) { suggestion in
                Button {
                    pick(suggestion)
                } label: {
                    Text(suggestion)
                        .font(.caption)
                        .lineLimit(1)
                        .padding(.horizontal, 9)
                        .padding(.vertical, 4)
                        .background(Capsule().fill(.quaternary.opacity(0.5)))
                }
                .buttonStyle(.plain)
            }
        }
    }
}

private struct HomeRow: View {
    let title: String
    let subtitle: String?
    let open: () -> Void
    /// Shown on hover as a small trash button; also in the context menu.
    var remove: (() -> Void)?
    var removeLabel: String = "Remove"
    @State private var hovering = false

    var body: some View {
        HStack(alignment: .firstTextBaseline) {
            VStack(alignment: .leading, spacing: 2) {
                Text(title)
                if let subtitle, !subtitle.isEmpty {
                    Text(subtitle)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                }
            }
            Spacer()
            if hovering, let remove {
                Button {
                    remove()
                } label: {
                    Image(systemName: "trash")
                }
                .buttonStyle(.borderless)
                .controlSize(.small)
                .help(removeLabel)
            }
            Button("Open", action: open)
                .buttonStyle(.bordered)
                .controlSize(.small)
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 6)
        .background(
            RoundedRectangle(cornerRadius: 7)
                .fill(hovering ? AnyShapeStyle(.quaternary.opacity(0.6)) : AnyShapeStyle(.clear))
        )
        .onHover { hovering = $0 }
        .contentShape(Rectangle())
        .onTapGesture(count: 2, perform: open)
    }
}
