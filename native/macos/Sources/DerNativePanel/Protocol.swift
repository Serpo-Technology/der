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
    /// Minutes between background refresh beats; nil or 0 is off.
    public let backgroundMinutes: Int?
}

public struct HomeRecipe: Decodable, Sendable, Identifiable {
    public let name: String
    public let title: String
    public let description: String?
    public var id: String { name }
}

public struct HomeRecent: Decodable, Sendable, Identifiable {
    public let id: String
    public let name: String
    public let description: String?
}

public struct LlmSettingsShape: Decodable, Sendable {
    public let provider: String
    public let model: String
    public let baseUrl: String?
    public let temperature: Double?
    public let maxTokens: Double?
}

public struct ClaudeOauthShape: Decodable, Sendable {
    public let signedIn: Bool
    public let hasRefreshToken: Bool
    public let tokenPreview: String
}

public struct SettingsViewShape: Decodable, Sendable {
    public let settings: LlmSettingsShape
    public let providers: [String]
    public let apiKeys: [String: String]
    public let claudeOauth: ClaudeOauthShape?
}

public struct IntegrationShape: Decodable, Sendable, Identifiable {
    public let name: String
    public let kind: String
    public let target: String?
    public let baseUrl: String?
    public let notes: String?
    public var id: String { name }
}

public struct SmtpShape: Decodable, Sendable {
    public let host: String
    public let port: Int?
    public let username: String
    public let hasPassword: Bool
    public let security: String
    public let from: String
    public let imapHost: String?
    public let imapPort: Int?
}

public struct PartOperationShape: Decodable, Sendable, Identifiable {
    public let name: String?
    public let description: String?
    public var id: String { name ?? "" }
}

public struct PartRecipeShape: Decodable, Sendable, Identifiable {
    public let name: String
    public let title: String?
    public let description: String?
    public let available: Bool?
    public var id: String { name }
}

public struct PartServiceCredentialShape: Decodable, Sendable, Identifiable {
    public let name: String
    public let kind: String?
    public let label: String?
    public var id: String { name }
}

public struct PartServiceShape: Decodable, Sendable {
    public let baseUrl: String?
    public let credentials: [PartServiceCredentialShape]?
    public let saved: [String]?
}

public struct InstalledPartShape: Decodable, Sendable, Identifiable {
    public let id: String
    public let name: String?
    public let version: String?
    public let publisher: String?
    public let description: String?
    public let operations: [PartOperationShape]?
    public let fragments: [String]?
    public let recipes: [PartRecipeShape]?
    public let fingerprintGrouped: String?
    public let service: PartServiceShape?
}

public struct RegistryEntryShape: Decodable, Sendable, Identifiable {
    public let id: String
    public let name: String?
    public let version: String?
    public let publisher: String?
    public let description: String?
    public let bundleUrl: String?
    public let installedVersion: String?
    public let updateAvailable: Bool?
}

public struct StageReviewShape: Decodable, Sendable {
    public let stagingToken: String
    public let id: String
    public let name: String
    public let version: String
    public let publisher: String
    public let description: String
    public let namespace: String
    public let capabilities: [String]?
    public let operations: [PartOperationShape]?
    public let recipes: [PartRecipeShape]?
    public let fingerprint: String
    public let fingerprintGrouped: String
    public let publisherStatus: String
    public let isDowngrade: Bool
}

/// One inbound line from the runtime core.
public struct InboundMessage: Decodable, Sendable {
    public let cmd: String
    public let windowId: String?
    public let title: String?
    public let theme: String?
    public let accent: String?
    public let background: String?
    /// File dialog requests the panel presents for the core.
    public let requestId: String?
    public let kind: String?
    public let tree: [ResolvedNode]?
    public let operationId: String?
    public let bookmarks: [HomeBookmark]?
    public let recipes: [HomeRecipe]?
    public let recents: [HomeRecent]?
    public let status: String?
    public let message: String?
    /// Streaming assembly: the tree is a growing draft; interaction waits.
    public let assembling: Bool?
    /// Home refreshes leave focus alone; explicit opens raise the window.
    public let raise: Bool?
    // Editor snapshots.
    public let experienceId: String?
    public let name: String?
    public let contractJson: String?
    public let blueprintJson: String?
    public let errors: [String]?
    public let warnings: [String]?
    // Management snapshots.
    public let view: SettingsViewShape?
    public let integrations: [IntegrationShape]?
    public let smtp: SmtpShape?
    /// Prefill for the mailAccount dialog request.
    public let account: SmtpShape?
    public let authorizeUrl: String?
    public let note: String?
    public let noteKind: String?
    public let installed: [InstalledPartShape]?
    public let registryUrl: String?
    public let registry: [RegistryEntryShape]?
    public let review: StageReviewShape?
}
