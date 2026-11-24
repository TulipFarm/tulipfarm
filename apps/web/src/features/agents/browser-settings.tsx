import { browserAllowedSitesSchema } from '@tulipfarm/browser/contracts';
import type { AgentBrowserSettings } from '@tulipfarm/agents/contracts';
import { ChoiceGroup, Field } from '@tulipfarm/sprout/field';
import { FormSection } from '@tulipfarm/sprout/form';
import { Skeleton } from '@tulipfarm/sprout/skeleton';
import { Textarea } from '@tulipfarm/sprout/textarea';
import { useBrowserLogins } from '@/features/browser/logins';

const loginLimit = 10;

const siteLines = (text: string) =>
  text
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean);

/** The allowed sites typed one per line, or an error to show. Empty text allows any public website. */
export function parseBrowserSites(text: string): { sites?: string[]; error?: string } {
  const lines = siteLines(text);
  if (!lines.length) return {};
  const parsed = browserAllowedSitesSchema.safeParse(lines);
  if (parsed.success) return { sites: [...new Set(parsed.data)] };
  return {
    error:
      lines.length > 50
        ? 'List 50 sites or fewer.'
        : 'Enter one site per line, such as example.com, without https:// or a path.',
  };
}

/** What the saved definition stores: nothing when the agent may visit any site and loads no logins. */
export function browserSettings(sitesText: string, logins: readonly string[]): AgentBrowserSettings | undefined {
  const { sites } = parseBrowserSites(sitesText);
  if (!sites && !logins.length) return undefined;
  return { ...(sites ? { sites } : {}), ...(logins.length ? { logins: [...logins] } : {}) };
}

/** Where an agent's browser may go, and which saved logins load into it, for its runs. */
export function AgentBrowserSettingsSection({
  workspaceId,
  sites,
  logins,
  error,
  disabled,
  onChange,
}: {
  workspaceId: string;
  sites: string;
  logins: readonly string[];
  error: string | undefined;
  disabled: boolean;
  onChange: (change: { browserSites?: string; browserLogins?: string[] }) => void;
}) {
  const read = useBrowserLogins(workspaceId);
  const available = read.state.kind === 'ready' ? read.state.data.logins.filter(login => login.canUse) : [];
  // Logins chosen by another manager stay chosen even when this manager can't see them.
  const hidden = logins.filter(id => !available.some(login => login.id === id));
  return (
    <FormSection
      title="Browser"
      description="Where this agent can browse and which logins it uses. Each run gets its own browser, which closes when the run ends."
    >
      <Field
        optional
        label="Allowed sites"
        helper="One site per line. Subdomains are included. Leave empty to let the agent visit any public website."
        error={error}
      >
        <Textarea
          value={sites}
          rows={4}
          maxLength={5000}
          placeholder={'example.com\nshop.example.org'}
          disabled={disabled}
          onChange={event => onChange({ browserSites: event.target.value })}
        />
      </Field>
      {read.state.kind === 'loading' ? (
        <Skeleton shape="panel" />
      ) : read.state.kind !== 'ready' ? (
        <p role="alert" className="text-sm text-destructive">
          Couldn’t show saved logins. You can still save the other settings.
        </p>
      ) : !available.length && !hidden.length ? (
        <p className="text-sm text-muted-foreground">
          No saved logins you can use yet. Sign in to a site in a chat’s browser, then choose Save login.
        </p>
      ) : (
        <ChoiceGroup
          type="checkbox"
          optional
          disabled={disabled}
          legend="Logins to load"
          helper={`The run’s browser starts signed in to these sites. It skips any login the run’s owner can’t use. Choose up to ${loginLimit}.`}
          options={[
            ...available.map(login => ({ value: login.id, label: login.name, description: login.site })),
            ...hidden.map(id => ({
              value: id,
              label: 'A login you can’t use',
              description: 'You don’t have access to this login. If you clear it, you can’t choose it again.',
            })),
          ]}
          value={[...logins]}
          onValueChange={next => onChange({ browserLogins: next.slice(0, loginLimit) })}
        />
      )}
    </FormSection>
  );
}
