import type { JSONSchema7 } from "@ai-sdk/provider";

/** CLI structured output is emulated by prompt schema text plus first-balanced-object extraction. */
export function firstJsonObject(text: string): string | undefined {
  let depth = 0;
  let start = -1;
  let inStr = false;
  let esc = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === "{") {
      if (depth++ === 0) start = i;
    } else if (ch === "}" && depth > 0 && --depth === 0) {
      const candidate = text.slice(start, i + 1);
      try {
        JSON.parse(candidate);
        return candidate;
      } catch {
        return undefined;
      }
    }
  }
  return undefined;
}

/** Instruction appended to the prompt when the caller asked for JSON output (`responseFormat`). */
export function jsonModeInstruction(
  schema: JSONSchema7 | undefined,
  name: string | undefined
): string {
  const lines = [
    "\n\nRespond with a single JSON object only — no prose before or after it, no markdown code fence.",
  ];
  if (name) lines.push(`The object represents: ${name}.`);
  if (schema) lines.push(`It must validate against this JSON Schema:\n${JSON.stringify(schema)}`);
  return lines.join("\n");
}
