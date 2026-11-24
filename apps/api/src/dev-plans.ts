import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { parseEnv, promisify } from 'node:util';
import type { TokenPlan, TokenPlanProvider } from '@tulipfarm/integrations/token-plans';
import { devSessionsAllowed } from './dev-session.ts';

const run = promisify(execFile);
const providers = ['claude', 'copilot'] as const satisfies readonly TokenPlanProvider[];
const retryMs = 5 * 60_000;

type Logger = { warn: (details: object, message: string) => void };
type Source = { token: string } | { command: string };

/** The machine-wide development file, outside every checkout so each worktree's stack shares it. */
export function devPlansFile(env: NodeJS.ProcessEnv = process.env) {
  return env.TULIPFARM_DEV_ENV_FILE?.trim() || join(homedir(), '.tulipfarm', 'dev.env');
}

/** `TULIPFARM_DEV_PLAN_<PROVIDER>_TOKEN`, or `_TOKEN_COMMAND` printing one, from the process env or the dev file. */
export function devPlanSources(env: NodeJS.ProcessEnv = process.env, file = devPlansFile(env)) {
  let values: Record<string, string | undefined> = {};
  try {
    values = parseEnv(readFileSync(file, 'utf8'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const merged = { ...values, ...env };
  const sources = new Map<TokenPlanProvider, Source>();
  for (const provider of providers) {
    const name = `TULIPFARM_DEV_PLAN_${provider.toUpperCase()}_TOKEN`;
    const token = merged[name]?.trim();
    const command = merged[`${name}_COMMAND`]?.trim();
    if (token) sources.set(provider, { token });
    else if (command) sources.set(provider, { command });
  }
  return sources;
}

/**
 * Local development only: connects each member's own Claude or Copilot plan from a token on this machine the first
 * time their model catalog loads, so a fresh database or workspace offers plan models without signing in again.
 * Undefined outside local development or when no token is configured.
 */
export function createDevPlans(
  plans: Partial<Record<TokenPlanProvider, TokenPlan | null>>,
  log: Logger,
  env: NodeJS.ProcessEnv = process.env,
) {
  if (!devSessionsAllowed(env)) return undefined;
  const sources = [...devPlanSources(env)].filter(([provider]) => plans[provider]);
  if (!sources.length) return undefined;
  const tokens = new Map<TokenPlanProvider, Promise<string>>();
  const tokenFor = (provider: TokenPlanProvider, source: Source) => {
    let token = tokens.get(provider);
    if (!token) {
      token =
        'token' in source
          ? Promise.resolve(source.token)
          : run('/bin/sh', ['-c', source.command], { timeout: 15_000 }).then(({ stdout }) => stdout.trim());
      token.catch(() => tokens.delete(provider));
      tokens.set(provider, token);
    }
    return token;
  };
  const settled = new Map<string, number>();
  return {
    async ensure(workspaceId: string, userId: string) {
      await Promise.all(
        sources.map(async ([provider, source]) => {
          const plan = plans[provider]!;
          const key = `${provider}:${workspaceId}:${userId}`;
          const at = settled.get(key);
          if (at !== undefined && (at === Infinity || Date.now() < at)) return;
          try {
            const { connections } = await plan.status(workspaceId, userId);
            if (!connections.some(connection => connection.state === 'connected'))
              await plan.connectToken(workspaceId, userId, await tokenFor(provider, source));
            settled.set(key, Infinity);
          } catch (error) {
            settled.set(key, Date.now() + retryMs);
            log.warn(
              { provider, workspaceId, error: error instanceof Error ? error.message : String(error) },
              'Development plan connection failed',
            );
          }
        }),
      );
    },
  };
}
