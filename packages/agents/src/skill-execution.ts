import { createHash } from 'node:crypto';
import { z } from 'zod';
import {
  AccessDenied,
  currentMember,
  lockAuthorization,
  requireNoMcpDerived,
  sourceDependenciesSchema,
  uuidSchema,
  type HumanActor,
  type SourceDependency,
} from '@tulipfarm/access';
import { createFiles, type FileBytes } from '@tulipfarm/files';
import { skillJobSchema, skillResultSchema, type SkillClient } from '@tulipfarm/workflow-snippets/skill-protocol';
import { canonicalJson } from '@tulipfarm/tables/canonical';
import { bindFileSources } from '@tulipfarm/conversations/file-references';
import { relation, type AgentStorage, type AgentTransaction } from './store.ts';
import { createWorkspaceSkills } from './workspace-skills.ts';
import { createSkillObjects, skillPackageCompatibility } from './skill-objects.ts';
import { requireDraftSources } from './draft-sources.ts';
import {
  skillExecutionCallSchema,
  skillExecutionResultSchema,
  type SkillExecutionCall,
} from './skill-execution-contracts.ts';
import { SkillPackageError } from './skill-package-contracts.ts';
import { createSkillTools } from './skill-tools.ts';
import { skillFileResultSchema, type skillFileCallSchema } from './skill-execution-contracts.ts';

export type SkillExecutionContext = {
  workspaceId: string;
  actor: HumanActor;
  callId: string;
  scope: { kind: 'conversation'; id: string; turnId: string } | { kind: 'run'; id: string };
  sources: readonly SourceDependency[];
};
export type SkillExecutionFactory = (runtime: AgentStorage) => {
  execute(
    context: SkillExecutionContext,
    call: SkillExecutionCall,
  ): Promise<z.infer<typeof skillExecutionResultSchema>>;
  readFile(
    context: SkillExecutionContext,
    call: z.infer<typeof skillFileCallSchema>,
  ): Promise<z.infer<typeof skillFileResultSchema>>;
};
const outputTypes: Record<string, string> = {
  txt: 'text/plain',
  md: 'text/markdown',
  csv: 'text/csv',
  json: 'application/json',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
};
export function skillOutput(path: string, content: string) {
  const bytes = Buffer.from(content, 'base64');
  if (bytes.toString('base64') !== content || !bytes.length) throw new SkillPackageError('invalid-package');
  const name = path.split('/').at(-1)!;
  const extension = name.split('.').at(-1)!.toLowerCase(),
    mediaType = outputTypes[extension];
  if (!mediaType || name.length > 200) throw new SkillPackageError('runtime-unavailable');
  if (extension === 'png') {
    if (!bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])))
      throw new SkillPackageError('invalid-package');
  } else if (extension === 'jpg' || extension === 'jpeg') {
    if (
      !bytes.subarray(0, 3).equals(Buffer.from([255, 216, 255])) ||
      !bytes.subarray(-2).equals(Buffer.from([255, 217]))
    )
      throw new SkillPackageError('invalid-package');
  } else {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    if (text.includes('\0')) throw new SkillPackageError('invalid-package');
    if (extension === 'json') JSON.parse(text);
  }
  return { name, mediaType, bytes };
}
function outputId(invocationId: string, path: string) {
  const hash = createHash('sha256')
    .update(JSON.stringify(['skill-output-v1', invocationId, path]))
    .digest('hex');
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-8${hash.slice(13, 16)}-8${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
}

export function createSkillExecutionFactory(bytes: FileBytes, client?: SkillClient): SkillExecutionFactory {
  return runtime => {
    const objects = createSkillObjects(runtime, bytes),
      skills = createWorkspaceSkills(runtime),
      files = createFiles(runtime, bytes);
    async function execute(context: SkillExecutionContext, value: SkillExecutionCall) {
      const call = skillExecutionCallSchema.parse(value);
      const { invocationId: suppliedId, ...request } = call;
      const id = uuidSchema.parse(suppliedId ?? context.callId);
      const reference = { kind: 'workspace-skill' as const, skillId: call.skillId, revision: call.revision };
      let sources = sourceDependenciesSchema.parse([
        ...new Map([...context.sources, reference].map(source => [canonicalJson(source), source])).values(),
      ]);
      const verify = async (tx: AgentTransaction) => {
        await currentMember(tx, context.actor);
        const row = (
          await tx.client.query(
            `SELECT membership_id,request,scope,sources,result FROM ${relation(tx, 'tf_skill_invocations')} WHERE id=$1`,
            [id],
          )
        ).rows[0];
        if (
          row &&
          (row.membership_id !== context.actor.membershipId ||
            canonicalJson(row.scope) !== canonicalJson(context.scope))
        )
          throw new AccessDenied();
        if (row && canonicalJson(row.request) !== canonicalJson(request))
          throw new SkillPackageError('import-conflict');
        if (row) sources = sourceDependenciesSchema.parse(row.sources);
        await requireNoMcpDerived(tx, sources);
        await requireDraftSources(
          bindFileSources(tx),
          context.actor,
          sources,
          new Set(),
          context.scope.kind === 'run' ? context.scope.id : undefined,
        );
        return row;
      };
      const [skill] = await skills.resolve(context.workspaceId, context.actor, [
        { id: call.skillId, revision: call.revision },
      ]);
      if (!skill?.package) throw new SkillPackageError('package-unavailable');
      const extensions = { bash: /\.(?:sh|bash)$/i, python: /\.py$/i, node: /\.(?:js|mjs|cjs)$/i };
      if (
        !extensions[call.language].test(call.entrypoint) ||
        !skill.package.manifest.files.some(file => file.path === call.entrypoint)
      )
        throw new SkillPackageError('runtime-unavailable');
      const prior = await runtime.transaction(context.workspaceId, skillPackageCompatibility, async tx => {
        await lockAuthorization(tx, 'write');
        const row = await verify(tx);
        if (row) return row.result ? skillExecutionResultSchema.parse(row.result) : null;
        if (suppliedId) throw new AccessDenied();
        await tx.client.query(
          `INSERT INTO ${relation(tx, 'tf_skill_invocations')} (id,membership_id,skill_id,revision,request,sources,scope) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
          [
            id,
            context.actor.membershipId,
            call.skillId,
            call.revision,
            request,
            JSON.stringify(sources),
            context.scope,
          ],
        );
        return null;
      });
      if (prior) return prior;
      const pending = (error: string) =>
        skillExecutionResultSchema.parse({
          invocationId: id,
          status: 'pending',
          exitCode: null,
          stdout: '',
          stderr: '',
          files: [],
          error,
          sources,
          instruction:
            'The execution outcome is not confirmed. Check with this invocationId and the same arguments. Never create a fresh invocation to retry.',
        });
      if (!client) return pending('runtime-unavailable');
      const packageFiles = await objects.readFiles(context.workspaceId, skill.package);
      await runtime.transaction(context.workspaceId, skillPackageCompatibility, async tx => {
        await lockAuthorization(tx);
        await verify(tx);
      });
      await skills.resolve(context.workspaceId, context.actor, [{ id: call.skillId, revision: call.revision }]);
      const job = skillJobSchema.parse({
        kind: 'skill',
        version: 1,
        workspaceId: context.workspaceId,
        invocationId: id,
        packageDigest: skill.package.digest,
        language: call.language,
        entrypoint: call.entrypoint,
        args: call.args,
        input: call.input,
        files: packageFiles.map(file => ({
          path: file.path,
          content: Buffer.from(file.bytes).toString('base64'),
          digest: createHash('sha256').update(file.bytes).digest('hex'),
        })),
      });
      let result: z.infer<typeof skillResultSchema>;
      try {
        if (client.available && !(await client.available())) return pending('runtime-unavailable');
        result = skillResultSchema.parse(await client.submit(job));
      } catch {
        await runtime.transaction(context.workspaceId, skillPackageCompatibility, async tx => {
          await lockAuthorization(tx);
          await verify(tx);
        });
        return pending('execution-outcome-unknown');
      }
      await runtime.transaction(context.workspaceId, skillPackageCompatibility, async tx => {
        await lockAuthorization(tx);
        await verify(tx);
      });
      const output = skillExecutionResultSchema.parse({
        invocationId: id,
        status:
          result.kind === 'pending'
            ? 'pending'
            : result.kind === 'failed' || result.exitCode !== 0
              ? 'failed'
              : 'completed',
        exitCode: result.kind === 'completed' ? result.exitCode : null,
        stdout: result.kind === 'completed' ? result.stdout : '',
        stderr: result.kind === 'completed' ? result.stderr : '',
        files: [],
        error:
          result.kind === 'failed'
            ? result.error
            : result.kind === 'completed' && result.exitCode !== 0
              ? 'script-exit-failed'
              : null,
        sources,
        instruction:
          result.kind === 'pending'
            ? 'Execution is pending. Call skills.execute with this invocationId and the same arguments to check it. Never start a new invocation to retry an unknown outcome.'
            : 'Report the exit status and any Files outputs. A successful script is not approval to perform business actions.',
      });
      if (result.kind === 'completed' && result.exitCode === 0) {
        let outputs: (ReturnType<typeof skillOutput> & { path: string })[] = [];
        try {
          outputs = result.files.map(file => ({ path: file.path, ...skillOutput(file.path, file.content) }));
        } catch (error) {
          if (!(error instanceof SkillPackageError || error instanceof SyntaxError || error instanceof TypeError))
            throw error;
          output.status = 'failed';
          output.error = 'output-rejected';
          output.instruction =
            'The script finished, but its output format is unsupported or invalid. No output files were published. Report this failure; do not repeat the execution automatically.';
        }
        for (const file of outputs) {
          const fileId = outputId(id, file.path);
          const published = await files.createDerived(
            context.workspaceId,
            context.actor.userId,
            fileId,
            { name: file.name, parentId: call.folderId ?? null, mediaType: file.mediaType },
            file.bytes,
            async tx => {
              await verify(tx);
              await tx.client.query(
                `INSERT INTO ${relation(tx, 'tf_file_skill_sources')} (file_id,invocation_id,sources) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`,
                [fileId, id, JSON.stringify(sources)],
              );
            },
          );
          output.files.push({ id: published.id, name: published.name });
        }
      }
      if (output.status !== 'pending')
        await runtime.transaction(context.workspaceId, skillPackageCompatibility, async tx => {
          await lockAuthorization(tx, 'write');
          await verify(tx);
          await tx.client.query(
            `UPDATE ${relation(tx, 'tf_skill_invocations')} SET result=$2 WHERE id=$1 AND result IS NULL`,
            [id, JSON.stringify(output)],
          );
        });
      return output;
    }
    return {
      execute,
      async readFile(context, call) {
        return skillFileResultSchema.parse(
          await createSkillTools(runtime, bytes).readFile(
            context.workspaceId,
            context.actor,
            call.skillId,
            call.revision,
            call.path,
            call.offset,
          ),
        );
      },
    };
  };
}
