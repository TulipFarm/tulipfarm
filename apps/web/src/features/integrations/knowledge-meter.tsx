import type { DefaultKnowledgeIntent } from './default-knowledge-api';

type Counts = DefaultKnowledgeIntent['counts'];
const segments = [
  {
    key: 'ready',
    label: 'Searchable',
    bar: 'fill-success',
    swatch: 'size-2 shrink-0 rounded-full bg-success',
  },
  {
    key: 'queued',
    label: 'Queued',
    bar: 'fill-info',
    swatch: 'size-2 shrink-0 rounded-full bg-info',
  },
  {
    key: 'failed',
    label: 'Failed',
    bar: 'fill-destructive',
    swatch: 'size-2 shrink-0 rounded-full bg-destructive',
  },
  {
    key: 'skipped',
    label: 'Skipped',
    bar: 'fill-muted-foreground',
    swatch: 'size-2 shrink-0 rounded-full bg-muted-foreground',
  },
  {
    key: 'quotaLimited',
    label: 'Over limit',
    bar: 'fill-warning',
    swatch: 'size-2 shrink-0 rounded-full bg-warning',
  },
] as const;

const number = new Intl.NumberFormat();
const total = (counts: Counts) =>
  Math.max(counts.total, counts.ready + counts.queued + counts.failed + counts.skipped + counts.quotaLimited);

/** Share of indexed items that can be searched, rounded down so 99.6% never reads as done. */
export function searchablePercent(counts: Counts) {
  const all = total(counts);
  return all ? Math.floor((counts.ready / all) * 100) : 0;
}

/**
 * A stacked bar of every indexed item by state, with a legend that always lists
 * all five states so the layout holds still while counts change.
 */
export function KnowledgeMeter({ counts, compact = false }: { counts: Counts; compact?: boolean }) {
  const all = total(counts);
  const percent = searchablePercent(counts);
  let offset = 0;
  const bars = segments.map(segment => {
    const width = all ? (counts[segment.key] / all) * 100 : 0;
    const bar = { ...segment, x: offset, width };
    offset += width;
    return bar;
  });
  const summary = `${number.format(counts.ready)} of ${number.format(all)} items searchable`;
  return (
    <div className="space-y-2.5">
      <div className="flex items-baseline justify-between gap-3">
        <p className="text-sm">
          <span className="font-semibold tabular-nums">{percent}%</span>{' '}
          <span className="text-muted-foreground">searchable</span>
        </p>
        {!compact && <p className="text-xs text-muted-foreground tabular-nums">{summary}</p>}
      </div>
      <svg
        role="img"
        aria-label={`${summary}. ${segments.map(segment => `${number.format(counts[segment.key])} ${segment.label.toLowerCase()}`).join(', ')}.`}
        className="block h-2 w-full overflow-hidden rounded-full bg-muted"
        preserveAspectRatio="none"
        viewBox="0 0 100 2"
      >
        {bars.map(
          bar =>
            bar.width > 0 && <rect key={bar.key} x={bar.x} y={0} width={bar.width} height={2} className={bar.bar} />,
        )}
      </svg>
      {compact && <p className="text-xs text-muted-foreground tabular-nums">{summary}</p>}
      {!compact && (
        <dl className="grid grid-cols-2 gap-x-4 gap-y-1.5 text-xs sm:grid-cols-5" aria-hidden="true">
          {segments.map(segment => (
            <div key={segment.key} className="flex items-center gap-1.5">
              <span className={segment.swatch} />
              <dt className="text-muted-foreground">{segment.label}</dt>
              <dd
                className={
                  counts[segment.key]
                    ? 'ml-auto font-medium tabular-nums sm:ml-1'
                    : 'ml-auto text-muted-foreground tabular-nums sm:ml-1'
                }
              >
                {number.format(counts[segment.key])}
              </dd>
            </div>
          ))}
        </dl>
      )}
    </div>
  );
}
