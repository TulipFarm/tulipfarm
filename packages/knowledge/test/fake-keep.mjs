import { randomUUID } from 'node:crypto';
import { createKnowledgeKeepFeed, createKnowledgeKeepIndex, createKnowledgeSearch } from '../dist/index.js';

/**
 * An in-memory Keep knowledge corpus: per-scope sources of episodes, keyword search and forget. `state.timeouts` holds
 * source ids whose ingest times out, and `state.beforeIngest` runs before each ingest; a result it returns is answered
 * instead. With `state.batch` false, Keep has no batch forget route.
 */
export function fakeKnowledgeKeep() {
  const corpora = new Map();
  const calls = [];
  const state = { available: true, batch: true, timeouts: new Set(), beforeIngest: undefined };
  const corpus = scope => {
    if (!corpora.has(scope.user)) corpora.set(scope.user, new Map());
    return corpora.get(scope.user);
  };
  const down = { status: 'unavailable', reason: 'unreachable' };
  const client = {
    async ingestKnowledge(input) {
      calls.push({ op: 'ingest', ...input });
      const answer = await state.beforeIngest?.(input);
      if (answer) return answer;
      if (!state.available) return down;
      if (state.timeouts.has(input.sourceId)) return { status: 'unavailable', reason: 'timeout' };
      const sources = corpus(input.scope);
      const existing = sources.get(input.sourceId);
      const source =
        existing && !input.replace
          ? existing
          : { title: input.title, collection: input.collection, metadata: input.metadata ?? {}, episodes: new Map() };
      for (const episode of input.episodes) source.episodes.set(episode.id, episode.text);
      sources.set(input.sourceId, source);
      return {
        status: 'ok',
        value: {
          sourceId: input.sourceId,
          replaced: Boolean(input.replace),
          episodesAdded: input.episodes.length,
          episodesUnchanged: 0,
        },
      };
    },
    async searchKnowledge(input) {
      calls.push({ op: 'search', ...input });
      if (!state.available) return down;
      const words = input.query.toLowerCase().split(/\s+/).filter(Boolean);
      const hits = [];
      for (const [sourceId, source] of corpus(input.scope)) {
        if (input.sourceIds && !input.sourceIds.includes(sourceId)) continue;
        for (const [episodeId, text] of source.episodes) {
          const score = words.filter(word => text.toLowerCase().includes(word)).length;
          if (!score) continue;
          hits.push({
            id: `${sourceId}#${episodeId}`,
            score,
            sourceId,
            text,
            citation: {
              sourceId,
              sourceTitle: source.title,
              episodeId: `${sourceId}#${episodeId}`,
              charStart: 0,
              charEnd: text.length,
              quote: text,
              sourceMetadata: source.metadata,
            },
          });
        }
      }
      return { status: 'ok', value: { hits: hits.sort((a, b) => b.score - a.score), omitted: 0 } };
    },
    async forgetKnowledgeSource(input) {
      calls.push({ op: 'forget', ...input });
      if (!state.available) return down;
      if (!corpus(input.scope).delete(input.sourceId)) return { status: 'not_found' };
      return { status: 'ok', value: { episodes: 1, chunks: 1 } };
    },
    async forgetKnowledgeSources(input) {
      calls.push({ op: 'forgetMany', ...input });
      if (!state.batch) return { status: 'not_found' };
      if (!state.available) return down;
      const sources = corpus(input.scope);
      const forgotten = [];
      const missing = [];
      for (const sourceId of input.sourceIds) {
        if (sources.delete(sourceId)) forgotten.push({ sourceId, receipt: { episodes: 1, chunks: 1 } });
        else missing.push(sourceId);
      }
      return { status: 'ok', value: { forgotten, missing } };
    },
  };
  return { client, calls, state, corpora };
}

// One corpus per process: delivery state lives in each workspace's tables, so every search over the same workspace must
// read the same Keep.
const sharedKeep = fakeKnowledgeKeep();

/**
 * Knowledge search backed by an in-memory Keep shared by the whole test process. `search.search` first delivers every
 * due document of the workspace, so tests can search right after writing documents; `query` runs a submitted search.
 */
export function keepBackedSearch({ runtime, ...options }) {
  const keep = sharedKeep;
  const feed = createKnowledgeKeepFeed({ runtime, client: () => keep.client });
  const engine = createKnowledgeSearch({
    runtime,
    ...options,
    index: createKnowledgeKeepIndex({ client: () => keep.client }),
  });
  async function deliver(workspaceId) {
    let after = null;
    for (;;) {
      const page = await feed.due(workspaceId, after, 50);
      if (!page.length) return;
      for (const work of page) await feed.sync(workspaceId, work.document_id);
      after = page.at(-1).document_id;
    }
  }
  const search = {
    ...engine,
    async search(workspaceId, ...rest) {
      await deliver(workspaceId);
      return engine.search(workspaceId, ...rest);
    },
  };
  return {
    keep,
    feed,
    search,
    deliver,
    query: (workspaceId, userId, query, filters) =>
      search.search(workspaceId, userId, {
        kind: 'submitted',
        commandId: randomUUID(),
        query,
        ...(filters ? { filters } : {}),
      }),
  };
}
