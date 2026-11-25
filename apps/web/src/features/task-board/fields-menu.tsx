import { LockIcon, SlidersIcon } from '@tulipfarm/icons';
import { Button } from '@tulipfarm/sprout/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@tulipfarm/sprout/dropdown-menu';
import type { TableDefinition } from '@/features/tables/api';
import { customTaskFields } from './task-composer';

const kindLabels: Record<string, string> = {
  text: 'Text',
  numeric: 'Number',
  boolean: 'Checkbox',
  date: 'Date',
  timestamp: 'Date and time',
  'single-select': 'Choice',
  'multi-select': 'Choices',
  relationship: 'Link',
  file: 'File',
  actor: 'Person or agent',
};

/** Lists the task fields: the built-in ones, which are locked, and the workspace's own. */
export function TaskFieldsMenu({ table }: { table: TableDefinition }) {
  const custom = customTaskFields(table);
  const builtIn = table.definition.fields.filter(field => !custom.includes(field));
  return (
    <DropdownMenu>
      <DropdownMenuTrigger render={<Button variant="outline" />}>
        <SlidersIcon size="md" aria-hidden="true" />
        Fields
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuGroup>
          <DropdownMenuLabel>Built-in</DropdownMenuLabel>
          {builtIn.map(field => (
            <DropdownMenuItem key={field.id} disabled>
              <span className="flex w-full items-center gap-2">
                <span className="min-w-0 flex-1 truncate">{field.label}</span>
                <LockIcon size="xs" aria-label="Locked" />
              </span>
            </DropdownMenuItem>
          ))}
        </DropdownMenuGroup>
        <DropdownMenuSeparator />
        <DropdownMenuGroup>
          <DropdownMenuLabel>Custom</DropdownMenuLabel>
          {custom.length === 0 ? (
            <DropdownMenuItem disabled>No custom fields yet</DropdownMenuItem>
          ) : (
            custom.map(field => (
              <DropdownMenuItem key={field.id} disabled>
                <span className="flex w-full items-center gap-2">
                  <span className="min-w-0 flex-1 truncate">{field.label}</span>
                  <span className="text-xs text-muted-foreground">{kindLabels[field.kind] ?? field.kind}</span>
                </span>
              </DropdownMenuItem>
            ))
          )}
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
