// The renderer protocol: resolved view trees from the runtime core, element
// writes and event dispatches back. Shapes mirror runtime/view.rs; the test
// target decodes the committed conformance vectors to keep them honest.

import Foundation

/// Any JSON value, Codable, order-preserving enough for rendering.
public indirect enum JSONValue: Codable, Equatable, Sendable {
    case null
    case bool(Bool)
    case number(Double)
    case string(String)
    case array([JSONValue])
    case object([String: JSONValue])

    public init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        if container.decodeNil() {
            self = .null
        } else if let value = try? container.decode(Bool.self) {
            self = .bool(value)
        } else if let value = try? container.decode(Double.self) {
            self = .number(value)
        } else if let value = try? container.decode(String.self) {
            self = .string(value)
        } else if let value = try? container.decode([JSONValue].self) {
            self = .array(value)
        } else {
            self = .object(try container.decode([String: JSONValue].self))
        }
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        switch self {
        case .null: try container.encodeNil()
        case .bool(let value): try container.encode(value)
        case .number(let value): try container.encode(value)
        case .string(let value): try container.encode(value)
        case .array(let value): try container.encode(value)
        case .object(let value): try container.encode(value)
        }
    }

    public var stringValue: String? {
        if case .string(let value) = self { return value }
        return nil
    }

    public var boolValue: Bool? {
        if case .bool(let value) = self { return value }
        return nil
    }

    public var numberValue: Double? {
        if case .number(let value) = self { return value }
        return nil
    }

    public var arrayValue: [JSONValue]? {
        if case .array(let value) = self { return value }
        return nil
    }

    /// The display form of a bound value, JavaScript-flavored: integral
    /// numbers print without a decimal part.
    public var display: String {
        switch self {
        case .null: return ""
        case .bool(let value): return value ? "true" : "false"
        case .number(let value):
            if value.truncatingRemainder(dividingBy: 1) == 0, abs(value) < 1e15 {
                return String(Int64(value))
            }
            return String(value)
        case .string(let value): return value
        case .array(let value): return value.map(\.display).joined(separator: ",")
        case .object: return "[object Object]"
        }
    }
}

public struct ResolvedControl: Codable, Equatable, Sendable {
    public let kind: String
    public let value: JSONValue?
}

public struct ResolvedRow: Codable, Equatable, Sendable {
    public let key: String
    public let item: JSONValue?
    public let children: [ResolvedNode]
}

public struct ResolvedNode: Codable, Equatable, Sendable, Identifiable {
    public let id: String
    public let type: String
    public let props: [String: JSONValue]
    public let events: [String: [String]]
    public let eventItem: JSONValue?
    public let control: ResolvedControl?
    public let children: [ResolvedNode]
    public let rows: [ResolvedRow]?

    enum CodingKeys: String, CodingKey {
        case id, type, props, events, eventItem, control, children, rows
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        id = try container.decodeIfPresent(String.self, forKey: .id) ?? ""
        type = try container.decodeIfPresent(String.self, forKey: .type) ?? ""
        props = try container.decodeIfPresent([String: JSONValue].self, forKey: .props) ?? [:]
        events = try container.decodeIfPresent([String: [String]].self, forKey: .events) ?? [:]
        eventItem = try container.decodeIfPresent(JSONValue.self, forKey: .eventItem)
        control = try container.decodeIfPresent(ResolvedControl.self, forKey: .control)
        children = try container.decodeIfPresent([ResolvedNode].self, forKey: .children) ?? []
        rows = try container.decodeIfPresent([ResolvedRow].self, forKey: .rows)
    }

    public func prop(_ name: String) -> JSONValue? {
        props[name]
    }

    public func knob(_ name: String, fallback: String) -> String {
        props[name]?.display ?? fallback
    }
}

public struct HomeBookmark: Decodable, Sendable, Identifiable {
    public let id: String
    public let name: String
}

/// One inbound line from the runtime core.
public struct InboundMessage: Decodable, Sendable {
    public let cmd: String
    public let windowId: String?
    public let title: String?
    public let theme: String?
    public let tree: [ResolvedNode]?
    public let operationId: String?
    public let bookmarks: [HomeBookmark]?
}
