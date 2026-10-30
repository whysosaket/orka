// Inset the original artwork for macOS without modifying the source PNGs.
import CoreGraphics
import Foundation
import ImageIO

let arguments = CommandLine.arguments
guard arguments.count == 3 else {
    fatalError("Usage: render-app-icon.swift <source-icons> <output-iconset>")
}
let source = URL(fileURLWithPath: arguments[1], isDirectory: true)
let output = URL(fileURLWithPath: arguments[2], isDirectory: true)
let layers: [(Int, String, String)] = [
    (16, "32x32.png", "icon_16x16.png"),
    (32, "32x32.png", "icon_32x32.png"),
    (64, "128x128.png", "icon_32x32@2x.png"),
    (128, "128x128.png", "icon_128x128.png"),
    (256, "128x128@2x.png", "icon_256x256.png"),
    (512, "icon.png", "icon_512x512.png"),
]

for (size, sourceName, outputName) in layers {
    guard let imageSource = CGImageSourceCreateWithURL(source.appendingPathComponent(sourceName) as CFURL, nil),
          let image = CGImageSourceCreateImageAtIndex(imageSource, 0, nil),
          let colorSpace = CGColorSpace(name: CGColorSpace.sRGB),
          let context = CGContext(data: nil, width: size, height: size, bitsPerComponent: 8,
                                  bytesPerRow: size * 4, space: colorSpace,
                                  bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else {
        fatalError("Could not render \(sourceName)")
    }

    // Match the approximately 80% artwork footprint of neighboring Dock icons.
    // Round the inset to whole pixels so every output is centered and symmetric.
    let inset = CGFloat((Double(size) * 0.1).rounded())
    let extent = CGFloat(size)
    context.clear(CGRect(x: 0, y: 0, width: extent, height: extent))
    context.interpolationQuality = .high
    context.draw(image, in: CGRect(x: inset, y: inset,
                                  width: extent - 2 * inset, height: extent - 2 * inset))

    guard let result = context.makeImage(),
          let destination = CGImageDestinationCreateWithURL(output.appendingPathComponent(outputName) as CFURL,
                                                            "public.png" as CFString, 1, nil) else {
        fatalError("Could not create \(outputName)")
    }
    CGImageDestinationAddImage(destination, result, nil)
    guard CGImageDestinationFinalize(destination) else {
        fatalError("Could not save \(outputName)")
    }
}
