import { unavailableAppHost, type AppBuilder, type AppHost } from '@tulipfarm/extensions';
import { z } from 'zod';
import type { AppFailure } from './app.ts';
import { buildIdSchema, type AppBuildId, type AppId, type GitCommit } from './ids.ts';

// A recipe path names a directory inside the app's own tree, so a build can never read or write outside it.
const treePathSchema = z
  .string()
  .min(1)
  .max(512)
  .refine(path => !path.startsWith('/') && !path.includes('\\'), { error: 'Use a relative path with / separators' })
  .refine(path => path.split('/').every(segment => segment !== '..' && segment.toLowerCase() !== '.git'), {
    error: 'Path must stay inside the app',
  });

const stepSchema = z.string().min(1).max(500);
const port = { error: 'Use a whole number port from 1024 to 65535' };
const start = { error: 'Name the command that starts the server' };

export const appRecipeSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('copy'), root: treePathSchema.default('.') }),
  z.strictObject({
    kind: z.literal('command'),
    runtime: z.enum(['node22']),
    install: stepSchema.optional(),
    command: stepSchema,
    output: treePathSchema,
  }),
  z.strictObject({
    kind: z.literal('server'),
    runtime: z.enum(['node22']),
    install: stepSchema.optional(),
    command: stepSchema.optional(),
    serve: z.strictObject({
      port: z.int(port).min(1024, port).max(65535, port),
      start: z
        .string(start)
        .max(500)
        .refine(command => command.trim() !== '', start),
    }),
  }),
]);
export type AppRecipe = z.infer<typeof appRecipeSchema>;

export const defaultAppRecipe: AppRecipe = Object.freeze({ kind: 'copy', root: '.' });

/** The builder ids this server builds with: `command` for command recipes, `server` for server recipes. */
export type AppBuilders = { readonly command: string | undefined; readonly server: string | undefined };

/**
 * Which recipes the registered builder and host can build. A server recipe builds only when a host can run it and the
 * builder can package a server.
 */
export function appBuilders(builder: AppBuilder | undefined, host: AppHost): AppBuilders {
  return { command: builder?.id, server: builder?.buildServer && host !== unavailableAppHost ? builder.id : undefined };
}

/** The builder folded into a build's id, or why this server cannot build the recipe. */
export function recipeBuilder(
  recipe: AppRecipe,
  builders: AppBuilders,
): { readonly ok: true; readonly builder: string } | { readonly ok: false; readonly failure: AppFailure } {
  switch (recipe.kind) {
    case 'copy':
      return { ok: true, builder: 'copy' };
    case 'command':
      return builders.command
        ? { ok: true, builder: builders.command }
        : refused('builder-unavailable', 'This server cannot run build commands');
    case 'server':
      return builders.server
        ? { ok: true, builder: builders.server }
        : refused('host-unavailable', 'This server cannot run apps that start their own server');
  }
}

const refused = (code: AppFailure['code'], message: string) =>
  ({ ok: false, failure: { code, message, retryable: false } }) as const;

/** The one workflow that builds a build, whichever service starts it. */
export const appBuildWorkflowId = (buildId: string) => `app-build-${buildId}`;

/** Reads the optional `app.json` at the commit root. A tree without one is copied as is. */
export function readAppRecipe(
  appJson: string | null,
): { readonly ok: true; readonly recipe: AppRecipe } | { readonly ok: false; readonly failure: AppFailure } {
  if (appJson === null) return { ok: true, recipe: defaultAppRecipe };
  let value: unknown;
  try {
    value = JSON.parse(appJson);
  } catch {
    return { ok: false, failure: recipeInvalid('app.json is not valid JSON') };
  }
  const parsed = appRecipeSchema.safeParse(value);
  if (parsed.success) return { ok: true, recipe: parsed.data };
  const issue = parsed.error.issues[0];
  const at = issue?.path.length ? `${issue.path.join('.')}: ` : '';
  return { ok: false, failure: recipeInvalid(`app.json ${at}${issue?.message ?? 'is invalid'}`) };
}

function recipeInvalid(message: string): AppFailure {
  return { code: 'recipe-invalid', message, retryable: false };
}

/**
 * The same app, commit and recipe on the same builder is the same build, so requesting a build is idempotent by
 * construction.
 */
export async function appBuildId(
  appId: AppId,
  commit: GitCommit,
  recipe: AppRecipe,
  builder: string,
): Promise<AppBuildId> {
  const input = `${appId}\n${commit}\n${canonicalRecipe(recipe)}\n${builder}`;
  const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
  return buildIdSchema.parse(Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join(''));
}

function canonicalRecipe(recipe: AppRecipe) {
  const entries = Object.entries(recipe)
    .filter(([, value]) => value !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return JSON.stringify(Object.fromEntries(entries));
}
