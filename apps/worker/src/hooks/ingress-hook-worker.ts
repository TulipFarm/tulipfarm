import { serveHookRequests } from "@tulipfarm/sandbox";

/**
 * The Worker's hook sandbox thread.
 *
 * It grants the isolate **nothing**. The only hook this process runs is an Integration's ingress
 * `classify(ctx)`, which is handed the delivery it must classify and has no business reading a
 * record: a classifier that could reach the resource tables would be a channel-shaped way for
 * untrusted, per-Integration code to query business data before anyone has been identified.
 *
 * The API's own entrypoint (`apps/api/src/hooks/hook-worker.ts`) grants a resource lookup because
 * its resource hooks need one. That the two differ at all is the point — the capability is a
 * property of the call site, not a flag inside the sandbox.
 */
serveHookRequests({});
