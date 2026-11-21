import { randomUUID } from 'node:crypto';

/**
 * An in-memory Keep with a file tree per scope, one ledger sequence, compare-and-swap writes, metadata, a trash, undo
 * and forget, plus knowledge sources of episodes with keyword search and forget_source.
 */
export function fakeKeep() {
  let seq = 0;
  const files = new Map();
  const sources = new Map();
  const sourceKey = (scope, sourceId) => `${scope.user}\u0000${sourceId}`;
  const calls = [];
  const key = (scope, path = '/profile.md') => `${scope.user}\u0000${path}`;
  const inScope = scope => [...files.entries()].filter(([name]) => name.startsWith(`${scope.user}\u0000`));
  const youPath = path => path === '/profile.md' || /^\/you\/[^/]+\.md$/.test(path);
  const head = file => file.revisions.at(-1);
  const headOf = file => ({ revisionId: head(file).revisionId, version: String(head(file).seq) });
  const revise = (file, text, change) => {
    seq += 1;
    file.revisions.push({ revisionId: randomUUID(), seq, text, change, at: new Date(Date.now() + seq).toISOString() });
  };
  const outcome = file => ({
    memoryId: file.memoryId,
    head: headOf(file),
    seq,
    changed: true,
    replayed: false,
    revisionId: head(file).revisionId,
  });
  const defaultName = path =>
    path
      .split('/')
      .at(-1)
      .replace(/\.md$/, '')
      .replace(/-/g, ' ')
      .replace(/^./, letter => letter.toUpperCase());
  const client = {
    available: true,
    /** Set to a result to make the next write answer with it instead of writing. */
    failWrite: undefined,
    async history({ scope, path }) {
      calls.push('history');
      if (!client.available) return { status: 'unavailable', reason: 'unreachable' };
      const file = files.get(key(scope, path));
      if (!file) return { status: 'not_found' };
      return {
        status: 'ok',
        value: {
          memoryId: file.memoryId,
          revisions: file.revisions.map((revision, index) => ({
            revisionId: revision.revisionId,
            seq: revision.seq,
            change: revision.change,
            createdAt: revision.at,
            version: String(revision.seq),
            path: path ?? '/profile.md',
            isHead: index === file.revisions.length - 1,
          })),
        },
      };
    },
    async read({ scope, path = '/profile.md' }) {
      calls.push('read');
      if (!client.available) return { status: 'unavailable', reason: 'unreachable' };
      const file = files.get(key(scope, path));
      if (!file || file.trashed) return { status: 'not_found' };
      const current = headOf(file);
      return {
        status: 'ok',
        value: { memoryId: file.memoryId, path, ...current, isHead: true, head: current, text: head(file).text },
      };
    },
    async write({ scope, path = '/profile.md', text, expectedRevisionId, description }) {
      calls.push('write');
      if (!client.available) return { status: 'unavailable', reason: 'unreachable' };
      if (client.failWrite) {
        const failure = client.failWrite;
        client.failWrite = undefined;
        return failure;
      }
      if (new TextEncoder().encode(text).length > 8192) return { status: 'rejected', code: 'limit_exceeded' };
      let file = files.get(key(scope, path));
      if (file ? file.trashed || expectedRevisionId !== head(file).revisionId : expectedRevisionId !== undefined)
        return { status: 'conflict', ...(file ? { current: headOf(file) } : {}) };
      if (!file)
        files.set(
          key(scope, path),
          (file = {
            memoryId: `mem_${randomUUID()}`,
            revisions: [],
            trashed: false,
            displayName: defaultName(path),
            description: '',
          }),
        );
      if (description !== undefined) file.description = description;
      revise(file, text, 'edit');
      return { status: 'ok', value: outcome(file) };
    },
    async updateMetadata({ scope, path, expectedRevisionId, displayName, description }) {
      calls.push('update_metadata');
      if (!client.available) return { status: 'unavailable', reason: 'unreachable' };
      const file = files.get(key(scope, path));
      if (!file || file.trashed) return { status: 'not_found' };
      if (expectedRevisionId !== head(file).revisionId) return { status: 'conflict', current: headOf(file) };
      if (displayName !== undefined) file.displayName = displayName;
      if (description !== undefined) file.description = description;
      revise(file, head(file).text, 'metadata');
      return {
        status: 'ok',
        value: { ...outcome(file), path, displayName: file.displayName, description: file.description },
      };
    },
    async list({ scope, includeTrashed }) {
      calls.push('list');
      if (!client.available) return { status: 'unavailable', reason: 'unreachable' };
      return {
        status: 'ok',
        value: {
          files: inScope(scope)
            .filter(([, file]) => includeTrashed || !file.trashed)
            .map(([name, file]) => {
              const path = name.slice(name.indexOf('\u0000') + 1);
              return {
                memoryId: file.memoryId,
                path,
                category: youPath(path) ? 'you' : (path.split('/')[1] ?? null),
                displayName: file.displayName,
                description: file.description,
                revisionId: head(file).revisionId,
                version: String(head(file).seq),
                sizeBytes: new TextEncoder().encode(head(file).text).length,
                updatedAt: head(file).at,
                trashed: file.trashed,
              };
            })
            .sort((a, b) => a.path.localeCompare(b.path)),
          nextAfter: null,
        },
      };
    },
    async delete({ scope, path, expectedRevisionId }) {
      calls.push('delete');
      const file = files.get(key(scope, path));
      if (!file || file.trashed) return { status: 'not_found' };
      if (expectedRevisionId !== head(file).revisionId) return { status: 'conflict', current: headOf(file) };
      file.trashed = true;
      seq += 1;
      return { status: 'ok', value: outcome(file) };
    },
    async restore({ scope, path }) {
      calls.push('restore');
      const file = files.get(key(scope, path));
      if (!file) return { status: 'not_found' };
      file.trashed = false;
      return { status: 'ok', value: outcome(file) };
    },
    async undo({ scope, path, expectedRevisionId }) {
      calls.push('undo');
      const file = files.get(key(scope, path));
      if (!file || file.revisions.length < 2) return { status: 'conflict' };
      if (expectedRevisionId !== head(file).revisionId) return { status: 'conflict', current: headOf(file) };
      revise(file, file.revisions.at(-2).text, 'undo');
      return { status: 'ok', value: outcome(file) };
    },
    async forget({ scope, path, text }) {
      calls.push('forget');
      if (!client.available) return { status: 'unavailable', reason: 'unreachable' };
      const targets = path === undefined ? inScope(scope) : [[key(scope, path), files.get(key(scope, path))]];
      if (targets.some(([, file]) => !file)) return { status: 'not_found' };
      const affected = [];
      for (const [name, file] of targets) {
        if (text === undefined) files.delete(name);
        else if (file.revisions.some(revision => revision.text.includes(text))) {
          for (const revision of file.revisions) revision.text = revision.text.replaceAll(text, '');
          revise(file, head(file).text, 'forget');
          affected.push(name.slice(name.indexOf('\u0000') + 1));
        }
      }
      return {
        status: 'ok',
        value: { erasureSeq: seq, filesAffected: affected, filesPurged: [], revisionsPurged: 0 },
      };
    },
    async memoryContext({ includeKnowledge, includePersonal, scope }) {
      calls.push('context');
      if (includeKnowledge !== false || includePersonal !== true) throw new Error('Personal context only');
      const live = (await client.list({ scope })).value.files;
      const text = path => head(files.get(key(scope, path))).text;
      const blocks = [
        'BEGIN MEMORY CONTEXT\nNotes. Files marked as excerpts or left out can be read in full with memory.view.',
        ...live
          .filter(file => file.category === 'you')
          .flatMap(file => ['UNTRUSTED MEMORY PROFILE', JSON.stringify({ path: file.path, text: text(file.path) })]),
        'MEMORY FILE DIRECTORY',
        JSON.stringify({ files: live.map(file => ({ path: file.path, description: file.description })) }),
        ...live
          .filter(file => file.category !== 'you')
          .flatMap(file => ['UNTRUSTED MEMORY FILE', JSON.stringify({ path: file.path, text: text(file.path) })]),
        'END MEMORY CONTEXT',
      ];
      return { status: 'ok', value: { text: blocks.join('\n'), tokens: 1, scope: '', notes: [] } };
    },
    async ingestKnowledge(input) {
      calls.push('ingest');
      if (!client.available) return { status: 'unavailable', reason: 'unreachable' };
      const key = sourceKey(input.scope, input.sourceId);
      const source = sources.get(key) ?? {
        scope: input.scope.user,
        metadata: input.metadata ?? {},
        episodes: new Map(),
      };
      let added = 0;
      for (const episode of input.episodes) {
        const existing = source.episodes.get(episode.id);
        if (existing !== undefined && existing.text !== episode.text) return { status: 'conflict' };
        if (existing === undefined) added += 1;
        source.episodes.set(episode.id, episode);
      }
      sources.set(key, source);
      return {
        status: 'ok',
        value: {
          sourceId: input.sourceId,
          replaced: false,
          episodesAdded: added,
          episodesUnchanged: input.episodes.length - added,
        },
      };
    },
    async searchKnowledge(input) {
      calls.push('search');
      if (!client.available) return { status: 'unavailable', reason: 'unreachable' };
      const words = input.query
        .toLowerCase()
        .split(/\W+/)
        .filter(word => word.length > 2);
      const hits = [];
      for (const [key, source] of sources) {
        const sourceId = key.slice(key.indexOf('\u0000') + 1);
        if (source.scope !== input.scope.user || (input.sourceIds && !input.sourceIds.includes(sourceId))) continue;
        for (const episode of source.episodes.values()) {
          const score = words.filter(word => episode.text.toLowerCase().includes(word)).length;
          if (!score) continue;
          const episodeId = `${sourceId}#${episode.id}`;
          hits.push({
            id: `chunk_${episode.id}`,
            score,
            sourceId,
            text: episode.text,
            citation: {
              sourceId,
              episodeId,
              charStart: 0,
              charEnd: episode.text.length,
              sourceMetadata: source.metadata,
            },
          });
        }
      }
      hits.sort((a, b) => b.score - a.score);
      return { status: 'ok', value: { hits: hits.slice(0, input.limit ?? 10), omitted: 0 } };
    },
    async forgetKnowledgeSource({ scope, sourceId }) {
      calls.push('forget_source');
      if (!client.available) return { status: 'unavailable', reason: 'unreachable' };
      const source = sources.get(sourceKey(scope, sourceId));
      if (!source) return { status: 'not_found' };
      sources.delete(sourceKey(scope, sourceId));
      return { status: 'ok', value: { episodes: source.episodes.size, chunks: source.episodes.size } };
    },
  };
  return { client, calls, files, sources };
}
