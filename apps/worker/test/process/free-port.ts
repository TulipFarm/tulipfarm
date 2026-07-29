import { createServer } from "node:net";

/**
 * Binds port 0, reads what the kernel handed out, and releases it. Both the scratch database and
 * the worker's probe server need a port nothing else in CI is using, and neither reports the port
 * it ended up on.
 */
export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      if (address === null || typeof address === "string") {
        probe.close(() => reject(new Error("could not resolve a free port")));
        return;
      }
      probe.close(() => resolve(address.port));
    });
  });
}
