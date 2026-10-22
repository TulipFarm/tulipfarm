import { useState } from 'react';
import { MoreH } from 'reicon-react/icons/MoreH';
import { Button } from '@tulipfarm/sprout/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@tulipfarm/sprout/dropdown-menu';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@tulipfarm/sprout/sheet';
import { DeletedRecords } from './deleted-records';
import { DefinitionStatus, SchemaHistory } from './schema-history';
import type { DefinitionState, TableApi } from './api';
import type { TableWorkspace } from './references';

type Panel = 'deleted' | 'schema';

/** Table maintenance lives behind one menu so the page stays about rows. */
export function TableMore({
  state,
  api,
  workspace,
  disabled,
}: {
  state: DefinitionState;
  api: TableApi;
  workspace: TableWorkspace;
  disabled: boolean;
}) {
  const [panel, setPanel] = useState<Panel | null>(null);
  const applied = state.applied;
  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger render={<Button variant="outline" size="icon-sm" aria-label="More table options" />}>
          <MoreH size={16} aria-hidden="true" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuGroup>
            {applied && <DropdownMenuItem onClick={() => setPanel('deleted')}>Deleted rows</DropdownMenuItem>}
            <DropdownMenuItem onClick={() => setPanel('schema')}>Schema history</DropdownMenuItem>
          </DropdownMenuGroup>
        </DropdownMenuContent>
      </DropdownMenu>
      <Sheet
        open={panel !== null}
        onOpenChange={open => {
          if (!open) setPanel(null);
        }}
      >
        <SheetContent size="xl">
          <SheetHeader>
            <SheetTitle>{panel === 'deleted' ? 'Deleted rows' : 'Schema history'}</SheetTitle>
            <SheetDescription>
              {panel === 'deleted'
                ? 'Deleted rows stay recoverable for 30 days.'
                : 'Field definitions and the changes that produced them.'}
            </SheetDescription>
          </SheetHeader>
          <div className="min-h-0 flex-1 space-y-8 overflow-y-auto px-4 pb-6">
            {panel === 'deleted' && applied && (
              <DeletedRecords
                table={{
                  id: state.id,
                  revision: applied.revision,
                  definition: applied.definition,
                  systemKind: state.systemKind,
                }}
                permissions={state.rowPermissions}
                api={api}
                workspace={workspace}
                disabled={disabled}
              />
            )}
            {panel === 'schema' && (
              <>
                <DefinitionStatus state={state} />
                <SchemaHistory tableId={state.id} api={api} />
              </>
            )}
          </div>
        </SheetContent>
      </Sheet>
    </>
  );
}
