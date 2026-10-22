import type { CorpusProvider } from '@tulipfarm/memory-core/ports/corpus-provider';
import type { GoogleCorpusProvider } from '@tulipfarm/google-workspace/corpus';
import type { SlackCorpusProvider } from './slack-contracts.ts';
import type { GitHubCorpusProvider } from './github-contracts.ts';
import type { AtlassianCorpusProvider } from './atlassian-contracts.ts';

type Operation<Method> = Method extends (...input: infer Input) => Promise<infer Result>
  ? { input: Input; result: Result }
  : never;

type GoogleCorpus = CorpusProvider<{
  discover: Operation<GoogleCorpusProvider['list']>;
  fetch: Operation<GoogleCorpusProvider['read']>;
  permissions: Operation<GoogleCorpusProvider['check']>;
}>;
type SlackCorpus = CorpusProvider<{
  discover: Operation<SlackCorpusProvider['list']>;
  fetch: Operation<SlackCorpusProvider['read']>;
  permissions: Operation<SlackCorpusProvider['access']>;
}>;
type GitHubCorpus = CorpusProvider<{
  discover: Operation<GitHubCorpusProvider['list']>;
  fetch: Operation<GitHubCorpusProvider['read']>;
  permissions: Operation<GitHubCorpusProvider['access']>;
}>;
type AtlassianCorpus = CorpusProvider<{
  discover: Operation<AtlassianCorpusProvider['list']>;
  fetch: Operation<AtlassianCorpusProvider['read']>;
  permissions: Operation<AtlassianCorpusProvider['access']>;
}>;

export function createGoogleCorpusAdapter(provider: GoogleCorpusProvider): GoogleCorpus {
  return {
    discover: (...input) => provider.list(...input),
    fetch: (...input) => provider.read(...input),
    permissions: (...input) => provider.check(...input),
  };
}

export function createSlackCorpusAdapter(provider: SlackCorpusProvider): SlackCorpus {
  return {
    discover: (...input) => provider.list(...input),
    fetch: (...input) => provider.read(...input),
    permissions: (...input) => provider.access(...input),
  };
}

export function createGitHubCorpusAdapter(provider: GitHubCorpusProvider): GitHubCorpus {
  return {
    discover: (...input) => provider.list(...input),
    fetch: (...input) => provider.read(...input),
    permissions: (...input) => provider.access(...input),
  };
}

export function createAtlassianCorpusAdapter(provider: AtlassianCorpusProvider): AtlassianCorpus {
  return {
    discover: (...input) => provider.list(...input),
    fetch: (...input) => provider.read(...input),
    permissions: (...input) => provider.access(...input),
  };
}
