// Native parts: the installed signed parts, a registry to browse and update
// from, and the install review that shows the publisher fingerprint before
// anything is written, so what you confirm is exactly what gets pinned.

import AppKit
import SwiftUI
import UniformTypeIdentifiers

@MainActor
final class PartsModel: ObservableObject {
    @Published var installed: [InstalledPartShape] = []
    @Published var registry: [RegistryEntryShape]?
    @Published var registryUrl = ""
    @Published var review: StageReviewShape?
    @Published var forceDowngrade = false
    @Published var note: String?
    @Published var noteIsError = false
    @Published var confirmingRemove: String?
    @Published var secretDrafts: [String: String] = [:]

    func apply(_ message: InboundMessage) {
        if let installed = message.installed {
            self.installed = installed
        }
        registry = message.registry
        if let url = message.registryUrl, registryUrl.isEmpty {
            registryUrl = url
        }
        if let review = message.review {
            self.review = review
            forceDowngrade = false
        }
        note = message.note
        noteIsError = message.noteKind == "error"
    }

    func fetchRegistry() {
        Outbound.shared.send([
            "event": "partsFetchRegistry",
            "url": registryUrl.trimmingCharacters(in: .whitespaces),
        ])
    }

    func installFromRegistry(_ entry: RegistryEntryShape) {
        guard let url = entry.bundleUrl else { return }
        Outbound.shared.send(["event": "partsInstallRegistry", "bundleUrl": url])
    }

    func installFromFile() {
        let panel = NSOpenPanel()
        if let derpart = UTType(filenameExtension: "derpart") {
            panel.allowedContentTypes = [derpart]
        }
        panel.allowsMultipleSelection = false
        panel.canChooseDirectories = false
        if panel.runModal() == .OK, let path = panel.url?.path {
            Outbound.shared.send(["event": "partsInstallFile", "path": path])
        }
    }

    func commit() {
        guard let review else { return }
        Outbound.shared.send([
            "event": "partsCommit",
            "token": review.stagingToken,
            "fingerprint": review.fingerprint,
            "forceDowngrade": forceDowngrade,
        ])
        self.review = nil
    }

    func cancelReview() {
        review = nil
        forceDowngrade = false
    }

    func remove(_ id: String) {
        if confirmingRemove != id {
            confirmingRemove = id
            Task { @MainActor in
                try? await Task.sleep(nanoseconds: 4_000_000_000)
                if confirmingRemove == id { confirmingRemove = nil }
            }
            return
        }
        confirmingRemove = nil
        Outbound.shared.send(["event": "partsRemove", "id": id])
    }

    func saveSecret(partId: String, credential: String) {
        let key = "\(partId):\(credential)"
        let secret = secretDrafts[key]?.trimmingCharacters(in: .whitespaces) ?? ""
        guard !secret.isEmpty else { return }
        Outbound.shared.send([
            "event": "partsSaveSecret",
            "fragmentId": partId,
            "name": credential,
            "secret": secret,
        ])
        secretDrafts[key] = ""
    }

    func openRecipe(_ name: String) {
        Outbound.shared.send(["event": "partsOpenRecipe", "name": name])
    }
}

struct PartsView: View {
    @ObservedObject var model: PartsModel

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 18) {
                HStack {
                    VStack(alignment: .leading, spacing: 2) {
                        Text("Parts").font(.title3).bold()
                        Text("Signed parts extend what your apps can do. Each runs sandboxed.")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                    Spacer()
                    Button("Install from file") { model.installFromFile() }
                }
                if let note = model.note {
                    Text(note)
                        .font(.caption)
                        .foregroundStyle(model.noteIsError ? AnyShapeStyle(.red) : AnyShapeStyle(.secondary))
                }

                GroupBox("Registry") {
                    VStack(alignment: .leading, spacing: 10) {
                        HStack {
                            TextField("https://... (index.json)", text: $model.registryUrl)
                                .onSubmit { model.fetchRegistry() }
                            Button("Fetch") { model.fetchRegistry() }
                                .disabled(model.registryUrl.trimmingCharacters(in: .whitespaces).isEmpty)
                        }
                        if let registry = model.registry {
                            if registry.isEmpty {
                                Text("The registry lists no parts.")
                                    .font(.caption)
                                    .foregroundStyle(.secondary)
                            }
                            ForEach(registry) { entry in
                                registryRow(entry)
                            }
                        }
                    }
                    .padding(6)
                }

                GroupBox("Installed") {
                    VStack(alignment: .leading, spacing: 10) {
                        if model.installed.isEmpty {
                            Text("No parts installed yet.")
                                .font(.caption)
                                .foregroundStyle(.secondary)
                        }
                        ForEach(model.installed) { part in
                            installedRow(part)
                        }
                    }
                    .padding(6)
                }
            }
            .padding(20)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .frame(minWidth: 520, minHeight: 480)
        .sheet(isPresented: Binding(
            get: { model.review != nil },
            set: { shown in if !shown { model.cancelReview() } }
        )) {
            if let review = model.review {
                ReviewSheet(model: model, review: review)
            }
        }
    }

    @ViewBuilder
    private func registryRow(_ entry: RegistryEntryShape) -> some View {
        let installedHere = entry.installedVersion != nil
        let hasUpdate = entry.updateAvailable ?? false
        HStack(alignment: .firstTextBaseline) {
            VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: 6) {
                    Text(entry.name ?? entry.id).fontWeight(.medium)
                    Text("v\(entry.version ?? "?")")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                    if hasUpdate {
                        Text("update")
                            .font(.caption2)
                            .padding(.horizontal, 6)
                            .padding(.vertical, 1)
                            .background(Capsule().fill(.orange.opacity(0.25)))
                    }
                }
                if let description = entry.description {
                    Text(description).font(.caption).foregroundStyle(.secondary).lineLimit(2)
                }
            }
            Spacer()
            Button(installedHere ? (hasUpdate ? "Update" : "Installed") : "Install") {
                model.installFromRegistry(entry)
            }
            .controlSize(.small)
            .disabled(installedHere && !hasUpdate)
        }
    }

    @ViewBuilder
    private func installedRow(_ part: InstalledPartShape) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(alignment: .firstTextBaseline) {
                VStack(alignment: .leading, spacing: 2) {
                    HStack(spacing: 6) {
                        Text(part.name ?? part.id).fontWeight(.medium)
                        Text("v\(part.version ?? "?")")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                    Text("\(part.publisher ?? "") \u{2022} \(part.description ?? "")")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .lineLimit(2)
                }
                Spacer()
                Button(model.confirmingRemove == part.id ? "Really remove?" : "Remove") {
                    model.remove(part.id)
                }
                .controlSize(.small)
            }
            let operations = (part.operations ?? []).compactMap(\.name)
            if !operations.isEmpty {
                Text("Operations: \(operations.joined(separator: ", "))")
                    .font(.caption2)
                    .foregroundStyle(.secondary)
                    .lineLimit(2)
            }
            if let fragments = part.fragments, !fragments.isEmpty {
                Text("UI parts: \(fragments.joined(separator: ", "))")
                    .font(.caption2)
                    .foregroundStyle(.secondary)
            }
            ForEach(part.recipes ?? []) { recipe in
                HStack {
                    Text(recipe.title ?? recipe.name).font(.caption)
                    Spacer()
                    Button("Open") { model.openRecipe(recipe.name) }
                        .controlSize(.mini)
                        .disabled(!(recipe.available ?? false))
                }
            }
            if let service = part.service, let requirements = service.credentials, !requirements.isEmpty {
                ForEach(requirements) { requirement in
                    let key = "\(part.id):\(requirement.name)"
                    let saved = (service.saved ?? []).contains(requirement.name)
                    HStack {
                        Text(requirement.label ?? requirement.name)
                            .font(.caption)
                        if saved {
                            Image(systemName: "checkmark.circle.fill")
                                .foregroundStyle(.green)
                                .imageScale(.small)
                        }
                        SecureField("Secret", text: Binding(
                            get: { model.secretDrafts[key] ?? "" },
                            set: { model.secretDrafts[key] = $0 }
                        ))
                        Button("Save") { model.saveSecret(partId: part.id, credential: requirement.name) }
                            .controlSize(.mini)
                    }
                }
            }
            Divider()
        }
    }
}

private struct ReviewSheet: View {
    @ObservedObject var model: PartsModel
    let review: StageReviewShape

    private var blocked: Bool { review.publisherStatus == "keyMismatch" }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Install \(review.name) v\(review.version)")
                .font(.headline)
            Text(review.description)
                .font(.caption)
                .foregroundStyle(.secondary)
            GroupBox {
                VStack(alignment: .leading, spacing: 6) {
                    LabeledContent("Publisher", value: review.publisher)
                    LabeledContent("Namespace", value: review.namespace)
                    LabeledContent("Key fingerprint") {
                        Text(review.fingerprintGrouped)
                            .font(.system(.caption, design: .monospaced))
                            .textSelection(.enabled)
                    }
                    switch review.publisherStatus {
                    case "new":
                        Text("First install: this key becomes the trusted key for \(review.publisher).")
                            .font(.caption)
                            .foregroundStyle(.orange)
                    case "keyMismatch":
                        Text("This bundle is signed with a DIFFERENT key than the one pinned for \(review.publisher). Install is blocked.")
                            .font(.caption)
                            .foregroundStyle(.red)
                    default:
                        Text("Signed by the already-trusted key for \(review.publisher).")
                            .font(.caption)
                            .foregroundStyle(.green)
                    }
                }
                .padding(4)
            }
            if let capabilities = review.capabilities, !capabilities.isEmpty {
                Text("Capabilities: \(capabilities.joined(separator: ", "))")
                    .font(.caption)
            }
            let operations = (review.operations ?? []).compactMap(\.name)
            if !operations.isEmpty {
                Text("Operations: \(operations.joined(separator: ", "))")
                    .font(.caption)
                    .lineLimit(3)
            }
            let recipes = review.recipes ?? []
            if !recipes.isEmpty {
                Text("Apps: \(recipes.map { $0.title ?? $0.name }.joined(separator: ", "))")
                    .font(.caption)
            }
            if review.isDowngrade {
                Toggle("Install anyway (this is an older version than the installed one)", isOn: $model.forceDowngrade)
                    .font(.caption)
            }
            HStack {
                Spacer()
                Button("Cancel") { model.cancelReview() }
                Button("Install") { model.commit() }
                    .buttonStyle(.borderedProminent)
                    .disabled(blocked || (review.isDowngrade && !model.forceDowngrade))
            }
        }
        .padding(20)
        .frame(minWidth: 440)
    }
}
