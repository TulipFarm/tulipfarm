import { Link } from '@tanstack/react-router';
import { workspaceRoute } from '@/router';
import { Button } from '@tulipfarm/sprout/button';
import { PageContent } from '@tulipfarm/sprout/page-content';
import { PageHeader } from '@tulipfarm/sprout/page-header';

const supportEmail = import.meta.env.VITE_SUPPORT_EMAIL;

export function HelpPage() {
  const { workspace } = workspaceRoute.useRouteContext();
  return (
    <div className="min-h-0 flex-1 overflow-auto">
      <PageContent>
        <PageHeader title="Help and support" description="Find the next step when your work is blocked." />
        <section className="space-y-3">
          <h2 className="text-lg font-medium">An agent cannot start</h2>
          <p>
            Check that its instructions are activated, you have run permission, and its selected model is available. A
            person with the agent’s manage permission, called an agent manager, turns on execution, activates
            instructions, and shares access. Approval of an action does not grant more permissions.
          </p>
          <Button
            variant="outline"
            nativeButton={false}
            render={<Link to="/$workspaceSlug/agents" params={{ workspaceSlug: workspace.slug }} />}
          >
            Open agents
          </Button>
        </section>
        <section className="space-y-3">
          <h2 className="text-lg font-medium">From a chat draft to the first run</h2>
          <ol className="list-decimal space-y-2 pl-5">
            <li>
              Review the agent draft in chat and save it. Saving stores the instructions; it does not turn the agent on.
            </li>
            <li>An agent manager opens the agent’s Execution tab, turns on execution, and saves.</li>
            <li>
              The agent manager activates the saved instructions. Later edits stay inactive until someone activates
              them.
            </li>
            <li>The agent manager shares invoke access on the Access tab with you or one of your teams.</li>
            <li>Start a task from the agent. Its setup checklist shows the next step and who must take it.</li>
          </ol>
          <p>
            Skills work the same way: a skill manager reviews each saved revision before agents use it. Skills add steps
            to follow, not permissions.
          </p>
        </section>
        <section className="space-y-3">
          <h2 className="text-lg font-medium">Using earlier steps in a workflow</h2>
          <p>
            A step can use a fixed value, the workflow input, or the output of an earlier step. It can only read steps
            that always run before it: a step that a condition can skip leaves no output. To read one field, separate
            nested names with /, such as contract / start_date. Leave the field empty to use the whole input or output.
          </p>
          <Button
            variant="outline"
            nativeButton={false}
            render={<Link to="/$workspaceSlug/workflows" params={{ workspaceSlug: workspace.slug }} />}
          >
            Open workflows
          </Button>
        </section>
        <section className="space-y-3">
          <h2 className="text-lg font-medium">Who can see an agent or a file</h2>
          <p>
            An agent’s Access tab lists each person and team it is shared with. Read lets them see it, invoke lets them
            start tasks, edit lets them change its instructions, and manage lets them change access, execution, and
            activation. Files added to your Knowledge stay private to you. Files added to a project are visible to
            everyone in that project. Being a workspace admin does not add access.
          </p>
        </section>
        <section className="space-y-3">
          <h2 className="text-lg font-medium">Credits or models are unavailable</h2>
          <p>
            Ask an admin to check workspace credits and model access. An unavailable model does not erase your saved
            preference. For exhausted credits or platform configuration, contact support.
          </p>
          <div className="flex flex-wrap gap-2">
            <Button
              variant="outline"
              nativeButton={false}
              render={<Link to="/$workspaceSlug/settings" params={{ workspaceSlug: workspace.slug }} />}
            >
              Workspace settings
            </Button>
            <Button
              variant="outline"
              nativeButton={false}
              render={<Link to="/$workspaceSlug/settings/models" params={{ workspaceSlug: workspace.slug }} />}
            >
              Model access
            </Button>
          </div>
        </section>
        <section className="space-y-3">
          <h2 className="text-lg font-medium">A submitted change is unconfirmed</h2>
          <p>
            Use the status or recovery action beside the change. Do not create a replacement while the original outcome
            is unknown. Work already accepted by the server may continue after you leave.
          </p>
        </section>
        <section className="space-y-3">
          <h2 className="text-lg font-medium">Files and integrations</h2>
          <p>
            Personal chat files are stored for download. Tasks can read selected UTF-8 text, CSV, JSON, and Markdown
            files up to 16,000 bytes. Personal Google accounts stay private; administrator workflow inputs have a
            different audience and setup.
          </p>
          <Button
            variant="outline"
            nativeButton={false}
            render={<Link to="/$workspaceSlug/integrations" params={{ workspaceSlug: workspace.slug }} />}
          >
            Open integrations
          </Button>
        </section>
        {supportEmail && (
          <section className="space-y-3 border-t pt-6">
            <h2 className="text-lg font-medium">Contact TulipFarm</h2>
            <p>
              Email {supportEmail} with the action you tried, what happened, and any diagnostic reference. Never include
              passwords, provider tokens, or private file contents.
            </p>
            <Button
              nativeButton={false}
              render={
                <a
                  href={`mailto:${supportEmail}?subject=${encodeURIComponent(`TulipFarm support: ${workspace.slug}`)}`}
                />
              }
            >
              Email support
            </Button>
            <p className="break-all text-sm text-muted-foreground">Workspace reference: {workspace.id}</p>
          </section>
        )}
      </PageContent>
    </div>
  );
}
