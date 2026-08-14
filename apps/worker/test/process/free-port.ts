import { createServer } from "node:net";

/** Finds a CI-free port for services that cannot report their bound port. */
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
