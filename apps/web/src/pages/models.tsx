import { useCallback, useEffect, useMemo, useState } from 'react';
import type { ModelCatalogFamily, ModelCatalogImageModel } from '@tulipfarm/config/model-catalog';
import { workspaceModelsRoute, workspaceRoute } from '@/router';
import { useNavigate } from '@tanstack/react-router';
import { Cpu } from 'reicon-react/icons/Cpu';
import { PageContent } from '@tulipfarm/sprout/page-content';
import { PageHeader } from '@tulipfarm/sprout/page-header';
import { ModelsSample, StatePanel } from '@tulipfarm/sprout/state-panel';
import { useModelMembership } from '@/features/models/queries';
import { useModelCatalog } from '@/features/models/use-model-catalog';
import type { ReadState } from '@/features/tables/request-state';
import { modelApi } from '@/features/models/api';
import { ModelRead } from '@/features/models/read';
import { FallbackRule } from '@/features/models/fallback-rule';
import { CompactionPolicySection } from '@/features/models/compaction-policy';
import { ModelAvailability } from '@/features/models/availability';
import { ModelSetupLink } from '@/features/models/model-setup';
import { ImageSettingsSection } from '@/features/models/image-settings';
import { useFlag } from '@/lib/feature-flags';
import { ChatGptPlanPane } from '@/features/models/chatgpt-plan';
import { isChatGptFamily } from '@/features/models/chatgpt-plan-api';
import {
  ApiKeysPane,
  ComingSoonPane,
  ModelSources,
  SharedPlanPane,
  type ModelSource,
} from '@/features/models/model-sources';

export function ModelsPage() {
  const { workspace, user } = workspaceRoute.useRouteContext();
  return <WorkspaceModels key={`${user.id}:${workspace.id}`} workspaceId={workspace.id} userId={user.id} />;
}

function WorkspaceModels({ workspaceId, userId }: { workspaceId: string; userId: string }) {
  const api = useMemo(() => modelApi(workspaceId), [workspaceId]);
  const [snapshot, setSnapshot] = useState<{
    families: ModelCatalogFamily[];
    imageModels: ModelCatalogImageModel[];
    membership: Awaited<ReturnType<typeof api.membership>>;
  } | null>(null);
  const [accessVersion, setAccessVersion] = useState(0);
  const catalog = useModelCatalog(workspaceId);
  const membership = useModelMembership(api.membership);
  useEffect(() => {
    if (catalog.state.kind !== 'ready' || membership.state.kind !== 'ready') return;
    if (
      snapshot &&
      (catalog.state.error || membership.state.error || catalog.state.refreshing || membership.state.refreshing)
    )
      return;
    setSnapshot({
      families: catalog.state.data.families,
      imageModels: catalog.state.data.imageModels,
      membership: membership.state.data,
    });
    setAccessVersion(previous => previous + 1);
  }, [
    catalog.state.kind,
    catalog.state.kind === 'ready' && catalog.state.data,
    catalog.state.kind === 'ready' && catalog.state.refreshing,
    catalog.state.kind === 'ready' && catalog.state.error,
    membership.state.kind,
    membership.state.kind === 'ready' && membership.state.data,
    membership.state.kind === 'ready' && membership.state.refreshing,
    membership.state.kind === 'ready' && membership.state.error,
  ]);
  const refresh = useCallback(async () => {
    await Promise.all([catalog.refresh(), membership.refresh()]);
  }, [catalog.refresh, membership.refresh]);
  const state: ReadState<NonNullable<typeof snapshot>> =
    catalog.state.kind !== 'ready'
      ? catalog.state
      : membership.state.kind !== 'ready'
        ? membership.state
        : snapshot
          ? {
              kind: 'ready',
              data: snapshot,
              refreshing: catalog.state.refreshing || membership.state.refreshing,
              error: catalog.state.error ?? membership.state.error,
            }
          : { kind: 'loading' };
  const read = { state, refresh };
  const concealed = read.state.kind !== 'ready';
  const writable = read.state.kind === 'ready' && !read.state.refreshing && !read.state.error;
  const admin = snapshot?.membership.role === 'admin';
  const images = useFlag('images');
  const navigate = useNavigate({ from: workspaceModelsRoute.fullPath });
  const chatGptOutcome = workspaceModelsRoute.useSearch({ select: search => search.chatgpt });
  const selected: ModelSource = workspaceModelsRoute.useSearch({ select: search => search.tab ?? 'access' });
  // A finished ChatGPT sign-in lands here; show the ChatGPT plan so its result is visible.
  const source: ModelSource = chatGptOutcome ? 'chatgpt' : selected === 'images' && !images ? 'access' : selected;
  const builtIn = (snapshot?.families ?? []).filter(family => !isChatGptFamily(family));
  const clearChatGptOutcome = useCallback(
    () => void navigate({ search: previous => ({ ...previous, chatgpt: undefined }), replace: true }),
    [navigate],
  );
  return (
    <PageContent>
      <PageHeader
        title="Models"
        description="Choose the models your chats and agents use: TulipFarm’s models or your own AI plans."
      />
      <ModelRead state={read.state} refresh={read.refresh} label="workspace models">
        {({ families, membership }) => (
          <>
            {read.state.kind === 'ready' && read.state.error && (
              <p role="status" className="text-sm text-muted-foreground">
                Displayed models may be out of date. Reload to check current availability.
              </p>
            )}
            {membership.role !== 'admin' && (
              <p className="text-sm text-muted-foreground">
                Only workspace admins can change TulipFarm model access and workspace settings. You can still connect
                and share your own plans.
              </p>
            )}
            {!families.length && (
              <StatePanel
                kind="empty"
                icon={Cpu}
                title="No models configured yet"
                description="Once your operator configures model providers, each model family appears here. Admins then choose which teams can use it and pick a fallback if it becomes unavailable."
                sample={<ModelsSample />}
              >
                <ModelSetupLink size="sm" />
              </StatePanel>
            )}
          </>
        )}
      </ModelRead>
      <ModelSources
        workspaceId={workspaceId}
        source={source}
        builtInCount={snapshot ? builtIn.length : null}
        images={images}
      >
        {source === 'access' && (
          <div className="grid gap-4">
            <header>
              <h2 className="text-lg font-medium">TulipFarm models</h2>
              <p className="text-sm text-muted-foreground">
                These models use workspace credits. Admins choose which teams can use each one, and agents follow the
                same rules.
              </p>
            </header>
            <ModelAvailability
              userId={userId}
              workspaceId={workspaceId}
              families={builtIn}
              imageModels={images ? (snapshot?.imageModels ?? []) : []}
              admin={admin}
              concealed={concealed}
              writable={writable}
              accessVersion={accessVersion}
              refreshAccess={read.refresh}
              renderRow={(family, row) =>
                snapshot && (
                  <FallbackRule
                    api={api}
                    userId={userId}
                    workspaceId={workspaceId}
                    source={family}
                    families={snapshot.families}
                    admin={admin}
                    concealed={concealed}
                    writable={writable}
                    accessVersion={accessVersion}
                    refreshAccess={read.refresh}
                    row={row}
                  />
                )
              }
            />
          </div>
        )}
        {source === 'chatgpt' && (
          <ChatGptPlanPane workspaceId={workspaceId} outcome={chatGptOutcome} clearOutcome={clearChatGptOutcome} />
        )}
        {(source === 'claude' || source === 'copilot') && <ComingSoonPane provider={source} />}
        {source === 'keys' && <ApiKeysPane />}
        {source.startsWith('plan:') && (
          <SharedPlanPane workspaceId={workspaceId} connectionId={source.slice('plan:'.length)} />
        )}
        {source === 'compaction' && snapshot && !concealed && (
          <CompactionPolicySection
            key={`${workspaceId}:${snapshot.membership.membershipId}:${snapshot.membership.role}`}
            workspaceId={workspaceId}
            admin={admin}
            writable={writable}
            accessVersion={accessVersion}
          />
        )}
        {source === 'images' && snapshot && !concealed && (
          <ImageSettingsSection
            key={`${workspaceId}:${snapshot.membership.membershipId}:${snapshot.membership.role}`}
            workspaceId={workspaceId}
            admin={admin}
            writable={writable}
            accessVersion={accessVersion}
          />
        )}
      </ModelSources>
    </PageContent>
  );
}
