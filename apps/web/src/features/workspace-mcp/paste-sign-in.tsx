import { useState } from 'react';
import { Button } from '@tulipfarm/sprout/button';
import { Field } from '@tulipfarm/sprout/field';
import { Input } from '@tulipfarm/sprout/input';
import { ArrowUpRight } from 'reicon-react/icons/ArrowUpRight';
import { McpRequestError, type McpApi } from './api';
import { endMcpPasteSignIn, markMcpConnected } from './sign-in';

/** A loopback address carrying the provider's answer, so a paste can finish without another click. */
function signInAddress(text: string) {
  const value = text.trim();
  if (!URL.canParse(value)) return false;
  const url = new URL(value);
  return (
    url.protocol === 'http:' &&
    ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) &&
    url.searchParams.has('state') &&
    (url.searchParams.has('code') || url.searchParams.has('error'))
  );
}

/**
 * Sign-in for servers that only send people back to a local address. The steps show before the member opens the
 * provider in a new tab, so this page stays open for the address they paste back.
 */
export function McpPasteSignIn({
  api,
  name,
  signIn: { integrationId, authorizationUrl },
  finished,
  restart,
}: {
  api: McpApi;
  name: string;
  signIn: { integrationId: string; authorizationUrl: string };
  /** Called once the server confirms the connection. */
  finished: (integrationId: string) => void | Promise<void>;
  /** Starts sign-in again with a fresh link. */
  restart: () => void;
}) {
  const [address, setAddress] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const prefix = `mcp-paste-${integrationId}`;
  const finish = async (value: string) => {
    if (busy || !value.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const result = await api.completeSignIn(value.trim());
      markMcpConnected(result.integrationId);
      endMcpPasteSignIn(integrationId);
      await finished(result.integrationId);
    } catch (failure) {
      setError(
        failure instanceof McpRequestError
          ? failure.message
          : 'Couldn’t finish connecting. Check your connection and try again.',
      );
    } finally {
      setBusy(false);
    }
  };
  return (
    <section aria-labelledby={`${prefix}-title`} className="max-w-2xl space-y-3 rounded-xl border border-border p-4">
      <h2 id={`${prefix}-title`} className="font-medium">
        Sign in to {name}
      </h2>
      <ol className="list-decimal space-y-1 ps-5 text-sm">
        <li>
          Select <strong>Sign in to {name}</strong>. It opens in a new tab.
        </li>
        <li>After you sign in, the new tab shows “This site can’t be reached”. That’s expected.</li>
        <li>Copy the full address from that tab’s address bar and paste it below.</li>
      </ol>
      {new URL(authorizationUrl).protocol === 'https:' && (
        <Button
          variant="outline"
          nativeButton={false}
          render={<a href={authorizationUrl} target="_blank" rel="noopener noreferrer" />}
        >
          Sign in to {name}
          <ArrowUpRight aria-hidden="true" />
        </Button>
      )}
      <form
        className="grid gap-2"
        onSubmit={event => {
          event.preventDefault();
          void finish(address);
        }}
      >
        <Field id={`${prefix}-address`} required label={`Address from the ${name} tab`} error={error ?? undefined}>
          <Input
            value={address}
            onChange={event => setAddress(event.target.value)}
            onPaste={event => {
              const text = event.clipboardData.getData('text');
              if (!signInAddress(text)) return;
              event.preventDefault();
              setAddress(text.trim());
              void finish(text);
            }}
            placeholder="http://127.0.0.1/…?code=…"
            autoComplete="off"
            spellCheck={false}
            readOnly={busy}
          />
        </Field>
        <div className="flex flex-wrap items-center gap-2">
          <Button type="submit" disabled={busy || !address.trim()} aria-busy={busy}>
            {busy ? 'Finishing…' : 'Finish connecting'}
          </Button>
          <Button type="button" variant="link" size="sm" disabled={busy} onClick={restart}>
            Get a new sign-in link
          </Button>
        </div>
      </form>
      {busy && (
        <p role="status" className="sr-only">
          Finishing connecting {name}…
        </p>
      )}
    </section>
  );
}
