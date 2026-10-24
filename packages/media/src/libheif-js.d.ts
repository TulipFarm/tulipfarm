declare module 'libheif-js/wasm-bundle.js' {
  type ImageData = { data: Uint8ClampedArray; width: number; height: number };

  interface HeifImage {
    get_width(): number;
    get_height(): number;
    display(target: ImageData, callback: (result: ImageData | null) => void): void;
    free(): void;
  }

  interface HeifDecoder {
    decode(bytes: Uint8Array): HeifImage[];
    decoder: { delete(): void };
  }

  const libheif: { HeifDecoder: new () => HeifDecoder };
  export default libheif;
}
