export class HookAnalysisError extends Error {
  name = "HookAnalysisError";
}

/**
 * Source patterns refused before a hook is ever compiled.
 *
 * This is a cheap first filter, not the isolation boundary — the isolate is. It exists so an
 * obvious escape attempt is rejected with a readable reason instead of failing opaquely inside a
 * sandbox that was never going to grant it anyway.
 */
const BANNED: RegExp[] = [
  /\brequire\s*\(/,
  /\bimport\s*\(/,
  /\beval\s*\(/,
  /\bFunction\s*\(/,
  /\bprocess\b/,
  /\bglobal\b/,
  /\bBuffer\b/,
  /\b__dirname\b/,
  /\b__filename\b/,
  /\bfetch\s*\(/,
  /\bXMLHttpRequest\b/,
  /\bsetTimeout\b/,
  /\bsetInterval\b/,
  /\bsetImmediate\b/,
  /\bqueueMicrotask\b/,
];

export function analyzeHook(source: string): void {
  for (const re of BANNED) {
    if (re.test(source)) {
      throw new HookAnalysisError(`banned pattern in hook: ${re.source}`);
    }
  }
}
