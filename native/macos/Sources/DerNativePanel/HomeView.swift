// DER's native home: describe an app to create it, or open one you kept.
// Creation runs in the core's generation pipeline; the finished app opens
// in its own native window.

import SwiftUI

@MainActor
final class HomeModel: ObservableObject {
    @Published var bookmarks: [HomeBookmark] = []
    @Published var recipes: [HomeRecipe] = []
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

    func openManage() {
        Outbound.shared.send(["event": "openManage"])
    }
}

struct HomeView: View {
    @ObservedObject var model: HomeModel

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            Text("What should your app do?")
                .font(.title3)
                .bold()
            HStack(spacing: 8) {
                TextField("Describe the app you want", text: $model.prompt)
                    .textFieldStyle(.roundedBorder)
                    .onSubmit { model.create() }
                Button("Create") { model.create() }
                    .buttonStyle(.borderedProminent)
                    .disabled(model.prompt.trimmingCharacters(in: .whitespaces).isEmpty)
            }
            if let note = model.note {
                HStack(spacing: 6) {
                    if model.isBuilding {
                        ProgressView().controlSize(.small)
                    }
                    Text(note)
                        .font(.caption)
                        .foregroundStyle(model.buildFailed ? AnyShapeStyle(.red) : AnyShapeStyle(.secondary))
                }
            }

            Divider()

            ScrollView {
                VStack(alignment: .leading, spacing: 12) {
                    Text("Your apps")
                        .font(.headline)
                    if model.bookmarks.isEmpty {
                        Text("Apps you bookmark appear here, ready to open.")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    } else {
                        ForEach(model.bookmarks) { bookmark in
                            HStack {
                                Text(bookmark.name)
                                Spacer()
                                Button("Open") { model.open(bookmark) }
                            }
                        }
                    }

                    if !model.recipes.isEmpty {
                        Text("Ready-made apps")
                            .font(.headline)
                            .padding(.top, 4)
                        ForEach(model.recipes) { recipe in
                            HStack(alignment: .firstTextBaseline) {
                                VStack(alignment: .leading, spacing: 2) {
                                    Text(recipe.title)
                                    if let description = recipe.description {
                                        Text(description)
                                            .font(.caption)
                                            .foregroundStyle(.secondary)
                                    }
                                }
                                Spacer()
                                Button("Open") { model.open(recipe) }
                            }
                        }
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
            }

            Divider()
            HStack {
                Text("Model settings, parts, and editors")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                Spacer()
                Button("Manage") { model.openManage() }
            }
        }
        .padding(20)
        .frame(minWidth: 460, minHeight: 460)
    }
}
