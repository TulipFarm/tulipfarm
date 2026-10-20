import { ChevronLeft, ChevronRight, ChevronsLeft } from 'lucide-react';
import { Button } from '@tulipfarm/sprout/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@tulipfarm/sprout/select';

export function TablePagination({
  page,
  pageSize,
  count,
  total,
  hasNext,
  disabled,
  loading = false,
  groups = false,
  unknownStart = false,
  onFirst,
  onPrevious,
  onNext,
  onPageSize,
}: {
  page: number;
  pageSize: number;
  count: number;
  total?: string | null;
  hasNext: boolean;
  disabled: boolean;
  loading?: boolean;
  groups?: boolean;
  unknownStart?: boolean;
  onFirst: () => void;
  onPrevious: () => void;
  onNext: () => void;
  onPageSize: (size: number) => void;
}) {
  const noun = groups ? 'groups' : 'rows';
  const exactTotal = total && /^\d+$/.test(total) ? Number(total) : null;
  const start = (page - 1) * pageSize;
  const range = count ? `${(start + 1).toLocaleString('en-US')}-${(start + count).toLocaleString('en-US')}` : '0';
  return (
    <nav
      aria-label={groups ? 'Group pages' : 'Row pages'}
      className="flex flex-wrap items-center justify-between gap-x-6 gap-y-3 rounded-lg border border-input bg-card px-3 py-3 text-sm"
    >
      <p role="status" className="tabular-nums text-muted-foreground">
        {loading
          ? `Loading ${noun}…`
          : unknownStart
            ? `${count} ${noun} on this page`
            : `${range}${total != null ? ` of ${exactTotal?.toLocaleString('en-US') ?? total}` : ''} ${noun}`}
      </p>
      <div className="flex flex-wrap items-center gap-x-5 gap-y-3">
        <div className="flex items-center gap-2">
          <span className="text-muted-foreground">{groups ? 'Groups' : 'Rows'} per page</span>
          <Select
            value={pageSize}
            onValueChange={value => {
              if (value !== null) onPageSize(value);
            }}
            disabled={disabled || loading}
          >
            <SelectTrigger size="sm" aria-label={groups ? 'Groups per page' : 'Rows per page'}>
              <SelectValue>{pageSize}</SelectValue>
            </SelectTrigger>
            <SelectContent>
              {[10, 25, 50, 100].map(size => (
                <SelectItem key={size} value={size}>
                  {size}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="flex items-center gap-2">
          {!unknownStart && <span className="whitespace-nowrap tabular-nums">Page {page}</span>}
          <Button
            variant="outline"
            size="icon-sm"
            aria-label={groups ? 'First groups' : 'First rows'}
            disabled={disabled || loading || page === 1}
            onClick={onFirst}
          >
            <ChevronsLeft aria-hidden="true" />
          </Button>
          <Button
            variant="outline"
            size="icon-sm"
            aria-label={groups ? 'Previous groups' : 'Previous rows'}
            disabled={disabled || loading || page === 1}
            onClick={onPrevious}
          >
            <ChevronLeft aria-hidden="true" />
          </Button>
          <Button
            variant="outline"
            size="icon-sm"
            aria-label={groups ? 'Next groups' : 'Next rows'}
            disabled={disabled || loading || !hasNext}
            onClick={onNext}
          >
            <ChevronRight aria-hidden="true" />
          </Button>
        </div>
      </div>
    </nav>
  );
}
