// Stdio plumbing: newline-delimited JSON in from the runtime core, events
// out. The panel is a pure view; every message it sends describes a user
// action, never a semantic decision.

import Foundation

/// Serialized writer to stdout; the reader thread and UI both send through it.
public final class Outbound: @unchecked Sendable {
    public static let shared = Outbound()
    private let lock = NSLock()
    private let handle = FileHandle.standardOutput

    public func send(_ payload: [String: Any]) {
        guard JSONSerialization.isValidJSONObject(payload),
              let data = try? JSONSerialization.data(withJSONObject: payload)
        else { return }
        lock.lock()
        defer { lock.unlock() }
        handle.write(data)
        handle.write(Data([0x0A]))
    }

    public func dispatch(windowId: String, operationIds: [String], item: JSONValue?) {
        var payload: [String: Any] = [
            "event": "dispatch",
            "windowId": windowId,
            "operationIds": operationIds,
        ]
        if let item, let encoded = item.foundationObject {
            payload["item"] = encoded
        }
        send(payload)
    }

    public func setElement(windowId: String, elementId: String, value: Any) {
        send([
            "event": "setElement",
            "windowId": windowId,
            "elementId": elementId,
            "value": value,
        ])
    }

    public func windowClosed(windowId: String) {
        send(["event": "windowClosed", "windowId": windowId])
    }
}

extension JSONValue {
    /// Foundation form for JSONSerialization when echoing values back.
    var foundationObject: Any? {
        switch self {
        case .null: return NSNull()
        case .bool(let value): return value
        case .number(let value): return value
        case .string(let value): return value
        case .array(let value): return value.compactMap { $0.foundationObject }
        case .object(let value): return value.compactMapValues { $0.foundationObject }
        }
    }
}

/// Reads stdin lines off the main thread and hands decoded messages to the
/// UI. EOF means the core is gone and the panel exits.
public func pumpInbound(onMessage: @escaping @Sendable (InboundMessage) -> Void) {
    Thread.detachNewThread {
        let decoder = JSONDecoder()
        while let line = readLine(strippingNewline: true) {
            guard !line.isEmpty, let data = line.data(using: .utf8) else { continue }
            guard let message = try? decoder.decode(InboundMessage.self, from: data) else {
                Outbound.shared.send(["event": "log", "message": "undecodable message"])
                continue
            }
            onMessage(message)
        }
        DispatchQueue.main.async { exit(0) }
    }
}
