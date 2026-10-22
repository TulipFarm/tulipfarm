import { useEffect, useState } from 'react';
import { Button } from '@tulipfarm/sprout/button';
import { WorksheetGrid } from '@/components/worksheet-grid';
import { Skeleton } from '@tulipfarm/sprout/skeleton';
import { StatePanel } from '@tulipfarm/sprout/state-panel';
import { useFeatureRead } from '@/lib/query';
import {
  googleFileKeys,
  outcome,
  sheetColumn,
  type GoogleBinding,
  type GoogleBlock,
  type GoogleFilesApi,
  type SheetTab,
} from './google-api';
import { GoogleBusyPanel, GoogleRecoveryPanel } from './google-recovery';

const pageRows = 100;
const maxColumns = 50;
const count = new Intl.NumberFormat();
const blockedCells: Record<Exclude<GoogleBlock, 'grant' | 'reconnect'>, [string, string]> = {
  'not-found': ['This spreadsheet isn’t available', 'It may have been deleted, moved to trash, or unshared in Google.'],
  denied: [
    'Google denied access to these cells',
    'Ask the spreadsheet’s owner in Google for access. Its cells stay hidden.',
  ],
  'too-large': ['These rows are too large to show here', 'Open the spreadsheet in Google to read them.'],
  'export-rejected': ['Google couldn’t return these cells', 'Open the spreadsheet in Google to read this tab.'],
  unsupported: ['Google couldn’t return these cells', 'Open the spreadsheet in Google to read this tab.'],
};

/** Formatted values for one bounded window of one tab. The limits are stated, never applied silently. */
export function GoogleSheet({
  api,
  binding,
  fileId,
  tabs,
  connect,
  refreshIntegration,
}: {
  api: GoogleFilesApi;
  binding: GoogleBinding;
  fileId: string;
  tabs: SheetTab[];
  connect: (app: 'drive' | 'sheets') => Promise<void>;
  refreshIntegration: () => Promise<unknown>;
}) {
  // A tab is chosen by title, so a refresh that removes or reorders tabs falls back to the first tab at row 1.
  const [position, setPosition] = useState({ title: tabs[0]?.title, start: 1 });
  const chosen = tabs.find(item => item.title === position.title);
  const tab = chosen ?? tabs[0];
  const start = chosen ? position.start : 1;
  const setStart = (next: number) => setPosition({ title: tab?.title, start: next });
  const columns = Math.min(Math.max(tab?.columns ?? 0, 1), maxColumns);
  const rows = tab && tab.rows > 0 ? Math.max(1, Math.min(pageRows, tab.rows - start + 1)) : pageRows;
  const readable = tab !== undefined && tab.title.length <= 100;
  const range = useFeatureRead({
    key: googleFileKeys.range(binding, fileId, tab?.title ?? '', start),
    enabled: readable,
    staleTime: 0,
    load: signal =>
      outcome(() =>
        api.range(
          fileId,
          { sheetName: tab?.title ?? '', startRow: start, rowCount: rows, columnCount: columns },
          signal,
        ),
      ),
  });
  const block = range.state.kind === 'ready' && range.state.data.kind === 'blocked' ? range.state.data.block : null;
  useEffect(() => {
    if (block === 'reconnect' || block === 'grant') void refreshIntegration();
  }, [block]);
  if (!tab)
    return (
      <StatePanel
        kind="empty"
        title="This spreadsheet has no visible tabs"
        description="Hidden tabs and chart sheets open in Google."
      />
    );
  const end = start + rows - 1;
  const values = range.state.kind === 'ready' && range.state.data.kind === 'ok' ? range.state.data.value.values : null;
  const more = tab.rows > 0 ? end < tab.rows : values?.length === rows;
  const letters = Array.from({ length: columns }, (_, index) => sheetColumn(index + 1));
  const body = (() => {
    if (!readable)
      return (
        <StatePanel
          kind="unavailable"
          title="This tab can’t be read here"
          description="Its name is longer than 100 characters. Open the spreadsheet in Google to read it."
        />
      );
    if (range.state.kind === 'loading')
      return (
        <div role="status" aria-label="Loading rows" className="space-y-3 p-4">
          <Skeleton />
          <Skeleton />
          <Skeleton />
          <span className="sr-only">Loading rows…</span>
        </div>
      );
    if (range.state.kind === 'unavailable')
      return (
        <StatePanel
          kind="unavailable"
          title="This sheet is unavailable"
          description="Your workspace access changed. Its cells stay hidden."
        />
      );
    if (range.state.kind === 'error' && range.state.busy)
      return (
        <GoogleBusyPanel heading="h3">
          <Button variant="outline" onClick={() => void range.refresh()}>
            Try again
          </Button>
        </GoogleBusyPanel>
      );
    if (range.state.kind === 'error')
      return (
        <StatePanel
          kind="error"
          title="Couldn’t load these rows"
          description="Google didn’t respond, or the request timed out. The spreadsheet is unchanged."
        >
          <Button variant="outline" onClick={() => void range.refresh()}>
            Retry loading rows
          </Button>
        </StatePanel>
      );
    const data = range.state.data;
    if (data.kind === 'blocked') {
      if (data.block === 'grant')
        return (
          <GoogleRecoveryPanel
            recovery={{ kind: 'grant', app: 'sheets' }}
            connect={connect}
            retry={refreshIntegration}
            heading="h3"
          />
        );
      if (data.block === 'reconnect')
        return (
          <GoogleRecoveryPanel
            recovery={{ kind: 'reconnect' }}
            connect={connect}
            retry={refreshIntegration}
            heading="h3"
          />
        );
      const [title, description] = blockedCells[data.block];
      return <StatePanel kind="unavailable" heading="h3" title={title} description={description} />;
    }
    if (!data.value.values.length)
      return (
        <StatePanel
          kind="empty"
          heading="h3"
          title={start === 1 ? 'This tab is empty' : 'No values in these rows'}
          description="Cells without values are not shown."
        />
      );
    return (
      <WorksheetGrid
        label={`${tab.title}, rows ${start} to ${start + data.value.values.length - 1}`}
        columns={letters}
        firstRow={start}
        rows={data.value.values}
      />
    );
  })();
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {tabs.length > 1 && (
        <div
          className="flex shrink-0 gap-1 overflow-x-auto border-b bg-background p-2"
          role="group"
          aria-label="Sheet tabs"
        >
          {tabs.map(item => (
            <Button
              key={item.title}
              variant={tab === item ? 'secondary' : 'ghost'}
              size="sm"
              aria-pressed={tab === item}
              onClick={() => setPosition({ title: item.title, start: 1 })}
            >
              {item.title}
            </Button>
          ))}
        </div>
      )}
      <div className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-b bg-background px-4 py-2">
        <p className="text-xs text-muted-foreground">
          Rows {count.format(start)}–{count.format(end)}
          {tab.rows > 0 && ` of ${count.format(tab.rows)}`} · Columns A–{sheetColumn(columns)}
          {tab.columns > 0 && ` of ${count.format(tab.columns)}`}.
          {tab.columns > maxColumns && ` Columns after ${sheetColumn(maxColumns)} open in Google.`} Charts, pivot
          tables, and editing stay in Google.
        </p>
        {(start > 1 || more) && (
          <div className="flex gap-2">
            {start > 1 && (
              <Button variant="outline" size="sm" onClick={() => setStart(Math.max(1, start - pageRows))}>
                Previous {pageRows} rows
              </Button>
            )}
            {more && (
              <Button variant="outline" size="sm" onClick={() => setStart(start + pageRows)}>
                Next {pageRows} rows
              </Button>
            )}
          </div>
        )}
      </div>
      {body}
    </div>
  );
}
