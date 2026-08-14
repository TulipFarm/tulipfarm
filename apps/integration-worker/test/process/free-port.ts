import { createServer } from "node:net";

/** Binds port 0 to reserve a CI-free port for processes that cannot report their chosen port. */
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
