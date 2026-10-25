import { z } from 'zod';
import { modelEndpointProblem, type ImageModelApi, type ServedImageModel } from '@tulipfarm/config';
import { ModelCallError, observeInference } from '@tulipfarm/observability';
import { modelHttpError, openAiWire, type InferenceRoute, type OpenAiShapedRoute } from './inference.ts';
import { providerFetch } from './provider-fetch.ts';

/** The served route of an image model with its credential, ready to send one image request. */
export type ImageProviderRoute = { api: ImageModelApi; timeoutMs: number } & (
  | Extract<InferenceRoute, { provider: 'openai' | 'xai' | 'google' | 'openai-compatible' }>
  | Extract<InferenceRoute, { provider: 'azure' }>
);

/** One image to make: the catalog's size or ratio for the requested shape, and up to the model's source images. */
export type ImageProviderRequest = {
  prompt: string;
  /** The catalog value for the shape, such as `1024x1536` (OpenAI) or `3:4` (xAI, Gemini). */
  size: string;
  quality: 'standard' | 'high';
  sources: readonly { bytes: Uint8Array; mediaType: string; name: string }[];
  /** JPEG for a channel that does not take PNG. Only the OpenAI Images API can choose; the others ignore it. */
  format?: 'jpeg';
};

/** Tokens the provider reports for one image request, or unknown when it reports none. */
export type ImageUsage = { kind: 'unknown' } | { kind: 'known'; input: number; output: number };

/**
 * What came back for one image. `refused` is a content-policy refusal; its provider text is never kept. Anything
 * else the provider rejects throws a `ModelCallError`.
 */
export type ProviderImageOutcome =
  | { kind: 'image'; bytes: Uint8Array; mediaType: string; usage: ImageUsage }
  | { kind: 'refused'; usage: ImageUsage };

/** Image requests take longer than chat steps; high quality OpenAI images can take two minutes. */
export const imageRequestTimeoutMs = 180_000;

/** The image model's first served route with its key from `env`, or null when the key is missing or the host not allowed. */
export function imageProviderRoute(
  model: Pick<ServedImageModel, 'route'>,
  env: NodeJS.ProcessEnv = process.env,
): ImageProviderRoute | null {
  const { route } = model;
  const credential = env[route.apiKeyEnv]?.trim();
  if (!credential || modelEndpointProblem(route.type, route.endpoint, env) !== null) return null;
  const common = { api: route.api, endpoint: route.endpoint, model: route.model, timeoutMs: imageRequestTimeoutMs };
  if (route.type === 'azure')
    return { ...common, provider: 'azure', auth: { kind: 'api-key', value: credential } } as ImageProviderRoute;
  if (route.type === 'anthropic') return null;
  return { ...common, provider: route.type, apiKey: credential } as ImageProviderRoute;
}

const openAiQuality = { standard: 'medium', high: 'high' } as const;
const xaiResolution = { standard: '1k', high: '2k' } as const;
const dataUrl = (source: ImageProviderRequest['sources'][number]) =>
  `data:${source.mediaType};base64,${Buffer.from(source.bytes).toString('base64')}`;

/**
 * The HTTP request for one image. OpenAI-shaped generations are JSON and edits are multipart with `image[]` parts;
 * xAI takes JSON for both, with sources as data URLs; Gemini sends sources as inline parts of one generateContent call.
 */
export function imageHttpRequest(
  route: ImageProviderRoute,
  request: ImageProviderRequest,
): { url: string; headers: Record<string, string>; body: string | FormData } {
  const edit = request.sources.length > 0;
  if (route.api === 'gemini-images') {
    if (route.provider !== 'google') throw new Error('gemini-images needs a Google route');
    return {
      url: `${route.endpoint}v1beta/models/${route.model}:generateContent`,
      headers: { 'content-type': 'application/json', 'x-goog-api-key': route.apiKey },
      body: JSON.stringify({
        contents: [
          {
            role: 'user',
            parts: [
              { text: request.prompt },
              ...request.sources.map(source => ({
                inlineData: { mimeType: source.mediaType, data: Buffer.from(source.bytes).toString('base64') },
              })),
            ],
          },
        ],
        generationConfig: { responseModalities: ['IMAGE'], imageConfig: { aspectRatio: request.size } },
      }),
    };
  }
  if (route.provider === 'google') throw new Error(`${route.api} cannot use a Google route`);
  const wire = openAiWire(route as OpenAiShapedRoute);
  const url = `${wire.base}images/${edit ? 'edits' : 'generations'}`;
  if (route.api === 'xai-images')
    return {
      url,
      headers: { ...wire.auth, 'content-type': 'application/json' },
      body: JSON.stringify({
        model: route.model,
        prompt: request.prompt,
        n: 1,
        response_format: 'b64_json',
        aspect_ratio: request.size,
        resolution: xaiResolution[request.quality],
        ...(request.sources.length === 1
          ? { image: { url: dataUrl(request.sources[0]!), type: 'image_url' } }
          : edit
            ? { images: request.sources.map(source => ({ url: dataUrl(source), type: 'image_url' })) }
            : {}),
      }),
    };
  const fields = {
    model: route.model,
    prompt: request.prompt,
    n: '1',
    size: request.size,
    quality: openAiQuality[request.quality],
    output_format: request.format ?? 'png',
  };
  if (!edit)
    return {
      url,
      headers: { ...wire.auth, 'content-type': 'application/json' },
      body: JSON.stringify({ ...fields, n: 1 }),
    };
  const form = new FormData();
  for (const [name, value] of Object.entries(fields)) form.append(name, value);
  for (const source of request.sources)
    form.append('image[]', new Blob([Buffer.from(source.bytes)], { type: source.mediaType }), source.name);
  return { url, headers: { ...wire.auth }, body: form };
}

const count = z.number().int().nonnegative();
const openAiImagesSchema = z.object({
  data: z
    .array(z.object({ b64_json: z.string().min(1), mime_type: z.string().nullish() }))
    .min(1)
    .max(1),
  usage: z.object({ input_tokens: count.nullish(), output_tokens: count.nullish() }).nullish(),
});
const geminiSchema = z.object({
  promptFeedback: z.object({ blockReason: z.string().optional() }).nullish(),
  candidates: z
    .array(
      z.object({
        finishReason: z.string().optional(),
        content: z
          .object({
            parts: z
              .array(z.object({ inlineData: z.object({ mimeType: z.string(), data: z.string() }).optional() }))
              .optional(),
          })
          .optional(),
      }),
    )
    .optional(),
  usageMetadata: z
    .object({
      promptTokenCount: count.default(0),
      candidatesTokenCount: count.default(0),
      thoughtsTokenCount: count.default(0),
    })
    .nullish(),
});
// Gemini finish reasons that mean the image was withheld under a content policy.
const geminiRefusals = new Set([
  'SAFETY',
  'IMAGE_SAFETY',
  'PROHIBITED_CONTENT',
  'IMAGE_PROHIBITED_CONTENT',
  'BLOCKLIST',
  'SPII',
  'RECITATION',
  'IMAGE_RECITATION',
]);
const refusalCodes = new Set(['moderation_blocked', 'content_policy_violation', 'content_filter']);
const errorCode = z.object({ error: z.object({ code: z.unknown().optional(), type: z.unknown().optional() }) });

/** Classifies a 2xx body: the image, a refusal, or null when the body is malformed. */
export function readImageResponse(api: ImageModelApi, body: unknown): ProviderImageOutcome | null {
  if (api === 'gemini-images') {
    const parsed = geminiSchema.safeParse(body);
    if (!parsed.success) return null;
    const meta = parsed.data.usageMetadata;
    const usage: ImageUsage = meta
      ? { kind: 'known', input: meta.promptTokenCount, output: meta.candidatesTokenCount + meta.thoughtsTokenCount }
      : { kind: 'unknown' };
    if (parsed.data.promptFeedback?.blockReason) return { kind: 'refused', usage };
    const candidate = parsed.data.candidates?.[0];
    const image = candidate?.content?.parts?.find(part => part.inlineData)?.inlineData;
    if (image) return { kind: 'image', bytes: Buffer.from(image.data, 'base64'), mediaType: image.mimeType, usage };
    if (candidate?.finishReason && geminiRefusals.has(candidate.finishReason)) return { kind: 'refused', usage };
    return null;
  }
  const parsed = openAiImagesSchema.safeParse(body);
  if (!parsed.success) return null;
  const sent = parsed.data.usage;
  const usage: ImageUsage =
    sent?.input_tokens != null && sent.output_tokens != null
      ? { kind: 'known', input: sent.input_tokens, output: sent.output_tokens }
      : { kind: 'unknown' };
  const image = parsed.data.data[0]!;
  return {
    kind: 'image',
    bytes: Buffer.from(image.b64_json, 'base64'),
    mediaType: image.mime_type ?? 'image/png',
    usage,
  };
}

function isRefusal(body: unknown) {
  const parsed = errorCode.safeParse(body);
  if (!parsed.success) return false;
  return [parsed.data.error.code, parsed.data.error.type].some(
    value => typeof value === 'string' && refusalCodes.has(value.toLowerCase()),
  );
}

/**
 * Sends one image request. An HTTP content-policy rejection is an unbilled refusal; other rejections, timeouts and
 * transport failures throw `ModelCallError`. `signal` cancels the request. The call is observed like other model calls,
 * recording only counts, sizes, media types and the outcome.
 */
export async function requestProviderImage(
  route: ImageProviderRoute,
  request: ImageProviderRequest,
  signal?: AbortSignal,
): Promise<ProviderImageOutcome> {
  return observeInference(
    { provider: route.provider, model: route.model, operation: 'image_generation' },
    async report => {
      report.media({
        'media.sources': request.sources.length,
        'media.source_bytes': request.sources.reduce((sum, source) => sum + source.bytes.byteLength, 0),
        'media.quality': request.quality,
      });
      try {
        const outcome = await sendImageRequest(route, request, signal);
        if (outcome.usage.kind === 'known') report.usage(outcome.usage.input, outcome.usage.output);
        report.media(
          outcome.kind === 'image'
            ? { 'media.outcome': 'image', 'media.bytes': outcome.bytes.byteLength, 'media.type': outcome.mediaType }
            : { 'media.outcome': 'refused' },
        );
        return outcome;
      } catch (error) {
        report.media({ 'media.outcome': 'failed' });
        report.error(error);
        throw error;
      }
    },
  );
}

async function sendImageRequest(
  route: ImageProviderRoute,
  request: ImageProviderRequest,
  signal: AbortSignal | undefined,
): Promise<ProviderImageOutcome> {
  const http = imageHttpRequest(route, request);
  const timeout = AbortSignal.timeout(route.timeoutMs);
  const response = await providerFetch(http.url, {
    method: 'POST',
    headers: http.headers,
    body: http.body,
    redirect: 'manual',
    signal: signal ? AbortSignal.any([timeout, signal]) : timeout,
  }).catch((error: unknown) => {
    if (signal?.aborted) throw error;
    const timedOut = error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError');
    throw new ModelCallError(timedOut ? 'timeout' : 'transport', { outputStarted: false }, { cause: error });
  });
  const text = await response.text();
  let body: unknown = null;
  try {
    body = JSON.parse(text);
  } catch {
    body = null;
  }
  if (!response.ok) {
    if (isRefusal(body)) return { kind: 'refused', usage: { kind: 'unknown' } };
    // The prompt and source names are passed so a provider error that quotes them is redacted before it is logged.
    throw modelHttpError(
      response,
      body,
      route.provider,
      false,
      [request.prompt, ...request.sources.map(source => source.name)].join('\n'),
    );
  }
  const outcome = readImageResponse(route.api, body);
  if (!outcome) throw new ModelCallError('invalid-decision', { status: response.status, outputStarted: false });
  return outcome;
}
