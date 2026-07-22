export interface MonotonicIdSourceOptions {
  prefix: string;
  start?: number;
  width?: number;
}

const ID_PREFIX = /^[a-z][a-z0-9_-]*$/i;

export class MonotonicIdSource {
  private nextValue: number;
  private readonly prefix: string;
  private readonly width: number;

  constructor({ prefix, start = 1, width = 6 }: MonotonicIdSourceOptions) {
    if (!ID_PREFIX.test(prefix)) {
      throw new TypeError("MonotonicIdSource prefix must be an identifier");
    }
    if (!Number.isSafeInteger(start) || start < 0) {
      throw new RangeError("MonotonicIdSource start must be a non-negative safe integer");
    }
    if (!Number.isSafeInteger(width) || width < 1) {
      throw new RangeError("MonotonicIdSource width must be a positive integer");
    }
    this.prefix = prefix;
    this.nextValue = start;
    this.width = width;
  }

  next(): string {
    if (!Number.isSafeInteger(this.nextValue)) {
      throw new RangeError("MonotonicIdSource exhausted safe integer identifiers");
    }
    const id = `${this.prefix}-${String(this.nextValue).padStart(this.width, "0")}`;
    this.nextValue += 1;
    return id;
  }
}
