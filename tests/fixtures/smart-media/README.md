These fixtures contain synthetic text and generated shapes, not user documents or photos.

- `source.png`, `similar.png`, `different.png`, `dated.jpg`: rendered with CoreGraphics/CoreText. Similar has a small brightness change; different has a different background pattern. The JPEG stores EXIF DateTimeOriginal `2024:11:01 00:20:00` without a time zone.
- `korean.png`, `korean.pdf`: generated Korean OCR / embedded-font PDF samples (물리·가속도·운동량).
- `math.docx`: minimal OOXML package with a synthetic calculus sentence.

The tests independently check content, metadata and hashes; a filename or successful parser construction alone is not the oracle.
