export class HookAnalysisError extends Error {
  name = "HookAnalysisError";
}

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
