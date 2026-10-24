import { canonicalJson } from '@tulipfarm/tables/canonical';
import { modelImageMediaTypes } from '@tulipfarm/media';
import { z } from 'zod';
import { agentDefinitionSchema, scopeSchema, toolCallSchema, taskMutationSchema } from './contracts.ts';
import { googleAgentToolCallSchema } from './google-tool-contracts.ts';
import { resolvedProceduresSchema } from './workspace-skill-contracts.ts';
import { resolveSelectedSkills, skillSelectionsSchema } from './skills.ts';
import { mcpModelCatalogSchema, isMcpCall } from './mcp-contracts.ts';
import { validateMcpCall } from './mcp-catalog.ts';
import { agentRuntimeToolNames, taskDirectToolNames } from './tool-capabilities.ts';
import { skillDefinitionRevision } from './skill-packages.ts';
import { nativeAgentTools, type NativeCall } from './native-tools.ts';
import { readOnlyTools, type ToolName } from './tools.ts';
import { withKnowledgeRetrieveGrant } from './knowledge-tool-contracts.ts';

export const chatToolSchema = toolCallSchema;
export const taskReadTools = new Set<string>(taskDirectToolNames);
const taskMutationTools: ReadonlySet<string> = new Set(
  taskMutationSchema.options.map(option => option.shape.tool.value),
);
const modelToolSchema = z.strictObject({
  id: z.uuid().optional(),
  activity: z.string().trim().min(1).max(120),
  call: chatToolSchema,
});

export const modelDecisionSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('answer'), text: z.string().min(1).max(4000) }),
  z.strictObject({ kind: z.literal('tool'), text: z.string().min(1).max(4000), call: chatToolSchema }),
  z.strictObject({
    kind: z.literal('tools'),
    text: z.string().min(1).max(4000),
    calls: z.array(modelToolSchema).min(2).max(8),
  }),
  z.strictObject({ kind: z.literal('clarify'), text: z.string().min(1).max(4000) }),
  z.strictObject({
    kind: z.literal('propose'),
    text: z.string().min(1).max(4000),
    calls: z.array(taskMutationSchema).min(1).max(50),
  }),
]);
/**
 * A task step's files and instruction links as the chat reader renders them: labelled untrusted blocks, with images
 * as image parts. The model reads it as a user message after the prompt.
 */
export const taskFileContentSchema = z
  .array(
    z.discriminatedUnion('type', [
      z.strictObject({ type: z.literal('text'), text: z.string().min(1) }),
      z.strictObject({ type: z.literal('image'), mediaType: z.enum(modelImageMediaTypes), data: z.base64() }),
    ]),
  )
  .min(1);
export type TaskFileContent = z.infer<typeof taskFileContentSchema>;
export const agentModelInputSchema = z
  .strictObject({
    prompt: z.string().min(1).max(32000),
    definition: agentDefinitionSchema,
    scope: scopeSchema,
    procedures: resolvedProceduresSchema.optional(),
    task: z.literal(true).optional(),
    runtime: z.literal('slackChannel').optional(),
    /** Offers `images.generate` when the agent lists it; set only while the images flag is on. */
    images: z.literal(true).optional(),
    personalMemory: z
      .strictObject({
        content: z.string().refine(value => Array.from(value).length <= 16000),
        revision: z.number().int().nonnegative(),
      })
      .optional(),
    mcp: mcpModelCatalogSchema.optional(),
    files: taskFileContentSchema.optional(),
  })
  .superRefine((input, ctx) => {
    if (input.files && !input.task)
      ctx.addIssue({ code: 'custom', message: 'File content requires a member-owned private task' });
    if (input.task && input.runtime)
      ctx.addIssue({ code: 'custom', message: 'Task inputs cannot select a Slack channel runtime' });
    if (input.personalMemory && !input.task)
      ctx.addIssue({ code: 'custom', message: 'Personal memory requires a member-owned private task' });
    if (input.mcp && (!input.task || !input.definition.mcp?.length))
      ctx.addIssue({ code: 'custom', message: 'MCP catalogs require a named task with explicit permission slots' });
    const selections = input.definition.skills ?? [];
    if (input.procedures === undefined) {
      if (!skillSelectionsSchema.safeParse(selections).success)
        ctx.addIssue({ code: 'custom', message: 'Workspace procedures must be resolved from the run' });
    } else if (
      input.procedures.length !== selections.length ||
      selections.some(
        (selection, i) =>
          selection.id !== input.procedures?.[i]?.id || selection.revision !== input.procedures?.[i]?.revision,
      )
    ) {
      ctx.addIssue({ code: 'custom', message: 'Resolved procedures must match the exact selections' });
    } else {
      for (const procedure of input.procedures) {
        const builtin = skillSelectionsSchema.safeParse([{ id: procedure.id, revision: procedure.revision }]);
        const valid = builtin.success
          ? canonicalJson(resolveSelectedSkills(builtin.data)[0]) === canonicalJson(procedure)
          : skillDefinitionRevision({
              name: procedure.name,
              ...(procedure.description ? { description: procedure.description } : {}),
              instructions: procedure.instructions,
              ...(procedure.package ? { package: procedure.package } : {}),
              ...(procedure.sources ? { sources: procedure.sources } : {}),
            }) === procedure.revision ||
            (!procedure.package &&
              skillDefinitionRevision({
                name: procedure.name,
                instructions: procedure.instructions,
                ...(procedure.sources ? { sources: procedure.sources } : {}),
              }) === procedure.revision);
        if (!valid) ctx.addIssue({ code: 'custom', message: 'Procedure content does not match its revision' });
      }
    }
  });
export function modelProcedures(
  input: z.infer<typeof agentModelInputSchema>,
): z.infer<typeof resolvedProceduresSchema> {
  const parsed = agentModelInputSchema.parse(input);
  return parsed.procedures ?? resolveSelectedSkills(skillSelectionsSchema.parse(parsed.definition.skills ?? []));
}
export type AgentModel = (input: z.infer<typeof agentModelInputSchema>) => Promise<z.infer<typeof modelDecisionSchema>>;
type ModelInput = Parameters<AgentModel>[0];

export function modelNativeTools(input: ModelInput) {
  const runtimeTools = input.runtime ? new Set<string>(agentRuntimeToolNames[input.runtime]) : null;
  const allowed: ToolName[] = input.task
    ? input.definition.tools.filter(tool => taskReadTools.has(tool) || taskMutationTools.has(tool))
    : runtimeTools
      ? input.definition.tools.filter(tool => runtimeTools.has(tool))
      : [...input.definition.tools];
  if (!input.images) allowed.splice(0, allowed.length, ...allowed.filter(tool => tool !== 'images.generate'));
  if (
    (input.definition.skills?.length ?? 0) > 0 &&
    !allowed.includes('skills.read') &&
    (!runtimeTools || runtimeTools.has('skills.read'))
  )
    allowed.push('skills.read');
  return nativeAgentTools(allowed, input.mcp, input.task === true);
}

export function parseNativeAgentDecision(
  value: { text: string; calls: NativeCall[] },
  input: ModelInput,
  catalog = modelNativeTools(input),
) {
  if (!value.calls.length) return parseModelDecision({ kind: 'answer', text: value.text }, input);
  if (value.calls.length > 8) throw new Error('tool-limit');
  const resolved = value.calls.map(call => catalog.resolve(call));
  if (resolved.some(result => !result.ok)) throw new Error('invalid-tool-call');
  const calls = resolved.flatMap(result => (result.ok ? [{ activity: result.activity, call: result.call }] : []));
  if (calls.length > 1 && calls.some(item => !readOnlyTools.has(item.call.tool))) throw new Error('parallel-write');
  const text = value.text.trim() || calls.map(item => item.activity).join('\n');
  if (input.task && calls.every(item => taskMutationTools.has(item.call.tool))) {
    return parseModelDecision({ kind: 'propose', text, calls: calls.map(item => item.call) }, input);
  }
  return parseModelDecision(
    calls.length === 1 ? { kind: 'tool', text, call: calls[0]?.call } : { kind: 'tools', text, calls },
    input,
  );
}

export function parseModelDecision(value: unknown, input: Parameters<AgentModel>[0]) {
  const decision = modelDecisionSchema.parse(value);
  const calls =
    decision.kind === 'tool' ? [decision.call] : decision.kind === 'tools' ? decision.calls.map(item => item.call) : [];
  for (const call of calls) {
    if (isMcpCall(call)) {
      if (!input.task || !input.definition.mcp?.length) throw new Error('mcp-origin-denied');
      validateMcpCall(call, input.mcp);
    } else {
      if (call.tool.startsWith('google.')) googleAgentToolCallSchema.parse(call);
      const runtimeTools = input.task
        ? taskReadTools
        : input.runtime
          ? new Set<string>(agentRuntimeToolNames[input.runtime])
          : null;
      const automaticSkillRead = call.tool === 'skills.read' && (input.definition.skills?.length ?? 0) > 0;
      if (
        (!withKnowledgeRetrieveGrant(input.definition.tools).includes(call.tool) && !automaticSkillRead) ||
        (runtimeTools && !runtimeTools.has(call.tool))
      )
        throw new Error('tool-not-admitted');
      if (call.tool === 'skills.read') {
        const id = call.skillId;
        const selected = input.definition.skills?.find(selection => selection.id === id);
        if (automaticSkillRead && (!selected || selected.revision !== call.revision))
          throw new Error('tool-not-admitted');
        if (z.uuid().safeParse(id).success && (!selected || selected.revision !== call.revision))
          throw new Error('tool-not-admitted');
        if (selected && call.revision !== undefined && selected.revision !== call.revision)
          throw new Error('tool-not-admitted');
        if (z.uuid().safeParse(id).success && !/^[a-f0-9]{64}$/.test(call.revision ?? ''))
          throw new Error('tool-not-admitted');
      }
    }
  }
  if (
    decision.kind === 'propose' &&
    (!input.task || decision.calls.some(call => !input.definition.tools.includes(call.tool)))
  )
    throw new Error('tool-not-admitted');
  return decision;
}
export class ModelUnavailable extends Error {
  readonly status: number | null;
  constructor(status: number | null) {
    super('Model decision unavailable');
    this.status = status;
  }
}
