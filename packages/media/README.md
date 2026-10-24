# Media

`@tulipfarm/media` identifies files from their bytes and prepares images for multimodal models. It never trusts a declared media type and never changes the bytes it is given.

## API

`sniffMediaType(bytes)` returns `{ mediaType, family }` or `null`. Families are `image`, `pdf`, `archive`, `office`, `audio` and `video`. It recognises PNG, JPEG, WebP, GIF, HEIC/HEIF, TIFF, BMP, SVG, PDF, ZIP, DOCX/XLSX/PPTX, MP3, WAV, OGG, FLAC, M4A, MP4, QuickTime, WebM, Matroska and AVI.

`prepareImageForModel(bytes, { maxBytes, maxEdge = 2048 })` returns `{ mediaType, data, width, height, downscaled }`. `mediaType` is one of `modelImageMediaTypes`: PNG, JPEG, WebP or GIF.

- A model type that is not animated or EXIF-rotated, fits `maxEdge` and fits `maxBytes` comes back as an unchanged copy.
- Otherwise the image is downscaled, keeping its aspect ratio and never enlarging, until its longest edge fits `maxEdge` and its encoded size fits `maxBytes`.
- JPEG and WebP stay in their format. Everything else becomes PNG, or JPEG when an opaque image does not fit as PNG. Animated GIFs keep their first frame.
- `downscaled` is true only when the dimensions changed.

Failures throw `ImagePreparationError` with a `code`:

| Code               | Meaning                                              |
| ------------------ | ---------------------------------------------------- |
| `unsupported-type` | The bytes are not a recognised image.                |
| `too-many-pixels`  | The image is larger than 100 megapixels.             |
| `timed-out`        | Preparation took longer than 30 seconds.             |
| `decode-failed`    | The image is corrupt or uses an unsupported variant. |
| `over-budget`      | The image does not fit `maxBytes` even at one pixel. |

## Decoders

`sharp` decodes PNG, JPEG, WebP, GIF, TIFF and SVG. Prebuilt `sharp` has no HEVC decoder and no BMP loader. HEIC and HEIF go through `libheif-js`, a WebAssembly build of libheif, loaded only when a HEIC file arrives. Uncompressed BMPs are decoded in this package. WebAssembly decoding cannot be interrupted, so the 100-megapixel check runs on the HEIC header before decoding and the deadline is checked afterwards.

## SVG

SVG is rendered by librsvg inside `sharp` from an in-memory buffer. librsvg does not run scripts. Without a base file it resolves no external references, so rendering makes no network or file requests. A test serves the SVG's external image from a local server and checks that the server receives no requests.
