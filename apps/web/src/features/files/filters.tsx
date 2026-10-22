import { useState } from 'react';
import { Filter } from 'reicon-react/icons/Filter';
import type { FilePerson, FileType } from '@tulipfarm/files/contracts';
import { Button } from '@tulipfarm/sprout/button';
import { Input } from '@tulipfarm/sprout/input';
import { Label } from '@tulipfarm/sprout/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@tulipfarm/sprout/select';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from '@tulipfarm/sprout/sheet';
import { filterKeys, librarySort, modifiedPresets, type FilesSearch } from './api';

export const typeLabels: Record<FileType, string> = {
  folder: 'Folders',
  document: 'Documents',
  spreadsheet: 'Spreadsheets',
  presentation: 'Presentations',
  pdf: 'PDFs',
  image: 'Images',
  other: 'Other files',
};
const any = 'any';
const sorts = {
  'name:asc': 'Name, A to Z',
  'name:desc': 'Name, Z to A',
  'modified:desc': 'Modified, newest first',
  'modified:asc': 'Modified, oldest first',
} as const;
type SortValue = keyof typeof sorts;
export const clearedFilters = Object.fromEntries(filterKeys.map(key => [key, undefined])) as Partial<FilesSearch>;

/** Changes to search state. The page drops the page cursor with every change, because a cursor belongs to one order and filter set. */
export type FilterChange = (next: Partial<FilesSearch>) => void;

export function activeFilterCount(search: FilesSearch) {
  return [search.type, search.owner, search.modified].filter(value => value !== undefined).length;
}

function Fields({
  id,
  search,
  owners,
  membershipId,
  change,
  sort,
}: {
  id: string;
  search: FilesSearch;
  owners: FilePerson[];
  membershipId: string;
  change: FilterChange;
  sort: boolean;
}) {
  const others = owners.filter(person => person.membershipId !== membershipId);
  const named =
    search.owner &&
    search.owner !== 'me' &&
    search.owner !== 'others' &&
    !others.some(person => person.membershipId === search.owner);
  const ownerLabel = !search.owner
    ? 'Anyone'
    : search.owner === 'me'
      ? 'Owned by me'
      : search.owner === 'others'
        ? 'Owned by others'
        : (others.find(person => person.membershipId === search.owner)?.name ?? 'Selected person');
  const sortValue = `${librarySort(search).key}:${librarySort(search).direction}` as SortValue;
  return (
    <>
      <div className="grid gap-1.5">
        <Label htmlFor={`${id}-type`}>Type</Label>
        <Select
          value={search.type ?? any}
          onValueChange={value => change({ type: value && value !== any ? (value as FileType) : undefined })}
        >
          <SelectTrigger id={`${id}-type`} size="sm">
            <SelectValue>{search.type ? typeLabels[search.type] : 'Any type'}</SelectValue>
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={any}>Any type</SelectItem>
            {Object.entries(typeLabels).map(([value, label]) => (
              <SelectItem key={value} value={value}>
                {label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <div className="grid gap-1.5">
        <Label htmlFor={`${id}-owner`}>Owner</Label>
        <Select
          value={search.owner ?? any}
          onValueChange={value => change({ owner: value && value !== any ? value : undefined })}
        >
          <SelectTrigger id={`${id}-owner`} size="sm">
            <SelectValue>{ownerLabel}</SelectValue>
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={any}>Anyone</SelectItem>
            <SelectItem value="me">Owned by me</SelectItem>
            <SelectItem value="others">Owned by others</SelectItem>
            {named && <SelectItem value={search.owner}>Selected person</SelectItem>}
            {others.map(person => (
              <SelectItem key={person.membershipId} value={person.membershipId}>
                {person.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <div className="grid gap-1.5">
        <Label htmlFor={`${id}-modified`}>Modified</Label>
        <Select
          value={search.modified ?? any}
          onValueChange={next => {
            const value = next && next !== any ? (next as keyof typeof modifiedPresets) : undefined;
            change({ modified: value, ...(value === 'custom' ? {} : { from: undefined, to: undefined }) });
          }}
        >
          <SelectTrigger id={`${id}-modified`} size="sm">
            <SelectValue>{search.modified ? modifiedPresets[search.modified] : 'Any time'}</SelectValue>
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={any}>Any time</SelectItem>
            {Object.entries(modifiedPresets).map(([value, label]) => (
              <SelectItem key={value} value={value}>
                {label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      {search.modified === 'custom' && (
        <>
          <div className="grid gap-1.5">
            <Label htmlFor={`${id}-from`}>From</Label>
            <Input
              id={`${id}-from`}
              type="date"
              value={search.from ?? ''}
              max={search.to}
              onChange={event => change({ from: event.target.value || undefined })}
            />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor={`${id}-to`}>Through</Label>
            <Input
              id={`${id}-to`}
              type="date"
              value={search.to ?? ''}
              min={search.from}
              onChange={event => change({ to: event.target.value || undefined })}
            />
          </div>
        </>
      )}
      {sort && (
        <div className="grid gap-1.5">
          <Label htmlFor={`${id}-sort`}>Sort</Label>
          <Select
            value={sortValue}
            onValueChange={next => {
              if (!next) return;
              const [key, direction] = (next as SortValue).split(':') as ['name' | 'modified', 'asc' | 'desc'];
              change({
                sort: key === 'name' ? undefined : key,
                order: direction === (key === 'modified' ? 'desc' : 'asc') ? undefined : direction,
              });
            }}
          >
            <SelectTrigger id={`${id}-sort`} size="sm">
              <SelectValue>{sorts[sortValue]}</SelectValue>
            </SelectTrigger>
            <SelectContent>
              {Object.entries(sorts).map(([value, label]) => (
                <SelectItem key={value} value={value}>
                  {label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      )}
    </>
  );
}

/**
 * Type, owner, and modified filters with sort. Wide layouts show them inline; narrow layouts open them in a bottom sheet.
 * `sort` is false where results come from several sources that each keep their own order.
 */
export function FilterBar({
  search,
  owners,
  membershipId,
  change,
  sort = true,
  compact = false,
}: {
  search: FilesSearch;
  owners: FilePerson[];
  membershipId: string;
  change: FilterChange;
  sort?: boolean;
  compact?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const count = activeFilterCount(search);
  const reset = count > 0 && (
    <Button variant="ghost" size="sm" onClick={() => change(clearedFilters)}>
      Clear filters
    </Button>
  );
  return (
    <div role="group" aria-label="Filter and sort">
      {!compact && (
        <div className="hidden flex-wrap items-end gap-3 sm:flex">
          <Fields
            id="files-filter"
            search={search}
            owners={owners}
            membershipId={membershipId}
            change={change}
            sort={sort}
          />
          {reset}
        </div>
      )}
      <div className={compact ? 'flex items-center gap-2' : 'flex items-center gap-2 sm:hidden'}>
        <Sheet open={open} onOpenChange={setOpen}>
          <SheetTrigger
            render={
              <Button
                variant="outline"
                size={compact ? 'icon-sm' : 'sm'}
                aria-label={compact ? 'Filter and sort' : undefined}
              />
            }
          >
            <Filter size={14} aria-hidden="true" />
            {!compact && (count ? `Filters (${count})` : sort ? 'Filter and sort' : 'Filters')}
          </SheetTrigger>
          <SheetContent side="bottom">
            <SheetHeader>
              <SheetTitle>{sort ? 'Filter and sort' : 'Filters'}</SheetTitle>
              <SheetDescription>Results update as you choose.</SheetDescription>
            </SheetHeader>
            <div className="grid gap-4 px-4">
              <Fields
                id={compact ? 'files-selection-filter-sheet' : 'files-filter-sheet'}
                search={search}
                owners={owners}
                membershipId={membershipId}
                change={change}
                sort={sort}
              />
            </div>
            <SheetFooter>
              <Button onClick={() => setOpen(false)}>Show results</Button>
              {reset}
            </SheetFooter>
          </SheetContent>
        </Sheet>
        {!open && !compact && reset}
      </div>
    </div>
  );
}
