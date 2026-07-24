// DER's native home: describe an app to create it, or open one you kept.
// Creation runs in the core's generation pipeline; the finished app opens
// in its own native window.

import SwiftUI

@MainActor
final class HomeModel: ObservableObject {
    @Published var bookmarks: [HomeBookmark] = []
    @Published var prompt = ""
    @Published var note: String?

    func create() {
        let trimmed = prompt.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        Outbound.shared.send(["event": "create", "prompt": trimmed])
        prompt = ""
        note = "Working on it. The app opens in its own window when ready."
    }

    func open(_ bookmark: HomeBookmark) {
        Outbound.shared.send(["event": "openBookmark", "id": bookmark.id])
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
                Text(note)
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }

            Divider()

            Text("Your apps")
                .font(.headline)
            if model.bookmarks.isEmpty {
                Text("Apps you bookmark appear here, ready to open.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            } else {
                ScrollView {
                    VStack(spacing: 4) {
                        ForEach(model.bookmarks) { bookmark in
                            HStack {
                                Text(bookmark.name)
                                Spacer()
                                Button("Open") { model.open(bookmark) }
                            }
                            .padding(.vertical, 2)
                        }
                    }
                }
            }
            Spacer(minLength: 0)
        }
        .padding(20)
        .frame(minWidth: 420, minHeight: 380)
    }
}
