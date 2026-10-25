declare module "*.wasm" {
  const module: WebAssembly.Module;
  export default module;
}

/** Minimal ImageData shape consumed by the WASM codecs in a DOM-free Worker. */
interface ImageData {
  readonly data: Uint8ClampedArray;
  readonly width: number;
  readonly height: number;
}
