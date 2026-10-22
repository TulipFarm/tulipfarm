import { BookOpen } from 'reicon-react/icons/BookOpen';
import { BranchDown } from 'reicon-react/icons/BranchDown';
import { ChatRound } from 'reicon-react/icons/ChatRound';
import { Checklist } from 'reicon-react/icons/Checklist';
import { Cpu } from 'reicon-react/icons/Cpu';
import { Database } from 'reicon-react/icons/Database';
import { Envelope } from 'reicon-react/icons/Envelope';
import { Files } from 'reicon-react/icons/Files';
import { Folder } from 'reicon-react/icons/Folder';
import { People } from 'reicon-react/icons/People';
import { Plug } from 'reicon-react/icons/Plug';
import { ShieldUser } from 'reicon-react/icons/ShieldUser';
import { User } from 'reicon-react/icons/User';
import { Users } from 'reicon-react/icons/Users';
import { AgentAvatar } from '@tulipfarm/sprout/agent-avatar';
import { Badge } from '@tulipfarm/sprout/badge';
import { FileTypeIcon } from '@tulipfarm/sprout/attachment';
import { BrandIcon } from '@tulipfarm/sprout/brand-icon';
import {
  SampleBar,
  SampleIconTile,
  SampleList,
  SampleMark,
  SampleTable,
  SampleText,
  SampleWindow,
  type SampleColumn,
} from '@tulipfarm/sprout/state-sample';

export function ChatsSample() {
  return (
    <SampleWindow icon={ChatRound} trail={['Chats']} tabs={['Active', 'Archived']}>
      <SampleList
        items={[
          {
            leading: <SampleIconTile icon={ChatRound} />,
            title: 'Which invoices are overdue this week?',
            detail: 'Found 7 invoices across 4 customers',
            trailing: <SampleText tone="muted">2m ago</SampleText>,
          },
          {
            leading: <SampleIconTile icon={ChatRound} />,
            title: 'Draft a follow-up for Northwind',
            detail: 'Draft ready for your review',
            trailing: <SampleText tone="muted">1h ago</SampleText>,
          },
          {
            leading: <SampleIconTile icon={ChatRound} />,
            title: 'Add a Suppliers table',
            detail: 'Name, contact, payment terms, region',
            trailing: <SampleText tone="muted">Yesterday</SampleText>,
          },
          {
            leading: <SampleIconTile icon={ChatRound} />,
            title: 'Summarize last month’s orders',
            detail: '312 orders, up 18% on September',
            trailing: <SampleText tone="muted">Sep 30</SampleText>,
          },
          {
            leading: <SampleIconTile icon={ChatRound} />,
            title: 'Who owns the Acme renewal?',
            detail: 'Assigned to the Sales team',
            trailing: <SampleText tone="muted">Sep 28</SampleText>,
          },
        ]}
      />
    </SampleWindow>
  );
}

export function FilesSample() {
  return (
    <SampleWindow icon={Files} trail={['Files', 'My files']}>
      <SampleList
        items={[
          {
            leading: <SampleIconTile icon={Folder} />,
            title: 'Supplier contracts',
            detail: 'Folder · Shared with Purchasing',
            trailing: <SampleText tone="muted">You</SampleText>,
          },
          {
            leading: <SampleIconTile icon={Folder} />,
            title: 'Month-end close',
            detail: 'Folder',
            trailing: <SampleText tone="muted">You</SampleText>,
          },
          {
            leading: (
              <FileTypeIcon
                name="Price list 2026.xlsx"
                mediaType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
              />
            ),
            title: 'Price list 2026.xlsx',
            detail: 'Spreadsheet · 48 KB',
            trailing: <SampleText tone="muted">You</SampleText>,
          },
          {
            leading: <FileTypeIcon name="Returns policy.pdf" mediaType="application/pdf" />,
            title: 'Returns policy.pdf',
            detail: 'PDF · 212 KB',
            trailing: <SampleText tone="muted">You</SampleText>,
          },
          {
            leading: (
              <FileTypeIcon
                name="Onboarding checklist.docx"
                mediaType="application/vnd.openxmlformats-officedocument.wordprocessingml.document"
              />
            ),
            title: 'Onboarding checklist.docx',
            detail: 'Document · 31 KB',
            trailing: <SampleText tone="muted">You</SampleText>,
          },
        ]}
      />
    </SampleWindow>
  );
}

export function AgentsSample() {
  return (
    <SampleWindow icon={Users} trail={['Agents']}>
      <SampleList
        items={[
          {
            leading: <AgentAvatar agentId="sample-collections" name="Collections assistant" size="sm" />,
            title: 'Collections assistant',
            detail: 'Follows up on overdue invoices',
            trailing: <Badge variant="success">Active</Badge>,
          },
          {
            leading: <AgentAvatar agentId="sample-onboarding" name="Onboarding guide" size="sm" />,
            title: 'Onboarding guide',
            detail: 'Welcomes new customers and books kickoffs',
            trailing: <Badge variant="success">Active</Badge>,
          },
          {
            leading: <AgentAvatar agentId="sample-inventory" name="Inventory watcher" size="sm" />,
            title: 'Inventory watcher',
            detail: 'Flags products below reorder level',
            trailing: <Badge variant="secondary">Draft</Badge>,
          },
          {
            leading: <AgentAvatar agentId="sample-support" name="Support triage" size="sm" />,
            title: 'Support triage',
            detail: 'Routes new tickets to the right team',
            trailing: <Badge variant="success">Active</Badge>,
          },
          {
            leading: <AgentAvatar agentId="sample-reports" name="Weekly reporter" size="sm" />,
            title: 'Weekly reporter',
            detail: 'Posts pipeline numbers every Monday',
            trailing: <Badge variant="secondary">Draft</Badge>,
          },
        ]}
      />
    </SampleWindow>
  );
}

export function ProjectsSample() {
  return (
    <SampleWindow icon={Folder} trail={['Projects']}>
      <p className="px-4 pt-4 pb-2 font-medium text-foreground">Active projects</p>
      <SampleList
        items={[
          { title: 'Spring launch', detail: 'Use the launch brief for dates and messaging.' },
          { title: 'Customer onboarding', detail: 'Keep kickoff notes and customer setup guides here.' },
          { title: 'Supplier review', detail: 'Compare quotes against our purchasing guidelines.' },
        ]}
      />
      <p className="px-4 pt-4 pb-2 font-medium text-foreground">Archived projects</p>
      <SampleList
        items={[
          {
            title: 'Summer catalogue',
            detail: 'Use the approved product descriptions.',
            trailing: <Badge variant="secondary">Archived</Badge>,
          },
        ]}
      />
    </SampleWindow>
  );
}

export function AgentTasksSample() {
  return (
    <SampleWindow icon={Checklist} trail={['My agent tasks']}>
      <SampleList
        items={[
          {
            leading: <AgentAvatar agentId="sample-collections" name="Collections assistant" size="sm" />,
            title: 'Send reminders for invoices past 30 days',
            detail: 'Collections assistant · Started 4m ago',
            trailing: <Badge variant="warning">Needs review</Badge>,
          },
          {
            leading: <AgentAvatar agentId="sample-onboarding" name="Onboarding guide" size="sm" />,
            title: 'Book a kickoff with Contoso',
            detail: 'Onboarding guide · Started 1h ago',
            trailing: <Badge variant="success">Completed</Badge>,
          },
          {
            leading: <AgentAvatar agentId="sample-inventory" name="Inventory watcher" size="sm" />,
            title: 'List products below reorder level',
            detail: 'Inventory watcher · Started today',
            trailing: <Badge variant="success">Completed</Badge>,
          },
          {
            leading: <AgentAvatar agentId="sample-support" name="Support triage" size="sm" />,
            title: 'Tag this week’s billing tickets',
            detail: 'Support triage · Started yesterday',
            trailing: <Badge variant="secondary">Pending</Badge>,
          },
        ]}
      />
    </SampleWindow>
  );
}

export function SkillsSample() {
  return (
    <SampleWindow icon={BookOpen} trail={['Skills']} tabs={['Workspace', 'Built-in']}>
      <SampleList
        items={[
          {
            leading: <SampleIconTile icon={BookOpen} />,
            title: 'Qualify an inbound lead',
            detail: 'Check budget, timeline, and decision maker',
            trailing: <Badge variant="success">Approved</Badge>,
          },
          {
            leading: <SampleIconTile icon={BookOpen} />,
            title: 'Prepare a quarterly review',
            detail: 'Pull revenue, churn, and open risks',
            trailing: <Badge variant="success">Approved</Badge>,
          },
          {
            leading: <SampleIconTile icon={BookOpen} />,
            title: 'Handle a refund request',
            detail: 'Verify the order, then propose a refund',
            trailing: <Badge variant="warning">In review</Badge>,
          },
          {
            leading: <SampleIconTile icon={BookOpen} />,
            title: 'Write a supplier follow-up',
            detail: 'Friendly tone, confirm delivery dates',
            trailing: <Badge variant="secondary">Draft</Badge>,
          },
        ]}
      />
    </SampleWindow>
  );
}

export function WorkflowsSample() {
  return (
    <SampleWindow icon={BranchDown} trail={['Workflows']}>
      <SampleTable
        columns={[{ label: 'Workflow', size: 'lg' }, { label: 'Trigger' }, { label: 'Status', size: 'sm' }]}
        rows={[
          [
            <>
              <SampleMark tone="green" />
              <SampleText tone="strong">Approve large discounts</SampleText>
            </>,
            <SampleText tone="muted">New quote</SampleText>,
            <Badge variant="success">Active</Badge>,
          ],
          [
            <>
              <SampleMark tone="blue" />
              <SampleText tone="strong">Onboard a new customer</SampleText>
            </>,
            <SampleText tone="muted">Deal won</SampleText>,
            <Badge variant="success">Active</Badge>,
          ],
          [
            <>
              <SampleMark tone="orange" />
              <SampleText tone="strong">Reorder low stock</SampleText>
            </>,
            <SampleText tone="muted">Daily, 8:00</SampleText>,
            <Badge variant="secondary">Draft</Badge>,
          ],
          [
            <>
              <SampleMark tone="violet" />
              <SampleText tone="strong">Escalate urgent tickets</SampleText>
            </>,
            <SampleText tone="muted">New ticket</SampleText>,
            <Badge variant="success">Active</Badge>,
          ],
          [
            <>
              <SampleMark tone="red" />
              <SampleText tone="strong">Chase unsigned contracts</SampleText>
            </>,
            <SampleText tone="muted">Weekly, Mon</SampleText>,
            <Badge variant="secondary">Draft</Badge>,
          ],
        ]}
      />
    </SampleWindow>
  );
}

export function TablesSample() {
  return (
    <SampleWindow icon={Database} trail={['Tables']}>
      <SampleTable
        columns={[
          { label: 'Table', size: 'lg' },
          { label: 'Fields', size: 'sm' },
          { label: 'Rows', size: 'sm' },
        ]}
        rows={[
          [
            <>
              <SampleMark tone="blue" />
              <SampleText tone="strong">Customers</SampleText>
            </>,
            <SampleText>12</SampleText>,
            <SampleText>1,248</SampleText>,
          ],
          [
            <>
              <SampleMark tone="green" />
              <SampleText tone="strong">Invoices</SampleText>
            </>,
            <SampleText>9</SampleText>,
            <SampleText>3,902</SampleText>,
          ],
          [
            <>
              <SampleMark tone="orange" />
              <SampleText tone="strong">Orders</SampleText>
            </>,
            <SampleText>14</SampleText>,
            <SampleText>8,417</SampleText>,
          ],
          [
            <>
              <SampleMark tone="violet" />
              <SampleText tone="strong">Products</SampleText>
            </>,
            <SampleText>8</SampleText>,
            <SampleText>326</SampleText>,
          ],
          [
            <>
              <SampleMark tone="red" />
              <SampleText tone="strong">Suppliers</SampleText>
            </>,
            <SampleText>7</SampleText>,
            <SampleText>58</SampleText>,
          ],
          [
            <>
              <SampleMark tone="teal" />
              <SampleText tone="strong">Support tickets</SampleText>
            </>,
            <SampleText>10</SampleText>,
            <SampleText>2,031</SampleText>,
          ],
        ]}
      />
    </SampleWindow>
  );
}

export function RecordsSample({ table, fields }: { table: string; fields: readonly string[] }) {
  const shown = fields.slice(0, 3);
  const columns: SampleColumn[] = shown.length
    ? shown.map((label, index) => ({ label, size: index === 0 ? 'lg' : 'md' }))
    : [{ label: 'Row', size: 'lg' }];
  const rows = [
    ['blue', 'lg', 'md'],
    ['green', 'md', 'sm'],
    ['orange', 'sm', 'lg'],
    ['violet', 'md', 'md'],
    ['red', 'lg', 'sm'],
    ['teal', 'sm', 'md'],
  ] as const;
  return (
    <SampleWindow icon={Database} trail={['Tables', table]}>
      <SampleTable
        columns={columns}
        rows={rows.map(([tone, first, rest]) =>
          columns.map((_, column) =>
            column === 0 ? (
              <>
                <SampleMark tone={tone} />
                <SampleBar width={first} />
              </>
            ) : (
              <SampleBar width={column % 2 ? rest : first} />
            ),
          ),
        )}
      />
    </SampleWindow>
  );
}

export function CreateInChatSample() {
  return (
    <SampleWindow icon={ChatRound} trail={['New chat']}>
      <div className="flex flex-col gap-3 p-4">
        <p className="ml-auto max-w-72 rounded-xl bg-accent px-3 py-2 text-foreground">
          Track our suppliers with a name, contact email, payment terms, and region.
        </p>
        <p className="max-w-80 text-foreground-secondary">
          I’ll create a <span className="font-medium text-foreground">Suppliers</span> table with these fields. Review
          the schema before approving.
        </p>
        <div className="max-w-80 rounded-lg border">
          <SampleTable
            columns={[{ label: 'Field', size: 'lg' }, { label: 'Type' }]}
            rows={[
              [<SampleText tone="strong">Name</SampleText>, <SampleText tone="muted">Text</SampleText>],
              [<SampleText tone="strong">Contact email</SampleText>, <SampleText tone="muted">Email</SampleText>],
              [<SampleText tone="strong">Payment terms</SampleText>, <SampleText tone="muted">Choice</SampleText>],
              [<SampleText tone="strong">Region</SampleText>, <SampleText tone="muted">Choice</SampleText>],
            ]}
          />
        </div>
      </div>
    </SampleWindow>
  );
}

export function IntegrationsSample() {
  return (
    <SampleWindow icon={Plug} trail={['Integrations']} tabs={['Connected', 'All']}>
      <SampleList
        items={[
          {
            leading: <BrandIcon brand="slack" size="sm" />,
            title: 'Slack',
            detail: 'Agents reply in #sales and #support',
            trailing: <Badge variant="success">Connected</Badge>,
          },
          {
            leading: <BrandIcon brand="gmail" size="sm" />,
            title: 'Gmail',
            detail: 'Reads new mail for heartbeat answers',
            trailing: <Badge variant="success">Connected</Badge>,
          },
          {
            leading: <BrandIcon brand="google-calendar" size="sm" />,
            title: 'Google Calendar',
            detail: 'Books meetings after your approval',
            trailing: <Badge variant="success">Connected</Badge>,
          },
          {
            leading: <BrandIcon brand="github" size="sm" />,
            title: 'GitHub',
            detail: 'Files issues for the product team',
            trailing: <Badge variant="success">Connected</Badge>,
          },
          {
            leading: <BrandIcon brand="jira" size="sm" />,
            title: 'Jira',
            detail: 'Searches the Support board',
            trailing: <Badge variant="warning">Needs attention</Badge>,
          },
        ]}
      />
    </SampleWindow>
  );
}

export function ModelsSample() {
  return (
    <SampleWindow icon={Cpu} trail={['Settings', 'Models']}>
      <SampleList
        items={[
          {
            leading: <BrandIcon brand="claude" size="sm" />,
            title: 'Claude',
            detail: 'Default for chat and agents',
            trailing: <Badge variant="success">Enabled</Badge>,
          },
          {
            leading: <BrandIcon brand="openai" size="sm" />,
            title: 'GPT',
            detail: 'Available to the Analytics team',
            trailing: <Badge variant="success">Enabled</Badge>,
          },
          {
            leading: <BrandIcon brand="deepseek" size="sm" />,
            title: 'DeepSeek',
            detail: 'Not available to any team',
            trailing: <Badge variant="secondary">Off</Badge>,
          },
          {
            leading: <BrandIcon brand="kimi" size="sm" />,
            title: 'Kimi',
            detail: 'Not available to any team',
            trailing: <Badge variant="secondary">Off</Badge>,
          },
        ]}
      />
    </SampleWindow>
  );
}

export function MembersSample() {
  return (
    <SampleWindow icon={User} trail={['Settings', 'Members']}>
      <SampleTable
        columns={[{ label: 'Member', size: 'lg' }, { label: 'Role', size: 'sm' }, { label: 'Teams' }]}
        rows={[
          [
            <>
              <SampleMark tone="violet" />
              <SampleText tone="strong">Maya Chen</SampleText>
            </>,
            <Badge variant="info">Admin</Badge>,
            <SampleText tone="muted">Operations</SampleText>,
          ],
          [
            <>
              <SampleMark tone="orange" />
              <SampleText tone="strong">Leo Martins</SampleText>
            </>,
            <Badge variant="secondary">Member</Badge>,
            <SampleText tone="muted">Sales, Support</SampleText>,
          ],
          [
            <>
              <SampleMark tone="green" />
              <SampleText tone="strong">Priya Nair</SampleText>
            </>,
            <Badge variant="secondary">Member</Badge>,
            <SampleText tone="muted">Finance</SampleText>,
          ],
          [
            <>
              <SampleMark tone="blue" />
              <SampleText tone="strong">Sam Okafor</SampleText>
            </>,
            <Badge variant="secondary">Member</Badge>,
            <SampleText tone="muted">Support</SampleText>,
          ],
          [
            <>
              <SampleMark tone="red" />
              <SampleText tone="strong">Ines Duarte</SampleText>
            </>,
            <Badge variant="info">Admin</Badge>,
            <SampleText tone="muted">Operations</SampleText>,
          ],
        ]}
      />
    </SampleWindow>
  );
}

export function TeamsSample() {
  return (
    <SampleWindow icon={People} trail={['Settings', 'Teams']}>
      <SampleList
        items={[
          {
            leading: <SampleMark tone="blue" size="md" />,
            title: 'Sales',
            detail: 'Pipeline, quotes, and renewals · 8 members',
          },
          {
            leading: <SampleMark tone="green" size="md" />,
            title: 'Finance',
            detail: 'Invoices and collections · 3 members',
          },
          {
            leading: <SampleMark tone="orange" size="md" />,
            title: 'Support',
            detail: 'Tickets and refunds · 6 members',
          },
          {
            leading: <SampleMark tone="violet" size="md" />,
            title: 'Operations',
            detail: 'Inventory and suppliers · 4 members',
          },
        ]}
      />
    </SampleWindow>
  );
}

export function InvitationsSample() {
  return (
    <SampleWindow icon={Envelope} trail={['Settings', 'Members', 'Invitations']}>
      <SampleTable
        columns={[{ label: 'Email', size: 'lg' }, { label: 'Status', size: 'sm' }, { label: 'Email delivery' }]}
        rows={[
          [
            <SampleText tone="link">maya@northwind.co</SampleText>,
            <Badge variant="info">active</Badge>,
            <SampleText tone="muted">Delivered</SampleText>,
          ],
          [
            <SampleText tone="link">leo@northwind.co</SampleText>,
            <Badge variant="secondary">Accepted</Badge>,
            <SampleText tone="muted">Delivered</SampleText>,
          ],
          [
            <SampleText tone="link">priya@northwind.co</SampleText>,
            <Badge variant="info">active</Badge>,
            <SampleText tone="muted">Sent</SampleText>,
          ],
          [
            <SampleText tone="link">sam@northwind.co</SampleText>,
            <Badge variant="secondary">expired</Badge>,
            <SampleText tone="muted">Delivered</SampleText>,
          ],
        ]}
      />
    </SampleWindow>
  );
}

export function GrantsSample() {
  return (
    <SampleWindow icon={ShieldUser} trail={['Settings', 'Table access']} tabs={['Sales', 'Finance', 'Support']}>
      <SampleTable
        columns={[
          { label: 'Table', size: 'lg' },
          { label: 'Read', size: 'sm' },
          { label: 'Edit', size: 'sm' },
        ]}
        rows={[
          [
            <>
              <SampleMark tone="blue" />
              <SampleText tone="strong">Customers</SampleText>
            </>,
            <Badge variant="success">Granted</Badge>,
            <Badge variant="success">Granted</Badge>,
          ],
          [
            <>
              <SampleMark tone="green" />
              <SampleText tone="strong">Invoices</SampleText>
            </>,
            <Badge variant="success">Granted</Badge>,
            <SampleText tone="muted">None</SampleText>,
          ],
          [
            <>
              <SampleMark tone="orange" />
              <SampleText tone="strong">Orders</SampleText>
            </>,
            <Badge variant="success">Granted</Badge>,
            <Badge variant="success">Granted</Badge>,
          ],
          [
            <>
              <SampleMark tone="violet" />
              <SampleText tone="strong">Products</SampleText>
            </>,
            <Badge variant="success">Granted</Badge>,
            <SampleText tone="muted">None</SampleText>,
          ],
          [
            <>
              <SampleMark tone="red" />
              <SampleText tone="strong">Suppliers</SampleText>
            </>,
            <SampleText tone="muted">None</SampleText>,
            <SampleText tone="muted">None</SampleText>,
          ],
        ]}
      />
    </SampleWindow>
  );
}
