import { randomUUID } from 'node:crypto';

/**
 * An in-memory Keep with one ledger sequence, compare-and-swap writes, a trash, undo and forget, plus knowledge sources
 * of episodes with keyword search and forget_source.
 */
export function fakeKeep() {
  let seq = 0;
  const files = new Map();
  const sources = new Map();
  const sourceKey = (scope, sourceId) => `${scope.user}\u0000${sourceId}`;
  const calls = [];
  const key = scope => scope.user;
  const head = file => file.revisions.at(-1);
  const headOf = file => ({ revisionId: head(file).revisionId, version: String(head(file).seq) });
  const revise = (file, text, change) => {
    seq += 1;
    file.revisions.push({ revisionId: randomUUID(), seq, text, change });
  };
  const client = {
    available: true,
    /** Set to a result to make the next write answer with it instead of writing. */
    failWrite: undefined,
    async history({ scope }) {
      calls.push('history');
      if (!client.available) return { status: 'unavailable', reason: 'unreachable' };
      const file = files.get(key(scope));
      if (!file) return { status: 'not_found' };
      return {
        status: 'ok',
        value: {
          memoryId: 'm',
          revisions: file.revisions.map((revision, index) => ({
            revisionId: revision.revisionId,
            seq: revision.seq,
            change: revision.change,
            createdAt: '',
            version: String(revision.seq),
            path: '/profile.md',
            isHead: index === file.revisions.length - 1,
          })),
        },
      };
    },
    async read({ scope }) {
      calls.push('read');
      if (!client.available) return { status: 'unavailable', reason: 'unreachable' };
      const file = files.get(key(scope));
      if (!file || file.trashed) return { status: 'not_found' };
      const current = headOf(file);
      return {
        status: 'ok',
        value: { memoryId: 'm', path: '/profile.md', ...current, isHead: true, head: current, text: head(file).text },
      };
    },
    async write({ scope, text, expectedRevisionId }) {
      calls.push('write');
      if (!client.available) return { status: 'unavailable', reason: 'unreachable' };
      if (client.failWrite) {
        const failure = client.failWrite;
        client.failWrite = undefined;
        return failure;
      }
      let file = files.get(key(scope));
      if (file ? expectedRevisionId !== head(file).revisionId : expectedRevisionId !== undefined)
        return { status: 'conflict', ...(file ? { current: headOf(file) } : {}) };
      if (!file) files.set(key(scope), (file = { revisions: [], trashed: false }));
      revise(file, text, 'edit');
      return {
        status: 'ok',
        value: { memoryId: 'm', head: headOf(file), seq, changed: true, replayed: false, revisionId: '' },
      };
    },
    async delete({ scope, expectedRevisionId }) {
      calls.push('delete');
      const file = files.get(key(scope));
      if (!file) return { status: 'not_found' };
      if (expectedRevisionId !== head(file).revisionId) return { status: 'conflict', current: headOf(file) };
      file.trashed = true;
      return { status: 'ok', value: undefined };
    },
    async restore({ scope }) {
      calls.push('restore');
      const file = files.get(key(scope));
      if (!file) return { status: 'not_found' };
      file.trashed = false;
      return { status: 'ok', value: { head: headOf(file) } };
    },
    async undo({ scope, expectedRevisionId }) {
      calls.push('undo');
      const file = files.get(key(scope));
      if (!file || file.revisions.length < 2) return { status: 'conflict' };
      if (expectedRevisionId !== head(file).revisionId) return { status: 'conflict', current: headOf(file) };
      revise(file, file.revisions.at(-2).text, 'undo');
      return { status: 'ok', value: { head: headOf(file) } };
    },
    async forget({ scope, text }) {
      calls.push('forget');
      const file = files.get(key(scope));
      if (!file) return { status: 'not_found' };
      if (text === undefined) files.delete(key(scope));
      else {
        for (const revision of file.revisions) revision.text = revision.text.replaceAll(text, '');
        revise(file, head(file).text, 'forget');
      }
      return { status: 'ok', value: { erasureSeq: seq, filesAffected: [], filesPurged: [], revisionsPurged: 0 } };
    },
    async memoryContext({ includeKnowledge, includePersonal, scope }) {
      calls.push('context');
      if (includeKnowledge !== false || includePersonal !== true) throw new Error('Personal context only');
      const file = files.get(key(scope));
      return { status: 'ok', value: { text: `## Personal\n${head(file).text}`, tokens: 1, scope: '', notes: [] } };
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
