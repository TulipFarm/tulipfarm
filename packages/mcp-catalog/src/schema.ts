import { z } from 'zod';

export const categories = {
  'email-and-calendar': 'Email and calendar',
  chat: 'Chat and meetings',
  'docs-and-files': 'Docs and files',
  'projects-and-issues': 'Projects and issues',
  code: 'Code',
  'cloud-and-infrastructure': 'Cloud and infrastructure',
  'data-and-databases': 'Data and databases',
  'monitoring-and-analytics': 'Monitoring and analytics',
  'crm-and-sales': 'CRM and sales',
  support: 'Customer support',
  marketing: 'Marketing and social',
  'payments-and-commerce': 'Payments and commerce',
  'finance-and-accounting': 'Finance and accounting',
  'hr-and-recruiting': 'HR and recruiting',
  design: 'Design',
  'search-and-research': 'Search and research',
  automation: 'Automation',
  'ai-and-media': 'AI and media',
  security: 'Security',
} as const;
export type CategoryId = keyof typeof categories;

export const teams = {
  engineering: 'Engineering',
  product: 'Product',
  design: 'Design',
  sales: 'Sales',
  marketing: 'Marketing',
  support: 'Support',
  operations: 'Operations',
  finance: 'Finance',
  hr: 'People and HR',
  everyone: 'Everyone',
} as const;
export type TeamId = keyof typeof teams;

/** Products whose app or connector directory lists the app. */
export const directories = {
  chatgpt: 'ChatGPT',
  claude: 'Claude',
  gemini: 'Gemini',
  'microsoft-copilot': 'Microsoft 365 Copilot',
  'copilot-studio': 'Copilot Studio',
  'notion-ai': 'Notion AI',
  manus: 'Manus',
  perplexity: 'Perplexity',
  lindy: 'Lindy',
  gumloop: 'Gumloop',
  'relevance-ai': 'Relevance AI',
  dust: 'Dust',
  glean: 'Glean',
  zapier: 'Zapier',
  make: 'Make',
  n8n: 'n8n',
  docker: 'Docker MCP Catalog',
  'github-registry': 'GitHub MCP Registry',
} as const;
export type DirectoryId = keyof typeof directories;

const keys = <T extends Record<string, string>>(record: T) =>
  Object.keys(record) as [keyof T & string, ...(keyof T & string)[]];
const https = z.url({ protocol: /^https$/ });
const line = (max: number) =>
  z
    .string()
    .min(2)
    .max(max)
    .regex(/^\S(.*\S)?$/, 'no leading or trailing spaces')
    .refine(value => !value.endsWith('.'), 'no full stop');
const envName = z.string().regex(/^[A-Z][A-Z0-9_]*$/);

const variable = z.strictObject({
  name: envName,
  description: line(120),
  secret: z.boolean(),
  required: z.boolean(),
});

const header = z.strictObject({
  name: z.string().regex(/^[A-Za-z0-9_-]+$/),
  /** Header value, with `{key}` where the person's key goes, or a `{variable}`. */
  value: z.string().regex(/\{[a-z][a-z0-9-]*\}/, 'has a {key} or {variable} placeholder'),
  description: line(120),
});

const urlVariable = z.strictObject({
  name: z.string().regex(/^[a-z][a-z0-9-]*$/),
  description: line(120),
  example: z.string().min(1).optional(),
});

/** Names of the `{placeholders}` in a remote URL. */
export const urlPlaceholders = (url: string) => [...url.matchAll(/\{([a-z][a-z0-9-]*)\}/g)].map(match => match[1]!);

export const remoteSchema = z
  .strictObject({
    /** Server URL. `{key}` is the person's key; other `{placeholders}` are listed in `variables`. */
    url: z
      .string()
      .refine(
        url => https.safeParse(url.replaceAll(/\{[a-z][a-z0-9-]*\}/g, 'x')).success,
        'an https URL, with only {lowercase-name} placeholders',
      ),
    transport: z.enum(['streamable-http', 'sse']),
    /** How someone signs in. `unknown` until the probe or a person has checked. */
    auth: z.enum(['oauth', 'api-key', 'none', 'unknown']),
    headers: z.array(header).min(1).optional(),
    /** Values that differ per account, such as a subdomain, asked for before connecting. Used as `{name}` in the URL or headers. */
    variables: z.array(urlVariable).min(1).optional(),
    /** Day the probe last reached the server, as YYYY-MM-DD. */
    checked: z.iso.date().optional(),
    /** First day the probe couldn't reach it. Apps hide unreachable servers. */
    unreachableSince: z.iso.date().optional(),
  })
  .refine(remote => {
    const used = new Set(placeholdersOf(remote));
    const declared = new Set(remote.variables?.map(variable => variable.name));
    return [...used].every(name => name === 'key' || declared.has(name)) && [...declared].every(name => used.has(name));
  }, 'every placeholder except {key} is listed in variables, and every variable is used')
  .refine(
    remote => !placeholdersOf(remote).includes('key') || remote.auth === 'api-key',
    '{key} is only for api-key servers',
  );

const placeholdersOf = (remote: { url: string; headers?: { value: string }[] | undefined }) => [
  ...urlPlaceholders(remote.url),
  ...(remote.headers ?? []).flatMap(header => urlPlaceholders(header.value)),
];

export const packageSchema = z.strictObject({
  registry: z.enum(['npm', 'pypi', 'oci']),
  name: z.string().min(1),
  env: z.array(variable).optional(),
});

export const iconsSchema = z.strictObject({
  /** Component name in @lobehub/icons, such as `Notion`. */
  lobehub: z
    .string()
    .regex(/^[A-Z][A-Za-z0-9]*$/)
    .optional(),
  /** Slug in simple-icons, such as `notion`. */
  simpleIcons: z
    .string()
    .regex(/^[a-z0-9]+$/)
    .optional(),
  color: z.string().regex(/^#[0-9A-F]{6}$/, 'uppercase #RRGGBB'),
});

export const appSchema = z
  .strictObject({
    $schema: z.string().optional(),
    id: z.string().regex(/^[a-z0-9]+(-[a-z0-9]+)*$/),
    name: z.string().min(1).max(40),
    maker: z.string().min(1).max(60),
    homepage: https,
    category: z.enum(keys(categories)),
    teams: z
      .array(z.enum(keys(teams)))
      .min(1)
      .max(3),
    summary: line(60),
    capabilities: z.array(line(70)).min(2).max(4),
    official: z.strictObject({ evidence: https, repository: https.optional() }),
    docs: https,
    remote: remoteSchema.optional(),
    packages: z.array(packageSchema).min(1).optional(),
    registryName: z
      .string()
      .regex(/^[a-zA-Z0-9.-]+\/[a-zA-Z0-9._-]+$/)
      .optional(),
    icons: iconsSchema,
    supportedBy: z.array(z.enum(keys(directories))).optional(),
    /** Shown before other apps in its category. */
    featured: z.boolean().optional(),
  })
  .refine(app => app.remote || app.packages, 'needs a remote server or a package');

export type McpCatalogApp = z.infer<typeof appSchema>;
export type McpCatalogRemote = z.infer<typeof remoteSchema>;
export type McpCatalogPackage = z.infer<typeof packageSchema>;

export const appJsonSchema = () => ({
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'https://tulipfarm.ai/schemas/mcp-catalog-app.v1.json',
  title: 'TulipFarm MCP catalog app',
  ...z.toJSONSchema(appSchema, { target: 'draft-2020-12', io: 'input', unrepresentable: 'any' }),
});
