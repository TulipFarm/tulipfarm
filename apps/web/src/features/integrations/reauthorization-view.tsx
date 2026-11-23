import { useSyncExternalStore } from 'react';
import { Button } from '@tulipfarm/sprout/button';
import { NoticeBanner } from '@tulipfarm/sprout/notice-banner';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@tulipfarm/sprout/select';
import { Sheet, SheetBody, SheetContent, SheetFooter, SheetHeader, SheetTitle } from '@tulipfarm/sprout/sheet';
import type { AuthorizationAttention } from './authorization-attention';

const wideQuery = '(min-width: 1024px)';
const subscribeWide = (changed: () => void) => {
  const media = window.matchMedia(wideQuery);
  media.addEventListener('change', changed);
  return () => media.removeEventListener('change', changed);
};
/** From 1024px the banner has room for its message and controls on one line. */
function useWide() {
  return useSyncExternalStore(
    subscribeWide,
    () => window.matchMedia(wideQuery).matches,
    () => true,
  );
}

export interface ReauthorizationViewProps {
  items: AuthorizationAttention[];
  selected: AuthorizationAttention;
  busy: boolean;
  checking: boolean;
  failed: boolean;
  stale: boolean;
  sheet: boolean;
  setSheet: (open: boolean) => void;
  onChoose: (id: string) => void;
  onAuthorize: () => void;
  onCheck: () => void;
}

export default function ReauthorizationView({
  items,
  selected,
  busy,
  checking,
  failed,
  stale,
  sheet,
  setSheet,
  onChoose,
  onAuthorize,
  onCheck,
}: ReauthorizationViewProps) {
  const wide = useWide();
  const summary =
    failed || stale
      ? 'Authorization needs a check'
      : items.length > 1
        ? `${items.length} apps need reauthorization`
        : `${selected.name} needs reauthorization`;
  const controls = (
    <>
      {items.length > 1 && (
        <div className="w-full min-w-0 sm:w-auto">
          <Select value={selected.id} onValueChange={value => onChoose(value as string)} disabled={busy}>
            <SelectTrigger aria-label="Integration to reauthorize">
              <SelectValue>{selected.name}</SelectValue>
            </SelectTrigger>
            <SelectContent>
              {items.map(item => (
                <SelectItem key={item.id} value={item.id}>
                  {item.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      )}
      <Button
        variant="outline"
        disabled={busy || checking}
        aria-busy={busy || checking}
        onClick={() => (failed || stale ? onCheck() : onAuthorize())}
      >
        {busy || checking ? 'Please wait...' : failed || stale ? 'Check integration status' : 'Update permissions'}
      </Button>
    </>
  );
  const reason =
    selected.reason === 'permissions'
      ? 'Approve the updated permissions to continue.'
      : selected.target.kind === 'github'
        ? 'GitHub reads and actions with this account need renewed access.'
        : `Tasks using ${selected.name} need renewed access.`;
  const problem =
    (failed ? 'Authorization could not be opened.' : 'Integration status could not refresh.') +
    ' Check integration status before trying again.';
  const message =
    failed || stale ? (
      <p role="alert">{problem}</p>
    ) : (
      <p role="status">
        <span className="font-medium text-warning">
          {items.length > 1
            ? `${items.length} integrations need authorization.`
            : `${selected.name} needs authorization.`}
        </span>{' '}
        {reason}
      </p>
    );
  if (wide)
    return (
      <NoticeBanner aria-label="Integration authorization" actions={controls}>
        {message}
      </NoticeBanner>
    );
  // Narrow screens get one line, so the page keeps its height; the details and controls open in a sheet.
  return (
    <>
      <NoticeBanner aria-label="Integration authorization">
        <div className="flex items-center justify-between gap-3">
          <p role={failed || stale ? 'alert' : 'status'} className="min-w-0 truncate font-medium text-warning">
            {summary}
          </p>
          <Button variant="link" size="sm" aria-haspopup="dialog" onClick={() => setSheet(true)}>
            Fix
          </Button>
        </div>
      </NoticeBanner>
      <Sheet open={sheet} onOpenChange={setSheet}>
        <SheetContent side="bottom">
          <SheetHeader>
            <SheetTitle>{summary}</SheetTitle>
          </SheetHeader>
          <SheetBody>
            <p className="text-sm text-muted-foreground">{failed || stale ? problem : reason}</p>
          </SheetBody>
          <SheetFooter>{controls}</SheetFooter>
        </SheetContent>
      </Sheet>
    </>
  );
}
