// The panel's protocol types decode every committed view vector: the same
// trees the Rust and TypeScript resolvers are held to. A vector this decoder
// cannot represent is a protocol gap, caught here instead of at render time.

import Foundation
import XCTest
@testable import DerNativePanel

final class ProtocolTests: XCTestCase {
    private func fixtureData(_ name: String) throws -> Data {
        var url = URL(fileURLWithPath: #filePath)
        for _ in 0..<5 { url.deleteLastPathComponent() }
        url.appendPathComponent("runtime-conformance/\(name)")
        return try Data(contentsOf: url)
    }

    func testDecodesEveryCommittedViewVector() throws {
        struct ViewVector: Decodable {
            let name: String
            let expected: [ResolvedNode]
        }
        struct Fixtures: Decodable { let views: [ViewVector] }

        let fixtures = try JSONDecoder().decode(Fixtures.self, from: fixtureData("views.json"))
        XCTAssertGreaterThan(fixtures.views.count, 5)
        for vector in fixtures.views {
            XCTAssertFalse(vector.expected.isEmpty || vector.name.isEmpty)
        }

        let listVector = fixtures.views.first { $0.name.hasPrefix("list rows") }
        let rows = try XCTUnwrap(listVector?.expected.first?.rows)
        XCTAssertEqual(rows.map(\.key), ["a", "null", "2"])
        XCTAssertEqual(rows[0].children.first?.props["content"]?.display, "Bolt")

        let events = fixtures.views.first { $0.name.hasPrefix("events") }
        let button = try XCTUnwrap(events?.expected.first)
        XCTAssertEqual(button.events["click"], ["op-first", "op-second"])
    }

    func testDisplayFormsAreJavaScriptFlavored() {
        XCTAssertEqual(JSONValue.number(3.0).display, "3")
        XCTAssertEqual(JSONValue.number(12.5).display, "12.5")
        XCTAssertEqual(JSONValue.bool(true).display, "true")
        XCTAssertEqual(JSONValue.null.display, "")
        XCTAssertEqual(
            JSONValue.array([.number(1), .null, .string("x")]).display,
            "1,,x"
        )
    }
}
