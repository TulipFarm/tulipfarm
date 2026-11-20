/**
 * An in-memory Keep knowledge corpus: per-scope sources of episodes, keyword search and forget. `state.timeouts` holds
 * source ids whose ingest times out, and `state.beforeIngest` runs before each ingest.
 */
export function fakeKnowledgeKeep() {
  const corpora = new Map();
  const calls = [];
  const state = { available: true, timeouts: new Set(), beforeIngest: undefined };
  const corpus = scope => {
    if (!corpora.has(scope.user)) corpora.set(scope.user, new Map());
    return corpora.get(scope.user);
  };
  const down = { status: 'unavailable', reason: 'unreachable' };
  const client = {
    async ingestKnowledge(input) {
      calls.push({ op: 'ingest', ...input });
      await state.beforeIngest?.(input);
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
  };
  return { client, calls, state, corpora };
}
