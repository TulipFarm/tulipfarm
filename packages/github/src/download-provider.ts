import { createHash } from 'node:crypto';
import { observeFetch } from '@tulipfarm/observability';
import { z } from 'zod';
import { GitHubCredentialRejected, type GitHubCredential } from './accounts.ts';
import { GitHubReadError, type GitHubDownload, type GitHubRead } from './read-contracts.ts';
import { dispatchGitHubRead } from './read-provider.ts';

export function downloadMetadataOperation(operation: GitHubDownload): GitHubRead {
  const kind =
    operation.kind === 'release.download'
      ? 'release.asset'
      : operation.kind === 'actions.artifact-download'
        ? 'actions.artifact'
        : 'actions.run';
  return { ...operation, kind };
}

export function requireDownloadMetadata(operation: GitHubDownload, value: unknown) {
  const identity = z.object({ id: z.number().int() }).parse(value);
  if (identity.id !== operation.id) throw new GitHubReadError('read-unavailable');
  if (operation.kind === 'actions.artifact-download') {
    const artifact = z
      .object({
        expired: z.literal(false),
        expires_at: z.iso.datetime(),
        size_in_bytes: z.number().int().nonnegative(),
      })
      .parse(value);
    if (Date.parse(artifact.expires_at) <= Date.now()) throw new GitHubReadError('read-unavailable');
  }
  if (operation.kind === 'actions.run-logs-download')
    z.object({ status: z.literal('completed'), run_attempt: z.number().int().positive() }).parse(value);
}

export function downloadIdentity(operation: GitHubDownload, value: unknown) {
  requireDownloadMetadata(operation, value);
  const identity = { id: z.number().int(), created_at: z.string().optional(), updated_at: z.string().optional() };
  if (operation.kind === 'release.download')
    return z
      .object({
        ...identity,
        name: z.string(),
        size: z.number().int().nonnegative(),
        state: z.string().optional(),
        digest: z.string().nullable().optional(),
      })
      .parse(value);
  if (operation.kind === 'actions.artifact-download')
    return z
      .object({
        ...identity,
        name: z.string(),
        size_in_bytes: z.number().int().nonnegative(),
        expired: z.literal(false),
        expires_at: z.iso.datetime(),
        digest: z.string().nullable().optional(),
        workflow_run: z.object({ id: z.number().int(), head_sha: z.string().optional() }).optional(),
      })
      .parse(value);
  return z
    .object({
      ...identity,
      status: z.literal('completed'),
      run_attempt: z.number().int().positive(),
      head_sha: z.string().optional(),
    })
    .parse(value);
}

let activeDownloads = 0;
export async function fetchGitHubDownload(input: {
  operation: GitHubDownload;
  credential: GitHubCredential;
  fetcher?: typeof fetch;
}) {
  if (activeDownloads >= 4) throw new GitHubReadError('read-limit');
  activeDownloads++;
  const signal = AbortSignal.timeout(10000);
  const fetcher: typeof fetch = observeFetch('github', 'download', (url, init) =>
    (input.fetcher ?? fetch)(url, {
      ...init,
      signal: AbortSignal.any([signal, ...(init?.signal ? [init.signal] : [])]),
    }),
  );
  const { operation, credential } = input;
  const metadataOperation = downloadMetadataOperation(operation);
  const metadata = async () =>
    downloadIdentity(operation, (await dispatchGitHubRead({ operation: metadataOperation, credential, fetcher })).data);
  try {
    const before = await metadata();
    let filename: string;
    let expectedSize: number | undefined;
    let expectedDigest: string | undefined;
    let attempt: number | undefined;
    if (operation.kind === 'actions.run-logs-download') {
      const run = z.object({ status: z.literal('completed'), run_attempt: z.number().int().positive() }).parse(before);
      attempt = run.run_attempt;
      filename = `run-${operation.id}-attempt-${run.run_attempt}-logs.zip`;
    } else {
      const asset = z
        .object({
          name: z.string().min(1).max(1024),
          size: z.number().int().nonnegative().optional(),
          size_in_bytes: z.number().int().nonnegative().optional(),
          expired: z.boolean().optional(),
          expires_at: z.string().nullable().optional(),
          digest: z.string().nullable().optional(),
        })
        .parse(before);
      if (asset.expired || (asset.expires_at && Date.parse(asset.expires_at) <= Date.now()))
        throw new GitHubReadError('read-unavailable');
      const size = operation.kind === 'release.download' ? asset.size : asset.size_in_bytes;
      if (size === undefined || size > 10485760) throw new GitHubReadError('read-limit');
      if (operation.kind === 'release.download') expectedSize = size;
      if (asset.digest?.startsWith('sha256:')) expectedDigest = asset.digest.slice(7);
      filename =
        asset.name
          .replace(/[^A-Za-z0-9_.-]/g, '_')
          .replace(/^\.+/, '')
          .slice(0, 150) || `download-${operation.id}`;
      if (operation.kind === 'actions.artifact-download') filename += '.zip';
    }
    const root = `https://api.github.com/repos/${encodeURIComponent(operation.owner)}/${encodeURIComponent(operation.repo)}`;
    const path =
      operation.kind === 'release.download'
        ? `/releases/assets/${operation.id}`
        : operation.kind === 'actions.artifact-download'
          ? `/actions/artifacts/${operation.id}/zip`
          : `/actions/runs/${operation.id}/attempts/${attempt}/logs`;
    let response = await fetcher(root + path, {
      redirect: 'manual',
      headers: {
        Authorization: `Bearer ${credential.accessToken}`,
        Accept: operation.kind === 'release.download' ? 'application/octet-stream' : 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'TulipFarm',
      },
    });
    if (response.status === 401) {
      await response.body?.cancel();
      throw new GitHubCredentialRejected();
    }
    if (response.status === 302) {
      const rawLocation = response.headers.get('location') ?? '';
      await response.body?.cancel();
      if (rawLocation.length > 8192) throw new GitHubReadError('read-unavailable');
      const location = new URL(rawLocation);
      const allowed =
        operation.kind === 'release.download'
          ? location.hostname === 'release-assets.githubusercontent.com' ||
            location.hostname === 'objects.githubusercontent.com'
          : /^[a-z0-9-]+\.actions\.githubusercontent\.com$/.test(location.hostname) ||
            /^productionresultssa[0-9]+\.blob\.core\.windows\.net$/.test(location.hostname);
      if (
        !allowed ||
        location.protocol !== 'https:' ||
        location.port ||
        location.username ||
        location.password ||
        location.hash ||
        [
          credential.accessToken,
          encodeURIComponent(credential.accessToken),
          Buffer.from(credential.accessToken).toString('base64'),
          Buffer.from(credential.accessToken).toString('base64url'),
        ].some(secret => decodeURIComponent(location.href).includes(secret))
      )
        throw new GitHubReadError('read-unavailable');
      response = await fetcher(location, { redirect: 'manual', headers: { Accept: 'application/octet-stream' } });
    }
    if (response.status !== 200 || !response.body) {
      await response.body?.cancel();
      throw new GitHubReadError('read-unavailable');
    }
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      if (Number(response.headers.get('content-length')) > 10485760) throw new GitHubReadError('read-limit');
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        size += chunk.value.byteLength;
        if (size > 10485760) throw new GitHubReadError('read-limit');
        chunks.push(chunk.value);
      }
    } finally {
      await reader.cancel();
    }
    const bytes = Buffer.concat(chunks);
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    if (!size || (expectedSize !== undefined && size !== expectedSize) || (expectedDigest && sha256 !== expectedDigest))
      throw new GitHubReadError('read-unavailable');
    if (JSON.stringify(await metadata()) !== JSON.stringify(before)) throw new GitHubReadError('read-unavailable');
    signal.throwIfAborted();
    return { bytes, filename, size, sha256, metadata: before, metadataOperation };
  } catch (error) {
    if (error instanceof GitHubReadError || error instanceof GitHubCredentialRejected) throw error;
    throw new GitHubReadError('read-unavailable');
  } finally {
    activeDownloads--;
  }
}
