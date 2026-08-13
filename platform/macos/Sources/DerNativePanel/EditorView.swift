// The native editors behind an app: the contract as validated JSON, and the
// blueprint projection that can regenerate it through the model. Apply and
// regenerate land in the open app window with its state preserved.

import SwiftUI

@MainActor
final class EditorModel: ObservableObject {
    let windowId: String
    @Published var name = ""
    @Published var tab = "contract"
    @Published var contractText = ""
    @Published var blueprintText = ""
    @Published var errors: [String] = []
    @Published var warnings: [String] = []
    @Published var busy = false
    @Published var note: String?
    @Published var noteIsError = false

    init(windowId: String) {
        self.windowId = windowId
    }

    func apply(_ message: InboundMessage) {
        if let name = message.name { self.name = name }
        if let contract = message.contractJson { contractText = contract }
        if let blueprint = message.blueprintJson { blueprintText = blueprint }
        if let note = message.note {
            self.note = note
            noteIsError = message.noteKind == "error"
        }
    }

    func applyVerdict(_ message: InboundMessage) {
        errors = message.errors ?? []
        warnings = message.warnings ?? []
        if errors.isEmpty && warnings.isEmpty {
            note = "No problems found"
            noteIsError = false
        }
    }

    func applyStatus(_ status: String, message: String?) {
        switch status {
        case "started":
            busy = true
            noteIsError = false
            note = message ?? "Working"
        case "done":
            busy = false
            noteIsError = false
            note = message
            errors = []
        case "failed":
            busy = false
            noteIsError = true
            note = message ?? "The change could not be applied"
        default:
            break
        }
    }

    func validate() {
        errors = []
        warnings = []
        Outbound.shared.send([
            "event": "editorValidate", "windowId": windowId, "json": contractText,
        ])
    }

    func applyContract() {
        errors = []
        warnings = []
        busy = true
        note = "Applying the contract"
        noteIsError = false
        Outbound.shared.send([
            "event": "editorApply", "windowId": windowId, "json": contractText,
        ])
    }

    func regenerate() {
        errors = []
        warnings = []
        Outbound.shared.send([
            "event": "editorRegenerate", "windowId": windowId, "blueprint": blueprintText,
        ])
    }
}

struct EditorView: View {
    @ObservedObject var model: EditorModel

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Picker("", selection: $model.tab) {
                Text("Contract").tag("contract")
                Text("Blueprint").tag("blueprint")
            }
            .pickerStyle(.segmented)
            .labelsHidden()

            if model.tab == "contract" {
                TextEditor(text: $model.contractText)
                    .font(.system(.caption, design: .monospaced))
                    .frame(minHeight: 260)
                HStack {
                    Button("Validate") { model.validate() }
                        .disabled(model.busy)
                    Button("Apply") { model.applyContract() }
                        .buttonStyle(.borderedProminent)
                        .disabled(model.busy)
                    Spacer()
                }
            } else {
                Text("What the app is made of; edit the plan and regenerate to rebuild the contract from it.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                TextEditor(text: $model.blueprintText)
                    .font(.system(.caption, design: .monospaced))
                    .frame(minHeight: 240)
                HStack {
                    Button("Regenerate contract") { model.regenerate() }
                        .buttonStyle(.borderedProminent)
                        .disabled(model.busy)
                    Spacer()
                }
            }

            if let note = model.note {
                HStack(spacing: 6) {
                    if model.busy { ProgressView().controlSize(.small) }
                    Text(note)
                        .font(.caption)
                        .foregroundStyle(model.noteIsError ? AnyShapeStyle(.red) : AnyShapeStyle(.secondary))
                }
            }
            if !model.errors.isEmpty {
                ScrollView {
                    VStack(alignment: .leading, spacing: 3) {
                        ForEach(model.errors, id: \.self) { error in
                            Text(error)
                                .font(.system(.caption2, design: .monospaced))
                                .foregroundStyle(.red)
                                .textSelection(.enabled)
                        }
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                }
                .frame(maxHeight: 110)
            }
            if !model.warnings.isEmpty {
                ScrollView {
                    VStack(alignment: .leading, spacing: 3) {
                        ForEach(model.warnings, id: \.self) { warning in
                            Text(warning)
                                .font(.system(.caption2, design: .monospaced))
                                .foregroundStyle(.orange)
                                .textSelection(.enabled)
                        }
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                }
                .frame(maxHeight: 70)
            }
        }
        .padding(14)
        .frame(minWidth: 520, minHeight: 460)
    }
}
