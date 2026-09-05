import { createHash } from "node:crypto";
import {
  SURFACE_CODE_VIEW_CHANNELS,
  SURFACE_CODE_VIEW_MAX_COMPILED_BYTES,
  SURFACE_CODE_VIEW_MAX_SOURCE_BYTES,
  type SurfaceCodeView,
} from "@tulipfarm/surface";
import { transform } from "esbuild";

/**
 * Capability names refused in authored source.
 *
 * This is **not** the security boundary — the frame's opaque origin and its `connect-src 'none'`
 * policy are, and `globalThis["fe" + "tch"]` defeats every list like this one. It is kept because it
 * turns a confused author's mistake into a tool error it can repair inside its retry budget, and
 * because an intent to exfiltrate then shows up in the Soul's git history instead of running
 * harmlessly but invisibly.
 */
const DENIED = [
  "fetch",
  "XMLHttpRequest",
  "WebSocket",
  "EventSource",
  "sendBeacon",
  "importScripts",
  "eval",
  "new Function",
  "document.cookie",
  "localStorage",
  "sessionStorage",
  "indexedDB",
  "parent",
  "top",
] as const;

const DYNAMIC_IMPORT = /\bimport\s*\(/;
const STATIC_IMPORT = /^\s*import\s+/m;

const COMMENT_OR_STRING =
  /\/\*[\s\S]*?\*\/|\/\/[^\n]*|'(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*"|`(?:\\.|[^`\\])*`/g;

/**
 * The denied names, each anchored so it matches a reference and not a longer identifier.
 *
 * A plain substring test read `parentNode` as `parent` and the CSS value `top` as `window.top`,
 * refusing views that touch nothing. The author's only recovery is to guess, and it guessed wrong:
 * it stripped every style from the grid rather than find a word it could not see.
 */
const DENIED_PATTERNS = DENIED.map(
  (name) => [name, new RegExp(`(?<![\\w$])${name.replace(/\./g, "\\.")}(?![\\w$])`)] as const
);

export function isSurfaceCodeViewChannel(channel: string): boolean {
  return (SURFACE_CODE_VIEW_CHANNELS as readonly string[]).includes(channel);
}

function byteLength(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

function deniedCapability(source: string): string | undefined {
  if (STATIC_IMPORT.test(source)) return "import";
  if (DYNAMIC_IMPORT.test(source)) return "import()";
  // Comments and string literals are blanked first: a capability named only inside one is text, not
  // a reference, and `verticalAlign: "top"` is the shape an author reaches for most.
  const code = source.replace(COMMENT_OR_STRING, " ");
  return DENIED_PATTERNS.find(([, pattern]) => pattern.test(code))?.[0];
}

/**
 * Compile one authored JSX view, or explain why it cannot be published.
 *
 * Compilation happens here, at authoring time, rather than in the browser: a syntax error must
 * reach the agent as a tool error carrying a line and column, not as a blank frame nobody can debug.
 */
export async function compileSurfaceCodeView(
  channel: string,
  source: string
): Promise<{ view: SurfaceCodeView } | { error: string }> {
  const path = `/code/${channel}`;
  if (!isSurfaceCodeViewChannel(channel)) {
    return { error: `${path}: a code view runs on the web channel only.` };
  }
  if (typeof source !== "string" || source.trim().length === 0) {
    return { error: `${path}: authored source is required.` };
  }
  if (byteLength(source) > SURFACE_CODE_VIEW_MAX_SOURCE_BYTES) {
    return { error: `${path}: source exceeds ${SURFACE_CODE_VIEW_MAX_SOURCE_BYTES} bytes.` };
  }
  const denied = deniedCapability(source);
  if (denied) {
    return {
      error:
        `${path}: "${denied}" is unavailable to a code view. It runs with no network, no storage ` +
        "and no access to the page; render only from the props you were given.",
    };
  }
  let compiled: string;
  try {
    const result = await transform(source, {
      loader: "jsx",
      jsx: "transform",
      jsxFactory: "React.createElement",
      jsxFragment: "React.Fragment",
      target: "es2022",
      sourcemap: false,
      minify: false,
      logLevel: "silent",
    });
    compiled = result.code;
  } catch (error) {
    return { error: `${path}: ${compileFailure(error)}` };
  }
  if (!/\brender\b/.test(compiled)) {
    return { error: `${path}: the source must define function render(props, tulip).` };
  }
  if (byteLength(compiled) > SURFACE_CODE_VIEW_MAX_COMPILED_BYTES) {
    return {
      error: `${path}: compiled output exceeds ${SURFACE_CODE_VIEW_MAX_COMPILED_BYTES} bytes.`,
    };
  }
  return {
    view: { source, compiled, sourceSha256: createHash("sha256").update(source).digest("hex") },
  };
}

function compileFailure(error: unknown): string {
  const first = (
    error as { errors?: Array<{ text: string; location?: { line: number; column: number } }> }
  ).errors?.[0];
  if (!first) return error instanceof Error ? error.message : String(error);
  const at = first.location ? ` at line ${first.location.line}:${first.location.column}` : "";
  return `${first.text}${at}`;
}
