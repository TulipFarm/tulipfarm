import { useMemo, useState } from 'react';
import { useNavigate } from '@tanstack/react-router';
import leaveManagement from '@tulipfarm/config/examples/system-packages/leave-management.json';
import { systemPackageSchema } from '@tulipfarm/agents/system-package-contracts';
import { Badge } from '@tulipfarm/sprout/badge';
import { Button } from '@tulipfarm/sprout/button';
import { PageContent } from '@tulipfarm/sprout/page-content';
import { PageHeader } from '@tulipfarm/sprout/page-header';
import { conversationApi } from '@/features/chat/conversation-api';
import { useConversationChanges } from '@/features/chat/queries';
import { useTableWrite } from '@/features/tables/use-table-write';
import { WriteFeedback } from '@/features/tables/feedback';
import { workspaceRoute } from '@/router';

export const bundledPackage = systemPackageSchema.parse(leaveManagement);

export function SystemPackagesPage() {
  const { workspace } = workspaceRoute.useRouteContext();
  const navigate = useNavigate();
  const changes = useConversationChanges();
  const api = useMemo(() => conversationApi(workspace.id, () => undefined), [workspace.id]);
  const [selection] = useState(() => ({ chatId: crypto.randomUUID(), commandId: crypto.randomUUID() }));
  const write = useTableWrite(
    async (input: typeof selection) => {
      await api.command({ kind: 'create', ...input }, AbortSignal.timeout(30_000));
      return input.chatId;
    },
    chatId => {
      void changes.created(chatId);
      void navigate({
        to: '/$workspaceSlug/chat/$chatId',
        params: { workspaceSlug: workspace.slug, chatId },
        search: { package: 'leave-management' },
      });
    },
  );
  const busy = write.state.kind === 'sending' || write.state.kind === 'uncertain';
  return (
    <div className="min-h-0 flex-1 overflow-auto">
      <PageContent>
        <PageHeader title="Packages" description="Choose a system. Set it up and review each change in chat." />
        <p className="text-sm text-muted-foreground">
          The marketplace is not connected yet. These bundled local examples use the real installer.
        </p>
        <section aria-label="Available packages" className="mt-6">
          <div className="space-y-3 border-b pb-6">
            <Badge variant="outline">Bundled local example</Badge>
            <h2 className="text-base font-medium">{bundledPackage.package.title}</h2>
            <p className="text-sm text-muted-foreground">{bundledPackage.package.description}</p>
            <p className="text-xs text-muted-foreground">
              Version {bundledPackage.package.version} · {bundledPackage.package.license}
            </p>
            <Button disabled={busy} onClick={() => void write.submit(selection)}>
              {write.state.kind === 'sending' ? 'Opening chat…' : 'Open Leave Management in chat'}
            </Button>
          </div>
        </section>
        <WriteFeedback
          state={write.state}
          retry={input => void write.submit(input)}
          checkStatus={() => void write.submit(selection)}
        />
      </PageContent>
    </div>
  );
}
