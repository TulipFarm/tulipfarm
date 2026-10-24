import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { AccessDenied, type AuthorizationTransaction, type HumanActor } from '@tulipfarm/access';
import {
  calculateUsageCost,
  imageAspects,
  imageQualities,
  modelPriceSchema,
  reserveModelCost,
  type ServedImageModel,
} from '@tulipfarm/config';
import { FileError, requireReadableFile, type createFiles } from '@tulipfarm/files';
import { imagePresets, sniffMediaType } from '@tulipfarm/media';
import {
  CreditsExhausted,
  creditUnitsForProviderCost,
  reserveCredits,
  settleCredits,
} from '@tulipfarm/workspace-storage/credits';
import { qualified } from '@tulipfarm/workspace-storage/runtime';
import { AttachmentError } from './attachments.ts';
import type { ImageReceipt } from './contracts.ts';
import {
  generateImagesCallSchema,
  imagesPerOrigin,
  type generatedImageSchema,
  type imageCallErrors,
  type imageFailures,
  type imageOutputResultSchema,
  type imageStates,
} from './image-contracts.ts';

export { generateImagesCallSchema, imagesPerOrigin };
import type { FileOutputStore } from './file-outputs.ts';
import type { AttachmentReader } from './turn-files.ts';

const staleClaimMs = 10 * 60 * 1000;

export type GenerateImagesCall = z.input<typeof generateImagesCallSchema>;

/** The turn or run an image belongs to. A turn's images may use the chat's attachments as sources. */
export type ImageOrigin = { kind: 'turn'; conversationId: string; turnId: string } | { kind: 'run'; runId: string };

/** The resolved image model of the work, or why it has none. Resolved and pinned by the caller at admission. */
export type ImageModelChoice =
  | {
      status: 'available';
      model: Pick<ServedImageModel, 'id' | 'name' | 'edits' | 'maxSources' | 'aspects' | 'pricing' | 'maxTokens'>;
      catalogRevision: string | null;
    }
  | { status: 'unavailable'; alternativeFamilyId: string | null; turnedOff?: boolean };

export type ImageGenerator = (
  request: { prompt: string; size: string; quality: 'standard' | 'high'; sources: readonly ImageSourceBytes[] },
  signal: AbortSignal | undefined,
) => Promise<
  { kind: 'image'; bytes: Uint8Array; mediaType: string; usage: ImageUsage } | { kind: 'refused'; usage: ImageUsage }
>;
export type ImageUsage = { kind: 'unknown' } | { kind: 'known'; input: number; output: number };
type ImageSourceBytes = { bytes: Uint8Array; mediaType: string; name: string };

export type ImageOutputContext = {
  workspaceId: string;
  actor: HumanActor;
  /** Private chats requested by a person may default to that person's files; anything else must name a folder. */
  autonomous: boolean;
  origin: ImageOrigin;
  model: ImageModelChoice;
  /** The provider call for the resolved model. */
  generate: ImageGenerator;
  /** The billing flow every image of this work is rounded in, and the task allowance it counts against, if any. */
  credits: {
    flowId: string;
    activity: 'chat' | 'agent';
    agentId: string | null;
    allowanceCredits?: string | undefined;
  };
  signal?: AbortSignal | undefined;
  /** Called with every image's state before generation starts and after each one changes. */
  progress?: ((images: readonly GeneratedImage[]) => void) | undefined;
};

export type ImageOutputStore = FileOutputStore & Pick<ReturnType<typeof createFiles>, 'read'>;
export type ImageOutputDeps = {
  files: ImageOutputStore;
  attachments?: AttachmentReader | undefined;
  /** A workspace transaction for generation rows and credits. */
  transaction: <T>(operation: (tx: AuthorizationTransaction) => Promise<T>) => Promise<T>;
};

export type ImageState = (typeof imageStates)[number];
export type ImageFailure = (typeof imageFailures)[number];
export type GeneratedImage = z.infer<typeof generatedImageSchema>;
/** What a generated file records, shown in the file viewer (item 29). */
export type ImageGenerationRecord = {
  prompt: string;
  imageModelId: string;
  catalogRevision: string | null;
  sources: { kind: 'file' | 'attachment'; id: string; sha256: string }[];
  origin: ImageOrigin;
};

export type ImageCallError = (typeof imageCallErrors)[number];
export type ImageOutputResult = z.infer<typeof imageOutputResultSchema>;

const fail = (error: ImageCallError, instruction: string, extra: object = {}): ImageOutputResult => ({
  error,
  instruction: `No image was generated. ${instruction}`,
  ...extra,
});

/** The call's identity: everything that changes what is generated, in a fixed order. */
export function imageCallHash(call: z.output<typeof generateImagesCallSchema>) {
  return createHash('sha256')
    .update(
      JSON.stringify([
        'images.generate',
        call.prompt,
        call.count,
        call.aspect ?? null,
        call.preset ?? null,
        call.quality,
        call.name ?? null,
        call.folderId ?? null,
        call.sources ?? [],
      ]),
    )
    .digest('hex');
}

/** One id per origin, exact call and image index: the generation row's id and the saved file's id. */
export function imageOutputId(origin: ImageOrigin, callHash: string, index: number) {
  const hash = createHash('sha256')
    .update(
      JSON.stringify([
        'images.generate',
        origin.kind,
        origin.kind === 'turn' ? origin.turnId : origin.runId,
        callHash,
        index,
      ]),
    )
    .digest();
  hash.writeUInt8((hash.readUInt8(6) & 0x0f) | 0x80, 6);
  hash.writeUInt8((hash.readUInt8(8) & 0x3f) | 0x80, 8);
  const hex = hash.subarray(0, 16).toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function usdToPicoUsd(usd: number) {
  const text = usd.toFixed(12).replace(/0+$/, '').replace(/\.$/, '');
  const [whole = '0', fraction = ''] = text.split('.');
  return (BigInt(whole) * 1_000_000_000_000n + BigInt(fraction.padEnd(12, '0').slice(0, 12))).toString();
}

type Model = Extract<ImageModelChoice, { status: 'available' }>['model'];
type Shape = (typeof imageAspects)[number];
type Quality = (typeof imageQualities)[number];

/**
 * Provider cost of one image in pico-USD. `usage` absent gives the most it can cost: the hold. A per-image price is
 * the same either way; token rates use the catalog's `maxTokens` bound, and a request reporting more than that, or no
 * usage at all, costs its hold.
 */
export function imageCost(
  model: Model,
  quality: Quality,
  shape: Shape,
  pricingRevision: string,
  usage?: ImageUsage,
  date = new Date().toISOString().slice(0, 10),
): string {
  if (model.pricing === 'unmetered') return '0';
  if (!Array.isArray(model.pricing)) return usdToPicoUsd(model.pricing.usdPerImage[quality][shape]);
  const bounds = {
    modelId: model.id,
    pricingRevision,
    rates: model.pricing.map(rate => modelPriceSchema.parse(rate)),
    maxInputTokens: model.maxTokens.input,
    maxOutputTokens: model.maxTokens.output,
    date,
  };
  const hold = reserveModelCost(bounds);
  if (!usage || usage.kind === 'unknown') return hold;
  try {
    const cost = calculateUsageCost({
      ...bounds,
      usage: {
        kind: 'known',
        tokens: {
          input: usage.input,
          output: usage.output,
          cacheRead: 0,
          cacheWrite: 0,
          cacheWrite5m: 0,
          cacheWrite1h: 0,
        },
      },
    });
    return cost.kind === 'known' ? cost.providerPicoUsd : hold;
  } catch {
    return hold;
  }
}

const generationRow = z.object({
  id: z.uuid(),
  ordinal: z.number().int(),
  state: z.enum(['pending', 'saved', 'refused', 'failed', 'cancelled']),
  failure: z.string().nullable(),
});
const generationsTable = (tx: AuthorizationTransaction) => qualified(tx.schema, 'tf_image_generations');
const originId = (origin: ImageOrigin) => (origin.kind === 'turn' ? origin.turnId : origin.runId);

const extensions: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' };
const sourceTypes = new Set(['image/png', 'image/jpeg', 'image/webp']);
function imageName(call: z.output<typeof generateImagesCallSchema>, index: number, mediaType: string) {
  const base =
    (call.name ?? call.prompt)
      .replace(/[\\/:*?"<>|\p{Cc}]+/gu, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 80)
      .trim() || 'Generated image';
  return `${base}${call.count > 1 ? ` ${index + 1}` : ''}.${extensions[mediaType] ?? 'png'}`;
}

/**
 * `images.generate`: checks the call in order before any credits are held, then generates each image on its own:
 * hold the most it can cost, call the provider, save the bytes unchanged in Files, and settle at the billed cost.
 */
export async function generateImageOutputs(
  deps: ImageOutputDeps,
  context: ImageOutputContext,
  input: GenerateImagesCall,
): Promise<ImageOutputResult> {
  const parsed = generateImagesCallSchema.safeParse(input);
  if (!parsed.success)
    return fail('invalid-request', 'Check the prompt, count (1 to 4), aspect or preset, and sources.');
  const call = parsed.data;
  if (call.aspect && call.preset) return fail('invalid-request', 'Give an aspect or a preset, not both.');
  const sources = [...new Set(call.sources ?? [])];
  // 1. The tool is enabled and the image model resolves.
  if (context.model.status === 'unavailable')
    return fail(
      'image-model-unavailable',
      context.model.turnedOff
        ? 'Image generation is turned off for this workspace. Say so; an admin can turn it on.'
        : context.model.alternativeFamilyId
          ? `Image generation is not available for the selected model. Say so, and that the ${context.model.alternativeFamilyId} model can generate images.`
          : 'Image generation is not available for the selected model, and no available model can generate images. Say so.',
      { alternativeFamilyId: context.model.alternativeFamilyId },
    );
  const { model, catalogRevision } = context.model;
  const hash = imageCallHash(call);
  // 2. The origin's running count plus this call stays within the limit. A repeat of this call is not counted twice.
  const used = await deps.transaction(async tx =>
    Number(
      (
        await tx.client.query(
          `SELECT count(*)::int AS used FROM ${generationsTable(tx)} WHERE origin_kind=$1 AND origin_id=$2 AND call_hash<>$3`,
          [context.origin.kind, originId(context.origin), hash],
        )
      ).rows[0]?.used ?? 0,
    ),
  );
  const remaining = Math.max(0, imagesPerOrigin - used);
  if (call.count > remaining)
    return fail(
      'image-limit-exceeded',
      remaining === 0
        ? `This ${context.origin.kind} already generated ${imagesPerOrigin} images, the most it can. Say so.`
        : `This ${context.origin.kind} can generate ${remaining} more image${remaining === 1 ? '' : 's'}. Say so, or ask for at most ${remaining}.`,
      { remaining },
    );
  // 3. Edits need a model that edits, within its source limit.
  if (sources.length > 0 && !model.edits)
    return fail(
      'image-edit-unsupported',
      'The image model cannot edit images. Offer to generate a new image from a description instead.',
    );
  if (sources.length > model.maxSources)
    return fail(
      'image-edit-unsupported',
      `The image model can use at most ${model.maxSources} source image${model.maxSources === 1 ? '' : 's'} in one edit.`,
    );
  // 4. The requester can read every source now.
  const read: (ImageSourceBytes & ImageGenerationRecord['sources'][number])[] = [];
  for (const id of sources) {
    const source = await readSource(deps, context, id);
    if (!source)
      return fail(
        'source-unreadable',
        `Source ${id} can't be read as an image. Use a PNG, JPEG or WebP image the person can open, attached to this chat or in Files.`,
      );
    read.push(source);
  }
  // 5. The destination follows the files.create rules.
  if (!(await destinationAllowed(deps, context, call.folderId)))
    return fail(
      'destination-required',
      call.folderId
        ? 'The folder is missing or the requester cannot add to it. Ask for a destination folder.'
        : 'Work that no person requested in a private chat must name a Files folder the requester can add to. Ask for a destination folder.',
    );

  const shape: Shape = call.preset ? imagePresets[call.preset].shape : (call.aspect ?? 'square');
  const record: ImageGenerationRecord = {
    prompt: call.prompt,
    imageModelId: model.id,
    catalogRevision,
    sources: read.map(({ kind, id, sha256 }) => ({ kind, id, sha256 })),
    origin: context.origin,
  };
  const ids = Array.from({ length: call.count }, (_, index) => imageOutputId(context.origin, hash, index));
  const rows = await deps.transaction(async tx => {
    const mine = new Set<string>();
    for (const [index, id] of ids.entries()) {
      const inserted = await tx.client.query(
        `INSERT INTO ${generationsTable(tx)} (id,origin_kind,origin_id,conversation_id,call_hash,ordinal,creator_membership_id,state,prompt,image_model_id,catalog_revision,sources)
        VALUES ($1,$2,$3,$4,$5,$6,$7,'pending',$8,$9,$10,$11) ON CONFLICT (id) DO NOTHING RETURNING id`,
        [
          id,
          context.origin.kind,
          originId(context.origin),
          context.origin.kind === 'turn' ? context.origin.conversationId : null,
          hash,
          index,
          context.actor.membershipId,
          call.prompt,
          model.id,
          catalogRevision,
          JSON.stringify(record.sources),
        ],
      );
      if (inserted.rowCount) mine.add(id);
    }
    // Earlier failures, cancellations and abandoned claims of the same call are tried again; saved and refused are final.
    const claimed = await tx.client.query(
      `UPDATE ${generationsTable(tx)} SET state='pending',failure=NULL,image_model_id=$3,catalog_revision=$4,updated_at=clock_timestamp()
      WHERE id=ANY($1::uuid[]) AND NOT (id=ANY($6::uuid[])) AND creator_membership_id=$2 AND (state IN ('failed','cancelled')
        OR (state='pending' AND updated_at < clock_timestamp() - make_interval(secs => $5)))
      RETURNING id`,
      [ids, context.actor.membershipId, model.id, catalogRevision, staleClaimMs / 1000, [...mine]],
    );
    for (const row of claimed.rows) mine.add(String(row.id));
    return z
      .array(generationRow)
      .parse(
        (
          await tx.client.query(
            `SELECT id,ordinal,state,failure FROM ${generationsTable(tx)} WHERE id=ANY($1::uuid[]) ORDER BY ordinal`,
            [ids],
          )
        ).rows,
      )
      .map(row => ({ ...row, claimed: mine.has(row.id) }));
  });

  const images: GeneratedImage[] = rows.map(row => ({ index: row.ordinal, id: row.id, state: row.state }));
  const publish = () => context.progress?.(images.map(image => ({ ...image })));
  for (const [index, row] of rows.entries()) {
    if (row.claimed) continue;
    if (row.state === 'saved') {
      const file = await savedFile(deps, context, row.id);
      if (file) images[index] = { ...images[index]!, file };
      else images[index] = { ...images[index]!, state: 'failed', failure: 'conflict' };
    } else if (row.state === 'pending') images[index] = { ...images[index]!, state: 'failed', failure: 'in-progress' };
    else if (row.state === 'failed')
      images[index] = { ...images[index]!, failure: (row.failure ?? 'generation-failed') as ImageFailure };
    else if (row.state === 'refused') images[index] = { ...images[index]!, failure: 'content-refused' };
  }
  publish();

  const pricingRevision = catalogRevision ?? 'catalog';
  const hold = imageCost(model, call.quality, shape, pricingRevision);
  const finish = async (index: number, state: ImageState, extra: Partial<GeneratedImage> = {}) => {
    images[index] = { ...images[index]!, state, ...extra };
    await deps.transaction(tx =>
      tx.client.query(
        `UPDATE ${generationsTable(tx)} SET state=$2,failure=$3,updated_at=clock_timestamp() WHERE id=$1`,
        [images[index]!.id, state, state === 'failed' ? (extra.failure ?? 'generation-failed') : null],
      ),
    );
    publish();
  };

  await Promise.all(
    rows.map(async (row, index) => {
      if (!row.claimed) return;
      if (context.signal?.aborted) return finish(index, 'cancelled');
      const usageId = `image:${row.id}:${randomUUID()}`;
      const held = await deps.transaction(async tx => {
        if (context.credits.allowanceCredits !== undefined) {
          const spent = BigInt(
            String(
              (
                await tx.client.query(
                  `SELECT COALESCE(sum(COALESCE(charged,reserved)),0)::text AS spent FROM ${qualified(tx.schema, 'tf_credit_usage')} WHERE flow_id=$1`,
                  [context.credits.flowId],
                )
              ).rows[0]?.spent ?? '0',
            ),
          );
          if (
            spent + creditUnitsForProviderCost(BigInt(hold)) >
            BigInt(context.credits.allowanceCredits) * 1_000_000_000_000n
          )
            return 'task-credits' as const;
        }
        try {
          await reserveCredits(tx, {
            id: usageId,
            flowId: context.credits.flowId,
            modelId: model.id,
            agentId: context.credits.agentId,
            activity: context.credits.activity,
            providerPicoUsd: hold,
            pricingRevision,
          });
          return 'held' as const;
        } catch (error) {
          if (error instanceof CreditsExhausted) return 'credits-exhausted' as const;
          throw error;
        }
      });
      if (held !== 'held') return finish(index, 'failed', { failure: held });
      const settle = (cost: string) => deps.transaction(tx => settleCredits(tx, usageId, cost));
      let outcome: Awaited<ReturnType<ImageGenerator>>;
      try {
        outcome = await context.generate(
          { prompt: call.prompt, size: model.aspects[shape], quality: call.quality, sources: read },
          context.signal,
        );
      } catch (error) {
        // Neither a cancelled request nor a provider error returns an image, so nothing billed reaches the workspace.
        await settle('0');
        if (context.signal?.aborted) return finish(index, 'cancelled');
        void error;
        return finish(index, 'failed', { failure: 'generation-failed' });
      }
      if (outcome.kind === 'refused') {
        // Only token-priced models bill a refusal, and only for the tokens the provider reports.
        await settle(
          Array.isArray(model.pricing) &&
            outcome.usage.kind === 'known' &&
            outcome.usage.input + outcome.usage.output > 0
            ? imageCost(model, call.quality, shape, pricingRevision, outcome.usage)
            : '0',
        );
        return finish(index, 'refused', { failure: 'content-refused' });
      }
      const cost = imageCost(model, call.quality, shape, pricingRevision, outcome.usage);
      const sniffed = sniffMediaType(outcome.bytes)?.mediaType;
      if (!sniffed || !extensions[sniffed]) {
        await settle(cost);
        return finish(index, 'failed', { failure: 'generation-failed' });
      }
      try {
        const file = await deps.files.createDerived(
          context.workspaceId,
          context.actor.userId,
          row.id,
          { name: imageName(call, index, sniffed), parentId: call.folderId ?? null, mediaType: sniffed },
          outcome.bytes,
          async tx => {
            for (const source of read)
              if (
                source.kind === 'file' &&
                (await requireReadableFile(tx, context.actor, source.id)).sha256 !== source.sha256
              )
                throw new AccessDenied();
          },
        );
        await settle(cost);
        return finish(index, 'saved', {
          file: {
            id: file.id,
            name: file.name,
            mediaType: file.mediaType ?? sniffed,
            size: file.size ?? outcome.bytes.byteLength,
            parentId: file.parentId,
          },
        });
      } catch (error) {
        // The provider billed the image even though it could not be saved.
        await settle(cost);
        if (error instanceof FileError && ['size', 'quota', 'busy', 'conflict'].includes(error.code))
          return finish(index, 'failed', { failure: error.code as ImageFailure });
        if (error instanceof AccessDenied) return finish(index, 'failed', { failure: 'conflict' });
        throw error;
      }
    }),
  );

  const saved = images.filter(image => image.state === 'saved').length;
  const refused = images.filter(image => image.state === 'refused').length;
  return {
    // Every image refused is the call's outcome; the provider's own wording is never returned.
    ...(refused === images.length ? { error: 'content-refused' as const } : {}),
    images,
    instruction: [
      saved
        ? `${saved} image${saved === 1 ? ' is' : 's are'} saved in Files and shown as cards under your reply. Refer to them by name.`
        : 'No image was saved.',
      refused
        ? `${refused} image${refused === 1 ? ' was' : 's were'} refused under the provider's content policy. Say so, and do not rewrite the prompt to get around it.`
        : '',
      images.some(image => image.state === 'cancelled')
        ? 'Images not finished when the turn stopped were cancelled.'
        : '',
      images.some(image => image.failure === 'credits-exhausted' || image.failure === 'task-credits')
        ? 'There were not enough credits for some images.'
        : '',
    ]
      .filter(Boolean)
      .join(' '),
  };
}

async function readSource(
  deps: ImageOutputDeps,
  context: ImageOutputContext,
  id: string,
): Promise<(ImageSourceBytes & ImageGenerationRecord['sources'][number]) | null> {
  const typed = (kind: 'file' | 'attachment', bytes: Uint8Array, name: string) => {
    const mediaType = sniffMediaType(bytes)?.mediaType;
    if (!mediaType || !sourceTypes.has(mediaType)) return null;
    return { kind, id, bytes, mediaType, name, sha256: createHash('sha256').update(bytes).digest('hex') };
  };
  try {
    const file = await deps.files.download(context.workspaceId, context.actor.userId, id);
    return typed('file', file.bytes, file.name);
  } catch (error) {
    if (!(error instanceof AccessDenied) && !(error instanceof FileError)) throw error;
  }
  if (context.origin.kind !== 'turn' || !deps.attachments) return null;
  try {
    const attachment = await deps.attachments.download(
      context.workspaceId,
      context.actor.userId,
      context.origin.conversationId,
      id,
    );
    return typed('attachment', attachment.bytes, attachment.filename);
  } catch (error) {
    if (error instanceof AccessDenied || error instanceof AttachmentError) return null;
    throw error;
  }
}

async function destinationAllowed(deps: ImageOutputDeps, context: ImageOutputContext, folderId: string | undefined) {
  if (!folderId) return !context.autonomous;
  try {
    const folder = await deps.files.read(context.workspaceId, context.actor.userId, folderId);
    return folder.kind === 'folder' && (folder.role === 'editor' || folder.role === 'manager');
  } catch (error) {
    if (error instanceof AccessDenied || error instanceof FileError) return false;
    throw error;
  }
}

async function savedFile(deps: ImageOutputDeps, context: ImageOutputContext, id: string) {
  try {
    const item = await deps.files.read(context.workspaceId, context.actor.userId, id);
    if (item.kind !== 'file' || item.trashed) return null;
    return {
      id: item.id,
      name: item.name,
      mediaType: item.mediaType ?? 'image/png',
      size: item.size ?? 0,
      parentId: item.parentId,
    };
  } catch (error) {
    if (error instanceof AccessDenied || error instanceof FileError) return null;
    throw error;
  }
}

/**
 * The generation details of a file for one reader: the prompt, model and origin, with each source listed only when
 * the reader can read it now. Null when the file was not generated.
 */
export async function imageGenerationDetails(
  tx: AuthorizationTransaction,
  actor: HumanActor,
  fileId: string,
): Promise<
  (Omit<ImageGenerationRecord, 'sources'> & { sources: { kind: 'file'; id: string }[]; hiddenSources: number }) | null
> {
  if ((await tx.client.query(`SELECT to_regclass($1) AS present`, [generationsTable(tx)])).rows[0]?.present === null)
    return null;
  const row = z
    .object({
      prompt: z.string(),
      image_model_id: z.string(),
      catalog_revision: z.string().nullable(),
      origin_kind: z.enum(['turn', 'run']),
      origin_id: z.uuid(),
      conversation_id: z.uuid().nullable(),
      sources: z.array(z.object({ kind: z.enum(['file', 'attachment']), id: z.uuid(), sha256: z.string() })),
    })
    .optional()
    .parse(
      (
        await tx.client.query(
          `SELECT prompt,image_model_id,catalog_revision,origin_kind,origin_id,conversation_id,sources FROM ${generationsTable(tx)} WHERE id=$1 AND state='saved'`,
          [fileId],
        )
      ).rows[0],
    );
  if (!row) return null;
  const sources: { kind: 'file'; id: string }[] = [];
  for (const source of row.sources) {
    if (source.kind !== 'file') continue;
    try {
      await requireReadableFile(tx, actor, source.id);
      sources.push({ kind: 'file', id: source.id });
    } catch (error) {
      if (!(error instanceof AccessDenied) && !(error instanceof FileError)) throw error;
    }
  }
  return {
    prompt: row.prompt,
    imageModelId: row.image_model_id,
    catalogRevision: row.catalog_revision,
    origin:
      row.origin_kind === 'turn'
        ? { kind: 'turn', conversationId: row.conversation_id!, turnId: row.origin_id }
        : { kind: 'run', runId: row.origin_id },
    sources,
    hiddenSources: row.sources.length - sources.length,
  };
}

/**
 * The current state of each image of one `images.generate` call of a turn, read from its generation rows. While the
 * call runs, images without a row yet are pending, so every image shows before generation starts.
 */
export async function imageReceipt(
  tx: AuthorizationTransaction,
  origin: Extract<ImageOrigin, { kind: 'turn' }>,
  storedCall: unknown,
  running: boolean,
): Promise<ImageReceipt | undefined> {
  const parsed = generateImagesCallSchema.safeParse(storedCall);
  if (!parsed.success) return undefined;
  if ((await tx.client.query(`SELECT to_regclass($1) AS present`, [generationsTable(tx)])).rows[0]?.present === null)
    return undefined;
  const hash = imageCallHash(parsed.data);
  const ids = Array.from({ length: parsed.data.count }, (_, index) => imageOutputId(origin, hash, index));
  const stored = new Map(
    z
      .array(z.object({ id: z.uuid(), state: z.enum(['pending', 'saved', 'refused', 'failed', 'cancelled']) }))
      .parse(
        (
          await tx.client.query(
            `SELECT id,state FROM ${generationsTable(tx)} WHERE id=ANY($1::uuid[]) AND origin_kind='turn' AND origin_id=$2`,
            [ids, origin.turnId],
          )
        ).rows,
      )
      .map(row => [row.id, row.state]),
  );
  const images = ids.flatMap((id, index) => {
    const state = stored.get(id) ?? (running ? 'pending' : undefined);
    return state ? [{ index, id, state }] : [];
  });
  return images.length ? images : undefined;
}
