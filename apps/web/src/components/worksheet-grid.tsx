/** A read-only window of worksheet cells. The region scrolls on its own so wide sheets never scroll the page. */
export function WorksheetGrid({
  label,
  columns,
  firstRow,
  rows,
}: {
  label: string;
  columns: readonly string[];
  firstRow: number;
  rows: readonly (readonly (string | number | boolean)[])[];
}) {
  return (
    <div className="min-h-0 flex-1 overflow-auto" tabIndex={0} role="region" aria-label={label}>
      <table className="w-full border-collapse bg-background text-sm">
        <thead className="sticky top-0 bg-background bg-[linear-gradient(var(--muted)_0_0)]">
          <tr>
            <th className="border px-3 py-2">
              <span className="sr-only">Row</span>
            </th>
            {columns.map(column => (
              <th key={column} scope="col" className="min-w-28 border px-3 py-2 text-left font-medium">
                {column}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, index) => (
            <tr key={firstRow + index}>
              <th
                scope="row"
                className="border bg-muted px-3 py-2 text-right font-normal text-muted-foreground tabular-nums"
              >
                {firstRow + index}
              </th>
              {columns.map((column, cell) => (
                <td key={column} className="max-w-96 border px-3 py-2 whitespace-pre-wrap wrap-anywhere">
                  {String(row[cell] ?? '')}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Sheet values have no column headings, so they render as bare rows rather than in sprout's Table, which always draws a header row. */
export function SheetValues({ values }: { values: readonly (readonly unknown[])[] }) {
  return (
    <div className="max-h-80 overflow-auto">
      <table className="w-full text-sm">
        <tbody>
          {values.map((row, index) => (
            <tr key={index} className="border-b border-border transition-colors last:border-0 hover:bg-muted/50">
              {row.map((cell, column) => (
                <td key={column} className="p-2 align-middle whitespace-nowrap">
                  <span className="whitespace-pre-wrap">{String(cell ?? '')}</span>
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
