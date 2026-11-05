import Foundation
import Vision
import PDFKit
import ImageIO
import CoreGraphics

struct Input: Decodable { let path: String; let kind: String; let ocr: Bool }
func recognize(_ image: CGImage) throws -> String {
    let request = VNRecognizeTextRequest()
    request.recognitionLevel = .accurate
    request.usesLanguageCorrection = true
    let supported = try request.supportedRecognitionLanguages()
    let languages = ["ko-KR", "en-US"].filter { supported.contains($0) }
    if !languages.isEmpty { request.recognitionLanguages = languages }
    request.automaticallyDetectsLanguage = true
    try VNImageRequestHandler(cgImage: image).perform([request])
    return (request.results ?? []).compactMap { $0.topCandidates(1).first?.string }.joined(separator: "\n")
}
func pixels(_ image: CGImage, width: Int, height: Int) throws -> [UInt8] {
    var bytes = [UInt8](repeating: 255, count: width * height * 4)
    try bytes.withUnsafeMutableBytes { pointer in
        guard let context = CGContext(data: pointer.baseAddress, width: width, height: height, bitsPerComponent: 8,
            bytesPerRow: width * 4, space: CGColorSpaceCreateDeviceRGB(),
            bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue | CGBitmapInfo.byteOrder32Big.rawValue) else {
            throw NSError(domain: "AFO", code: 1, userInfo: [NSLocalizedDescriptionKey: "이미지 픽셀을 읽지 못했습니다."])
        }
        context.setFillColor(CGColor(gray: 1, alpha: 1)); context.fill(CGRect(x: 0, y: 0, width: width, height: height))
        context.interpolationQuality = .medium
        context.draw(image, in: CGRect(x: 0, y: 0, width: width, height: height))
    }
    return bytes
}
func gray(_ bytes: [UInt8], _ index: Int) -> Double {
    return Double(bytes[index * 4]) * 0.299 + Double(bytes[index * 4 + 1]) * 0.587 + Double(bytes[index * 4 + 2]) * 0.114
}
func hex(_ value: UInt64) -> String { String(format: "%016llx", value) }

func inspect(_ input: Input) throws -> [String: Any] {
    let url = URL(fileURLWithPath: input.path)
    if input.kind == "pdf" {
        guard let document = PDFDocument(url: url), !document.isLocked else {
            throw NSError(domain: "AFO", code: 2, userInfo: [NSLocalizedDescriptionKey: "잠겼거나 읽을 수 없는 PDF입니다."])
        }
        let maxPages = input.ocr ? 6 : 12
        var parts: [String] = []
        var didOCR = false
        for index in 0..<min(document.pageCount, maxPages) {
            guard let page = document.page(at: index) else { continue }
            var text = page.string ?? ""
            if input.ocr && text.trimmingCharacters(in: .whitespacesAndNewlines).count < 8 {
                let image = page.thumbnail(of: CGSize(width: 1500, height: 1500), for: .mediaBox)
                if let cgImage = image.cgImage(forProposedRect: nil, context: nil, hints: nil) {
                    text = try recognize(cgImage); didOCR = true
                }
            }
            parts.append(text)
        }
        return ["text": String(parts.joined(separator: "\n").prefix(200_000)), "method": didOCR ? "apple-vision-pdf-ocr" : "pdfkit-text",
            "limited": document.pageCount > maxPages, "pages": min(document.pageCount, maxPages)]
    }
    guard let source = CGImageSourceCreateWithURL(url as CFURL, nil),
        let properties = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any],
        let width = (properties[kCGImagePropertyPixelWidth] as? NSNumber)?.intValue,
        let height = (properties[kCGImagePropertyPixelHeight] as? NSNumber)?.intValue, width > 0, height > 0 else {
        throw NSError(domain: "AFO", code: 3, userInfo: [NSLocalizedDescriptionKey: "이 이미지 형식을 해독할 OS 코덱이 없습니다."])
    }
    guard Double(width) * Double(height) <= 80_000_000 else {
        throw NSError(domain: "AFO", code: 4, userInfo: [NSLocalizedDescriptionKey: "이미지 분석 해상도 한도(80 MP)를 넘었습니다."])
    }
    let options: [CFString: Any] = [kCGImageSourceCreateThumbnailFromImageAlways: true, kCGImageSourceCreateThumbnailWithTransform: true,
        kCGImageSourceThumbnailMaxPixelSize: input.ocr ? 2000 : 96, kCGImageSourceShouldCacheImmediately: true]
    guard let image = CGImageSourceCreateThumbnailAtIndex(source, 0, options as CFDictionary) else {
        throw NSError(domain: "AFO", code: 5, userInfo: [NSLocalizedDescriptionKey: "이미지 축소본을 만들지 못했습니다."])
    }
    let dh = try pixels(image, width: 9, height: 8)
    var dHash: UInt64 = 0
    for y in 0..<8 { for x in 0..<8 { dHash = (dHash << 1) | (gray(dh, y * 9 + x) > gray(dh, y * 9 + x + 1) ? 1 : 0) } }
    let ah = try pixels(image, width: 8, height: 8)
    let grays = (0..<64).map { gray(ah, $0) }
    let mean = grays.reduce(0, +) / 64
    let variance = grays.map { ($0 - mean) * ($0 - mean) }.reduce(0, +) / 64
    var aHash: UInt64 = 0
    for value in grays { aHash = (aHash << 1) | (value >= mean ? 1 : 0) }
    let color = (0..<3).map { channel in (0..<64).map { Double(ah[$0 * 4 + channel]) }.reduce(0, +) / 64 }
    let orientation = (properties[kCGImagePropertyOrientation] as? NSNumber)?.intValue ?? 1
    var result: [String: Any] = ["width": orientation >= 5 ? height : width, "height": orientation >= 5 ? width : height, "hash": hex(dHash), "averageHash": hex(aHash),
        "variance": variance, "color": color, "text": "", "method": input.ocr ? "apple-vision-image-ocr" : "imageio"]
    if input.ocr { do { result["text"] = try recognize(image) } catch { result["ocrError"] = error.localizedDescription } }
    if let small = CGImageSourceCreateThumbnailAtIndex(source, 0, [kCGImageSourceCreateThumbnailFromImageAlways: true,
        kCGImageSourceCreateThumbnailWithTransform: true, kCGImageSourceThumbnailMaxPixelSize: 96] as CFDictionary) {
        let data = NSMutableData()
        if let destination = CGImageDestinationCreateWithData(data, "public.png" as CFString, 1, nil) {
            CGImageDestinationAddImage(destination, small, nil)
            if CGImageDestinationFinalize(destination) && data.length <= 29_000 { result["thumbnail"] = "data:image/png;base64," + (data as Data).base64EncodedString() }
        }
    }
    return result
}
do {
    guard CommandLine.arguments.count == 2 else { throw NSError(domain: "AFO", code: 6, userInfo: [NSLocalizedDescriptionKey: "요청 파일이 필요합니다."]) }
    let data = try Data(contentsOf: URL(fileURLWithPath: CommandLine.arguments[1]))
    guard data.count <= 65_536 else { throw NSError(domain: "AFO", code: 7) }
    let input = try JSONDecoder().decode(Input.self, from: data)
    let output = try inspect(input)
    FileHandle.standardOutput.write(try JSONSerialization.data(withJSONObject: output, options: [.sortedKeys]))
} catch {
    let output = ["error": error.localizedDescription]
    FileHandle.standardOutput.write((try? JSONSerialization.data(withJSONObject: output)) ?? Data("{}".utf8))
    exit(1)
}
