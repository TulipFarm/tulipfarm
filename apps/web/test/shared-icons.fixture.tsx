import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { AddIcon } from '@tulipfarm/sprout/icons';
import { Button } from '@tulipfarm/sprout/button';
import { Sidebar, SidebarContent, SidebarMenu, SidebarProvider } from '@tulipfarm/sprout/sidebar';
import { ActionNudge, useNudge } from '../src/components/action-nudge';
import { SuggestionCard, SuggestionGrid } from '../src/components/chat-suggestions';
import { Table, TableBody, TableCell, TableHeader, TableRow, TableSortHead } from '../src/components/data-grid';
import { DataList } from '../src/components/data-list';
import { PrivateMark } from '../src/components/private-mark';
import { SlackChannelName } from '../src/components/slack-channel-name';
import { SidebarRecentItem } from '../src/features/navigation/sidebar-recent-item';
import '../src/index.css';

function SharedIconsFixture() {
  const [sorted, setSorted] = useState<'asc' | 'desc' | false>(false);
  const [disabled, setDisabled] = useState(false);
  const [action, setAction] = useState('');
  const nudge = useNudge('shared-icons-fixture');
  return (
    <SidebarProvider>
      <Sidebar>
        <SidebarContent>
          <SidebarMenu>
            <SidebarRecentItem
              label="Tables"
              icon={<AddIcon size="md" aria-hidden="true" />}
              link={<a href="#tables" />}
              active={false}
              defaultOpen
              entries={[
                { id: 'customers', name: 'Customers', link: <a href="#customers" />, active: true, pinned: true },
              ]}
              state="ready"
              retry={() => {}}
            />
          </SidebarMenu>
        </SidebarContent>
      </Sidebar>
      <main className="min-w-0 flex-1 space-y-4 p-4">
        <p>
          Restricted repository <PrivateMark label="Restricted" />
        </p>
        <SlackChannelName title="#general" private={false} />
        <SlackChannelName title="#finance" private />
        <Table aria-label="Customers">
          <TableHeader>
            <TableRow>
              <TableSortHead
                sorted={sorted}
                disabled={disabled}
                clearsOnDescending
                onSort={() => setSorted(value => (value === false ? 'asc' : value === 'asc' ? 'desc' : false))}
              >
                Name
              </TableSortHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            <TableRow>
              <TableCell>Cedar</TableCell>
            </TableRow>
          </TableBody>
        </Table>
        <Button onClick={() => setDisabled(value => !value)}>Toggle sorting availability</Button>
        <DataList headings={[{ label: 'Access', hint: 'Only permitted members can read this item.' }]} />
        {!nudge.dismissed && (
          <ActionNudge
            icon={AddIcon}
            label="Create table"
            onAction={() => setAction('Create table')}
            onDismiss={nudge.dismiss}
          />
        )}
        <SuggestionGrid>
          {[true, false].map((featured, index) => (
            <SuggestionCard
              key={index}
              icon={<AddIcon size="md" aria-hidden="true" />}
              kind="Table"
              label={featured ? 'Plan work' : 'Track work'}
              tone="primary"
              featured={featured}
              index={index}
              disabled={disabled}
              onClick={() => setAction(featured ? 'Plan work' : 'Track work')}
            />
          ))}
        </SuggestionGrid>
        <output aria-label="Selected action">{action}</output>
      </main>
    </SidebarProvider>
  );
}

const root = document.getElementById('root');
if (!root) throw new Error('Missing shared icons fixture root');
createRoot(root).render(<SharedIconsFixture />);
