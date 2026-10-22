// The settings registry (packages/config/src/settings.ts) is the application config
// contract. This test fails when server code reads an environment variable that the
// registry does not declare, when a declared variable is no longer read, or when the
// documents generated from the registry are stale.
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { test } from 'node:test';
import { featureFlags } from '../packages/config/src/feature-flags.ts';
import { settings, settingsByName } from '../packages/config/src/settings.ts';
import { renderConfigurationDocument, renderEnvExample } from '../packages/config/src/settings-docs.ts';

const root = join(import.meta.dirname, '..');
// Server processes and the shared packages they load. The web app reads Vite variables;
// packages/secrets is the Azure operator CLI, which never runs in a self-hosted stack.
const sourceRoots = [
  'apps/api/src',
  'apps/worker/src',
  'apps/database/src',
  'apps/snippet-broker/src',
  ...readdirSync(join(root, 'packages'))
    .filter(name => name !== 'secrets')
    .map(name => `packages/${name}/src`),
];
// Passed through unchanged to child processes; operators never set them for TulipFarm.
const systemVariables = new Set(['PATH', 'HOME']);

// Reads whose variable name is computed. Each entry lists every name the file can read,
// and the number of computed reads, so a new computed read needs review here.
const computedReads = {
  // Startup log: checks whether any provider setting is present, to tell missing from invalid.
  'apps/api/src/integration-status.ts': {
    sites: 1,
    names: [
      'GOOGLE_WORKSPACE_CLIENT_ID',
      'GOOGLE_WORKSPACE_CLIENT_SECRET',
      'GOOGLE_WORKSPACE_REDIRECT_URI',
      'GITHUB_OAUTH_CLIENT_ID',
      'GITHUB_OAUTH_CLIENT_SECRET',
      'GITHUB_OAUTH_REDIRECT_URI',
      'GITHUB_OAUTH_SCOPES',
      'ATLASSIAN_MCP_CLIENT_ID',
      'ATLASSIAN_MCP_CLIENT_SECRET',
      'ATLASSIAN_MCP_REDIRECT_URI',
      'ATLASSIAN_REST_CLIENT_ID',
      'ATLASSIAN_REST_CLIENT_SECRET',
      'ATLASSIAN_REST_REDIRECT_URI',
      'TRELLO_CLIENT_ID',
      'TRELLO_CLIENT_SECRET',
      'TRELLO_REDIRECT_URI',
      'SLACK_CONFIGURATION',
      'SLACK_CREDENTIAL_KEYS',
    ],
  },
  // Guards that refuse maintenance credentials name declared variables but read none.
  'apps/api/src/storage-composition.ts': { sites: 1, names: [] },
  'apps/api/src/workspace-mcp-composition.ts': {
    sites: 1,
    names: ['WORKSPACE_MCP_ADMISSION_ENABLED', 'WORKSPACE_MCP_DISPATCH_ENABLED'],
  },
  'apps/database/src/cli.ts': { sites: 1, names: ['DATABASE_MIGRATION_URL', 'DATABASE_ADMIN_URL', 'DATABASE_URL'] },
  'apps/database/src/dev-setup.ts': {
    sites: 2,
    names: [
      'TEMPORAL_ADDRESS',
      'TEMPORAL_NAMESPACE',
      'TEMPORAL_TLS',
      'TEMPORAL_API_KEY',
      'FIRECRAWL_ENDPOINT',
      'FIRECRAWL_API_KEY',
    ],
  },
  // Environment secret store (#14): reads operator-provisioned release secrets by name, which are not app settings.
  'apps/database/src/secrets.ts': { sites: 1, names: [] },
  'apps/database/src/self-host-setup.ts': {
    sites: 1,
    names: [
      'TULIPFARM_DATABASE_ADMIN_URL',
      'TULIPFARM_OBJECT_STORAGE_ENDPOINT',
      'TULIPFARM_OBJECT_STORAGE_ACCESS_KEY_ID',
      'TULIPFARM_OBJECT_STORAGE_SECRET_ACCESS_KEY',
    ],
  },
  'apps/database/src/table-registry.ts': {
    sites: 1,
    names: [
      'WORKSPACE_AUTHORING_DATABASE_URL',
      'WORKSPACE_CONFIRMATION_REGISTRY_DATABASE_URL',
      'WORKSPACE_MIGRATION_REGISTRY_DATABASE_URL',
    ],
  },
  'apps/snippet-broker/src/server.ts': {
    sites: 1,
    names: [
      'SNIPPET_IMAGE',
      'SNIPPET_BROKER_TOKEN_FILE',
      'SNIPPET_DATABASE',
      'SNIPPET_RUNTIME',
      'SNIPPET_ALLOW_LOCAL_RUNC',
      'SKILL_SCRIPTS_ENABLED',
      'HOST',
      'PORT',
    ],
  },
  'apps/worker/src/worker.ts': { sites: 1, names: [] },
  // Reads the API key that the model catalog names for each served route; the built-in providers' keys by default.
  'packages/agents/src/model-environment.ts': {
    sites: 1,
    names: ['ANTHROPIC_API_KEY', 'AZURE_FOUNDRY_API_KEY', 'GEMINI_API_KEY', 'OPENAI_API_KEY', 'XAI_API_KEY'],
  },
  // Reads the key and endpoint variables the model catalog names (the built-in providers' by default), and checks that no
  // removed model setting is set and no model variable has a public prefix; those names are deliberately undeclared.
  'packages/config/src/model-catalog-loader.ts': {
    sites: 2,
    names: [
      'ANTHROPIC_API_KEY',
      'ANTHROPIC_BASE_URL',
      'OPENAI_API_KEY',
      'OPENAI_BASE_URL',
      'XAI_API_KEY',
      'XAI_BASE_URL',
      'GEMINI_API_KEY',
      'GEMINI_BASE_URL',
      'AZURE_FOUNDRY_API_KEY',
      'AZURE_FOUNDRY_ENDPOINT',
    ],
  },
  'packages/atlassian/src/account-provider.ts': {
    sites: 4,
    names: ['ATLASSIAN_MCP', 'ATLASSIAN_REST', 'TRELLO'].flatMap(prefix =>
      ['CLIENT_ID', 'CLIENT_SECRET', 'REDIRECT_URI', 'SCOPES'].map(suffix => `${prefix}_${suffix}`),
    ),
  },
  'packages/config/src/knowledge-embeddings.ts': { sites: 1, names: [] },
  // Reads each registered flag's override variable.
  'packages/config/src/feature-flags.ts': { sites: 1, names: Object.values(featureFlags).map(flag => flag.env) },
  'packages/email/src/sender.ts': { sites: 1, names: ['SMTP_REQUIRE_TLS', 'SMTP_SECURE'] },
  // Reads <NAME>_FILE for each secret setting.
  'packages/config/src/secret-files.ts': { sites: 3, names: [] },
  // Reads <PREFIX>_KEY_ID, <PREFIX>_KEY, and <PREFIX>_PREVIOUS_KEYS for its callers below.
  'packages/keyring/src/index.ts': { sites: 6, names: [] },
  'packages/recommendations/src/configuration.ts': { sites: 1, names: [] },
  'packages/social/src/platform-apps.ts': {
    sites: 4,
    names: ['LINKEDIN', 'YOUTUBE', 'FACEBOOK', 'INSTAGRAM', 'THREADS', 'PINTEREST', 'TIKTOK', 'X', 'REDDIT'].flatMap(
      platform =>
        ['CLIENT_ID', 'CLIENT_SECRET', 'REDIRECT_URI', 'ACCESS_TIER'].map(suffix => `SOCIAL_${platform}_${suffix}`),
    ),
  },
  'packages/workspaces/src/chat-objects.ts': {
    sites: 2,
    names: ['CHAT_R2_ACCOUNT_ID', 'CHAT_R2_BUCKET', 'CHAT_R2_ACCESS_KEY_ID', 'CHAT_R2_SECRET_ACCESS_KEY'],
  },
  'packages/workspaces/src/soul.ts': {
    sites: 2,
    names: ['R2_SOUL_READ_ACCESS_KEY_ID', 'R2_SOUL_READ_SECRET_ACCESS_KEY', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY'],
  },
  'packages/workspaces/src/storage.ts': {
    sites: 1,
    names: [
      'WORKSPACE_STORAGE_MAX_POOLS',
      'WORKSPACE_STORAGE_CONNECTIONS_PER_POOL',
      'WORKSPACE_STORAGE_MAX_TRANSACTIONS',
      'WORKSPACE_STORAGE_MAX_BACKGROUND_TRANSACTIONS',
      'WORKSPACE_STORAGE_IDLE_TIMEOUT_MS',
    ],
  },
  // Refuses conflicting endpoints and session tokens; the credentials it uses are read statically.
  'packages/workspaces/src/soul-read-qualification.ts': { sites: 3, names: [] },
  'packages/workspaces/src/credentials.ts': {
    sites: 2,
    names: ['RUNTIME', 'MIGRATION', 'CONFIRMATION'].flatMap(capability =>
      ['KEY_ID', 'KEY', 'PREVIOUS_KEYS'].map(suffix => `WORKSPACE_${capability}_${suffix}`),
    ),
  },
  'packages/workspaces/src/email-delivery.ts': {
    sites: 1,
    names: ['EMAIL_DELIVERY_KEY_ID', 'EMAIL_DELIVERY_KEY', 'EMAIL_DELIVERY_PREVIOUS_KEYS'],
  },
  'packages/integrations/src/credentials.ts': {
    sites: 1,
    names: ['INTEGRATION_CREDENTIAL_KEY_ID', 'INTEGRATION_CREDENTIAL_KEY', 'INTEGRATION_CREDENTIAL_PREVIOUS_KEYS'],
  },
};

const staticRead = /\b(?:process\.env|env)(?:\??\.([A-Z][A-Z0-9_]*)\b|\[\s*['"]([A-Z][A-Z0-9_]*)['"]\s*\])/g;
// A computed key, a schema parsed over the whole environment, or a keyring prefix.
const computedRead =
  /\b(?:process\.env|env)\[\s*(?!['"])|\.(?:safeParse|parse)\(\s*(?:process\.env|env)\s*\)|\b(?:parseKeyring|parseCurrentKey)\(/g;

function sourceFiles() {
  const files = [];
  const walk = directory => {
    for (const name of readdirSync(directory)) {
      const path = join(directory, name);
      if (statSync(path).isDirectory()) walk(path);
      else if (/\.(?:ts|mts)$/.test(name) && !name.endsWith('.d.ts')) files.push(path);
    }
  };
  for (const directory of sourceRoots) if (existsSync(join(root, directory))) walk(join(root, directory));
  return files.map(path => ({ path: relative(root, path), text: readFileSync(path, 'utf8') }));
}

const files = sourceFiles();

test('server code reads only environment variables declared in the settings registry', () => {
  const undeclared = new Map();
  for (const { path, text } of files) {
    for (const match of text.matchAll(staticRead)) {
      const name = match[1] ?? match[2];
      if (systemVariables.has(name) || settingsByName.has(name)) continue;
      undeclared.set(name, [...(undeclared.get(name) ?? []), path]);
    }
  }
  assert.deepEqual(
    Object.fromEntries(undeclared),
    {},
    'Declare these variables in packages/config/src/settings.ts, then run pnpm config:docs',
  );
});

test('computed environment reads are reviewed and their names declared', () => {
  const found = {};
  for (const { path, text } of files) {
    const sites = [...text.matchAll(computedRead)].length;
    if (sites) found[path] = sites;
  }
  const expected = Object.fromEntries(Object.entries(computedReads).map(([path, entry]) => [path, entry.sites]));
  assert.deepEqual(found, expected, 'A computed environment read changed: list the names it reads in computedReads');
  for (const [path, { names }] of Object.entries(computedReads)) {
    for (const name of names) assert.ok(settingsByName.has(name), `${path} reads undeclared ${name}`);
  }
});

test('every declared variable is still read', () => {
  const compose = readFileSync(join(root, 'self-host/compose.yaml'), 'utf8');
  const source = files
    .filter(file => file.path !== 'packages/config/src/settings.ts')
    .map(file => file.text)
    .join('\n');
  const computed = new Set(Object.values(computedReads).flatMap(entry => entry.names));
  // COMPOSE_* variables configure Compose itself, not the services.
  const unused = settings
    .filter(setting =>
      setting.services.includes('compose')
        ? !setting.name.startsWith('COMPOSE_') && !new RegExp(`\\$\\{${setting.name}\\b`).test(compose)
        : !computed.has(setting.name) && !new RegExp(`\\b${setting.name}\\b`).test(source),
    )
    .map(setting => setting.name);
  assert.deepEqual(unused, [], 'Remove these variables from packages/config/src/settings.ts or restore their readers');
});

test('documents generated from the settings registry are current', () => {
  const stale = 'is stale: run pnpm config:docs';
  assert.equal(
    readFileSync(join(root, 'self-host/.env.example'), 'utf8'),
    renderEnvExample(),
    `self-host/.env.example ${stale}`,
  );
  // The self-hosting configuration reference moves to the tulipfarm.ai docs repository.
  if (!existsSync(join(root, 'docs/self-hosting/configuration.md'))) return;
  const configuration = readFileSync(join(root, 'docs/self-hosting/configuration.md'), 'utf8');
  assert.equal(
    configuration,
    renderConfigurationDocument(configuration),
    `docs/self-hosting/configuration.md ${stale}`,
  );
});
