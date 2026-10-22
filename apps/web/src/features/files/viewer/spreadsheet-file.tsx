import { useEffect, useState } from 'react';
import { read, utils } from 'xlsx';
import { FileError, LoadingFile } from '@tulipfarm/sprout/file-viewer';
import { Button } from '@tulipfarm/sprout/button';
import { WorksheetGrid } from '@/components/worksheet-grid';

type Sheet = { name: string; rows: string[][]; columns: string[]; truncated: boolean };
type State = { kind: 'loading' } | { kind: 'error' } | { kind: 'ready'; sheets: Sheet[] };

export default function SpreadsheetFile({ bytes, onRetry }: { bytes: ArrayBuffer; onRetry: () => void }) {
  const [state, setState] = useState<State>({ kind: 'loading' });
  const [selected, setSelected] = useState(0);
  useEffect(() => {
    try {
      const workbook = read(bytes, { type: 'array', sheetRows: 1001, cellHTML: false, cellFormula: false });
      const sheets = workbook.SheetNames.map(name => {
        const sheet = workbook.Sheets[name];
        if (!sheet?.['!ref']) return { name, rows: [], columns: [], truncated: false };
        const range = utils.decode_range(sheet['!ref']);
        const original = utils.decode_range(sheet['!fullref'] ?? sheet['!ref']);
        range.e.r = Math.min(range.e.r, range.s.r + 999);
        range.e.c = Math.min(range.e.c, range.s.c + 99);
        return {
          name,
          rows: utils.sheet_to_json<string[]>(sheet, { header: 1, raw: false, defval: '', range }),
          columns: Array.from({ length: range.e.c - range.s.c + 1 }, (_, index) => utils.encode_col(range.s.c + index)),
          truncated: original.e.r > range.e.r || original.e.c > range.e.c,
        };
      });
      setState({ kind: 'ready', sheets });
    } catch {
      setState({ kind: 'error' });
    }
  }, [bytes]);
  if (state.kind === 'loading') return <LoadingFile />;
  if (state.kind === 'error')
    return (
      <FileError
        message="The spreadsheet could not be read. It may be damaged or password-protected."
        onRetry={onRetry}
      />
    );
  const sheet = state.sheets[selected];
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div
        className="flex shrink-0 gap-1 overflow-x-auto border-b bg-background p-2"
        role="group"
        aria-label="Worksheets"
      >
        {state.sheets.map((item, index) => (
          <Button
            key={item.name}
            variant={selected === index ? 'secondary' : 'ghost'}
            size="sm"
            aria-pressed={selected === index}
            onClick={() => setSelected(index)}
          >
            {item.name}
          </Button>
        ))}
      </div>
      {sheet?.truncated && (
        <p className="px-4 py-2 text-sm text-muted-foreground">
          Showing up to 1,000 rows and 100 columns. Download the original for the complete worksheet.
        </p>
      )}
      {!sheet?.rows.length ? (
        <p className="p-8 text-center text-muted-foreground">This worksheet is empty.</p>
      ) : (
        <WorksheetGrid label={`${sheet.name} worksheet`} columns={sheet.columns} firstRow={1} rows={sheet.rows} />
      )}
    </div>
  );
}
