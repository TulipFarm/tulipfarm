/** Serialize only values that can be represented exactly as JSON without invoking accessors. */
export function serializeJson(value: unknown, ancestors = new Set<object>()): string | undefined {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") return Number.isFinite(value) ? JSON.stringify(value) : undefined;
  if (typeof value !== "object" || ancestors.has(value)) return undefined;

  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      const items: string[] = [];
      for (let index = 0; index < value.length; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
        if (!descriptor?.enumerable || !("value" in descriptor)) return undefined;
        const item = serializeJson(descriptor.value, ancestors);
        if (item === undefined) return undefined;
        items.push(item);
      }
      for (const key of Reflect.ownKeys(value)) {
        if (key === "length") continue;
        if (typeof key === "symbol") return undefined;
        const index = Number(key);
        if (
          !Number.isInteger(index) ||
          index < 0 ||
          index >= value.length ||
          String(index) !== key
        ) {
          return undefined;
        }
      }
      return `[${items.join(",")}]`;
    }

    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return undefined;
    const entries: string[] = [];
    const keys = Reflect.ownKeys(value);
    if (keys.some((key) => typeof key === "symbol")) return undefined;
    for (const key of (keys as string[]).sort()) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor?.enumerable || !("value" in descriptor)) return undefined;
      const item = serializeJson(descriptor.value, ancestors);
      if (item === undefined) return undefined;
      entries.push(`${JSON.stringify(key)}:${item}`);
    }
    return `{${entries.join(",")}}`;
  } finally {
    ancestors.delete(value);
  }
}
