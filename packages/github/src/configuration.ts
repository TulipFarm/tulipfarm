import { githubConfiguration, hasScopes } from './provider.ts';
import { githubReadBindings } from './read-provider.ts';
import { githubWriteBindings } from './write-provider.ts';

export const githubOperationScopes = [
  'read:user',
  'read:org',
  'repo',
  'workflow',
  'delete_repo',
  'project',
  'write:discussion',
];

export function githubRuntimeConfiguration(env: NodeJS.ProcessEnv = process.env) {
  const oauth = githubConfiguration(env);
  const readBindings = githubReadBindings(env);
  const writeBindings = githubWriteBindings(env);
  const bindingValues = [env.GITHUB_MCP_READ_BINDINGS, env.GITHUB_MCP_WRITE_BINDINGS];
  if (!oauth && bindingValues.some(value => value !== undefined))
    throw new Error('GitHub MCP bindings require OAuth configuration');
  if (
    oauth &&
    env.NODE_ENV === 'production' &&
    (bindingValues.some(value => value === undefined) || !hasScopes(oauth.scopes, githubOperationScopes))
  ) {
    throw new Error('GitHub production configuration requires operation scopes and both reviewed binding arrays');
  }
  return { oauth, readBindings, writeBindings };
}
