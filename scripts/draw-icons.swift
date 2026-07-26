// Renders the DER app icon at every required size. The mark: three part
// tiles already composed and a fourth snapping into place, on a deep
// surface with the violet-to-cyan accent range.

import AppKit
import CoreGraphics

func drawIcon(size: CGFloat) -> CGImage? {
    let scale = size / 1024.0
    guard let ctx = CGContext(
        data: nil,
        width: Int(size),
        height: Int(size),
        bitsPerComponent: 8,
        bytesPerRow: 0,
        space: CGColorSpace(name: CGColorSpace.sRGB)!,
        bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
    ) else { return nil }
    ctx.scaleBy(x: scale, y: scale)

    // macOS-style full-bleed rounded square.
    let bgRect = CGRect(x: 0, y: 0, width: 1024, height: 1024)
    let bgPath = CGPath(roundedRect: bgRect, cornerWidth: 229, cornerHeight: 229, transform: nil)
    ctx.addPath(bgPath)
    ctx.clip()

    // Vertical surface gradient: deep indigo night.
    let bgColors = [
        CGColor(red: 0.145, green: 0.153, blue: 0.235, alpha: 1.0),
        CGColor(red: 0.055, green: 0.06, blue: 0.11, alpha: 1.0),
    ] as CFArray
    let space = CGColorSpace(name: CGColorSpace.sRGB)!
    if let gradient = CGGradient(colorsSpace: space, colors: bgColors, locations: [0.0, 1.0]) {
        ctx.drawLinearGradient(
            gradient,
            start: CGPoint(x: 512, y: 1024),
            end: CGPoint(x: 512, y: 0),
            options: []
        )
    }

    // A faint accent bloom behind the tiles.
    if let glow = CGGradient(
        colorsSpace: space,
        colors: [
            CGColor(red: 0.35, green: 0.3, blue: 0.9, alpha: 0.35),
            CGColor(red: 0.35, green: 0.3, blue: 0.9, alpha: 0.0),
        ] as CFArray,
        locations: [0.0, 1.0]
    ) {
        ctx.drawRadialGradient(
            glow,
            startCenter: CGPoint(x: 512, y: 540),
            startRadius: 0,
            endCenter: CGPoint(x: 512, y: 540),
            endRadius: 520,
            options: []
        )
    }

    // The 2x2 tile grid, centered; cell geometry.
    let tile: CGFloat = 300
    let gap: CGFloat = 56
    let originX = (1024 - tile * 2 - gap) / 2
    let originY = (1024 - tile * 2 - gap) / 2
    let corner: CGFloat = 68

    func tileRect(_ column: Int, _ row: Int) -> CGRect {
        CGRect(
            x: originX + CGFloat(column) * (tile + gap),
            y: originY + CGFloat(row) * (tile + gap),
            width: tile,
            height: tile
        )
    }

    func fillTile(_ rect: CGRect, from: CGColor, to: CGColor, rotation: CGFloat = 0) {
        ctx.saveGState()
        if rotation != 0 {
            let center = CGPoint(x: rect.midX, y: rect.midY)
            ctx.translateBy(x: center.x, y: center.y)
            ctx.rotate(by: rotation)
            ctx.translateBy(x: -center.x, y: -center.y)
        }
        ctx.setShadow(
            offset: CGSize(width: 0, height: -14),
            blur: 46,
            color: CGColor(red: 0, green: 0, blue: 0, alpha: 0.45)
        )
        let path = CGPath(roundedRect: rect, cornerWidth: corner, cornerHeight: corner, transform: nil)
        ctx.addPath(path)
        ctx.clip()
        if let gradient = CGGradient(
            colorsSpace: space, colors: [from, to] as CFArray, locations: [0.0, 1.0]
        ) {
            ctx.drawLinearGradient(
                gradient,
                start: CGPoint(x: rect.minX, y: rect.maxY),
                end: CGPoint(x: rect.maxX, y: rect.minY),
                options: [.drawsBeforeStartLocation, .drawsAfterEndLocation]
            )
        }
        // Top edge highlight.
        ctx.setFillColor(CGColor(red: 1, green: 1, blue: 1, alpha: 0.14))
        ctx.fill(CGRect(x: rect.minX, y: rect.maxY - 10, width: rect.width, height: 10))
        ctx.restoreGState()
    }

    // Three tiles in place: violet, indigo, cyan.
    fillTile(
        tileRect(0, 1),
        from: CGColor(red: 0.42, green: 0.2, blue: 0.9, alpha: 1),
        to: CGColor(red: 0.55, green: 0.36, blue: 0.98, alpha: 1)
    )
    fillTile(
        tileRect(1, 1),
        from: CGColor(red: 0.27, green: 0.28, blue: 0.9, alpha: 1),
        to: CGColor(red: 0.38, green: 0.45, blue: 0.98, alpha: 1)
    )
    fillTile(
        tileRect(0, 0),
        from: CGColor(red: 0.02, green: 0.55, blue: 0.72, alpha: 1),
        to: CGColor(red: 0.1, green: 0.72, blue: 0.88, alpha: 1)
    )

    // The fourth slot: a faint socket outline waiting.
    let slot = tileRect(1, 0)
    ctx.saveGState()
    let slotPath = CGPath(
        roundedRect: slot.insetBy(dx: 8, dy: 8),
        cornerWidth: corner - 8,
        cornerHeight: corner - 8,
        transform: nil
    )
    ctx.addPath(slotPath)
    ctx.setStrokeColor(CGColor(red: 1, green: 1, blue: 1, alpha: 0.18))
    ctx.setLineWidth(10)
    ctx.setLineDash(phase: 0, lengths: [34, 26])
    ctx.strokePath()
    ctx.restoreGState()

    // The arriving tile: bright cyan, offset toward the corner, rotated.
    let arriving = slot.offsetBy(dx: 64, dy: 64)
    fillTile(
        arriving,
        from: CGColor(red: 0.06, green: 0.74, blue: 0.93, alpha: 1),
        to: CGColor(red: 0.3, green: 0.9, blue: 1.0, alpha: 1),
        rotation: -0.16
    )

    return ctx.makeImage()
}

func writePng(_ image: CGImage, to path: String) {
    let rep = NSBitmapImageRep(cgImage: image)
    guard let data = rep.representation(using: .png, properties: [:]) else { return }
    try? data.write(to: URL(fileURLWithPath: path))
}

let iconsetPath = CommandLine.arguments[1]
try? FileManager.default.createDirectory(
    atPath: iconsetPath, withIntermediateDirectories: true
)
let sizes: [(name: String, px: CGFloat)] = [
    ("icon_16x16", 16), ("icon_16x16@2x", 32),
    ("icon_32x32", 32), ("icon_32x32@2x", 64),
    ("icon_128x128", 128), ("icon_128x128@2x", 256),
    ("icon_256x256", 256), ("icon_256x256@2x", 512),
    ("icon_512x512", 512), ("icon_512x512@2x", 1024),
]
for entry in sizes {
    if let image = drawIcon(size: entry.px) {
        writePng(image, to: "\(iconsetPath)/\(entry.name).png")
    }
}
print("iconset written")

// The menu bar template glyph: the logo as line art. Template images render
// from alpha alone, so the mark is black strokes on transparency.
func drawTrayGlyph(size: CGFloat) -> CGImage? {
    let scale = size / 88.0
    guard let ctx = CGContext(
        data: nil,
        width: Int(size),
        height: Int(size),
        bitsPerComponent: 8,
        bytesPerRow: 0,
        space: CGColorSpace(name: CGColorSpace.sRGB)!,
        bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
    ) else { return nil }
    ctx.scaleBy(x: scale, y: scale)
    ctx.setStrokeColor(CGColor(red: 0, green: 0, blue: 0, alpha: 1))
    ctx.setLineWidth(7)

    let tile: CGFloat = 30
    let gap: CGFloat = 10
    let originX = (88 - tile * 2 - gap) / 2
    let originY = (88 - tile * 2 - gap) / 2
    let corner: CGFloat = 8

    func tileRect(_ column: Int, _ row: Int) -> CGRect {
        CGRect(
            x: originX + CGFloat(column) * (tile + gap),
            y: originY + CGFloat(row) * (tile + gap),
            width: tile,
            height: tile
        )
    }

    func strokeTile(_ rect: CGRect, rotation: CGFloat = 0) {
        ctx.saveGState()
        if rotation != 0 {
            let center = CGPoint(x: rect.midX, y: rect.midY)
            ctx.translateBy(x: center.x, y: center.y)
            ctx.rotate(by: rotation)
            ctx.translateBy(x: -center.x, y: -center.y)
        }
        let path = CGPath(
            roundedRect: rect.insetBy(dx: 3.5, dy: 3.5),
            cornerWidth: corner,
            cornerHeight: corner,
            transform: nil
        )
        ctx.addPath(path)
        ctx.strokePath()
        ctx.restoreGState()
    }

    strokeTile(tileRect(0, 0))
    strokeTile(tileRect(0, 1))
    strokeTile(tileRect(1, 1))
    strokeTile(tileRect(1, 0).offsetBy(dx: 7, dy: 7), rotation: -0.16)

    return ctx.makeImage()
}

if CommandLine.arguments.count > 2 {
    let trayPath = CommandLine.arguments[2]
    if let glyph = drawTrayGlyph(size: 88) {
        writePng(glyph, to: trayPath)
    }
    print("tray glyph written")
}
