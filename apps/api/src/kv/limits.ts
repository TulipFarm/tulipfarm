/**
 * Generic KV caps (KV-V1). Unlike working memory (tiny, always-injected, char-capped), KV holds
 * arbitrary JSON, so the value cap is a generous BYTE budget on the serialized value — measured with
 * `Buffer.byteLength`, never `String.length`, since a multibyte value can blow the byte cap while
 * staying under its character count. Namespace and key share one charset so they are safe to embed
 * in URL path segments and predictable across every surface (repo, service, tools, routes).
 */
export const MAX_VALUE_BYTES = 256 * 1024;
export const MAX_KEY_CHARS = 256;
export const MAX_NAMESPACE_CHARS = 128;
/** Alphanumerics plus `. _ : -`, must start alphanumeric. Path-safe (no `/`) and map-key friendly. */
export const KV_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;
