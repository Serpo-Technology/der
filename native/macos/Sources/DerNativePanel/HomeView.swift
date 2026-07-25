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

    func openSettings() {
        Outbound.shared.send(["event": "openSettings"])
    }

    func openParts() {
        Outbound.shared.send(["event": "openParts"])
    }
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
                                HomeRow(title: bookmark.name, subtitle: nil) {
                                    model.open(bookmark)
                                }
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
                                HomeRow(title: recent.name, subtitle: recent.description) {
                                    model.open(recent)
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
            HStack(spacing: 8) {
                TextField("A tip calculator, a reading log, a pantry tracker...", text: $model.prompt)
                    .textFieldStyle(.roundedBorder)
                    .controlSize(.large)
                    .focused($promptFocused)
                    .onSubmit { model.create() }
                Button("Create") { model.create() }
                    .buttonStyle(.borderedProminent)
                    .controlSize(.large)
                    .disabled(
                        model.prompt.trimmingCharacters(in: .whitespaces).isEmpty || model.isBuilding
                    )
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

private struct HomeRow: View {
    let title: String
    let subtitle: String?
    let open: () -> Void
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
