import sharp, { type Sharp } from 'sharp';
import { decodeBmp, type RgbaImage } from './bmp.ts';
import { sniffMediaType, type MediaType } from './sniff.ts';

export const modelImageMediaTypes = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'] as const;

export type ModelImageMediaType = (typeof modelImageMediaTypes)[number];

export type PreparedImage = {
  mediaType: ModelImageMediaType;
  data: Uint8Array;
  width: number;
  height: number;
  downscaled: boolean;
};

export type PrepareImageOptions = { maxBytes: number; maxEdge?: number };

export type ImagePreparationErrorCode =
  | 'unsupported-type'
  | 'too-many-pixels'
  | 'timed-out'
  | 'decode-failed'
  | 'over-budget';

export class ImagePreparationError extends Error {
  readonly code: ImagePreparationErrorCode;

  constructor(code: ImagePreparationErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'ImagePreparationError';
    this.code = code;
  }
}

const maxInputPixels = 100_000_000;
const timeoutMs = 30_000;
const shrinkFactor = 0.75;
const maxPasses = 64;
const lossyQuality = 85;

type DecodedImage = {
  open: () => Sharp;
  width: number;
  height: number;
  hasAlpha: boolean;
  // Animated or EXIF-rotated inputs cannot be sent as they are, whatever their size.
  needsReencode: boolean;
};

/** The displayed width and height of an image, after its EXIF orientation; null when sharp cannot read it. */
export async function imageDimensions(bytes: Uint8Array): Promise<{ width: number; height: number } | null> {
  try {
    const { autoOrient } = await sharp(bytes, { limitInputPixels: maxInputPixels }).metadata();
    return { width: autoOrient.width, height: autoOrient.height };
  } catch {
    return null;
  }
}

export async function prepareImageForModel(bytes: Uint8Array, options: PrepareImageOptions): Promise<PreparedImage> {
  const { maxBytes, maxEdge = 2048 } = options;
  const sniffed = sniffMediaType(bytes);
  if (sniffed?.family !== 'image') {
    throw new ImagePreparationError(
      'unsupported-type',
      `Cannot prepare ${sniffed?.mediaType ?? 'unrecognised bytes'} as an image`,
    );
  }
  const deadline = Date.now() + timeoutMs;
  try {
    const image = await decode(sniffed.mediaType, bytes, deadline);
    const { width, height } = image;
    if (
      isModelImageMediaType(sniffed.mediaType) &&
      !image.needsReencode &&
      Math.max(width, height) <= maxEdge &&
      bytes.byteLength <= maxBytes
    ) {
      return { mediaType: sniffed.mediaType, data: new Uint8Array(bytes), width, height, downscaled: false };
    }
    const format =
      sniffed.mediaType === 'image/jpeg' || sniffed.mediaType === 'image/webp' ? sniffed.mediaType : 'image/png';
    return await fitWithinBudget(image, format, maxBytes, maxEdge, deadline);
  } catch (error) {
    throw asPreparationError(error);
  }
}

async function fitWithinBudget(
  image: DecodedImage,
  initialFormat: ModelImageMediaType,
  maxBytes: number,
  maxEdge: number,
  deadline: number,
): Promise<PreparedImage> {
  let format = initialFormat;
  let scale = Math.min(1, maxEdge / Math.max(image.width, image.height));
  for (let pass = 0; pass < maxPasses; pass++) {
    const width = Math.max(1, Math.round(image.width * scale));
    const height = Math.max(1, Math.round(image.height * scale));
    const data = await encode(image, format, width, height, deadline);
    const downscaled = width !== image.width || height !== image.height;
    if (data.byteLength <= maxBytes) return { mediaType: format, data, width, height, downscaled };
    if (format === 'image/png' && !image.hasAlpha) {
      format = 'image/jpeg';
      continue;
    }
    if (width === 1 && height === 1) break;
    scale *= shrinkFactor;
  }
  throw new ImagePreparationError('over-budget', `Cannot encode the image within ${maxBytes} bytes`);
}

async function encode(
  image: DecodedImage,
  format: ModelImageMediaType,
  width: number,
  height: number,
  deadline: number,
): Promise<Uint8Array> {
  const remainingMs = deadline - Date.now();
  if (remainingMs <= 0) throw new ImagePreparationError('timed-out', `Image preparation exceeded ${timeoutMs / 1000}s`);
  let pipeline = image.open().timeout({ seconds: Math.ceil(remainingMs / 1000) });
  if (width !== image.width || height !== image.height) pipeline = pipeline.resize(width, height, { fit: 'fill' });
  if (format === 'image/jpeg') pipeline = pipeline.jpeg({ quality: lossyQuality });
  else if (format === 'image/webp') pipeline = pipeline.webp({ quality: lossyQuality });
  else pipeline = pipeline.png();
  return new Uint8Array(await pipeline.toBuffer());
}

async function decodeWithSharp(bytes: Uint8Array): Promise<DecodedImage> {
  // librsvg only resolves external references relative to a base file; buffer input has none, so SVG cannot fetch.
  const options = { limitInputPixels: maxInputPixels, autoOrient: true } as const;
  const metadata = await sharp(bytes, options).metadata();
  checkPixels(metadata.width, metadata.height);
  return {
    open: () => sharp(bytes, options),
    width: metadata.autoOrient.width,
    height: metadata.autoOrient.height,
    hasAlpha: metadata.hasAlpha,
    needsReencode: (metadata.pages ?? 1) > 1 || (metadata.orientation ?? 1) > 1,
  };
}

function decode(mediaType: MediaType, bytes: Uint8Array, deadline: number): Promise<DecodedImage> {
  switch (mediaType) {
    case 'image/heic':
    case 'image/heif':
      return decodeHeif(bytes, deadline).then(fromRgba);
    case 'image/bmp':
      return Promise.resolve(fromRgba(decodeBmp(bytes, checkPixels)));
    default:
      return decodeWithSharp(bytes);
  }
}

async function decodeHeif(bytes: Uint8Array, deadline: number): Promise<RgbaImage> {
  const { default: libheif } = await import('libheif-js/wasm-bundle.js');
  const decoder = new libheif.HeifDecoder();
  const images = decoder.decode(bytes);
  try {
    const primary = images[0];
    if (!primary) throw new ImagePreparationError('decode-failed', 'The HEIF file contains no image');
    const width = primary.get_width();
    const height = primary.get_height();
    checkPixels(width, height);
    const rgba = await new Promise<Uint8ClampedArray>((resolve, reject) => {
      primary.display({ data: new Uint8ClampedArray(width * height * 4), width, height }, result => {
        if (result) resolve(result.data);
        else reject(new ImagePreparationError('decode-failed', 'libheif could not decode the image'));
      });
    });
    // WebAssembly decoding is synchronous and cannot be interrupted; the pixel limit above bounds its cost.
    if (Date.now() > deadline) {
      throw new ImagePreparationError('timed-out', `Image preparation exceeded ${timeoutMs / 1000}s`);
    }
    return { width, height, rgba: new Uint8Array(rgba.buffer, rgba.byteOffset, rgba.byteLength) };
  } finally {
    for (const image of images) image.free();
    decoder.decoder.delete();
  }
}

function fromRgba({ width, height, rgba }: RgbaImage): DecodedImage {
  const raw = { width, height, channels: 4 } as const;
  const hasAlpha = !isOpaque(rgba);
  return {
    open: () => {
      const pipeline = sharp(rgba, { raw, limitInputPixels: maxInputPixels });
      return hasAlpha ? pipeline : pipeline.removeAlpha();
    },
    width,
    height,
    hasAlpha,
    needsReencode: true,
  };
}

function isOpaque(rgba: Uint8Array): boolean {
  for (let index = 3; index < rgba.length; index += 4) {
    if (rgba[index] !== 255) return false;
  }
  return true;
}

function checkPixels(width: number, height: number): void {
  if (width * height > maxInputPixels) {
    throw new ImagePreparationError('too-many-pixels', `${width}×${height} exceeds ${maxInputPixels} pixels`);
  }
}

function isModelImageMediaType(mediaType: MediaType): mediaType is ModelImageMediaType {
  return (modelImageMediaTypes as readonly string[]).includes(mediaType);
}

function asPreparationError(error: unknown): ImagePreparationError {
  if (error instanceof ImagePreparationError) return error;
  const message = error instanceof Error ? error.message : String(error);
  if (/pixel limit/i.test(message)) return new ImagePreparationError('too-many-pixels', message, { cause: error });
  if (/timeout/i.test(message)) return new ImagePreparationError('timed-out', message, { cause: error });
  return new ImagePreparationError('decode-failed', message, { cause: error });
}
