// pre-merge branches can be scanned and tested: "owner/repo#my-branch". No "#" ⇒ default branch.
export function splitSourceRef(source: string): { base: string; ref?: string } {
  const idx = source.indexOf("#");
  return idx === -1 ? { base: source } : { base: source.slice(0, idx), ref: source.slice(idx + 1) };
}

export function sourceType(source: string): "github" | "git" {
  const { base } = splitSourceRef(source);
  return /github\.com|^[\w.-]+\/[\w.-]+$/.test(base) ? "github" : "git";
}
