import {
  createTaskRuntime,
  TaskFileUnsupported,
  taskFilesReader,
  taskGoogleFilesReader,
} from '@tulipfarm/agents/task-runtime';
import { googleOperations } from './google-composition.ts';
import { createTaskProgress, type TaskProgress } from '@tulipfarm/agents/task-progress';
import { createMemoryRouteHealth } from '@tulipfarm/agents/chat';
import { modelEnvironment } from '@tulipfarm/agents/model-environment';
import type { ModelBundleStore } from '@tulipfarm/agents/model-bundles';
import { createAttachments } from '@tulipfarm/conversations/attachments';
import { createFiles } from '@tulipfarm/files';
import { chatObjectStore } from '@tulipfarm/workspaces/chat-objects';
import { slackActionsFromEnvironment } from '@tulipfarm/agents/slack-environment';
import { workspaceMcpFromEnvironment } from './workspace-mcp-composition.ts';
import type { McpExecutionFactory } from '@tulipfarm/agents/mcp-runtime';
import { githubTaskTools } from './github-composition.ts';
import { withKnowledgeSourceAuthorization } from '@tulipfarm/knowledge';
import type { KnowledgeToolsFactory } from '@tulipfarm/agents/tools';
import { createKnowledgeTools } from './knowledge-tools-composition.ts';
import { createSkillExecutionFactory } from '@tulipfarm/agents/skill-execution';
import { configuredSkillClient } from '@tulipfarm/workflow-snippets/client';

export function createTaskComposition(
  storage: Parameters<typeof createTaskRuntime>[0],
  mcp: McpExecutionFactory | undefined = workspaceMcpFromEnvironment(),
  knowledge: KnowledgeToolsFactory = createKnowledgeTools({ runtime: storage }),
  bundles?: ModelBundleStore,
) {
  const runtime = withKnowledgeSourceAuthorization(storage);
  const environment = modelEnvironment();
  const model = environment?.continuity(createMemoryRouteHealth, bundles) ?? null;
  const objects = chatObjectStore();
  const attachments = objects ? createAttachments(runtime, objects) : null;
  const files = objects ? createFiles(runtime, objects) : null;
  let google: ReturnType<typeof googleOperations> | undefined;
  const tasks = createTaskRuntime(
    runtime,
    model,
    attachments
      ? async input => {
          const file = await attachments.download(
            input.workspaceId,
            input.userId,
            input.conversationId,
            input.attachmentId,
          );
          if (
            !['text/plain', 'text/csv', 'application/json', 'text/markdown'].includes(file.mediaType) ||
            file.bytes.byteLength > 16000
          )
            throw new TaskFileUnsupported();
          try {
            return { filename: file.filename, text: new TextDecoder('utf-8', { fatal: true }).decode(file.bytes) };
          } catch {
            throw new TaskFileUnsupported();
          }
        }
      : undefined,
    slackActionsFromEnvironment(),
    mcp,
    githubTaskTools,
    knowledge,
    files ? taskFilesReader(files) : undefined,
    taskGoogleFilesReader({ fileText: (...args) => (google ??= googleOperations(runtime)).fileText(...args) }),
    objects ? createSkillExecutionFactory(objects, configuredSkillClient()) : undefined,
  );
  const progress = createTaskProgress(runtime);
  async function processAgentTaskStep(workspaceId: string, taskId: string): Promise<TaskProgress> {
    try {
      await mcp?.(runtime).recover(workspaceId);
      await tasks.process(workspaceId, taskId);
      return await progress(workspaceId, taskId);
    } catch {
      // Database and provider failures can contain private inputs. Temporal stores errors.
      throw new Error('task-step-unavailable');
    }
  }
  return {
    model,
    registerModelBundle: async () => {
      if (environment && bundles) await bundles.register(environment.bundle);
    },
    activities: {
      processAgentTaskStep,
      processAgentTask: async (workspaceId: string, taskId: string) => {
        await processAgentTaskStep(workspaceId, taskId);
      },
    },
    close: async () => {
      objects?.close();
    },
  };
}
