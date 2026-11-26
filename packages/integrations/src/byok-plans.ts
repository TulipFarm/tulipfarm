import { randomUUID } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { z } from 'zod';
import {
  AccessDenied,
  type AuthorizationTransaction,
  currentMember,
  type HumanActor,
  lockAndResolveHuman,
} from '@tulipfarm/access';
import {
  byokEndpointProblem,
  defaultModelEndpoints,
  isPrivateModelIp,
  normalizeModelEndpoint,
} from '@tulipfarm/config';
import { commonCompatibility, qualified, type createWorkspaceRuntime } from '@tulipfarm/workspace-storage/runtime';
import type { IntegrationKeyring } from './credentials.ts';
import { planTokenCipher } from './plan-cipher.ts';
import { liveAccounts, maxPlanAccounts, nextGeneration } from './plan-accounts.ts';
import type { SubscriptionModel } from './subscriptions.ts';

/**
 * Bring-your-own-key (BYOK) API key connections for Anthropic, OpenAI, Google Gemini, xAI, and OpenAI-compatible
 * custom endpoints (OpenRouter, Groq, Together, Ollama, vLLM, etc.). Keys are verified by calling the provider's live
 * model-listing endpoint, encrypted at rest with AES-256-GCM, and stored in `tf_subscription_connections` so sharing,
 * multi-account fallback, per-model toggles, and unmetered billing work identically to subscription plans.
 */
export const byokPlanProviders = [
  'byok-anthropic',
  'byok-openai',
  'byok-google',
  'byok-xai',
  'byok-openai-compatible',
] as const;
export type ByokPlanProvider = (typeof byokPlanProviders)[number];

export const byokPlanErrorCodes = [
  'key-invalid',
  'key-rejected',
  'endpoint-invalid',
  'endpoint-required',
  'no-models',
  'not-connected',
  'reconnect-required',
  'too-many-accounts',
  'rate-limited',
  'unavailable',
] as const;
export type ByokPlanErrorCode = (typeof byokPlanErrorCodes)[number];

export class ByokPlanError extends Error {
  readonly provider: ByokPlanProvider;
  readonly code: ByokPlanErrorCode;
  readonly detail?: string | undefined;
  constructor(provider: ByokPlanProvider, code: ByokPlanErrorCode, detail?: string) {
    super(detail ? `${provider}-${code}: ${detail}` : `${provider}-${code}`);
    this.provider = provider;
    this.code = code;
    this.detail = detail;
    this.name = 'ByokPlanError';
  }
}

export type ByokPlanStatus = {
  connectionId: string;
  provider: ByokPlanProvider;
  state: 'connected' | 'reconnect-required' | 'signed-out';
  account: string | null;
  endpoint: string | null;
  models: SubscriptionModel[];
  createdAt: string;
};

export type ByokRuntime = Pick<ReturnType<typeof createWorkspaceRuntime>, 'transaction'>;

const uuid = z.uuid();
const credentialSchema = z.object({ apiKey: z.string().min(1) });
const storedModels = z
  .array(
    z
      .object({
        slug: z.string(),
        label: z.string(),
        maxInputTokens: z.number().int().positive().optional(),
        maxOutputTokens: z.number().int().positive().optional(),
        imageInput: z.boolean().optional(),
      })
      .loose(),
  )
  .max(1000);
const connectionRow = z.object({
  id: z.uuid(),
  owner_membership_id: z.uuid(),
  generation: z.number().int().positive(),
  state: z.enum(['connected', 'plan-disabled', 'reconnect-required', 'signed-out']),
  email: z.string().nullable(),
  endpoint: z.string().nullable().default(null),
  credential: z.unknown(),
  models: z.unknown(),
  created_at: z.union([z.date(), z.string()]).transform(value => new Date(value)),
});

const defaultByokDiscoveryBases: Record<Exclude<ByokPlanProvider, 'byok-openai-compatible'>, string> = {
  'byok-anthropic': 'https://api.anthropic.com',
  'byok-openai': 'https://api.openai.com/v1',
  'byok-google': 'https://generativelanguage.googleapis.com/v1beta',
  'byok-xai': 'https://api.x.ai/v1',
};

const loopbackHosts = new Set(['localhost', '127.0.0.1', '::1']);

function normalizeEndpoint(
  provider: ByokPlanProvider,
  raw: string | null | undefined,
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  const trimmed = raw?.trim();
  if (provider !== 'byok-openai-compatible') {
    if (trimmed) {
      throw new ByokPlanError(provider, 'endpoint-invalid', 'custom endpoint is only supported for OpenAI-compatible');
    }
    return null;
  }
  if (!trimmed) throw new ByokPlanError(provider, 'endpoint-required');
  if (!URL.canParse(trimmed)) throw new ByokPlanError(provider, 'endpoint-invalid', 'must be a valid URL');
  const normalized = normalizeModelEndpoint(trimmed);
  const problem = byokEndpointProblem(normalized, env);
  if (problem) throw new ByokPlanError(provider, 'endpoint-invalid', problem);
  return normalized;
}

async function assertPublicEndpoint(
  provider: ByokPlanProvider,
  endpoint: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const url = new URL(endpoint);
  const host = url.hostname.replace(/^\[(.*)\]$/, '$1').toLowerCase();
  if (env.NODE_ENV !== 'production' && loopbackHosts.has(host)) return;
  let records: { address: string }[];
  try {
    records = await lookup(host, { all: true });
  } catch {
    throw new ByokPlanError(provider, 'unavailable', 'could not resolve provider host');
  }
  if (!records.length || records.some(record => isPrivateModelIp(record.address))) {
    throw new ByokPlanError(provider, 'endpoint-invalid', 'must resolve to a public address');
  }
}

function maskKey(apiKey: string): string {
  const trimmed = apiKey.trim();
  if (trimmed.length <= 8) return 'API key';
  return `${trimmed.slice(0, 4)}...${trimmed.slice(-4)}`;
}

function defaultAccountLabel(provider: ByokPlanProvider, apiKey: string, endpoint: string | null): string {
  if (endpoint) {
    try {
      return new URL(endpoint).host;
    } catch {
      return maskKey(apiKey);
    }
  }
  const names: Record<ByokPlanProvider, string> = {
    'byok-anthropic': 'Anthropic',
    'byok-openai': 'OpenAI',
    'byok-google': 'Google Gemini',
    'byok-xai': 'xAI',
    'byok-openai-compatible': 'Custom endpoint',
  };
  return `${names[provider]} (${maskKey(apiKey)})`;
}

// Excludes non-chat endpoints (embeddings, audio, image generation, moderation, legacy completions) from OpenAI's /models.
const openAiNonChatPattern =
  /^(?:text-embedding|embedding|whisper|tts-|dall-e|gpt-image|chatgpt-image|omni-moderation|text-moderation|babbage|davinci|ada|curie|sora|gpt-.*-(?:realtime|audio|transcribe|tts|search))/i;

const xAiNonChatPattern = /(?:^|-)image(?:$|-)|^grok-imagine/i;

function dedupeModels(models: readonly SubscriptionModel[]): SubscriptionModel[] {
  const seen = new Map<string, SubscriptionModel>();
  for (const model of models) {
    const slug = model.slug.trim();
    if (!slug || seen.has(slug)) continue;
    seen.set(slug, {
      slug,
      label: model.label.trim() || slug,
      ...(model.maxInputTokens ? { maxInputTokens: model.maxInputTokens } : {}),
      ...(model.maxOutputTokens ? { maxOutputTokens: model.maxOutputTokens } : {}),
      ...(model.imageInput !== undefined ? { imageInput: model.imageInput } : {}),
    });
  }
  return [...seen.values()].slice(0, 1000);
}

const discoveryTimeoutMs = 15_000;
const maxDiscoveryBytes = 4 * 1024 * 1024;

async function readBoundedText(provider: ByokPlanProvider, response: Response): Promise<string> {
  const contentLength = Number(response.headers.get('content-length') ?? '');
  if (Number.isFinite(contentLength) && contentLength > maxDiscoveryBytes) {
    throw new ByokPlanError(provider, 'unavailable', 'provider model list too large');
  }
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxDiscoveryBytes) {
        await reader.cancel().catch(() => undefined);
        throw new ByokPlanError(provider, 'unavailable', 'provider model list too large');
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(merged);
}

async function fetchJson(
  provider: ByokPlanProvider,
  url: string,
  headers: Record<string, string>,
  fetchImpl: typeof fetch,
): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), discoveryTimeoutMs);
  try {
    let response: Response;
    try {
      response = await fetchImpl(url, { method: 'GET', headers, redirect: 'error', signal: controller.signal });
    } catch {
      throw new ByokPlanError(provider, 'unavailable', 'could not reach provider');
    }
    if (response.status === 401 || response.status === 403) {
      throw new ByokPlanError(provider, 'key-rejected');
    }
    if (response.status === 429) {
      throw new ByokPlanError(provider, 'rate-limited');
    }
    if (!response.ok) {
      throw new ByokPlanError(provider, 'unavailable', `provider returned HTTP ${response.status}`);
    }
    let text: string;
    try {
      text = await readBoundedText(provider, response);
    } catch (error) {
      if (error instanceof ByokPlanError) throw error;
      throw new ByokPlanError(provider, 'unavailable', 'could not read provider response');
    }
    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw new ByokPlanError(provider, 'unavailable', 'provider returned invalid JSON');
    }
  } finally {
    clearTimeout(timer);
  }
}

const anthropicModelsSchema = z.object({
  data: z.array(
    z
      .object({
        id: z.string().min(1),
        display_name: z.string().optional(),
        max_input_tokens: z.number().int().positive().optional(),
        max_tokens: z.number().int().positive().optional(),
        capabilities: z
          .object({
            image_input: z.object({ supported: z.boolean().optional() }).loose().optional(),
          })
          .loose()
          .optional(),
      })
      .loose(),
  ),
});

const openAiCompatibleModelsSchema = z.object({
  data: z.array(
    z
      .object({
        id: z.string().min(1),
        name: z.string().optional(),
        context_length: z.number().int().positive().optional(),
        max_context_length: z.number().int().positive().optional(),
        top_provider: z
          .object({
            context_length: z.number().int().positive().optional(),
            max_completion_tokens: z.number().int().positive().optional(),
          })
          .loose()
          .optional(),
        architecture: z
          .object({
            input_modalities: z.array(z.string()).optional(),
          })
          .loose()
          .optional(),
      })
      .loose(),
  ),
});

const googleModelsSchema = z.object({
  models: z
    .array(
      z
        .object({
          name: z.string().min(1),
          displayName: z.string().optional(),
          supportedGenerationMethods: z.array(z.string()).optional(),
          inputTokenLimit: z.number().int().positive().optional(),
          outputTokenLimit: z.number().int().positive().optional(),
        })
        .loose(),
    )
    .default([]),
});

/** Discovers live chat-capable models from a BYOK provider using the member's API key and endpoint. */
export async function discoverByokModels(
  provider: ByokPlanProvider,
  apiKey: string,
  endpoint: string | null,
  fetchImpl: typeof fetch = fetch,
  env: NodeJS.ProcessEnv = process.env,
): Promise<SubscriptionModel[]> {
  const rawBase = provider === 'byok-openai-compatible' ? (endpoint ?? '') : defaultByokDiscoveryBases[provider];
  if (!rawBase) throw new ByokPlanError(provider, 'endpoint-required');
  if (provider === 'byok-openai-compatible' && fetchImpl === fetch) {
    await assertPublicEndpoint(provider, rawBase, env);
  }
  const base = rawBase.replace(/\/+$/, '');

  if (provider === 'byok-anthropic') {
    const raw = await fetchJson(
      provider,
      `${base}/v1/models?limit=100`,
      { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
      fetchImpl,
    );
    const parsed = anthropicModelsSchema.safeParse(raw);
    if (!parsed.success) throw new ByokPlanError(provider, 'unavailable', 'unexpected model list format');
    const models = dedupeModels(
      parsed.data.data.map(item => ({
        slug: item.id,
        label: item.display_name?.trim() || item.id,
        maxInputTokens: item.max_input_tokens,
        maxOutputTokens: item.max_tokens,
        imageInput: item.capabilities?.image_input?.supported,
      })),
    );
    if (!models.length) throw new ByokPlanError(provider, 'no-models');
    return models;
  }

  if (provider === 'byok-google') {
    const raw = await fetchJson(provider, `${base}/models?pageSize=200`, { 'x-goog-api-key': apiKey }, fetchImpl);
    const parsed = googleModelsSchema.safeParse(raw);
    if (!parsed.success) throw new ByokPlanError(provider, 'unavailable', 'unexpected model list format');
    const models = dedupeModels(
      parsed.data.models
        .filter(item => !item.supportedGenerationMethods || item.supportedGenerationMethods.includes('generateContent'))
        .map(item => {
          const slug = item.name.replace(/^models\//, '');
          return {
            slug,
            label: item.displayName?.trim() || slug,
            maxInputTokens: item.inputTokenLimit,
            maxOutputTokens: item.outputTokenLimit,
          };
        })
        .filter(item => !/^(?:embedding|text-embedding|aqa|imagen|veo)/i.test(item.slug)),
    );
    if (!models.length) throw new ByokPlanError(provider, 'no-models');
    return models;
  }

  // OpenAI, xAI, and OpenAI-compatible endpoints all expose GET {base}/models with Bearer auth.
  const raw = await fetchJson(provider, `${base}/models`, { Authorization: `Bearer ${apiKey}` }, fetchImpl);
  const parsed = openAiCompatibleModelsSchema.safeParse(raw);
  if (!parsed.success) throw new ByokPlanError(provider, 'unavailable', 'unexpected model list format');
  const models = dedupeModels(
    parsed.data.data
      .filter(item => {
        if (provider === 'byok-openai') return !openAiNonChatPattern.test(item.id);
        if (provider === 'byok-xai') return !xAiNonChatPattern.test(item.id);
        return true;
      })
      .map(item => {
        const maxInputTokens = item.top_provider?.context_length ?? item.context_length ?? item.max_context_length;
        const maxOutputTokens = item.top_provider?.max_completion_tokens;
        const imageInput = item.architecture?.input_modalities
          ? item.architecture.input_modalities.includes('image')
          : undefined;
        return {
          slug: item.id,
          label: item.name?.trim() || item.id,
          maxInputTokens,
          maxOutputTokens,
          imageInput,
        };
      }),
  );
  if (!models.length) throw new ByokPlanError(provider, 'no-models');
  return models;
}

export function createByokPlans(options: {
  runtime: ByokRuntime;
  keyring: IntegrationKeyring;
  fetch?: typeof fetch;
  env?: NodeJS.ProcessEnv;
}) {
  const { runtime, keyring, fetch: fetchImpl = fetch, env = process.env } = options;
  const connections = (tx: AuthorizationTransaction) => qualified(tx.schema, 'tf_subscription_connections');
  const grants = (tx: AuthorizationTransaction) => qualified(tx.schema, 'tf_subscription_grants');

  function cipherFor(provider: ByokPlanProvider) {
    return planTokenCipher(keyring, `byok-plan:${provider}`, () => new ByokPlanError(provider, 'reconnect-required'));
  }

  async function authorized<T>(
    workspaceId: string,
    userId: string,
    mode: 'read' | 'write',
    operation: (tx: AuthorizationTransaction, actor: HumanActor) => Promise<T>,
  ) {
    return runtime.transaction(uuid.parse(workspaceId), commonCompatibility, async tx => {
      const actor = await lockAndResolveHuman(tx, userId, mode);
      await currentMember(tx, actor);
      return operation(tx, actor);
    });
  }

  function toStatus(provider: ByokPlanProvider, row: z.infer<typeof connectionRow>): ByokPlanStatus {
    return {
      connectionId: row.id,
      provider,
      state: row.state === 'plan-disabled' ? 'connected' : row.state,
      account: row.email,
      endpoint: row.endpoint,
      models: row.state === 'signed-out' ? [] : (storedModels.safeParse(row.models).data ?? []),
      createdAt: row.created_at.toISOString(),
    };
  }

  return {
    /**
     * Connects a new BYOK API key or reconnects an existing connection owned by the caller. Verifies the key and
     * discovers available models before saving.
     */
    async connect(
      workspaceId: string,
      userId: string,
      provider: ByokPlanProvider,
      input: {
        apiKey: string;
        endpoint?: string | null | undefined;
        label?: string | null | undefined;
        connectionId?: string | null | undefined;
      },
    ): Promise<ByokPlanStatus> {
      const apiKey = input.apiKey.trim();
      if (!apiKey || apiKey.length > 2048 || /[\r\n]/.test(apiKey)) {
        throw new ByokPlanError(provider, 'key-invalid');
      }
      const endpoint = normalizeEndpoint(provider, input.endpoint, env);
      const existingId = input.connectionId ? uuid.parse(input.connectionId) : null;

      // Authorize workspace membership, connection ownership, and account cap BEFORE making any outbound request.
      await authorized(workspaceId, userId, 'read', async (tx, actor) => {
        if (existingId) {
          const existing = await tx.client.query(
            `SELECT id, owner_membership_id, generation, state, email, endpoint, credential, models, created_at
               FROM ${connections(tx)} WHERE id=$1 AND provider=$2`,
            [existingId, provider],
          );
          const row = existing.rows[0] ? connectionRow.parse(existing.rows[0]) : null;
          if (!row) throw new ByokPlanError(provider, 'not-connected');
          if (row.owner_membership_id !== actor.membershipId) throw new AccessDenied();
        } else {
          const count = await liveAccounts(tx, actor.membershipId, provider);
          if (count >= maxPlanAccounts) throw new ByokPlanError(provider, 'too-many-accounts');
        }
      });

      const models = await discoverByokModels(provider, apiKey, endpoint, fetchImpl, env);
      const label = input.label?.trim().slice(0, 120) || defaultAccountLabel(provider, apiKey, endpoint);
      const planLabel = endpoint
        ? (() => {
            try {
              return new URL(endpoint).host;
            } catch {
              return 'Custom endpoint';
            }
          })()
        : 'API key';

      return authorized(workspaceId, userId, 'write', async (tx, actor) => {
        const cipher = cipherFor(provider);
        if (existingId) {
          const existing = await tx.client.query(
            `SELECT id, owner_membership_id, generation, state, email, endpoint, credential, models, created_at
               FROM ${connections(tx)} WHERE id=$1 AND provider=$2`,
            [existingId, provider],
          );
          const row = existing.rows[0] ? connectionRow.parse(existing.rows[0]) : null;
          if (!row) throw new ByokPlanError(provider, 'not-connected');
          if (row.owner_membership_id !== actor.membershipId) throw new AccessDenied();
          const generation = row.generation + 1;
          const encrypted = cipher.encrypt([actor.membershipId, generation], { apiKey });
          const listed = new Set(models.map(item => item.slug));
          const updated = await tx.client.query(
            `UPDATE ${connections(tx)}
                SET state='connected', generation=$2, email=$3, plan=$4, endpoint=$5, credential=$6::jsonb,
                    models=$7::jsonb, models_fetched_at=clock_timestamp(),
                    disabled_models=ARRAY(SELECT m FROM unnest(disabled_models) AS m WHERE m = ANY($8::text[])),
                    cooldown_until=NULL, usage_limited_at=NULL, updated_at=clock_timestamp()
              WHERE id=$1
            RETURNING id, owner_membership_id, generation, state, email, endpoint, credential, models, created_at`,
            [
              row.id,
              generation,
              label,
              planLabel,
              endpoint,
              JSON.stringify(encrypted),
              JSON.stringify(models),
              [...listed],
            ],
          );
          return toStatus(provider, connectionRow.parse(updated.rows[0]));
        }

        const count = await liveAccounts(tx, actor.membershipId, provider);
        if (count >= maxPlanAccounts) throw new ByokPlanError(provider, 'too-many-accounts');
        const id = randomUUID();
        const generation = await nextGeneration(tx, actor.membershipId, provider);
        const encrypted = cipher.encrypt([actor.membershipId, generation], { apiKey });
        const inserted = await tx.client.query(
          `INSERT INTO ${connections(tx)}
            (id, provider, owner_membership_id, generation, state, email, plan, endpoint, credential, models, models_fetched_at, updated_at)
           VALUES ($1, $2, $3, $4, 'connected', $5, $6, $7, $8::jsonb, $9::jsonb, clock_timestamp(), clock_timestamp())
           RETURNING id, owner_membership_id, generation, state, email, endpoint, credential, models, created_at`,
          [
            id,
            provider,
            actor.membershipId,
            generation,
            label,
            planLabel,
            endpoint,
            JSON.stringify(encrypted),
            JSON.stringify(models),
          ],
        );
        return toStatus(provider, connectionRow.parse(inserted.rows[0]));
      });
    },

    /** Re-fetches the live model list for an owner's connected BYOK API key and persists the updated list. */
    async refreshModels(
      workspaceId: string,
      userId: string,
      provider: ByokPlanProvider,
      connectionId: string,
    ): Promise<ByokPlanStatus> {
      const id = uuid.parse(connectionId);
      const { apiKey, endpoint, generation } = await authorized(workspaceId, userId, 'read', async (tx, actor) => {
        const result = await tx.client.query(
          `SELECT id, owner_membership_id, generation, state, email, endpoint, credential, models, created_at
             FROM ${connections(tx)} WHERE id=$1 AND provider=$2`,
          [id, provider],
        );
        const row = result.rows[0] ? connectionRow.parse(result.rows[0]) : null;
        if (!row || row.state === 'signed-out') throw new ByokPlanError(provider, 'not-connected');
        if (row.owner_membership_id !== actor.membershipId) throw new AccessDenied();
        if (row.state !== 'connected' || !row.credential) throw new ByokPlanError(provider, 'reconnect-required');
        const cipher = cipherFor(provider);
        const decrypted = cipher.decrypt([row.owner_membership_id, row.generation], row.credential, credentialSchema);
        return { apiKey: decrypted.apiKey, endpoint: row.endpoint, generation: row.generation };
      });

      const models = await discoverByokModels(provider, apiKey, endpoint, fetchImpl, env);
      return authorized(workspaceId, userId, 'write', async (tx, actor) => {
        const listed = new Set(models.map(item => item.slug));
        const updated = await tx.client.query(
          `UPDATE ${connections(tx)}
              SET models=$3::jsonb, models_fetched_at=clock_timestamp(),
                  disabled_models=ARRAY(SELECT m FROM unnest(disabled_models) AS m WHERE m = ANY($4::text[])),
                  updated_at=clock_timestamp()
            WHERE id=$1 AND provider=$2 AND owner_membership_id=$5 AND state='connected' AND generation=$6
          RETURNING id, owner_membership_id, generation, state, email, endpoint, credential, models, created_at`,
          [id, provider, JSON.stringify(models), [...listed], actor.membershipId, generation],
        );
        if (!updated.rows[0]) {
          // A concurrent key rotation superseded this refresh; return the current persisted status without overwriting it.
          const current = await tx.client.query(
            `SELECT id, owner_membership_id, generation, state, email, endpoint, credential, models, created_at
               FROM ${connections(tx)} WHERE id=$1 AND provider=$2 AND owner_membership_id=$3`,
            [id, provider, actor.membershipId],
          );
          const row = current.rows[0] ? connectionRow.parse(current.rows[0]) : null;
          if (!row || row.state === 'signed-out') throw new ByokPlanError(provider, 'not-connected');
          return toStatus(provider, row);
        }
        return toStatus(provider, connectionRow.parse(updated.rows[0]));
      });
    },

    /** Disconnects an owner's BYOK API key, deleting its encrypted credential and all sharing grants. */
    async disconnect(workspaceId: string, userId: string, provider: ByokPlanProvider, connectionId: string) {
      const id = uuid.parse(connectionId);
      await authorized(workspaceId, userId, 'write', async (tx, actor) => {
        const result = await tx.client.query(
          `SELECT owner_membership_id FROM ${connections(tx)} WHERE id=$1 AND provider=$2`,
          [id, provider],
        );
        const row = result.rows[0] as { owner_membership_id: string } | undefined;
        if (!row) throw new ByokPlanError(provider, 'not-connected');
        if (row.owner_membership_id !== actor.membershipId) throw new AccessDenied();
        await tx.client.query(`DELETE FROM ${grants(tx)} WHERE connection_id=$1`, [id]);
        await tx.client.query(
          `UPDATE ${connections(tx)}
              SET state='signed-out', credential=NULL, models=NULL, models_fetched_at=NULL,
                  disabled_models='{}', cooldown_until=NULL, usage_limited_at=NULL, updated_at=clock_timestamp()
            WHERE id=$1`,
          [id],
        );
      });
    },

    /** Decrypts a connected BYOK API key, canonical endpoint, and generation for a model inference call. */
    async accessCredential(
      workspaceId: string,
      provider: ByokPlanProvider,
      connectionId: string,
    ): Promise<{ apiKey: string; endpoint: string; generation: number }> {
      return runtime.transaction(uuid.parse(workspaceId), commonCompatibility, async tx => {
        const result = await tx.client.query(
          `SELECT id, owner_membership_id, generation, state, email, endpoint, credential, models, created_at
             FROM ${connections(tx)} WHERE id=$1 AND provider=$2`,
          [uuid.parse(connectionId), provider],
        );
        const row = result.rows[0] ? connectionRow.parse(result.rows[0]) : null;
        if (!row || row.state === 'signed-out') throw new ByokPlanError(provider, 'not-connected');
        if (row.state !== 'connected' || !row.credential) throw new ByokPlanError(provider, 'reconnect-required');
        const cipher = cipherFor(provider);
        const decrypted = cipher.decrypt([row.owner_membership_id, row.generation], row.credential, credentialSchema);
        const endpoint =
          provider === 'byok-openai-compatible'
            ? row.endpoint
              ? normalizeModelEndpoint(row.endpoint)
              : defaultModelEndpoints[provider]
            : defaultModelEndpoints[provider];
        return { apiKey: decrypted.apiKey, endpoint, generation: row.generation };
      });
    },

    /** Marks a BYOK connection as needing reconnection after a provider rejects its key, clearing its credential. */
    async markReconnectRequired(
      workspaceId: string,
      provider: ByokPlanProvider,
      connectionId: string,
      expectedGeneration?: number,
    ) {
      await runtime.transaction(uuid.parse(workspaceId), commonCompatibility, async tx => {
        if (expectedGeneration !== undefined) {
          await tx.client.query(
            `UPDATE ${connections(tx)} SET state='reconnect-required', credential=NULL, updated_at=clock_timestamp()
              WHERE id=$1 AND provider=$2 AND state='connected' AND generation=$3`,
            [uuid.parse(connectionId), provider, expectedGeneration],
          );
        } else {
          await tx.client.query(
            `UPDATE ${connections(tx)} SET state='reconnect-required', credential=NULL, updated_at=clock_timestamp()
              WHERE id=$1 AND provider=$2 AND state='connected'`,
            [uuid.parse(connectionId), provider],
          );
        }
      });
    },
  };
}
