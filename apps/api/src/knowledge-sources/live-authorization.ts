import type { LiveSourceAuthorizationPort } from "@tulipfarm/knowledge";

export class CompositeLiveSourceAuthorization implements LiveSourceAuthorizationPort {
  constructor(private readonly ports: readonly LiveSourceAuthorizationPort[]) {}

  async check(
    input: Parameters<LiveSourceAuthorizationPort["check"]>[0]
  ): ReturnType<LiveSourceAuthorizationPort["check"]> {
    for (const port of this.ports) {
      const result = await port.check(input);
      if (result !== undefined) return result;
    }
    return undefined;
  }
}
