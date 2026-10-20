import { useEffect, useRef, useState, type ReactElement } from 'react';
import { providerResourceResultSchema, type ProviderResourceInput } from '@tulipfarm/workflows/contracts';
import { workflowRequest, WorkflowRequestError } from './api';
import { Button } from '@tulipfarm/sprout/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@tulipfarm/sprout/select';

export function providerFailureMessage(failure: unknown) {
  const code = failure instanceof WorkflowRequestError ? failure.code : '';
  const messages: Record<string, string> = {
    credentials: 'The token is invalid or expired. Replace it and retry.',
    permission: 'The token cannot read this source. Check its scopes and source access, then retry.',
    'rate-limited': 'The provider is limiting requests. Wait a minute and retry.',
    unavailable: 'The provider did not respond. Your inputs are kept. Retry.',
    'invalid-response': 'The provider returned an invalid response. Your inputs are kept. Retry.',
    'source-invalid':
      'The source does not match this token, or the range or key column is invalid. Check your choices and retry.',
  };
  return messages[code] ?? 'The check failed. Your inputs are kept. Retry when access or connectivity is restored.';
}

export function ProviderResourcePicker({
  base,
  provider,
  resource,
  token,
  parentId,
  conversation,
  value,
  label,
  manualInput,
  onSelect,
  onDenied,
}: {
  base: string;
  provider: ProviderResourceInput['provider'];
  resource: ProviderResourceInput['resource'];
  token: string;
  parentId?: string | undefined;
  conversation?: 'public' | 'direct' | undefined;
  value: string;
  label: string;
  manualInput: ReactElement;
  onSelect: (value: string) => void;
  onDenied: () => void;
}) {
  const [manual, setManual] = useState(false);
  const [items, setItems] = useState<{ value: string; label: string }[]>([]);
  const [next, setNext] = useState<string | null>(null);
  const [state, setState] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle');
  const [error, setError] = useState('');
  const sequence = useRef(0);
  useEffect(() => {
    sequence.current++;
    setItems([]);
    setNext(null);
    setState('idle');
    setError('');
    return () => {
      sequence.current++;
    };
  }, [base, provider, resource, token, parentId, conversation]);
  async function load(more = false) {
    const current = ++sequence.current;
    setState('loading');
    setError('');
    try {
      const result = providerResourceResultSchema.parse(
        await workflowRequest(`${base}/provider-integrations/resources`, 'POST', {
          provider,
          resource,
          token,
          ...(parentId ? { parentId } : {}),
          ...(conversation ? { conversation } : {}),
          ...(more && next ? { cursor: next } : {}),
        }),
      );
      if (current !== sequence.current) return;
      setItems(previous => [
        ...new Map([...(more ? previous : []), ...result.items].map(item => [item.value, item])).values(),
      ]);
      setNext(result.nextCursor);
      setState('ready');
    } catch (failure) {
      if (current !== sequence.current) return;
      if (failure instanceof WorkflowRequestError && [401, 403, 404].includes(failure.status)) onDenied();
      setError(providerFailureMessage(failure));
      setState('error');
    }
  }
  return (
    <div className="space-y-2">
      {manual ? (
        manualInput
      ) : (
        <Select
          disabled={items.length === 0}
          value={value || null}
          onValueChange={selected => {
            if (selected) onSelect(selected);
          }}
          items={items}
        >
          <SelectTrigger width="full" aria-label={label}>
            <SelectValue placeholder={`Choose ${label.toLowerCase()}`} />
          </SelectTrigger>
          <SelectContent>
            {items.map(item => (
              <SelectItem key={item.value} value={item.value}>
                {item.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      )}
      <div className="flex flex-wrap gap-2">
        <Button
          variant="outline"
          disabled={!token || state === 'loading' || parentId === ''}
          onClick={() => void load()}
        >
          {state === 'loading' ? 'Loading choices…' : `Load ${label.toLowerCase()}`}
        </Button>
        {next && (
          <Button variant="outline" disabled={state === 'loading'} onClick={() => void load(true)}>
            Load more {label.toLowerCase()}
          </Button>
        )}
        <Button variant="ghost" onClick={() => setManual(current => !current)}>
          {manual ? `Choose ${label.toLowerCase()} from list` : `Enter ${label.toLowerCase()} manually`}
        </Button>
      </div>
      {!token && <p className="text-sm text-muted-foreground">Enter a token to load choices.</p>}
      {parentId === '' && <p className="text-sm text-muted-foreground">Choose the account or site first.</p>}
      {state === 'loading' && <p role="status">Loading {label.toLowerCase()} choices.</p>}
      {state === 'ready' && !items.length && (
        <p role="status">
          No choices on this page.{' '}
          {next ? 'Load more to continue.' : 'Check source access or enter a known ID, then test it.'}
        </p>
      )}
      {error && (
        <p role="alert">{error} Retry loading choices. A manually entered source must still pass Test integration.</p>
      )}
    </div>
  );
}
