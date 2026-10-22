import { z } from 'zod';
import { Parser } from 'htmlparser2';
import { normalizeEndpoint } from '@tulipfarm/workspace-mcp-transport';
import { createPublicDownload } from '@tulipfarm/workspace-mcp-transport/public-download';
import { SkillPackageError, skillPackageLimits } from './skill-package-contracts.ts';
import { buildSkillPackage, skillBytesDigest, type SkillPackageFile } from './skill-packages.ts';
import { readSkillArchive } from './skill-package-archive.ts';

type GitHubSource = { kind: 'github'; repository: string; tail: string[]; ref?: string; hint?: string };
export type SkillSource = GitHubSource | { kind: 'website'; url: string };
const segment = (value: string) => /^[a-zA-Z0-9_.-]{1,100}$/.test(value) && value !== '.' && value !== '..';
export function resolveSkillSource(input: string): SkillSource {
  input = input.trim();
  if (/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:#[^\s]+)?$/.test(input)) input = `https://github.com/${input}`;
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new SkillPackageError('source-unsupported');
  }
  let ref: string | undefined;
  try {
    ref = url.hash ? decodeURIComponent(url.hash.slice(1)) : undefined;
  } catch {
    throw new SkillPackageError('source-unsupported');
  }
  url.hash = '';
  normalizeEndpoint(url.href);
  let parts: string[];
  try {
    parts = url.pathname
      .split('/')
      .filter(Boolean)
      .map(part => decodeURIComponent(part));
  } catch {
    throw new SkillPackageError('source-unsupported');
  }
  if (parts.some(part => part.includes('/') || part.includes('\\') || part === '.' || part === '..'))
    throw new SkillPackageError('source-unsupported');
  if (['github.com', 'raw.githubusercontent.com', 'skills.sh'].includes(url.hostname)) {
    const [owner, repository] = parts;
    if (!owner || !repository || !segment(owner) || !segment(repository) || url.search)
      throw new SkillPackageError('source-unsupported');
    const base = {
      kind: 'github' as const,
      repository: `${owner}/${repository.replace(/\.git$/, '')}`,
      ...(ref ? { ref } : {}),
    };
    if (url.hostname === 'skills.sh') {
      if (parts.length !== 3 || !segment(parts[2]!)) throw new SkillPackageError('source-unsupported');
      return { ...base, tail: [], hint: parts[2]! };
    }
    if (url.hostname === 'raw.githubusercontent.com') {
      if (parts.length < 4 || parts.at(-1) !== 'SKILL.md') throw new SkillPackageError('source-unsupported');
      return { ...base, tail: parts.slice(2) };
    }
    if (parts.length === 2) return { ...base, tail: [] };
    if (
      !['tree', 'blob'].includes(parts[2]!) ||
      parts.length < 4 ||
      (parts[2] === 'blob' && parts.at(-1) !== 'SKILL.md')
    )
      throw new SkillPackageError('source-unsupported');
    return { ...base, tail: parts.slice(3) };
  }
  if (ref) throw new SkillPackageError('source-unsupported');
  return { kind: 'website', url: url.href };
}

export type SkillSourceProvenance = {
  submittedUrl: string;
  canonicalUrl: string;
  digest: string;
  repository?: string;
  commit?: string;
  directory?: string;
};
export type DiscoveredSkill = ReturnType<typeof buildSkillPackage> & { path: string; source: SkillSourceProvenance };
export type SkillDiscovery =
  | { kind: 'skills'; skills: DiscoveredSkill[] }
  | { kind: 'links'; links: string[] }
  | { kind: 'page'; url: string };

export function discoverSkillFiles(
  files: readonly SkillPackageFile[],
  source: SkillSourceProvenance,
  root?: string,
  hint?: string,
): DiscoveredSkill[] {
  const paths = files
    .filter(file => file.path === 'SKILL.md' || file.path.endsWith('/SKILL.md'))
    .map(file => file.path.slice(0, -'SKILL.md'.length));
  if (paths.length > skillPackageLimits.candidates) throw new SkillPackageError('source-limit');
  const selected = root !== undefined ? paths.filter(path => path === (root ? `${root}/` : '')) : paths;
  const packages = selected.map(prefix => {
    const nested = paths.filter(path => path !== prefix && path.startsWith(prefix));
    const local = files
      .filter(file => file.path.startsWith(prefix) && !nested.some(path => file.path.startsWith(path)))
      .map(file => ({ path: file.path.slice(prefix.length), bytes: file.bytes }));
    const path = prefix.replace(/\/$/, '');
    const built = buildSkillPackage(local, path ? path.split('/').at(-1) : undefined);
    return { ...built, path, source: { ...source, directory: path } };
  });
  const result = hint ? packages.filter(item => item.definition.name === hint) : packages;
  if (!result.length) throw new SkillPackageError('no-skills');
  return result;
}

const treeSchema = z.object({
  truncated: z.boolean(),
  tree: z
    .array(
      z.object({
        path: z.string().max(4096),
        mode: z.string(),
        type: z.enum(['blob', 'tree', 'commit']),
        sha: z.string().regex(/^[a-f0-9]{40}$/),
        size: z.number().int().nonnegative().optional(),
      }),
    )
    .max(skillPackageLimits.sourceFiles),
});
const commitSchema = z.object({
  sha: z.string().regex(/^[a-f0-9]{40}$/),
  commit: z.object({ tree: z.object({ sha: z.string().regex(/^[a-f0-9]{40}$/) }) }),
});
export function createSkillSourceReader(download = createPublicDownload()) {
  return async (submittedUrl: string, signal = AbortSignal.timeout(60000)): Promise<SkillDiscovery> => {
    const source = resolveSkillSource(submittedUrl);
    let received = 0,
      requests = 0;
    async function get(url: string) {
      if (++requests > 256 || received >= skillPackageLimits.sourceBytes) throw new SkillPackageError('source-limit');
      const result = await download(url, skillPackageLimits.sourceBytes - received, signal);
      received += result.bytes.byteLength;
      if (
        result.status === 429 ||
        (result.status === 403 && /rate limit/i.test(result.bytes.subarray(0, 4096).toString('utf8')))
      )
        throw new SkillPackageError('source-rate-limit');
      return result;
    }
    if (source.kind === 'github') {
      const api = `https://api.github.com/repos/${source.repository}`;
      async function commit(ref: string) {
        const result = await get(`${api}/commits/${encodeURIComponent(ref)}`);
        if (result.status === 404 || result.status === 422) return null;
        if (result.status !== 200) throw new SkillPackageError('source-unavailable');
        return commitSchema.parse(JSON.parse(result.bytes.toString('utf8')));
      }
      let resolved: z.infer<typeof commitSchema> | null = null,
        root: string | undefined;
      if (source.ref) {
        resolved = await commit(source.ref);
        if (source.tail.length) {
          const candidates = [];
          for (let end = source.tail.length; end > 0; end--) {
            if (await commit(source.tail.slice(0, end).join('/'))) candidates.push(end);
          }
          if (candidates.length !== 1) throw new SkillPackageError('source-unsupported');
          root = source.tail
            .slice(candidates[0])
            .join('/')
            .replace(/(?:^|\/)SKILL\.md$/, '');
        }
      } else if (source.tail.length) {
        const candidates: { value: z.infer<typeof commitSchema>; end: number }[] = [];
        for (let end = source.tail.length; end > 0; end--) {
          const value = await commit(source.tail.slice(0, end).join('/'));
          if (value) candidates.push({ value, end });
        }
        if (candidates.length !== 1) throw new SkillPackageError('source-unsupported');
        resolved = candidates[0]!.value;
        root = source.tail
          .slice(candidates[0]!.end)
          .join('/')
          .replace(/(?:^|\/)SKILL\.md$/, '');
      } else {
        const repo = await get(api);
        if (repo.status !== 200) throw new SkillPackageError('source-unavailable');
        const info = z
          .object({ private: z.literal(false), default_branch: z.string() })
          .parse(JSON.parse(repo.bytes.toString('utf8')));
        resolved = await commit(info.default_branch);
      }
      if (!resolved) throw new SkillPackageError('source-unavailable');
      const treeResult = await get(`${api}/git/trees/${resolved.commit.tree.sha}?recursive=1`);
      if (treeResult.status !== 200) throw new SkillPackageError('source-unavailable');
      const tree = treeSchema.parse(JSON.parse(treeResult.bytes.toString('utf8')));
      if (tree.truncated) throw new SkillPackageError('source-limit');
      const skillPaths = tree.tree
        .filter(entry => entry.type === 'blob' && (entry.path === 'SKILL.md' || entry.path.endsWith('/SKILL.md')))
        .map(entry => entry.path.slice(0, -'SKILL.md'.length))
        .filter(path => root === undefined || path === (root ? `${root}/` : ''));
      if (!skillPaths.length) throw new SkillPackageError('no-skills');
      if (skillPaths.length > skillPackageLimits.candidates) throw new SkillPackageError('source-limit');
      const entries = tree.tree.filter(
        entry => skillPaths.some(path => entry.path.startsWith(path)) && entry.type !== 'tree',
      );
      if (entries.some(entry => entry.mode !== '100644' && entry.mode !== '100755'))
        throw new SkillPackageError('invalid-package');
      if (
        entries.reduce((sum, entry) => sum + (entry.size ?? skillPackageLimits.sourceBytes), 0) >
        skillPackageLimits.sourceBytes
      )
        throw new SkillPackageError('source-limit');
      const files: SkillPackageFile[] = [];
      for (const entry of entries) {
        const blob = await get(
          `https://raw.githubusercontent.com/${source.repository}/${resolved.sha}/${entry.path.split('/').map(encodeURIComponent).join('/')}`,
        );
        if (blob.status !== 200 || blob.bytes.length !== entry.size) throw new SkillPackageError('source-unavailable');
        files.push({ path: entry.path, bytes: blob.bytes });
      }
      return {
        kind: 'skills',
        skills: discoverSkillFiles(
          files,
          {
            submittedUrl,
            canonicalUrl: `https://github.com/${source.repository}/tree/${resolved.sha}`,
            digest: resolved.sha,
            repository: source.repository,
            commit: resolved.sha,
          },
          root,
          source.hint,
        ),
      };
    }
    const result = await get(source.url);
    if (result.status !== 200) throw new SkillPackageError('source-unavailable');
    const provenance = { submittedUrl, canonicalUrl: result.url, digest: skillBytesDigest(result.bytes) };
    if (result.bytes[0] === 0x50 && result.bytes[1] === 0x4b)
      return { kind: 'skills', skills: discoverSkillFiles(await readSkillArchive(result.bytes, signal), provenance) };
    if (result.mediaType === 'text/html' || result.mediaType === 'application/xhtml+xml') {
      const links = new Set<string>();
      const parser = new Parser(
        {
          onopentag(name, attributes) {
            if (name !== 'a' || !attributes.href) return;
            let url: URL;
            try {
              url = new URL(attributes.href, result.url);
            } catch {
              return;
            }
            if (
              !(
                /(?:\/SKILL\.md|\.(?:zip|skill))$/i.test(url.pathname) ||
                ['github.com', 'skills.sh', 'raw.githubusercontent.com'].includes(url.hostname)
              )
            )
              return;
            if (url.protocol !== 'https:' || url.username || url.password) return;
            links.add(url.href);
          },
        },
        { decodeEntities: true },
      );
      parser.end(result.bytes.toString('utf8'));
      if (links.size > skillPackageLimits.candidates) throw new SkillPackageError('source-limit');
      return links.size ? { kind: 'links', links: [...links] } : { kind: 'page', url: result.url };
    }
    return { kind: 'skills', skills: discoverSkillFiles([{ path: 'SKILL.md', bytes: result.bytes }], provenance) };
  };
}
