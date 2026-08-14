import { serveHookRequests } from "./worker-host";

/** Default hook worker grants no host/fs/net capability; hosts needing more ship their own entrypoint. */
serveHookRequests();
