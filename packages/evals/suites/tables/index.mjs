// Moved from packages/agents/test/table-proposal.eval.mjs: how well the chat agent writes a valid tables.propose
// payload. A case passes when the agent produces a pending schema proposal, which is its approval request.
import { randomUUID } from 'node:crypto';
import { chatPaths } from '../paths.mjs';

const team = 'qa-eval-operations';
const suffix = `Owning team: ${team}. Use schema.context to find the team. Prepare one schema proposal for my approval; create no records and change no existing tables.`;
const prompts = [
  {
    id: 'todo',
    text: 'Create a table "Eval Todo List". Fields: title (text, required, unique), done (boolean, required), due date (date), priority (single-select: Low, Medium, High, Urgent), tags (multi-select: Home, Work, Errands, Finance, Health), and attachments (files).',
  },
  {
    id: 'crm',
    text: 'Create two linked tables for a CRM. "Eval Companies": name (text, required, unique), industry (single-select: Software, Retail, Healthcare, Finance, Manufacturing, Education, Logistics, Media, Energy, Hospitality, Agriculture, Government), employee count (whole number, up to 9 digits), and created at (date and time). "Eval Contacts": full name (text, required), email (text, required, unique), primary contact (boolean), and company (a link to exactly one company in Eval Companies).',
  },
  {
    id: 'invoice',
    text: 'Create a table "Eval Invoices". Fields: invoice number (text, required, unique), issued on (date, required), due on (date), amount (money, 12 digits total with 2 decimal places, required), tax rate (decimal with 4 decimal places, at most 5 digits total), paid (boolean), paid at (date and time), status (single-select: Draft, Sent, Paid, Overdue, Void), and PDF (file).',
  },
  {
    id: 'leave',
    text: 'Create an HR leave tracker table "Eval Leave Requests". Fields: request code (text, required, unique), employee name (text, required), leave type (single-select: Annual, Sick, Parental, Unpaid, Bereavement, Study), start date and end date (dates, required), days requested (decimal with one decimal place, up to 999.5), approved (boolean), submitted at (date and time), and reasons (multi-select: Travel, Family, Medical, Personal, Other).',
  },
  {
    id: 'inventory',
    text: 'Create a table "Eval Inventory". Fields: SKU (text, required, unique), warehouse (single-select with 15 options: Mumbai, Delhi, Bengaluru, Chennai, Hyderabad, Pune, Kolkata, Ahmedabad, Jaipur, Lucknow, Kochi, Indore, Nagpur, Surat, Bhopal), categories (multi-select with 20 options: Electronics, Furniture, Apparel, Toys, Books, Kitchen, Garden, Sports, Beauty, Grocery, Office, Automotive, Pet, Baby, Tools, Music, Health, Jewelry, Footwear, Outdoor), unit price (12 digits with 2 decimal places), weight in kg (8 digits with 3 decimal places), and last counted at (date and time).',
  },
  {
    id: 'projects',
    text: 'Create two linked tables. "Eval Projects": project code (text, required, unique), name (text, required), status (single-select: Planned, Active, Paused, Done), and archived (boolean). "Eval Project Tasks": task title (text, required), project (a link to one project in Eval Projects, required), estimate hours (decimal with 2 decimal places, up to 9999.99), labels (multi-select: Bug, Feature, Chore, Research), due date (date), and completed at (date and time).',
  },
];

export default {
  name: 'tables',
  tolerance: 5,
  paths: [...chatPaths, 'packages/agents/skills/table-authoring/', 'packages/agents/src/table', 'packages/tables/src/'],
  harness: {
    allowedTools: new Set([
      'schema.context',
      'schema.inspect',
      'tables.list',
      'tables.definitions',
      'skills.list',
      'skills.read',
      'tables.propose',
    ]),
    liveWrites: new Set(['tables.propose']),
    async setup(f) {
      const teamId = randomUUID();
      await f.db.platform.query(`INSERT INTO ${f.table('tf_teams')}(id,name) VALUES($1,$2)`, [teamId, team]);
      await f.db.platform.query(`INSERT INTO ${f.table('tf_member_teams')}(membership_id,team_id) VALUES($1,$2)`, [
        f.workspace.membershipId,
        teamId,
      ]);
      await f.db.platform.query(`UPDATE ${f.table('tf_soul_head')} SET revision=$1 WHERE id=1`, ['a'.repeat(40)]);
    },
  },
  cases: prompts.map(prompt => ({
    id: prompt.id,
    name: prompt.id,
    message: `${prompt.text} ${suffix}`,
    checks: [{ kind: 'tool-called', tool: 'tables.propose' }, { kind: 'approval-requested' }],
  })),
};
