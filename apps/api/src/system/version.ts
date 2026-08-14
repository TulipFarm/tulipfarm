/** Running release version: bundle define, then `TULIPFARM_VERSION`, then `dev`. */
declare const __TULIPFARM_VERSION__: string | undefined;

export function runningVersion(): string {
  const envVer = process.env.TULIPFARM_VERSION;
  if (typeof envVer === "string" && envVer.length > 0 && envVer !== "latest") {
    return envVer;
  }
  if (typeof __TULIPFARM_VERSION__ === "string" && __TULIPFARM_VERSION__.length > 0) {
    return __TULIPFARM_VERSION__;
  }
  return envVer ?? "dev";
}

/** True only for strictly newer stable semver; non-semver and prereleases never nag. */
export function isNewerVersion(current: string, latest: string): boolean {
  const cur = parseSemver(current);
  const next = parseSemver(latest);
  if (!cur || !next) return false;
  for (let i = 0; i < 3; i++) {
    if (next[i] > cur[i]) return true;
    if (next[i] < cur[i]) return false;
  }
  return false;
}

function parseSemver(version: string): [number, number, number] | null {
  const m = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(version.trim());
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}
