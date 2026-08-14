/** KV value cap is serialized bytes (`Buffer.byteLength`); namespace/key are URL-safe. */
export const MAX_VALUE_BYTES = 256 * 1024;
export const MAX_KEY_CHARS = 256;
export const MAX_NAMESPACE_CHARS = 128;
/** Alphanumerics plus `. _ : -`; starts alphanumeric; path-safe and map-key friendly. */
export const KV_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;
