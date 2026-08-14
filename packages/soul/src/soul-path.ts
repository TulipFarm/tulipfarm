import { join } from "node:path";

/** Per-business checkout path: `<root>/<businessId>/soul`, no filesystem side effects. */
export function resolveSoulPath(root: string, businessId: string): string {
  return join(root, businessId, "soul");
}
