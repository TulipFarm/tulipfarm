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

export const appRecipeSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('copy'), root: treePathSchema.default('.') }),
  z.strictObject({
    kind: z.literal('command'),
    runtime: z.enum(['node22']),
    install: z.string().min(1).max(500).optional(),
    command: z.string().min(1).max(500),
    output: treePathSchema,
  }),
]);
export type AppRecipe = z.infer<typeof appRecipeSchema>;

export const defaultAppRecipe: AppRecipe = Object.freeze({ kind: 'copy', root: '.' });

/** The builder folded into a build's id. A command needs the server's builder, so without one it has none. */
export function recipeBuilder(recipe: AppRecipe, commandBuilder: string | undefined) {
  return recipe.kind === 'copy' ? 'copy' : commandBuilder;
}

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
