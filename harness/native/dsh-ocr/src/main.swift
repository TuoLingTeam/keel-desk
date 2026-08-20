// dsh-ocr — offline text recognition helper backed by the macOS Vision engine.
//
// Contract (kept deliberately small so the Node side can shell out to it):
//
//   dsh-ocr <image-path>
//
// Recognised text goes to stdout, one physical line per observation, in reading
// order. Nothing else is ever written to stdout, so an empty stdout means "this
// image carries no text". Diagnostics go to stderr with these exit codes:
//
//   0  recognition ran (stdout may still be empty)
//   2  wrong usage
//   3  the file could not be decoded as an image
//   4  the Vision request failed
//
// `DSH_OCR_LANGUAGES` overrides the recognition languages as a comma separated
// list of BCP-47 tags, e.g. `DSH_OCR_LANGUAGES=zh-Hans,ja,en-US`.

import Foundation
import ImageIO
import Vision

let defaultLanguages = ["zh-Hans", "en-US"]

func fail(_ message: String, _ code: Int32) -> Never {
  FileHandle.standardError.write(Data((message + "\n").utf8))
  exit(code)
}

let arguments = Array(CommandLine.arguments.dropFirst())
guard arguments.count == 1, !arguments[0].hasPrefix("-") else {
  fail("usage: dsh-ocr <image-path>", 2)
}
let path = arguments[0]

guard
  let source = CGImageSourceCreateWithURL(URL(fileURLWithPath: path) as CFURL, nil),
  let image = CGImageSourceCreateImageAtIndex(source, 0, nil)
else {
  fail("cannot load image: \(path)", 3)
}

let configured = ProcessInfo.processInfo.environment["DSH_OCR_LANGUAGES"]?
  .split(separator: ",")
  .map { $0.trimmingCharacters(in: .whitespaces) }
  .filter { !$0.isEmpty }

let request = VNRecognizeTextRequest()
request.recognitionLevel = .accurate
request.usesLanguageCorrection = true
request.recognitionLanguages = (configured?.isEmpty == false) ? configured! : defaultLanguages

do {
  try VNImageRequestHandler(cgImage: image, options: [:]).perform([request])
} catch {
  fail("recognition failed: \(error.localizedDescription)", 4)
}

// Vision does not promise reading order, so rebuild it from the geometry:
// observations are grouped into rows by vertical overlap (normalised
// coordinates start at the bottom-left) and then ordered left to right.
let observations = request.results ?? []
let rowTolerance = 0.012

let ordered = observations
  .sorted { $0.boundingBox.midY > $1.boundingBox.midY }
  .reduce(into: [[VNRecognizedTextObservation]]()) { rows, observation in
    if var row = rows.last,
      let anchor = row.first,
      abs(anchor.boundingBox.midY - observation.boundingBox.midY) <= rowTolerance
    {
      row.append(observation)
      rows[rows.count - 1] = row
    } else {
      rows.append([observation])
    }
  }
  .map { row in
    row
      .sorted { $0.boundingBox.minX < $1.boundingBox.minX }
      .compactMap { $0.topCandidates(1).first?.string }
      .joined(separator: " ")
  }
  .filter { !$0.isEmpty }

if !ordered.isEmpty {
  print(ordered.joined(separator: "\n"))
}
