// SwiftUI rendering of a resolved tree. Semantics arrived fully computed:
// visibility is applied, bindings are values, rows are expanded; this file
// only maps the element vocabulary and its knobs onto native controls.

import AVKit
import Charts
import PDFKit
import SwiftUI

@MainActor
final class TreeModel: ObservableObject {
    let windowId: String
    @Published var tree: [ResolvedNode]
    @Published var assembling: Bool
    @Published var theme: String?
    @Published var accent: String?
    @Published var background: String?
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

    /// A free-form background hex parsed into channels; drives the whole
    /// derived palette when present.
    private var backgroundChannels: (r: Double, g: Double, b: Double)? {
        guard let background, background.count == 7, background.hasPrefix("#"),
              let value = UInt32(background.dropFirst(), radix: 16) else { return nil }
        return (
            Double((value >> 16) & 0xff) / 255.0,
            Double((value >> 8) & 0xff) / 255.0,
            Double(value & 0xff) / 255.0
        )
    }

    var backgroundIsDark: Bool {
        guard let rgb = backgroundChannels else {
            return theme == "dark" || theme == "terminal"
        }
        return (rgb.r * 299 + rgb.g * 587 + rgb.b * 114) / 1000 < 0.57
    }

    /// Steps the background toward black (light bg) or white (dark bg): the
    /// same derivation the webview computes into CSS variables.
    private func steppedSurface(_ amount: Double) -> Color? {
        guard let rgb = backgroundChannels else { return nil }
        let target: Double = backgroundIsDark ? 1.0 : 0.0
        func mix(_ channel: Double) -> Double { channel + (target - channel) * amount }
        return Color(red: mix(rgb.r), green: mix(rgb.g), blue: mix(rgb.b))
    }

    /// A subtle themed surface behind the content.
    var backgroundColor: Color? {
        if let rgb = backgroundChannels {
            return Color(red: rgb.r, green: rgb.g, blue: rgb.b)
        }
        switch theme {
        case "paper": return Color(red: 0.98, green: 0.955, blue: 0.90)
        case "terminal": return Color(red: 0.04, green: 0.07, blue: 0.05)
        case "dark": return Color(red: 0.11, green: 0.11, blue: 0.125)
        default: return nil
        }
    }

    /// Raised panel color for card surfaces.
    var surfaceColor: Color {
        if let stepped = steppedSurface(0.07) { return stepped }
        switch theme {
        case "paper": return Color(red: 0.955, green: 0.925, blue: 0.85)
        case "terminal": return Color(red: 0.07, green: 0.11, blue: 0.08)
        case "dark": return Color(red: 0.15, green: 0.155, blue: 0.175)
        default: return Color(nsColor: .controlBackgroundColor).opacity(0.6)
        }
    }

    var borderColor: Color {
        if let stepped = steppedSurface(0.2) { return stepped }
        switch theme {
        case "paper": return Color(red: 0.85, green: 0.80, blue: 0.70)
        case "terminal": return Color(red: 0.17, green: 0.28, blue: 0.19)
        case "dark": return Color(white: 0.28)
        default: return Color(nsColor: .separatorColor)
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
        case "chart": ChartNode(node: node)
        case "pdf": PdfNode(node: node)
        case "video": VideoNode(node: node)
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
    @EnvironmentObject var model: TreeModel

    var body: some View {
        let done = (node.prop("className")?.display ?? "").split(separator: " ").contains("done")
        styledByRole(Text(contentText(node)))
            .strikethrough(done)
            .foregroundStyle(toneStyle)
    }

    private func styledByRole(_ text: Text) -> Text {
        switch node.knob("role", fallback: "body") {
        case "title": return text.font(.title2).bold()
        case "subtitle": return text.font(.title3)
        case "caption": return text.font(.caption)
        default: return text
        }
    }

    private var toneStyle: AnyShapeStyle {
        switch node.knob("tone", fallback: "default") {
        case "accent": return AnyShapeStyle(model.accentColor ?? .accentColor)
        case "muted": return AnyShapeStyle(.secondary)
        case "danger": return AnyShapeStyle(.red)
        default:
            return node.knob("role", fallback: "body") == "caption"
                ? AnyShapeStyle(.secondary)
                : AnyShapeStyle(.primary)
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
    @EnvironmentObject var model: TreeModel

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
        .modifier(SurfaceModifier(kind: node.knob("surface", fallback: "plain"), model: model))
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

/// The surface knob: cards raise a group on the theme's panel color; accent
/// panels tint it with the app accent, both faces alike.
struct SurfaceModifier: ViewModifier {
    let kind: String
    let model: TreeModel

    func body(content: Content) -> some View {
        switch kind {
        case "card":
            content
                .padding(12)
                .background(
                    RoundedRectangle(cornerRadius: 8)
                        .fill(model.surfaceColor)
                        .overlay(
                            RoundedRectangle(cornerRadius: 8).stroke(model.borderColor)
                        )
                )
        case "accent":
            let accent = model.accentColor ?? .accentColor
            content
                .padding(12)
                .background(
                    RoundedRectangle(cornerRadius: 8)
                        .fill(accent.opacity(0.14))
                        .overlay(RoundedRectangle(cornerRadius: 8).stroke(accent.opacity(0.6)))
                )
        default:
            content
        }
    }
}

struct ListNode: View {
    let node: ResolvedNode
    @EnvironmentObject var model: TreeModel

    var body: some View {
        let rows = node.rows ?? []
        if rows.isEmpty {
            Text(node.prop("emptyText")?.display ?? "")
                .foregroundStyle(.secondary)
                .italic()
        } else {
            VStack(alignment: .leading, spacing: 0) {
                ForEach(Array(rows.enumerated()), id: \.element.key) { index, row in
                    HStack(spacing: 8) {
                        ForEach(row.children) { child in
                            NodeView(node: child)
                        }
                        Spacer(minLength: 0)
                    }
                    .padding(.vertical, 6)
                    if index < rows.count - 1 {
                        Rectangle()
                            .fill(model.borderColor.opacity(0.6))
                            .frame(height: 1)
                    }
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

/// Models route converter output (raw base64) straight into image src;
/// recognize the common formats and synthesize the data URL.
private func imageSource(_ src: String) -> URL? {
    if src.isEmpty { return nil }
    if src.contains(":") { return URL(string: src) }
    let magic: [(String, String)] = [
        ("iVBOR", "image/png"),
        ("/9j/", "image/jpeg"),
        ("R0lGOD", "image/gif"),
        ("UklGR", "image/webp"),
        ("Qk", "image/bmp"),
    ]
    for (prefix, mime) in magic where src.hasPrefix(prefix) {
        return URL(string: "data:\(mime);base64,\(src)")
    }
    return URL(string: src)
}

struct ImageNode: View {
    let node: ResolvedNode

    var body: some View {
        if let src = node.prop("src")?.stringValue, let url = imageSource(src) {
            AsyncImage(url: url) { image in
                image.resizable().scaledToFit()
            } placeholder: {
                ProgressView()
            }
            .frame(maxHeight: 320)
        } else {
            EmptyView()
        }
    }
}

/// Bar or line chart over an array of objects, via Swift Charts.
struct ChartNode: View {
    let node: ResolvedNode
    @EnvironmentObject var model: TreeModel

    private struct Point: Identifiable {
        let id: Int
        let label: String
        let value: Double
    }

    private var points: [Point] {
        let xField = node.prop("x")?.stringValue ?? "key"
        let yField = node.prop("y")?.stringValue ?? "sum"
        let rows = node.prop("data")?.arrayValue ?? []
        return rows.enumerated().compactMap { index, row in
            guard case .object(let fields) = row else { return nil }
            let label = fields[xField]?.display ?? ""
            let value = fields[yField].flatMap { $0.numberValue } ?? 0
            return Point(id: index, label: label, value: value)
        }
    }

    var body: some View {
        let data = points
        if data.isEmpty {
            ViewerEmpty(text: node.prop("emptyText")?.stringValue ?? "No data yet")
        } else {
            Chart(data) { point in
                if node.knob("kind", fallback: "bar") == "line" {
                    LineMark(
                        x: .value("Label", point.label),
                        y: .value("Value", point.value)
                    )
                    .interpolationMethod(.catmullRom)
                } else {
                    BarMark(
                        x: .value("Label", point.label),
                        y: .value("Value", point.value)
                    )
                    .cornerRadius(3)
                }
            }
            .foregroundStyle(model.accentColor ?? .accentColor)
            .frame(height: 180)
        }
    }
}

/// Placeholder shown by viewer elements before a file is opened.
struct ViewerEmpty: View {
    let text: String
    @EnvironmentObject var model: TreeModel

    var body: some View {
        Text(text)
            .font(.callout)
            .foregroundStyle(.secondary)
            .frame(maxWidth: .infinity, minHeight: 120)
            .background(
                RoundedRectangle(cornerRadius: 8)
                    .stroke(model.borderColor, style: StrokeStyle(lineWidth: 1, dash: [5]))
            )
    }
}

private struct PdfKitView: NSViewRepresentable {
    let url: URL

    func makeNSView(context: Context) -> PDFView {
        let view = PDFView()
        view.autoScales = true
        view.document = PDFDocument(url: url)
        return view
    }

    func updateNSView(_ view: PDFView, context: Context) {
        if view.document?.documentURL != url {
            view.document = PDFDocument(url: url)
        }
    }
}

struct PdfNode: View {
    let node: ResolvedNode

    var body: some View {
        if let src = node.prop("src")?.stringValue, !src.isEmpty, let url = URL(string: src) {
            PdfKitView(url: url)
                .frame(minHeight: 420)
        } else {
            ViewerEmpty(text: node.prop("emptyText")?.stringValue ?? "Open a PDF to view it")
        }
    }
}

struct VideoNode: View {
    let node: ResolvedNode
    @State private var player: AVPlayer?
    @State private var currentSrc = ""

    var body: some View {
        let src = node.prop("src")?.stringValue ?? ""
        if src.isEmpty {
            ViewerEmpty(text: node.prop("emptyText")?.stringValue ?? "Open a video to play it")
        } else {
            VideoPlayer(player: player)
                .frame(minHeight: 280)
                .onAppear { syncPlayer(src) }
                .onChange(of: src) { value in syncPlayer(value) }
        }
    }

    private func syncPlayer(_ src: String) {
        guard src != currentSrc, let url = URL(string: src) else { return }
        currentSrc = src
        player = AVPlayer(url: url)
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
