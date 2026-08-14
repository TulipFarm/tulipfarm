import { serveHookRequests } from "@tulipfarm/sandbox";

/** Ingress classifiers get no grants; capability belongs to the call site, not the sandbox. */
serveHookRequests({});
