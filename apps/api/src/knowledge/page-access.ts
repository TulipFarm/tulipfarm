/**
 * Re-export only. The gate lives in `@tulipfarm/knowledge` because the worker's Tool host needs the
 * same implementation and cannot import this app. Kept as a module so existing imports resolve.
 */

export { type PageReadAuthorizer, PageReadGate, type ReadablePages } from "@tulipfarm/knowledge";
