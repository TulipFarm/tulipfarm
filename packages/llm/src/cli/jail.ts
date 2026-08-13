import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * A CLI provider spawns a real coding-agent binary, which reads its own config from `$HOME` (API
 * keys, MCP servers, hooks, skills). Pointing `HOME` at a fresh directory per call — never the
 * host user's home — is what stops a subscription turn from picking up ambient host config or
 * leaking the operator's own CLI session into TulipFarm inference. Ported from
 * `qm/src/harness/claude-harness.ts`.
 */
export interface CliJail {
  readonly home: string;
  cleanup(): void;
}

export function createCliJail(prefix: string): CliJail {
  const home = mkdtempSync(join(tmpdir(), prefix));
  return {
    home,
    cleanup() {
      rmSync(home, { recursive: true, force: true });
    },
  };
}

/** Env vars every CLI provider may inherit from the host process, regardless of which CLI it is. */
const BASE_ENV_PASSTHROUGH = [
  "PATH",
  "TMPDIR",
  "LANG",
  "LC_ALL",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "NODE_EXTRA_CA_CERTS",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "ALL_PROXY",
] as const;

/**
 * Build a jailed child env: `HOME` pinned to the jail, an explicit allowlist copied from the host
 * process env, plus caller-supplied vars (e.g. the credential). Everything else — most importantly
 * `DATABASE_URL`, `ENCRYPTION_KEY`, and every other provider's secret — is absent by construction.
 */
export function jailedEnv(
  source: NodeJS.ProcessEnv,
  home: string,
  extraPassthrough: readonly string[] = [],
  extraVars: NodeJS.ProcessEnv = {}
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { HOME: home };
  for (const name of [...BASE_ENV_PASSTHROUGH, ...extraPassthrough]) {
    if (source[name] !== undefined) env[name] = source[name];
  }
  return { ...env, ...extraVars };
}
