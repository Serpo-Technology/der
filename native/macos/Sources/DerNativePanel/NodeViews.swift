// SwiftUI rendering of a resolved tree. Semantics arrived fully computed:
// visibility is applied, bindings are values, rows are expanded; this file
// only maps the element vocabulary and its knobs onto native controls.

import SwiftUI

@MainActor
final class TreeModel: ObservableObject {
    let windowId: String
    @Published var tree: [ResolvedNode]
    @Published var assembling: Bool
    @Published var theme: String?
    @Published var accent: String?
    @Published var editInstruction = ""
    @Published var editBusy = false
    @Published var editNote: String?
    @Published var editFailed = false
    @Published var bookmarked = false

    init(windowId: String, tree: [ResolvedNode], assembling: Bool = false) {
        self.windowId = windowId
        self.tree = tree
        self.assembling = assembling
    }

    /// The tint the contract's accent asks for: a palette name or any hex
    /// color the model derived from the request.
    var accentColor: Color? {
        guard let accent else {
            return theme == "terminal" ? Color(red: 0.2, green: 0.83, blue: 0.6) : nil
        }
        switch accent {
        case "blue": return .blue
        case "green": return .green
        case "violet": return .purple
        case "rose": return .pink
        case "amber": return .orange
        case "cyan": return .cyan
        default: return Color(hex: accent)
        }
    }

    /// A subtle themed surface behind the content.
    var backgroundColor: Color? {
        switch theme {
        case "paper": return Color(red: 0.98, green: 0.955, blue: 0.90)
        case "terminal": return Color(red: 0.04, green: 0.07, blue: 0.05)
        case "dark": return Color(red: 0.11, green: 0.11, blue: 0.125)
        default: return nil
        }
    }

    func sendEdit() {
        let instruction = editInstruction.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !instruction.isEmpty, !editBusy else { return }
        Outbound.shared.send([
            "event": "editExperience",
            "windowId": windowId,
            "instruction": instruction,
        ])
        editInstruction = ""
        editBusy = true
        editFailed = false
        editNote = "Applying your change"
    }

    func applyEditStatus(_ status: String, note: String?) {
        switch status {
        case "started":
            editBusy = true
            editFailed = false
            editNote = "Applying your change"
        case "done":
            editBusy = false
            editFailed = false
            editNote = note ?? "Edit applied"
            Task { @MainActor [weak self] in
                try? await Task.sleep(nanoseconds: 4_000_000_000)
                if self?.editBusy == false, self?.editFailed == false {
                    self?.editNote = nil
                }
            }
        case "failed":
            editBusy = false
            editFailed = true
            editNote = note ?? "The change could not be applied"
        default:
            break
        }
    }

    func bookmark() {
        Outbound.shared.send(["event": "bookmarkAdd", "windowId": windowId])
        bookmarked = true
    }

    func dispatch(_ operationIds: [String], item: JSONValue?) {
        guard !operationIds.isEmpty else { return }
        Outbound.shared.dispatch(windowId: windowId, operationIds: operationIds, item: item)
    }

    func write(_ elementId: String, _ value: Any) {
        Outbound.shared.setElement(windowId: windowId, elementId: elementId, value: value)
    }
}

extension Color {
    /// "#RRGGBB" to a Color; nil for anything else.
    init?(hex: String) {
        guard hex.count == 7, hex.hasPrefix("#"),
              let value = UInt32(hex.dropFirst(), radix: 16) else { return nil }
        self.init(
            red: Double((value >> 16) & 0xff) / 255.0,
            green: Double((value >> 8) & 0xff) / 255.0,
            blue: Double(value & 0xff) / 255.0
        )
    }
}

struct RootView: View {
    @ObservedObject var model: TreeModel

    var body: some View {
        themedBody
            .background(model.backgroundColor ?? Color(nsColor: .windowBackgroundColor))
            .tint(model.accentColor ?? .accentColor)
    }

    private var themedBody: some View {
        VStack(spacing: 0) {
            if model.assembling {
                HStack(spacing: 8) {
                    ProgressView().controlSize(.small)
                    Text("Assembling")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                    Spacer()
                }
                .padding(.horizontal, 16)
                .padding(.vertical, 8)
                .background(.quaternary.opacity(0.4))
            }
            ScrollView {
                VStack(alignment: .leading, spacing: 12) {
                    ForEach(model.tree) { node in
                        NodeView(node: node)
                    }
                }
                .padding(16)
                .frame(maxWidth: .infinity, alignment: .leading)
            }
            // Drafts are display-only until the finished app takes over.
            .allowsHitTesting(!model.assembling)
            if !model.assembling {
                Divider()
                VStack(alignment: .leading, spacing: 4) {
                    HStack(spacing: 8) {
                        TextField("Change this app...", text: $model.editInstruction)
                            .textFieldStyle(.roundedBorder)
                            .onSubmit { model.sendEdit() }
                            .disabled(model.editBusy)
                        Button("Apply") { model.sendEdit() }
                            .disabled(
                                model.editBusy
                                    || model.editInstruction
                                        .trimmingCharacters(in: .whitespaces).isEmpty
                            )
                        Button {
                            model.bookmark()
                        } label: {
                            Image(systemName: model.bookmarked ? "star.fill" : "star")
                        }
                        .help("Keep in Your apps")
                        .disabled(model.bookmarked)
                        Button {
                            Outbound.shared.send([
                                "event": "openEditor", "windowId": model.windowId,
                            ])
                        } label: {
                            Image(systemName: "curlybraces.square")
                        }
                        .help("Contract and blueprint editors")
                    }
                    if let note = model.editNote {
                        HStack(spacing: 6) {
                            if model.editBusy {
                                ProgressView().controlSize(.small)
                            }
                            Text(note)
                                .font(.caption)
                                .foregroundStyle(
                                    model.editFailed
                                        ? AnyShapeStyle(.red) : AnyShapeStyle(.secondary)
                                )
                                .lineLimit(2)
                        }
                    }
                }
                .padding(.horizontal, 12)
                .padding(.vertical, 8)
            }
        }
        .environmentObject(model)
        .animation(.easeOut(duration: 0.2), value: model.assembling)
    }
}

struct NodeView: View {
    let node: ResolvedNode
    @EnvironmentObject var model: TreeModel

    var body: some View {
        switch node.type {
        case "text": TextNode(node: node)
        case "button": ButtonNode(node: node)
        case "input": InputNode(node: node)
        case "textarea": TextareaNode(node: node)
        case "checkbox": CheckboxNode(node: node)
        case "select": SelectNode(node: node)
        case "container", "form": ContainerNode(node: node)
        case "list": ListNode(node: node)
        case "timer": TimerNode(node: node)
        case "divider": Divider()
        case "progress": ProgressView()
        case "image": ImageNode(node: node)
        case "link": LinkNode(node: node)
        default: FallbackNode(node: node)
        }
    }
}

private func contentText(_ node: ResolvedNode) -> String {
    (node.prop("content") ?? node.prop("text"))?.display ?? ""
}

struct TextNode: View {
    let node: ResolvedNode

    var body: some View {
        let text = Text(contentText(node))
        let done = (node.prop("className")?.display ?? "").split(separator: " ").contains("done")
        switch node.knob("role", fallback: "body") {
        case "title": text.font(.title2).bold().strikethrough(done)
        case "subtitle": text.font(.title3).strikethrough(done)
        case "caption": text.font(.caption).foregroundStyle(.secondary).strikethrough(done)
        default: text.strikethrough(done)
        }
    }
}

struct ButtonNode: View {
    let node: ResolvedNode
    @EnvironmentObject var model: TreeModel

    var body: some View {
        let label = node.prop("text")?.display ?? contentText(node)
        let button = Button(label.isEmpty ? " " : label) {
            model.dispatch(node.events["click"] ?? [], item: node.eventItem)
        }
        switch node.knob("variant", fallback: "secondary") {
        case "primary": button.buttonStyle(.borderedProminent)
        case "danger": button.buttonStyle(.bordered).tint(.red)
        default: button.buttonStyle(.bordered)
        }
    }
}

/// Two-way control: local text pushes writes; incoming control values sync
/// back (resets included) without clobbering identical text.
struct InputNode: View {
    let node: ResolvedNode
    @EnvironmentObject var model: TreeModel
    @State private var text = ""

    var body: some View {
        let field = TextField(node.prop("placeholder")?.display ?? "", text: $text)
            .textFieldStyle(.roundedBorder)
            .onAppear { text = node.control?.value?.display ?? "" }
            .onChange(of: node.control?.value) { value in
                let incoming = value?.display ?? ""
                if incoming != text { text = incoming }
            }
            .onChange(of: text) { value in
                if value != (node.control?.value?.display ?? "") {
                    model.write(node.id, value)
                }
            }
            .onSubmit { model.dispatch(node.events["submit"] ?? [], item: node.eventItem) }
        labeled(field)
    }

    @ViewBuilder
    private func labeled(_ field: some View) -> some View {
        if let label = node.prop("label")?.stringValue, !label.isEmpty {
            VStack(alignment: .leading, spacing: 4) {
                Text(label).font(.caption).foregroundStyle(.secondary)
                field
            }
        } else {
            field
        }
    }
}

struct TextareaNode: View {
    let node: ResolvedNode
    @EnvironmentObject var model: TreeModel
    @State private var text = ""

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            if let label = node.prop("label")?.stringValue, !label.isEmpty {
                Text(label).font(.caption).foregroundStyle(.secondary)
            }
            TextEditor(text: $text)
                .frame(minHeight: 72)
                .overlay(RoundedRectangle(cornerRadius: 6).stroke(.quaternary))
                .onAppear { text = node.control?.value?.display ?? "" }
                .onChange(of: node.control?.value) { value in
                    let incoming = value?.display ?? ""
                    if incoming != text { text = incoming }
                }
                .onChange(of: text) { value in
                    if value != (node.control?.value?.display ?? "") {
                        model.write(node.id, value)
                    }
                }
        }
    }
}

struct CheckboxNode: View {
    let node: ResolvedNode
    @EnvironmentObject var model: TreeModel

    var body: some View {
        Toggle(
            node.prop("label")?.display ?? contentText(node),
            isOn: Binding(
                get: { node.control?.value?.boolValue ?? false },
                set: { value in
                    model.write(node.id, value)
                    model.dispatch(node.events["change"] ?? [], item: node.eventItem)
                }
            )
        )
        .toggleStyle(.checkbox)
    }
}

struct SelectNode: View {
    let node: ResolvedNode
    @EnvironmentObject var model: TreeModel

    private var options: [(value: String, label: String)] {
        (node.prop("options")?.arrayValue ?? []).map { option in
            if case .object(let fields) = option {
                let value = fields["value"]?.display ?? ""
                return (value, fields["label"]?.display ?? value)
            }
            return (option.display, option.display)
        }
    }

    var body: some View {
        let current = node.control?.value?.display ?? options.first?.value ?? ""
        Picker(
            node.prop("label")?.stringValue ?? "",
            selection: Binding(
                get: { current },
                set: { value in
                    model.write(node.id, value)
                    model.dispatch(node.events["change"] ?? [], item: node.eventItem)
                }
            )
        ) {
            ForEach(options, id: \.value) { option in
                Text(option.label).tag(option.value)
            }
        }
        .pickerStyle(.menu)
    }
}

struct ContainerNode: View {
    let node: ResolvedNode

    var body: some View {
        let gap = Double(node.knob("gap", fallback: "8")) ?? 8
        let padding = Double(node.knob("padding", fallback: "0")) ?? 0
        Group {
            if node.knob("direction", fallback: "row") == "column" {
                VStack(alignment: .leading, spacing: gap) { childViews }
            } else {
                HStack(alignment: rowAlignment, spacing: gap) { childViews }
            }
        }
        .padding(padding)
    }

    private var childViews: some View {
        ForEach(node.children) { child in
            NodeView(node: child)
        }
    }

    private var rowAlignment: VerticalAlignment {
        switch node.knob("align", fallback: "center") {
        case "start": return .top
        case "end": return .bottom
        default: return .center
        }
    }
}

struct ListNode: View {
    let node: ResolvedNode

    var body: some View {
        let rows = node.rows ?? []
        if rows.isEmpty {
            Text(node.prop("emptyText")?.display ?? "")
                .foregroundStyle(.secondary)
                .italic()
        } else {
            VStack(alignment: .leading, spacing: 6) {
                ForEach(rows, id: \.key) { row in
                    HStack(spacing: 8) {
                        ForEach(row.children) { child in
                            NodeView(node: child)
                        }
                        Spacer(minLength: 0)
                    }
                    .padding(.vertical, 2)
                }
            }
        }
    }
}

/// Invisible interval clock: ticks only while the node exists, which is the
/// resolver's visibility gate doing the pausing.
struct TimerNode: View {
    let node: ResolvedNode
    @EnvironmentObject var model: TreeModel

    var body: some View {
        let seconds = max(Double(node.knob("seconds", fallback: "1")) ?? 1, 0.05)
        Color.clear
            .frame(width: 0, height: 0)
            .onReceive(Timer.publish(every: seconds, on: .main, in: .common).autoconnect()) { _ in
                model.dispatch(node.events["tick"] ?? [], item: node.eventItem)
            }
    }
}

struct ImageNode: View {
    let node: ResolvedNode

    var body: some View {
        if let src = node.prop("src")?.stringValue, let url = URL(string: src) {
            AsyncImage(url: url) { image in
                image.resizable().scaledToFit()
            } placeholder: {
                ProgressView()
            }
            .frame(maxHeight: 240)
        } else {
            EmptyView()
        }
    }
}

struct LinkNode: View {
    let node: ResolvedNode

    var body: some View {
        if let href = node.prop("href")?.stringValue, let url = URL(string: href) {
            Link(contentText(node).isEmpty ? href : contentText(node), destination: url)
        } else {
            Text(contentText(node))
        }
    }
}

/// Unknown vocabulary renders its content and children rather than nothing.
struct FallbackNode: View {
    let node: ResolvedNode

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            if !contentText(node).isEmpty {
                Text(contentText(node))
            }
            ForEach(node.children) { child in
                NodeView(node: child)
            }
        }
    }
}
