import { serveHookRequests } from "./worker-host";

/**
 * A hook sandbox thread that grants the isolate nothing at all.
 *
 * This is the entrypoint for every host that only needs to *evaluate* untrusted source —
 * classifying an inbound channel delivery, running a Routine expression — as opposed to letting a
 * hook read records back. Granting no capability is the default; a host that needs one ships its
 * own entrypoint and says so explicitly.
 */
serveHookRequests();
