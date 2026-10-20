import { z } from 'zod';

export const accountRoutes = [
  { path: 'login', title: 'Log in' },
  { path: 'signup', title: 'Sign up' },
  { path: 'register', title: 'Register' },
  { path: 'logout', title: 'Log out' },
  { path: 'forgot-password', title: 'Forgot password' },
  { path: 'reset-password', title: 'Reset password' },
  { path: 'verify-email', title: 'Verify email' },
  { path: 'complete-profile', title: 'Complete your profile' },
  { path: 'invite', title: 'Accept invitation' },
  { path: 'auth', title: 'Authentication' },
  { path: 'callback', title: 'Authentication callback' },
] as const;

export const reservedWorkspaceSlugs: ReadonlySet<string> = new Set([
  ...accountRoutes.map(route => route.path),
  'create-workspace',
  'workspace-setups',
  'workspaces',
  'onboarding',
  'design-system',
  'account',
  'settings',
  'admin',
  'api',
  'assets',
  'help',
  'support',
  'billing',
  'privacy',
  'terms',
  'www',
]);

export function workspaceSlugError(slug: string): string | undefined {
  if (reservedWorkspaceSlugs.has(slug.toLowerCase())) {
    return 'This URL is reserved by TulipFarm. Choose another one.';
  }
  if (slug.length < 3 || slug.length > 48) {
    return 'Use between 3 and 48 characters.';
  }
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) {
    return 'Use lowercase letters, numbers, and single hyphens between words.';
  }
  return undefined;
}

export function suggestWorkspaceSlug(name: string): string {
  return name
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .slice(0, 48)
    .replace(/^-|-$/g, '');
}

// Browser shrinks to 128px WebP (about 32 KB). Base64 of 32 KB is under 45,000 characters.
export const avatarImageSchema = z
  .string()
  .max(45_000)
  .regex(/^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/);

export const accountSignInMethodsSchema = z.strictObject({
  methods: z.array(z.enum(['email-link', 'google'])),
});

export const createWorkspaceSchema = z
  .object({
    requestId: z.uuid(),
    name: z.string().trim().min(1).max(80),
    slug: z.string().refine(slug => !workspaceSlugError(slug), 'Invalid workspace URL'),
    icon: avatarImageSchema.optional(),
  })
  .strict();

const workspaceFields = {
  id: z.uuid(),
  name: z.string(),
  slug: z.string(),
  icon: avatarImageSchema.nullable().default(null),
  createdAt: z.iso.datetime(),
};
export const workspaceSchema = z.discriminatedUnion('status', [
  z.object({ ...workspaceFields, status: z.literal('provisioning') }),
  z.object({ ...workspaceFields, status: z.literal('ready'), soulCommit: z.string().regex(/^[a-f0-9]{40}$/) }),
]);
export const workspaceListSchema = z.array(workspaceSchema);
export const workspaceSetupSchema = z.object({
  id: z.uuid(),
  stage: z.enum(['reserved', 'database', 'ready', 'unavailable']),
  error: z.enum(['setup_failed', 'incompatible_version']).nullable(),
});
export type Workspace = z.infer<typeof workspaceSchema>;
export type CreateWorkspace = z.infer<typeof createWorkspaceSchema>;
